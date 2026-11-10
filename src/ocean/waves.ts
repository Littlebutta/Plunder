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
 *   with trains running in every compass quarter so the sea crosses itself;
 * - every wave's height is modulated by two slow envelopes: "wave groups"
 *   that travel at half the wave's speed (sets of bigger waves roll through),
 *   and a second one running along the crest, which chops the long parallel
 *   lines into short humps;
 * - every wave also swells and fades on its own slow clock (tens of seconds),
 *   so which direction dominates keeps changing and the rhythm never settles;
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
/** Each wave's height breathes by +/- this fraction on its own slow clock. */
const BREATH = 0.35;
/** Breathing rate (rad/s): base + per-radian-of-phase spread, so periods run from about 20 to 70 s. */
const BREATH_RATE = 0.09;
const BREATH_SPREAD = 0.036;
const COS_WB = Math.cos(WARP_B);
const SIN_WB = Math.sin(WARP_B);
/**
 * Regions: each wave is strong in some stretches of sea and faint in others,
 * on a pattern hundreds of metres across that is laid in its own direction and
 * drifts slowly. Sail a little way and a different set of trains dominates,
 * so the sea never reads as one set of rows marching the same way.
 */
const REGION = 0.5;
const REGION_K1 = (2 * Math.PI) / 190;
const REGION_K2 = (2 * Math.PI) / 120;
/** Directions of a wave's two region patterns, from its phase. */
const regionDir = (ph: number, n: 1 | 2): [number, number] => (n === 1 ? [Math.cos(ph * 2 + 0.4), Math.sin(ph * 2 + 0.4)] : [Math.cos(ph * 3.1 - 1), Math.sin(ph * 3.1 - 1)]);

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
  // long swell: three trains from different quarters, so they cross instead of marching together
  { direction: 20, wavelength: 72, steepness: 0.115, phase: 0.0, grouping: 0.55 },
  { direction: 118, wavelength: 51, steepness: 0.1, phase: 2.1, grouping: 0.55 },
  { direction: -74, wavelength: 38, steepness: 0.095, phase: 4.3, grouping: 0.5 },
  // cross swell, running against the main trains
  { direction: -163, wavelength: 29, steepness: 0.085, phase: 1.3, grouping: 0.5 },
  { direction: 67, wavelength: 21, steepness: 0.07, phase: 5.2, grouping: 0.45 },
  // wind chop from all round
  { direction: -28, wavelength: 13, steepness: 0.07, phase: 0.7, grouping: 0.4 },
  { direction: 152, wavelength: 9.5, steepness: 0.06, phase: 3.6, grouping: 0.4 },
  { direction: -115, wavelength: 7, steepness: 0.05, phase: 2.8, grouping: 0.35 },
  { direction: 88, wavelength: 5.5, steepness: 0.04, phase: 4.9, grouping: 0.3 },
  { direction: -5, wavelength: 4, steepness: 0.035, phase: 1.9, grouping: 0.25 },
];

export interface SeaState {
  waves: WaveParams[];
  intensity: number;
  warp: number;
  amplitudeScale: number;
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
  warp = 1.15;
  /**
   * Wave height multiplier for weather (1 = normal sea, about 1.6 = storm).
   * After changing it call `syncUniforms()`, `ocean.refreshAmplitude()` and
   * `projectiles.markSeaDirty()`.
   */
  amplitudeScale = 1;
  /** Terrain map; the sea is scaled down in shallow water. Null = open ocean everywhere. */
  shore: ShoreField | null = null;

  readonly uniforms = {
    uTime: { value: 0 },
    // xy = direction, z = k (wave number), w = base amplitude
    uWaveA: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    // x = phase speed c, y = steepness (Q), z = phase, w = grouping depth
    uWaveB: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    uWaveCount: { value: 0 },
    uWarp: { value: 1.15 },
    // A lone travelling swell (the tsunami, see setSwell): xy = direction, z = crest offset along it, w = height
    uSwellA: { value: new THREE.Vector4(1, 0, 0, 0) },
    // xy = middle of the crest, z = half its length, w = width
    uSwellB: { value: new THREE.Vector4(0, 0, 1, 1) },
  };

