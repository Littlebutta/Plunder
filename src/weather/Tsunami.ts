import * as THREE from 'three';
import type { WaveField } from '../ocean/waves';
import { WORLD_RADIUS } from '../world/worldConfig';
import type { LurkerTarget } from './Lurkers';

/**
 * A tsunami: one huge swell that rolls across the map, wandering as it goes
 * (its heading drifts, and it turns back in from the edge of the world), and
 * dies away when the event ends. It is part of the sea itself (`setSwell` on
 * the wave field, which the shader and the buoyancy share), so ships really
 * climb it. A ship the breaking crest catches is carried along with it, takes
 * a beating, and may be rolled over.
 */
const LEVELS = [
  { height: 6, width: 26, half: 190, speed: 11, damage: 6 },
  { height: 9, width: 30, half: 260, speed: 13, damage: 10 },
  { height: 12, width: 36, half: 340, speed: 15, damage: 15 },
];

export interface TsunamiHooks {
  splash(at: THREE.Vector3, size: number): void;
}

export class Tsunami {
  /** 0..1 how strong it is (follows the event's weight). */
  presence = 0;
  level = 1;
  active = false;
  readonly centre = new THREE.Vector3();
  /** Unit heading. */
  readonly dir = new THREE.Vector3(1, 0, 0);
  private turn = 0;
  private turnIn = 0;
  private sprayIn = 0;
  /** Per ship: seconds before the crest can batter her again. */
  private readonly struck = new Map<THREE.Vector3, number>();

  constructor(
    private readonly waves: WaveField,
    private readonly hooks: TsunamiHooks,
  ) {}

  /** Rise somewhere out at sea, heading roughly across the map past `near`. */
  start(level: number, near: THREE.Vector3): void {
    this.level = level;
    this.active = true;
    // start well off, on the far side of the middle from the player, so it is seen coming
    const a = Math.random() * Math.PI * 2;
    const r = WORLD_RADIUS * 0.55;
    this.centre.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    const toward = new THREE.Vector3(near.x - this.centre.x, 0, near.z - this.centre.z);
    if (toward.lengthSq() < 1) toward.set(-this.centre.x, 0, -this.centre.z);
    toward.normalize().applyAxisAngle(_up, (Math.random() - 0.5) * 0.9);
    this.dir.copy(toward);
    this.turn = 0;
    this.turnIn = 0;
    this.struck.clear();
  }

  clear(): void {
    this.active = false;
    this.presence = 0;
    this.waves.setSwell(1, 0, 0, 0, 0, 1, 1);
  }

  get height(): number {
    return LEVELS[this.level - 1].height * this.presence;
  }

  update(dt: number, prey: LurkerTarget[]): void {
    if (!this.active) return;
    const L = LEVELS[this.level - 1];
    // wander: the heading drifts this way and that
    this.turnIn -= dt;
    if (this.turnIn <= 0) {
      this.turnIn = 6 + Math.random() * 8;
      this.turn = (Math.random() - 0.5) * 0.12;
    }
    let turn = this.turn;
    // nearing the rim: swing back toward the middle
    const r = Math.hypot(this.centre.x, this.centre.z);
    if (r > WORLD_RADIUS * 0.6) {
      const inward = Math.atan2(-this.centre.z, -this.centre.x);
      const heading = Math.atan2(this.dir.z, this.dir.x);
      let d = inward - heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 0.6) turn = Math.sign(d) * 0.22;
    }
    this.dir.applyAxisAngle(_up, -turn * dt).normalize();
    this.centre.addScaledVector(this.dir, L.speed * dt);
    const h = L.height * this.presence;
    this.waves.setSwell(this.dir.x, this.dir.z, this.centre.x, this.centre.z, h, L.half, L.width);

    // spray off the breaking crest, near the ships that can see it
    this.sprayIn -= dt;
    if (this.sprayIn <= 0 && h > 1) {
      this.sprayIn = 0.12;
      const along = (Math.random() - 0.5) * L.half * 1.1;
      const at = _a.set(this.centre.x - this.dir.z * along, 0, this.centre.z + this.dir.x * along);
      at.y = this.waves.heightAt(at.x, at.z);
      if (prey.some((p) => p.position.distanceToSquared(at) < 400 * 400)) this.hooks.splash(at, 1.6 + Math.random() * 1.4);
    }

    // ships on the face of the wave are swept along with it; the crest batters them once as it passes
    for (const [k, t] of this.struck) {
      if (t - dt <= 0) this.struck.delete(k);
      else this.struck.set(k, t - dt);
    }
    for (const p of prey) {
      const dx = p.position.x - this.centre.x;
      const dz = p.position.z - this.centre.z;
      const ahead = dx * this.dir.x + dz * this.dir.z;
      const side = Math.abs(-this.dir.z * dx + this.dir.x * dz);
      if (side > L.half || ahead > L.width * 0.8 || ahead < -L.width * 1.6) continue;
      const k = (1 - THREE.MathUtils.smoothstep(side, L.half * 0.55, L.half)) * this.presence;
      // carried along: pulled up to the wave's own speed
      const v = p.velocity;
      const along = v.x * this.dir.x + v.z * this.dir.z;
      const want = L.speed * 0.9 * k;
      if (along < want) {
        const add = Math.min(want - along, 9 * dt * k);
        v.x += this.dir.x * add;
        v.z += this.dir.z * add;
      }
      // the crest itself breaks over her
      if (Math.abs(ahead) < L.width * 0.35 && k > 0.4 && !this.struck.has(p.position)) {
        this.struck.set(p.position, 12);
        const shove = _s.copy(this.dir).multiplyScalar(4 * k).setY(3 * k);
        p.hit(L.damage * k, _a.copy(p.position).setY(p.position.y + 1.5), shove);
      }
    }
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _s = new THREE.Vector3();
