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
 * - every wave's height is modulated by a slow "wave group" envelope that
 *   travels at half the wave's speed (like real deep-water groups), so sets
 *   of bigger waves roll through and the sea changes from place to place.
 *
 * If you change the math here, change `GERSTNER_GLSL` below to match.
 */
import * as THREE from 'three';

export const MAX_WAVES = 12;
const GRAVITY = 9.81;
/** Group envelope is this many wavelengths long. */
const GROUP_LENGTH = 7;
/** Group envelope travels at this angle off the wave direction (radians). */
const GROUP_SKEW = 0.44;
const COS_SKEW = Math.cos(GROUP_SKEW);
const SIN_SKEW = Math.sin(GROUP_SKEW);

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
  // long swell
  { direction: 15, wavelength: 72, steepness: 0.16, phase: 0.0, grouping: 0.55 },
  { direction: 35, wavelength: 50, steepness: 0.13, phase: 2.1, grouping: 0.5 },
  { direction: -8, wavelength: 38, steepness: 0.11, phase: 4.3, grouping: 0.5 },
  // cross swell
  { direction: 112, wavelength: 30, steepness: 0.08, phase: 1.3, grouping: 0.4 },
  { direction: 135, wavelength: 19, steepness: 0.06, phase: 5.2, grouping: 0.35 },
  // wind chop
  { direction: 60, wavelength: 12, steepness: 0.07, phase: 0.7, grouping: 0.3 },
  { direction: -40, wavelength: 9, steepness: 0.06, phase: 3.6, grouping: 0.3 },
  { direction: 170, wavelength: 7, steepness: 0.05, phase: 2.8, grouping: 0.25 },
  { direction: 85, wavelength: 5.5, steepness: 0.04, phase: 4.9, grouping: 0.2 },
  { direction: 20, wavelength: 4, steepness: 0.035, phase: 1.9, grouping: 0.2 },
];

export interface SeaState {
  waves: WaveParams[];
  intensity: number;
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

  readonly uniforms = {
    uTime: { value: 0 },
    // xy = direction, z = k (wave number), w = base amplitude
    uWaveA: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    // x = phase speed c, y = steepness (Q), z = phase, w = grouping depth
    uWaveB: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    uWaveCount: { value: 0 },
  };

  private time = 0;

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
    return { waves: this.waves.map((w) => ({ ...w })), intensity: this.intensity };
  }

  applySeaState(state: SeaState): void {
    this.waves = state.waves.map((w) => ({ ...w }));
    this.intensity = state.intensity;
    this.syncUniforms();
  }

  syncUniforms(): void {
    const n = Math.min(this.waves.length, MAX_WAVES);
    this.uniforms.uWaveCount.value = n;
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
   * Group envelope (0..1+) for wave i at grid point (x, z): a long, slow,
   * slightly skewed sine travelling at half the wave's phase speed.
   */
  private envelope(i: number, x: number, z: number, t: number): number {
    const a = this.uniforms.uWaveA.value[i];
    const b = this.uniforms.uWaveB.value[i];
    if (b.w <= 0) return 1;
    const gx = a.x * COS_SKEW - a.y * SIN_SKEW;
    const gz = a.x * SIN_SKEW + a.y * COS_SKEW;
    const gk = a.z / GROUP_LENGTH;
    const g = Math.sin(gk * (gx * x + gz * z - b.x * 0.5 * t) + b.z * 1.7);
    return 1 - b.w + b.w * (0.5 + 0.5 * g) * 2 * 0.85;
  }

  /**
   * Raw Gerstner displacement of the undisplaced grid point (x, z).
   * Writes into `out` (dx, dy, dz) and returns it.
   */
  displacement(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    const t = this.time;
    const n = this.uniforms.uWaveCount.value;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      const f = a.z * (a.x * x + a.y * z - b.x * t) + b.z;
      const amp = a.w * this.envelope(i, x, z, t);
      const cf = Math.cos(f);
      out.x += a.x * amp * cf;
      out.y += amp * Math.sin(f);
      out.z += a.y * amp * cf;
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
   * Analytic Gerstner normal at undisplaced grid point (x, z). The group
   * envelope varies slowly, so its own slope is ignored.
   */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    const t = this.time;
    const n = this.uniforms.uWaveCount.value;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      const env = this.envelope(i, x, z, t);
      const f = a.z * (a.x * x + a.y * z - b.x * t) + b.z;
      const wa = a.z * a.w * env; // k * amplitude == steepness
      const cf = Math.cos(f);
      const sf = Math.sin(f);
      nx -= a.x * wa * cf;
      nz -= a.y * wa * cf;
      ny -= b.y * env * sf;
    }
    return out.set(nx, ny, nz).normalize();
  }
}

const _tmpD = new THREE.Vector3();

/** GLSL twin of `WaveField.displacement()` / `normalAt()`. */
export const GERSTNER_GLSL = /* glsl */ `
  #define MAX_WAVES ${MAX_WAVES}
  uniform float uTime;
  uniform vec4 uWaveA[MAX_WAVES];
  uniform vec4 uWaveB[MAX_WAVES];
  uniform int uWaveCount;

  float waveEnvelope(vec4 a, vec4 b, vec2 p) {
    if (b.w <= 0.0) return 1.0;
    vec2 g = vec2(a.x * ${COS_SKEW.toFixed(6)} - a.y * ${SIN_SKEW.toFixed(6)}, a.x * ${SIN_SKEW.toFixed(6)} + a.y * ${COS_SKEW.toFixed(6)});
    float gk = a.z / ${GROUP_LENGTH.toFixed(1)};
    float s = sin(gk * (dot(g, p) - b.x * 0.5 * uTime) + b.z * 1.7);
    return 1.0 - b.w + b.w * (0.5 + 0.5 * s) * 2.0 * 0.85;
  }

  // Returns displaced offset; writes analytic normal and the average group
  // envelope (useful for foam: big sets get whitecaps, lulls stay clean).
  vec3 gerstner(vec2 p, float fade, out vec3 normal, out float envOut) {
    vec3 d = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    float envSum = 0.0;
    float envW = 0.0;
    for (int i = 0; i < MAX_WAVES; i++) {
      if (i >= uWaveCount) break;
      vec4 a = uWaveA[i];
      vec4 b = uWaveB[i];
      float env = waveEnvelope(a, b, p);
      float f = a.z * (dot(a.xy, p) - b.x * uTime) + b.z;
      float amp = a.w * fade * env;
      float cf = cos(f);
      float sf = sin(f);
      d.x += a.x * amp * cf;
      d.y += amp * sf;
      d.z += a.y * amp * cf;
      float wa = a.z * amp;
      n.x -= a.x * wa * cf;
      n.z -= a.y * wa * cf;
      n.y -= b.y * fade * env * sf;
      envSum += env * a.w;
      envW += a.w;
    }
    normal = normalize(n);
    envOut = envW > 0.0 ? envSum / envW : 1.0;
    return d;
  }
`;