  /**
   * Raise a lone swell (the tsunami): a crest `width` across and `halfLength`
   * either side of `centre`, travelling along `dir` (unit). Height 0 removes it.
   * GLSL twin: `swell()` in GERSTNER_GLSL.
   */
  setSwell(dirX: number, dirZ: number, centreX: number, centreZ: number, height: number, halfLength: number, width: number): void {
    const sw = this.swellState;
    Object.assign(sw, { dx: dirX, dz: dirZ, cx: centreX, cz: centreZ, h: height, half: halfLength, w: width });
    this.uniforms.uSwellA.value.set(dirX, dirZ, dirX * centreX + dirZ * centreZ, height);
    this.uniforms.uSwellB.value.set(centreX, centreZ, halfLength, width);
  }
  private readonly swellState = { dx: 1, dz: 0, cx: 0, cz: 0, h: 0, half: 1, w: 1 };

  /** The swell's height (and, in `slope`, its rise along its direction) at grid point (x, z), before the shore scale. */
  swellAt(x: number, z: number, slope?: { v: number }): number {
    const sw = this.swellState;
    if (sw.h <= 0) {
      if (slope) slope.v = 0;
      return 0;
    }
    const ds = sw.dx * (x - sw.cx) + sw.dz * (z - sw.cz);
    const w = ds > 0 ? sw.w * 0.45 : sw.w * 1.5;
    const prof = Math.exp(-(ds * ds) / (w * w));
    const along = Math.abs(-sw.dz * (x - sw.cx) + sw.dx * (z - sw.cz));
    const m = 1 - THREE.MathUtils.smoothstep(along, sw.half * 0.55, sw.half);
    const h = sw.h * prof * m;
    if (slope) slope.v = h * ((-2 * ds) / (w * w));
    return h;
  }

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
    return { waves: this.waves.map((w) => ({ ...w })), intensity: this.intensity, warp: this.warp, amplitudeScale: this.amplitudeScale };
  }

  applySeaState(state: SeaState): void {
    this.waves = state.waves.map((w) => ({ ...w }));
    this.intensity = state.intensity;
    this.warp = state.warp;
    this.amplitudeScale = state.amplitudeScale ?? 1;
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
      const q = w.steepness * this.intensity * this.amplitudeScale;
      a.set(Math.cos(rad), Math.sin(rad), k, q / k);
      b.set(c, q, w.phase ?? 0, THREE.MathUtils.clamp(w.grouping ?? 0, 0, 0.95));
    }
    this.refreshCoef();
  }

  /**
   * Per-wave constants for the CPU twin, so a sample is mostly a handful of
   * multiply-adds and sines. `coef` holds the parts that depend on position
   * (16 per wave), `timeCoef` the parts that depend only on the clock (6 per
   * wave), refreshed once per new wave time.
   */
  private readonly coef = new Float64Array(MAX_WAVES * 20);
  private readonly timeCoef = new Float64Array(MAX_WAVES * 8);
  private coefTime = NaN;

  /** Rebuild the position constants from the uniforms (`syncUniforms` calls this). */
  private refreshCoef(): void {
    const n = this.uniforms.uWaveCount.value;
    const s = this.coef;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      const dx = a.x;
      const dz = a.y;
      const k = a.z;
      const kg = k / GROUP_LENGTH;
      const kc = k / CREST_LENGTH;
      const kq = k / WARP_LENGTH;
      const o = i * 20;
      const ph = b.z;
      const [r1x, r1z] = regionDir(ph, 1);
      const [r2x, r2z] = regionDir(ph, 2);
      s[o + 15] = REGION_K1 * r1x;
      s[o + 16] = REGION_K1 * r1z;
      s[o + 17] = REGION_K2 * r2x;
      s[o + 18] = REGION_K2 * r2z;
      s[o] = k * dx;
      s[o + 1] = k * dz;
      s[o + 2] = a.w;
      s[o + 3] = dx;
      s[o + 4] = dz;
      s[o + 5] = b.y;
      s[o + 6] = b.w;
      s[o + 7] = kg * (dx * COS_SKEW - dz * SIN_SKEW);
      s[o + 8] = kg * (dx * SIN_SKEW + dz * COS_SKEW);
      s[o + 9] = kc * (dx * COS_CREST - dz * SIN_CREST);
      s[o + 10] = kc * (dx * SIN_CREST + dz * COS_CREST);
      s[o + 11] = kq * (dx * COS_WA - dz * SIN_WA);
      s[o + 12] = kq * (dx * SIN_WA + dz * COS_WA);
      s[o + 13] = kq * 1.7 * (dx * COS_WB - dz * SIN_WB);
      s[o + 14] = kq * 1.7 * (dx * SIN_WB + dz * COS_WB);
    }
    this.coefTime = NaN;
  }

  /** The clock-only parts of every wave at time t. */
  private refreshTime(t: number): void {
    if (t === this.coefTime) return;
    this.coefTime = t;
    const n = this.uniforms.uWaveCount.value;
    const tc = this.timeCoef;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      const k = a.z;
      const c = b.x;
      const ph = b.z;
      const kq = k / WARP_LENGTH;
      const o = i * 8;
      tc[o + 6] = ph * 2.3 + t * 0.021;
      tc[o + 7] = ph * 1.1 - t * 0.017;
      tc[o] = -(k / GROUP_LENGTH) * c * 0.5 * t + ph * 1.7;
      tc[o + 1] = -(k / CREST_LENGTH) * c * 0.35 * t + ph * 2.9;
      tc[o + 2] = 1 + BREATH * Math.sin(t * (BREATH_RATE + BREATH_SPREAD * ph) + ph * 4.7);
      tc[o + 3] = -kq * c * 0.2 * t + ph * 3.1;
      tc[o + 4] = kq * 1.7 * c * 0.15 * t + ph * 5.3;
      tc[o + 5] = -k * c * t + ph;
    }
  }

  /**
   * Phase, envelope and (with `slope`) warp gradient of wave i at grid point
   * (x, z), at the time `refreshTime` was last given.
   * GLSL twin: `waveEval()` in GERSTNER_GLSL.
   */
  private evalWave(i: number, x: number, z: number, slope: boolean): void {
    const s = this.coef;
    const tc = this.timeCoef;
    const o = i * 20;
    const p = i * 8;
    const ev = this.ev;
    const g = s[o + 6];
    // slow breathing on the wave's own clock, and its strong and faint stretches of sea
    let env = tc[p + 2] * (1 + REGION * Math.sin(s[o + 15] * x + s[o + 16] * z + tc[p + 6]) * (0.6 + 0.4 * Math.sin(s[o + 17] * x + s[o + 18] * z + tc[p + 7])));
    if (g > 0) {
      // wave groups (sets) travelling at half the phase speed
      const e1 = Math.sin(s[o + 7] * x + s[o + 8] * z + tc[p]);
      // along-crest modulation: breaks long crests into short humps
      const e2 = Math.sin(s[o + 9] * x + s[o + 10] * z + tc[p + 1]);
      env *= (1 - g + g * 0.85 * (1 + e1)) * (1 + g * 0.7 * e2);
    }
    ev.env = env;
    const u1 = s[o + 11] * x + s[o + 12] * z + tc[p + 3];
    const u2 = s[o + 13] * x + s[o + 14] * z + tc[p + 4];
    const wp = this.warp;
    if (slope) {
      const c1 = Math.cos(u1) * wp;
      const c2 = Math.cos(u2) * wp;
      ev.wx = s[o + 11] * c1 + s[o + 13] * c2;
      ev.wz = s[o + 12] * c1 + s[o + 14] * c2;
    }
    ev.f = s[o] * x + s[o + 1] * z + tc[p + 5] + wp * (Math.sin(u1) + Math.sin(u2));
  }

  /**
   * Raw Gerstner displacement of the undisplaced grid point (x, z).
   * Writes into `out` (dx, dy, dz) and returns it.
   */
  displacement(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    this.refreshTime(this.time);
    const n = this.uniforms.uWaveCount.value;
    const s = this.coef;
    const ev = this.ev;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let i = 0; i < n; i++) {
      this.evalWave(i, x, z, false);
      const o = i * 20;
      const amp = s[o + 2] * ev.env;
      const cf = Math.cos(ev.f);
      ox += s[o + 3] * amp * cf;
      oy += amp * Math.sin(ev.f);
      oz += s[o + 4] * amp * cf;
    }
    out.set(ox, oy, oz);
    const sc = this.shore ? this.shore.waveScale(x, z) : 1;
    if (sc !== 1) out.multiplyScalar(sc);
    if (this.swellState.h > 0) {
      const h = this.swellAt(x, z) * sc;
      // the crest leans forward a little as it runs
      out.x += this.swellState.dx * h * 0.3;
      out.y += h;
      out.z += this.swellState.dz * h * 0.3;
    }
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
   * Height at (x, z) for a point that moves only a little between calls, such
   * as a buoyancy probe: `guess` keeps the sideways offset found last time, so
   * one refinement is enough instead of four (pass {x: NaN, z: NaN} at first).
   */
  heightNear(x: number, z: number, guess: { x: number; z: number }): number {
    if (Number.isNaN(guess.x)) {
      const h = this.heightAt(x, z);
      guess.x = _tmpD.x;
      guess.z = _tmpD.z;
      return h;
    }
    const d = _tmpD;
    this.displacement(x - guess.x, z - guess.z, d);
    this.displacement(x - d.x, z - d.z, d);
    guess.x = d.x;
    guess.z = d.z;
    return d.y;
  }

  /**
   * Analytic Gerstner normal at undisplaced grid point (x, z). The envelopes
   * and the shore scale vary slowly, so their own slopes are ignored.
   */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    this.refreshTime(this.time);
    let nx = 0;
    let ny = 1;
    let nz = 0;
    const n = this.uniforms.uWaveCount.value;
    const c = this.coef;
    const ev = this.ev;
    const s = this.shore ? this.shore.waveScale(x, z) : 1;
    for (let i = 0; i < n; i++) {
      this.evalWave(i, x, z, true);
      const o = i * 20;
      const amp = c[o + 2] * ev.env * s;
      const cf = Math.cos(ev.f);
      const sf = Math.sin(ev.f);
      nx -= (c[o] + ev.wx) * amp * cf;
      nz -= (c[o + 1] + ev.wz) * amp * cf;
      ny -= c[o + 5] * ev.env * s * sf;
    }
    if (this.swellState.h > 0) {
      this.swellAt(x, z, _slope);
      nx -= this.swellState.dx * _slope.v * s;
      nz -= this.swellState.dz * _slope.v * s;
    }
    return out.set(nx, ny, nz).normalize();
  }
}

