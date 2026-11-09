import * as THREE from 'three';
import ProjectileWorker from './projectile.worker.ts?worker&inline';
import {
  EVENT_HIT,
  EVENT_LAND,
  EVENT_STRIDE,
  GRAVITY,
  KINDS,
  MAX_PROJECTILES,
  ProjectileSim,
  SNAP_STRIDE,
  COLLIDER_STRIDE,
} from './ProjectileSim';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { WaveField } from '../ocean/waves';
import { toonMaterial } from '../render/toon';

export interface ImpactEvent {
  type: 'splash' | 'hit' | 'land';
  position: THREE.Vector3;
  kind: number;
  colliderId: number;
}

export interface Collider {
  id: number;
  position: THREE.Vector3;
  radius: number;
}

/**
 * Main-thread face of the projectile simulation.
 *
 * Simulation runs off-thread in a Web Worker (inlined as a blob so it also
 * works from file:// in a packaged desktop build). Each frame we send one
 * message with new spawns + colliders and receive the previous step's
 * snapshot, so the worker and the renderer overlap instead of waiting on each
 * other. Positions are extrapolated by their velocity to the current frame,
 * hiding the one-frame latency.
 *
 * If a worker can't be created, the same ProjectileSim runs inline.
 */
export class ProjectileSystem {
  readonly mesh: THREE.InstancedMesh;
  /** Called for every water splash / collider hit. */
  onImpact: ((e: ImpactEvent) => void) | null = null;

  /** Stats for the HUD / debug panel. */
  readonly stats = { active: 0, workerMs: 0, threaded: false };

  private worker: Worker | null = null;
  private fallback: ProjectileSim | null = null;
  private busy = false;
  private frame = 0;
  private pendingSpawns: number[] = [];
  private pendingDt = 0;
  private seaDirty = true;
  private shoreDirty = true;
  private colliders: Collider[] = [];

  private snapshot: Float32Array = new Float32Array(0);
  private snapCount = 0;
  private snapAge = 0;

  private readonly dummy = new THREE.Object3D();

  constructor(private readonly waves: WaveField) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geo, toonMaterial(0x2b2b30), MAX_PROJECTILES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'projectiles';

    try {
      this.worker = new ProjectileWorker();
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
      this.worker.onerror = (err) => {
        console.warn('Projectile worker failed, falling back to main thread', err);
        this.worker?.terminate();
        this.worker = null;
        this.busy = false;
        this.fallback = new ProjectileSim();
        this.seaDirty = true;
        this.shoreDirty = true;
      };
      this.stats.threaded = true;
    } catch (err) {
      console.warn('Web Workers unavailable, simulating projectiles on the main thread', err);
      this.fallback = new ProjectileSim();
    }
  }

  /** Mark the sea state as changed (e.g. after editing waves in the debug panel). */
  markSeaDirty(): void {
    this.seaDirty = true;
  }

  setColliders(colliders: Collider[]): void {
    this.colliders = colliders;
  }

  spawn(position: THREE.Vector3, velocity: THREE.Vector3, kind = 0, owner = -1): void {
    this.pendingSpawns.push(position.x, position.y, position.z, velocity.x, velocity.y, velocity.z, kind, owner);
  }

  update(dt: number): void {
    this.pendingDt += dt;
    this.snapAge += dt;

    if (!this.busy) {
      const req: WorkerRequest = {
        frame: this.frame++,
        dt: this.pendingDt,
        waveTime: this.waves.currentTime,
        spawns: this.pendingSpawns.length ? Float32Array.from(this.pendingSpawns) : undefined,
        colliders: this.packColliders(),
        sea: this.seaDirty ? this.waves.serialize() : undefined,
        shore: this.shoreDirty && this.waves.shore ? { size: this.waves.shore.size, extent: this.waves.shore.extent, heights: this.waves.shore.heights } : undefined,
      };
      this.shoreDirty = false;
      this.pendingSpawns.length = 0;
      this.pendingDt = 0;
      this.seaDirty = false;

      if (this.worker) {
        this.busy = true;
        const transfer: Transferable[] = [];
        if (req.spawns) transfer.push(req.spawns.buffer);
        if (req.colliders) transfer.push(req.colliders.buffer);
        this.worker.postMessage(req, transfer);
      } else if (this.fallback) {
        const sim = this.fallback;
        if (req.shore) sim.setShore(req.shore);
        if (req.sea) sim.setSeaState(req.sea);
        if (req.colliders) sim.setColliders(req.colliders);
        if (req.spawns) sim.spawn(req.spawns);
        this.receive({ ...sim.step(req.dt, req.waveTime), frame: req.frame });
      }
    }

    this.render();
  }

  private packColliders(): Float32Array {
    const out = new Float32Array(this.colliders.length * COLLIDER_STRIDE);
    this.colliders.forEach((c, i) => {
      const o = i * COLLIDER_STRIDE;
      out[o] = c.position.x;
      out[o + 1] = c.position.y;
      out[o + 2] = c.position.z;
      out[o + 3] = c.radius;
      out[o + 4] = c.id;
    });
    return out;
  }

  private receive(res: WorkerResponse): void {
    this.busy = false;
    this.snapshot = res.snapshot;
    this.snapCount = res.count;
    this.snapAge = 0;
    this.stats.active = res.count;
    this.stats.workerMs = res.stepMs;

    if (this.onImpact) {
      for (let i = 0; i < res.eventCount; i++) {
        const o = i * EVENT_STRIDE;
        const type = res.events[o];
        this.onImpact({
          type: type === EVENT_HIT ? 'hit' : type === EVENT_LAND ? 'land' : 'splash',
          position: new THREE.Vector3(res.events[o + 1], res.events[o + 2], res.events[o + 3]),
          kind: res.events[o + 4],
          colliderId: res.events[o + 5],
        });
      }
    }
  }

  private render(): void {
    const s = this.snapshot;
    const t = Math.min(this.snapAge, 0.1);
    const d = this.dummy;
    for (let i = 0; i < this.snapCount; i++) {
      const o = i * SNAP_STRIDE;
      const kind = KINDS[s[o + 6] | 0] ?? KINDS[0];
      d.position.set(s[o] + s[o + 3] * t, s[o + 1] + s[o + 4] * t - 0.5 * GRAVITY * t * t, s[o + 2] + s[o + 5] * t);
      d.scale.setScalar(kind.radius * 1.4);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.count = this.snapCount;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
