/**
 * Gerstner wave model shared by the GPU (vertex shader) and the CPU (physics,
 * projectile worker, camera).
 *
 * The SAME parameters drive both sides: the shader receives them as uniforms
 * and `WaveField.sample()` evaluates identical math in TypeScript, so a ship
 * floating on the CPU-side surface sits exactly on the rendered water.
 *
 * To keep the sea from looking like one repeating pattern:
 * - waves come from three systems (a long swell, a cross swell, wind chop),
 *   each with its own direction, length and phase;
 * - every wave's height is modulated by two slow envelopes: "wave groups"
 *   that travel at half the wave's speed (sets of bigger waves roll through),
 *   and a second one running along the crest, which chops the long parallel
 *   lines into short humps;
 * - every wave's phase is warped by a slow drifting field, so crests bend
 *   and wander instead of marching in straight rows;
 * - near land the whole sea is scaled down by the shore map (see shore.ts).
 *
 * If you change the math here, change `GERSTNER_GLSL` below to match.
 */
import * as THREE from 'three';
import { ShoreField, SHORE_FULL_DEPTH, SHORE_MIN_WAVE, SHORE_TEX_MIN, SHORE_TEX_RANGE } from './shore';

export const MAX_WAVES = 12;
const GRAVITY = 9.81;
/** Group envelope is this many wavelengths long. */
const GROUP_LENGTH = 7;
/** Group envelope travels at this angle off the wave direction (radians). */
const GROUP_SKEW = 0.44;
const COS_SKEW = Math.cos(GROUP_SKEW);
const SIN_SKEW = Math.sin(GROUP_SKEW);
/** Along-crest envelope: this many wavelengths long, at this angle off the wave direction. */
const CREST_LENGTH = 3.3;
const CREST_SKEW = -1.15;
const COS_CREST = Math.cos(CREST_SKEW);
const SIN_CREST = Math.sin(CREST_SKEW);
/** Phase warp: two drifting sines, this many wavelengths long, at these angles. */
const WARP_LENGTH = 9;
const WARP_A = 1.2;
const WARP_B = -0.9;
const COS_WA = Math.cos(WARP_A);
const SIN_WA = Math.sin(WARP_A);
const COS_WB = Math.cos(WARP_B);
const SIN_WB = Math.sin(WARP_B);

export interface WaveParams {
  /** Direction of travel in degrees (0 = +X, 90 = +Z). */
  direction: number;
  /** Crest-to-crest distance in metres. */
  wavelength: number;
  /** 0..1. Sum of all steepness values should stay below ~1 to avoid loops. */
  steepness: number;
  /** Phase offset in radians, so waves don't all line up at the origin. */
  phase?: number;
  /** 0..1 how strongly wave groups modulate this wave's height. */
  grouping?: number;
}

export const DEFAULT_WAVES: WaveParams[] = [
  // long swell: three trains fanned well apart so they cross instead of stacking
  { direction: 15, wavelength: 72, steepness: 0.14, phase: 0.0, grouping: 0.55 },
  { direction: 64, wavelength: 47, steepness: 0.12, phase: 2.1, grouping: 0.55 },
  { direction: -41, wavelength: 36, steepness: 0.11, phase: 4.3, grouping: 0.5 },
  // cross swell
  { direction: 122, wavelength: 27, steepness: 0.08, phase: 1.3, grouping: 0.45 },
  { direction: -98, wavelength: 19, steepness: 0.065, phase: 5.2, grouping: 0.4 },
  // wind chop
  { direction: 38, wavelength: 12, steepness: 0.07, phase: 0.7, grouping: 0.35 },
  { direction: -17, wavelength: 9, steepness: 0.06, phase: 3.6, grouping: 0.35 },
  { direction: 171, wavelength: 7, steepness: 0.05, phase: 2.8, grouping: 0.3 },
  { direction: 88, wavelength: 5.5, steepness: 0.04, phase: 4.9, grouping: 0.25 },
  { direction: -66, wavelength: 4, steepness: 0.035, phase: 1.9, grouping: 0.2 },
];

export interface SeaState {
  waves: WaveParams[];
  intensity: number;
  warp: number;
}