const _slope = { v: 0 };

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

  uniform vec4 uSwellA;
  uniform vec4 uSwellB;
  // The lone travelling swell (tsunami): steep in front, long behind, tapering at its ends.
  // Adds its displacement; bends the normal and raises the foam envelope on the crest.
  vec3 swell(vec2 p, float scale, inout vec3 n, inout float env) {
    if (uSwellA.w <= 0.0) return vec3(0.0);
    vec2 dir = uSwellA.xy;
    float ds = dot(dir, p) - uSwellA.z;
    float w = ds > 0.0 ? uSwellB.w * 0.45 : uSwellB.w * 1.5;
    float prof = exp(-(ds * ds) / (w * w));
    float along = abs(dot(vec2(-dir.y, dir.x), p - uSwellB.xy));
    float m = 1.0 - smoothstep(uSwellB.z * 0.55, uSwellB.z, along);
    float h = uSwellA.w * prof * m * scale;
    float dh = h * (-2.0 * ds / (w * w));
    n = normalize(n / max(n.y, 0.2) - vec3(dir.x * dh, 0.0, dir.y * dh));
    env = max(env, 1.0 + prof * m * 1.6);
    return vec3(dir.x * h * 0.3, h, dir.y * h * 0.3);
  }

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
    env *= 1.0 + ${BREATH.toFixed(3)} * sin(uTime * (${BREATH_RATE.toFixed(4)} + ${BREATH_SPREAD.toFixed(4)} * ph) + ph * 4.7);
    vec2 r1 = vec2(cos(ph * 2.0 + 0.4), sin(ph * 2.0 + 0.4));
    vec2 r2 = vec2(cos(ph * 3.1 - 1.0), sin(ph * 3.1 - 1.0));
    env *= 1.0 + ${REGION.toFixed(3)} * sin(${REGION_K1.toFixed(6)} * dot(r1, p) + ph * 2.3 + uTime * 0.021) * (0.6 + 0.4 * sin(${REGION_K2.toFixed(6)} * dot(r2, p) + ph * 1.1 - uTime * 0.017));
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
