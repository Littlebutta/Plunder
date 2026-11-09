/**
 * Pure projectile simulation: no DOM, no Three.js scene. It runs inside the
 * projectile Web Worker, and on the main thread as a fallback if workers are
 * unavailable, so both paths behave identically.
 *
 * Data layout is struct-of-floats in one Float32Array so thousands of shells
 * cost almost nothing to step and can be handed back as a transferable buffer.
 */
import { WaveField, SeaState } from '../ocean/waves';
import { ShoreField, ShoreData } from '../ocean/shore';

export const GRAVITY = 9.81;
export const SIM_DT = 1 / 120;
export const MAX_PROJECTILES = 8192;

/** Per-projectile floats in the state buffer. */
export const STRIDE = 9; // x y z vx vy vz age kind owner
/** Per-projectile floats in the snapshot sent to the renderer. */
export const SNAP_STRIDE = 7; // x y z vx vy vz kind

/** Per-collider floats: x y z radius id */
export const COLLIDER_STRIDE = 5;

/** Per-event floats: type x y z kind colliderId */
export const EVENT_STRIDE = 7; // type x y z kind colliderId owner
export const EVENT_SPLASH = 1;
export const EVENT_HIT = 2;
/** Shell hit the ground (an island). */
export const EVENT_LAND = 3;

export interface ProjectileKind {
  /** Quadratic air-drag coefficient (1/m). */
  drag: number;
  /** Lifetime safety cap in seconds. */
  maxAge: number;
  /** Visual + collision radius (m). */
  radius: number;
}

/** Kinds are indexed by number so they pack into the float buffer. */
export const KINDS: ProjectileKind[] = [
  { drag: 0.0012, maxAge: 12, radius: 0.09 }, // 0: swivel ball
  { drag: 0.0006, maxAge: 15, radius: 0.16 }, // 1: cannon shell
];

export interface StepResult {
  snapshot: Float32Array;
  count: number;
  events: Float32Array;
  eventCount: number;
  stepMs: number;
}

export class ProjectileSim {
  private readonly state = new Float32Array(MAX_PROJECTILES * STRIDE);
  private count = 0;
  private readonly waves = new WaveField();
  private colliders: Float32Array = new Float32Array(0);
  private lastWaveTime: number | null = null;
  private colliderCount = 0;
  private events: number[] = [];
  private accumulator = 0;

  /** Terrain map: calms the sea near land and lets shells hit islands. */
  setShore(data: ShoreData): void {
    this.waves.shore = ShoreField.from(data);
  }

  setSeaState(sea: SeaState): void {
    this.waves.applySeaState(sea);
  }

  setColliders(data: Float32Array): void {
    this.colliders = data;
    this.colliderCount = Math.floor(data.length / COLLIDER_STRIDE);
  }

  /** spawns: packed [x y z vx vy vz kind owner] * n */
  spawn(spawns: Float32Array): void {
    for (let i = 0; i + 7 < spawns.length; i += 8) {
      if (this.count >= MAX_PROJECTILES) break;
      const o = this.count * STRIDE;
      this.state[o] = spawns[i];
      this.state[o + 1] = spawns[i + 1];
      this.state[o + 2] = spawns[i + 2];
      this.state[o + 3] = spawns[i + 3];
      this.state[o + 4] = spawns[i + 4];
      this.state[o + 5] = spawns[i + 5];
      this.state[o + 6] = 0;
      this.state[o + 7] = spawns[i + 6];
      this.state[o + 8] = spawns[i + 7];
      this.count++;
    }
  }