export interface WaveSample {
  height: number;
  normal: THREE.Vector3;
}

/**
 * Holds wave parameters as packed uniform arrays and evaluates the surface on
 * the CPU. Call `syncUniforms()` after editing `waves` (the debug GUI does).
 */
export class WaveField {
  waves: WaveParams[];
  /** Global multiplier on steepness; lets us calm or rough up the sea. */
  intensity = 0.7;
  /** Global time-scale. */
  speed = 1;
  /** How far crests bend and wander (radians of phase). 0 = straight rows. */
  warp = 0.9;
  /** Terrain map; the sea is scaled down in shallow water. Null = open ocean everywhere. */
  shore: ShoreField | null = null;

  readonly uniforms = {
    uTime: { value: 0 },
    // xy = direction, z = k (wave number), w = base amplitude
    uWaveA: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    // x = phase speed c, y = steepness (Q), z = phase, w = grouping depth
    uWaveB: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    uWaveCount: { value: 0 },
    uWarp: { value: 0.9 },
  };

  private time = 0;
  /** Scratch for one wave's evaluation: phase, envelope, warp gradient x/z. */
  private readonly ev = { f: 0, env: 1, wx: 0, wz: 0 };

  constructor(waves: WaveParams[] = DEFAULT_WAVES) {
    this.waves = waves.map((w) => ({ ...w }));
    this.syncUniforms();
  }

  update(dt: number): void {
    this.time += dt * this.speed;
    this.uniforms.uTime.value = this.time;
  }

  get currentTime(): number {
    return this.time;
  }

  /** Jump to an absolute wave time (used by the projectile worker to stay in sync). */
  setTime(t: number): void {
    this.time = t;
    this.uniforms.uTime.value = t;
  }

  /** Plain-data snapshot of the sea state, cheap to post to a worker. */
  serialize(): SeaState {
    return { waves: this.waves.map((w) => ({ ...w })), intensity: this.intensity, warp: this.warp };
  }

  applySeaState(state: SeaState): void {
    this.waves = state.waves.map((w) => ({ ...w }));
    this.intensity = state.intensity;
    this.warp = state.warp;
    this.syncUniforms();
  }

  syncUniforms(): void {
    const n = Math.min(this.waves.length, MAX_WAVES);
    this.uniforms.uWaveCount.value = n;
    this.uniforms.uWarp.value = this.warp;
    for (let i = 0; i < MAX_WAVES; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      if (i >= n) {
        a.set(1, 0, 1, 0);
        b.set(0, 0, 0, 0);
        continue;
      }
      const w = this.waves[i];
      const rad = THREE.MathUtils.degToRad(w.direction);
      const k = (2 * Math.PI) / Math.max(0.5, w.wavelength);
      const c = Math.sqrt(GRAVITY / k);
      const q = w.steepness * this.intensity;
      a.set(Math.cos(rad), Math.sin(rad), k, q / k);
      b.set(c, q, w.phase ?? 0, THREE.MathUtils.clamp(w.grouping ?? 0, 0, 0.95));
    }
  }

