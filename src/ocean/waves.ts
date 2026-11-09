/**
 * Gerstner wave model shared by the GPU (vertex shader) and the CPU (physics).
 *
 * The SAME parameters drive both sides: the shader receives them as uniforms
 * and `WaveField.sample()` evaluates identical math in TypeScript, so a ship
 * floating on the CPU-side surface sits exactly on the rendered water.
 *
 * If you change the math here, change `GERSTNER_GLSL` below to match.
 */
import * as THREE from 'three';

export const MAX_WAVES = 6;
const GRAVITY = 9.81;

export interface WaveParams {
  /** Direction of travel in degrees (0 = +X, 90 = +Z). */
  direction: number;
  /** Crest-to-crest distance in metres. */
  wavelength: number;
  /** 0..1. Sum of all steepness values should stay below ~1 to avoid loops. */
  steepness: number;
}

export const DEFAULT_WAVES: WaveParams[] = [
  { direction: 20, wavelength: 60, steepness: 0.22 },
  { direction: 55, wavelength: 34, steepness: 0.18 },
  { direction: -15, wavelength: 21, steepness: 0.14 },
  { direction: 95, wavelength: 13, steepness: 0.1 },
  { direction: 160, wavelength: 8, steepness: 0.07 },
  { direction: 5, wavelength: 5, steepness: 0.05 },
];

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
    // xy = direction, z = k (wave number), w = amplitude
    uWaveA: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
    // x = phase speed c, y = steepness (Q), z/w unused
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
      b.set(c, q, 0, 0);
    }
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
      const f = a.z * (a.x * x + a.y * z - b.x * t);
      const amp = a.w;
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
    return this.sample(x, z, _tmpSample).height;
  }

  /** Analytic Gerstner normal at undisplaced grid point (x, z). */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    const t = this.time;
    const n = this.uniforms.uWaveCount.value;
    for (let i = 0; i < n; i++) {
      const a = this.uniforms.uWaveA.value[i];
      const b = this.uniforms.uWaveB.value[i];
      const f = a.z * (a.x * x + a.y * z - b.x * t);
      const wa = a.z * a.w; // k * amplitude == steepness
      const cf = Math.cos(f);
      const sf = Math.sin(f);
      nx -= a.x * wa * cf;
      nz -= a.y * wa * cf;
      ny -= b.y * sf;
    }
    return out.set(nx, ny, nz).normalize();
  }
}

const _tmpD = new THREE.Vector3();
const _tmpSample: WaveSample = { height: 0, normal: new THREE.Vector3() };

/** GLSL twin of `WaveField.displacement()` / `normalAt()`. */
export const GERSTNER_GLSL = /* glsl */ `
  #define MAX_WAVES ${MAX_WAVES}
  uniform float uTime;
  uniform vec4 uWaveA[MAX_WAVES];
  uniform vec4 uWaveB[MAX_WAVES];
  uniform int uWaveCount;

  // Returns displaced offset; writes analytic normal.
  vec3 gerstner(vec2 p, float fade, out vec3 normal) {
    vec3 d = vec3(0.0);
    vec3 n = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < MAX_WAVES; i++) {
      if (i >= uWaveCount) break;
      vec4 a = uWaveA[i];
      vec4 b = uWaveB[i];
      float f = a.z * (dot(a.xy, p) - b.x * uTime);
      float amp = a.w * fade;
      float cf = cos(f);
      float sf = sin(f);
      d.x += a.x * amp * cf;
      d.y += amp * sf;
      d.z += a.y * amp * cf;
      float wa = a.z * amp;
      n.x -= a.x * wa * cf;
      n.z -= a.y * wa * cf;
      n.y -= b.y * fade * sf;
    }
    normal = normalize(n);
    return d;
  }
`;