  /**
   * Advance by `dt` seconds of game time. `waveTimeEnd` is the wave clock at
   * the END of this interval; substeps interpolate toward it.
   */
  step(dt: number, waveTimeEnd: number): StepResult {
    const t0 = performance.now();
    this.events.length = 0;
    this.accumulator += Math.min(dt, 0.25);
    const steps = Math.floor(this.accumulator / SIM_DT);
    this.accumulator -= steps * SIM_DT;
    const waveStart = this.lastWaveTime ?? waveTimeEnd;
    for (let s = 0; s < steps; s++) {
      this.waves.setTime(waveStart + ((s + 1) / steps) * (waveTimeEnd - waveStart));
      this.substep(SIM_DT);
    }
    this.waves.setTime(waveTimeEnd);
    this.lastWaveTime = waveTimeEnd;

    const snapshot = new Float32Array(this.count * SNAP_STRIDE);
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const p = i * SNAP_STRIDE;
      snapshot[p] = this.state[o];
      snapshot[p + 1] = this.state[o + 1];
      snapshot[p + 2] = this.state[o + 2];
      snapshot[p + 3] = this.state[o + 3];
      snapshot[p + 4] = this.state[o + 4];
      snapshot[p + 5] = this.state[o + 5];
      snapshot[p + 6] = this.state[o + 7];
    }
    return {
      snapshot,
      count: this.count,
      events: Float32Array.from(this.events),
      eventCount: this.events.length / EVENT_STRIDE,
      stepMs: performance.now() - t0,
    };
  }

  get activeCount(): number {
    return this.count;
  }

  private substep(h: number): void {
    const st = this.state;
    const col = this.colliders;
    // Rough upper bound on wave height; skip water sampling above it.
    const waterCeiling = 6;
    let i = 0;
    while (i < this.count) {
      const o = i * STRIDE;
      const kind = KINDS[st[o + 7] | 0] ?? KINDS[0];
      const px = st[o];
      const py = st[o + 1];
      const pz = st[o + 2];
      let vx = st[o + 3];
      let vy = st[o + 4];
      let vz = st[o + 5];

      // Semi-implicit Euler: gravity + quadratic drag.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const k = kind.drag * speed;
      vx -= vx * k * h;
      vy -= (vy * k + GRAVITY) * h;
      vz -= vz * k * h;
      const nx = px + vx * h;
      const ny = py + vy * h;
      const nz = pz + vz * h;
      const age = st[o + 6] + h;

      let dead = age > kind.maxAge;

      // Colliders: swept segment vs sphere.
      if (!dead && this.colliderCount > 0) {
        const owner = st[o + 8];
        for (let c = 0; c < this.colliderCount; c++) {
          const co = c * COLLIDER_STRIDE;
          if (col[co + 4] === owner) continue;
          const r = col[co + 3] + kind.radius;
          // closest point on segment p->n to sphere centre
          const sx = nx - px;
          const sy = ny - py;
          const sz = nz - pz;
          const len2 = sx * sx + sy * sy + sz * sz || 1e-9;
          let t = ((col[co] - px) * sx + (col[co + 1] - py) * sy + (col[co + 2] - pz) * sz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px + sx * t - col[co];
          const dy = py + sy * t - col[co + 1];
          const dz = pz + sz * t - col[co + 2];
          if (dx * dx + dy * dy + dz * dz <= r * r) {
            this.events.push(EVENT_HIT, px + sx * t, py + sy * t, pz + sz * t, st[o + 7], col[co + 4], st[o + 8]);
            dead = true;
            break;
          }
        }
      }

      // Land impact (islands). Only the shell's end point is tested; at 120 Hz
      // that is at most ~0.6 m of travel, far finer than the terrain.
      const shore = this.waves.shore;
      if (!dead && shore) {
        const ground = shore.heightAt(nx, nz);
        if (ground > -0.3 && ny <= ground) {
          this.events.push(EVENT_LAND, nx, ground, nz, st[o + 7], -1, st[o + 8]);
          dead = true;
        }
      }

      // Water impact.
      if (!dead && ny < waterCeiling) {
        const water = this.waves.heightAt(nx, nz);
        if (ny <= water) {
          this.events.push(EVENT_SPLASH, nx, water, nz, st[o + 7], -1, st[o + 8]);
          dead = true;
        }
      }

      if (dead) {
        // swap-remove: move last projectile into this slot, don't advance i
        this.count--;
        if (i !== this.count) st.copyWithin(o, this.count * STRIDE, this.count * STRIDE + STRIDE);
        continue;
      }
      st[o] = nx;
      st[o + 1] = ny;
      st[o + 2] = nz;
      st[o + 3] = vx;
      st[o + 4] = vy;
      st[o + 5] = vz;
      st[o + 6] = age;
      i++;
    }
  }
}