  /**
   * Phase, envelope and warp gradient of wave i at grid point (x, z).
   * GLSL twin: `waveEval()` in GERSTNER_GLSL.
   */
  private evalWave(i: number, x: number, z: number, t: number): void {
    const a = this.uniforms.uWaveA.value[i];
    const b = this.uniforms.uWaveB.value[i];
    const ev = this.ev;
    const dx = a.x;
    const dz = a.y;
    const k = a.z;
    const c = b.x;
    const ph = b.z;
    const g = b.w;

    let env = 1;
    if (g > 0) {
      // wave groups (sets) travelling at half the phase speed
      const e1 = Math.sin((k / GROUP_LENGTH) * ((dx * COS_SKEW - dz * SIN_SKEW) * x + (dx * SIN_SKEW + dz * COS_SKEW) * z - c * 0.5 * t) + ph * 1.7);
      // along-crest modulation: breaks long crests into short humps
      const e2 = Math.sin((k / CREST_LENGTH) * ((dx * COS_CREST - dz * SIN_CREST) * x + (dx * SIN_CREST + dz * COS_CREST) * z - c * 0.35 * t) + ph * 2.9);
      env = (1 - g + g * 0.85 * (1 + e1)) * (1 + g * 0.7 * e2);
    }
    ev.env = env;

    const kq = k / WARP_LENGTH;
    const ax = dx * COS_WA - dz * SIN_WA;
    const az = dx * SIN_WA + dz * COS_WA;
    const bx = dx * COS_WB - dz * SIN_WB;
    const bz = dx * SIN_WB + dz * COS_WB;
    const u1 = kq * (ax * x + az * z - c * 0.2 * t) + ph * 3.1;
    const u2 = kq * 1.7 * (bx * x + bz * z + c * 0.15 * t) + ph * 5.3;
    const wp = this.warp;
    const c1 = Math.cos(u1) * wp * kq;
    const c2 = Math.cos(u2) * wp * kq * 1.7;
    ev.wx = ax * c1 + bx * c2;
    ev.wz = az * c1 + bz * c2;
    ev.f = k * (dx * x + dz * z - c * t) + ph + wp * (Math.sin(u1) + Math.sin(u2));
  }

  /**
   * Raw Gerstner displacement of the undisplaced grid point (x, z).
   * Writes into `out` (dx, dy, dz) and returns it.
   */
  displacement(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    const t = this.time;
    const n = this.uniforms.uWaveCount.value;
    const ev = this.ev;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      this.evalWave(i, x, z, t);
      const amp = a.w * ev.env;
      const cf = Math.cos(ev.f);
      out.x += a.x * amp * cf;
      out.y += amp * Math.sin(ev.f);
      out.z += a.y * amp * cf;
    }
    if (this.shore) out.multiplyScalar(this.shore.waveScale(x, z));
    return out;
  }

  /**
   * Height and normal of the water surface at world (x, z).
   *
   * Gerstner waves move vertices sideways as well as up, so the vertex that
   * ends up above (x, z) didn't start there. A few fixed-point iterations find
   * the source grid point; 4 is plenty for steepness sums below ~0.9.
   */
  sample(x: number, z: number, out?: WaveSample): WaveSample {
    const res = out ?? { height: 0, normal: new THREE.Vector3() };
    let px = x;
    let pz = z;
    const d = _tmpD;
    for (let it = 0; it < 4; it++) {
      this.displacement(px, pz, d);
      px = x - d.x;
      pz = z - d.z;
    }
    this.displacement(px, pz, d);
    res.height = d.y;
    this.normalAt(px, pz, res.normal);
    return res;
  }

  /** Height only (cheaper call site for buoyancy probes). */
  heightAt(x: number, z: number): number {
    let px = x;
    let pz = z;
    const d = _tmpD;
    for (let it = 0; it < 4; it++) {
      this.displacement(px, pz, d);
      px = x - d.x;
      pz = z - d.z;
    }
    return this.displacement(px, pz, d).y;
  }

  /**
   * Analytic Gerstner normal at undisplaced grid point (x, z). The envelopes
   * and the shore scale vary slowly, so their own slopes are ignored.
   */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    const t = this.time;
    const n = this.uniforms.uWaveCount.value;
    const ev = this.ev;
    const s = this.shore ? this.shore.waveScale(x, z) : 1;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      this.evalWave(i, x, z, t);
      const amp = a.w * ev.env * s;
      const cf = Math.cos(ev.f);
      const sf = Math.sin(ev.f);
      nx -= (a.z * a.x + ev.wx) * amp * cf;
      nz -= (a.z * a.y + ev.wz) * amp * cf;
      ny -= b.y * ev.env * s * sf;
    }
    return out.set(nx, ny, nz).normalize();
  }
}

const _tmpD = new THREE.Vector3();

/**
 * GLSL twin of `WaveField.evalWave()` / `displacement()` / `normalAt()`, plus
 * `shoreScale()` (twin of `shoreWaveScale()` in shore.ts).
 */
export const GERSTNER_GLSL = /* glsl */ `
  #define MAX_WAVES ${MAX_WAVES}
  uniform float uTime;
  uniform vec4 uWaveA[MAX_WAVES];
  uniform vec4 uWaveB[MAX_WAVES];
  uniform int uWaveCount;
  uniform float uWarp;
  uniform sampler2D uShoreMap;
  uniform float uShoreExtent;

  // Terrain height (m) at a world position, from the shore map.
  float terrainHeight(vec2 p) {
    return texture2D(uShoreMap, p / uShoreExtent + 0.5).r * ${SHORE_TEX_RANGE.toFixed(1)} + ${SHORE_TEX_MIN.toFixed(1)};
  }
  // Wave height multiplier: 1 in open water, small at the beach.
  float shoreScale(float terrain) {
    float t = clamp(-terrain / ${SHORE_FULL_DEPTH.toFixed(1)}, 0.0, 1.0);
    return ${SHORE_MIN_WAVE.toFixed(3)} + ${(1 - SHORE_MIN_WAVE).toFixed(3)} * t * t * (3.0 - 2.0 * t);
  }

  vec2 rot(vec2 d, float c, float s) { return vec2(d.x * c - d.y * s, d.x * s + d.y * c); }

  // Phase (x), envelope (y) and warp gradient (zw) of one wave at grid point p.
  vec4 waveEval(vec4 a, vec4 b, vec2 p) {
    vec2 d = a.xy;
    float k = a.z;
    float c = b.x;
    float ph = b.z;
    float g = b.w;
    float env = 1.0;
    if (g > 0.0) {
      float e1 = sin(k / ${GROUP_LENGTH.toFixed(1)} * (dot(rot(d, ${COS_SKEW.toFixed(6)}, ${SIN_SKEW.toFixed(6)}), p) - c * 0.5 * uTime) + ph * 1.7);
      float e2 = sin(k / ${CREST_LENGTH.toFixed(1)} * (dot(rot(d, ${COS_CREST.toFixed(6)}, ${SIN_CREST.toFixed(6)}), p) - c * 0.35 * uTime) + ph * 2.9);
      env = (1.0 - g + g * 0.85 * (1.0 + e1)) * (1.0 + g * 0.7 * e2);
    }
    float kq = k / ${WARP_LENGTH.toFixed(1)};
    vec2 ra = rot(d, ${COS_WA.toFixed(6)}, ${SIN_WA.toFixed(6)});
    vec2 rb = rot(d, ${COS_WB.toFixed(6)}, ${SIN_WB.toFixed(6)});
    float u1 = kq * (dot(ra, p) - c * 0.2 * uTime) + ph * 3.1;
    float u2 = kq * 1.7 * (dot(rb, p) + c * 0.15 * uTime) + ph * 5.3;
    vec2 grad = ra * (cos(u1) * uWarp * kq) + rb * (cos(u2) * uWarp * kq * 1.7);
    float f = k * (dot(d, p) - c * uTime) + ph + uWarp * (sin(u1) + sin(u2));
    return vec4(f, env, grad);
  }

  // Returns displaced offset; writes analytic normal and the average group
  // envelope (useful for foam: big sets get whitecaps, lulls stay clean).
  // 'fade' scales the whole sea (distance fade x shore scale).
  vec3 gerstner(vec2 p, float fade, out vec3 normal, out float envOut) {
    vec3 d = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float envSum = 0.0;
    float envW = 0.0;
    for (int i = 0; i < MAX_WAVES; i++) {
      if (i >= uWaveCount) break;
      vec4 a = uWaveA[i];
      vec4 b = uWaveB[i];
      vec4 e = waveEval(a, b, p);
      float env = e.y;
      float amp = a.w * fade * env;
      float cf = cos(e.x);
      float sf = sin(e.x);
      d.x += a.x * amp * cf;
      d.y += amp * sf;
      d.z += a.y * amp * cf;
      n.x -= (a.z * a.x + e.z) * amp * cf;
      n.z -= (a.z * a.y + e.w) * amp * cf;
      n.y -= b.y * fade * env * sf;
      envSum += env * a.w;
      envW += a.w;
    }
    normal = normalize(n);
    envOut = envW > 0.0 ? envSum / envW : 1.0;
    return d;
  }
`;
