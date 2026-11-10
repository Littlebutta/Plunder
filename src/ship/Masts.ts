import * as THREE from 'three';
import type { Collider } from '../combat/ProjectileSystem';
import type { MastVisual } from './ShipVisual';

export const MAST = {
  hp: 40,
  /** Damage per hit by projectile kind: swivel shot, cannon shell. */
  damage: [9, 21],
  /** Seconds after the last hit before the crew start on repairs, and hit points a second once they do. */
  repairDelay: 10,
  repairRate: 2.5,
  /** Wood to step a new mast in place of one that went over the side. */
  woodCost: 3,
  /** Share of her drive a ship keeps with every mast down. */
  jury: 0.3,
  /** Chance that a shell striking the hull also carries away rigging on the nearest mast. */
  hullHitChance: 0.3,
};

/** Collider ids for mast hitboxes: MAST_ID_BASE + ship id * 16 + mast * 2 + part. */
export const MAST_ID_BASE = 2000;
export const MAST_ID_END = MAST_ID_BASE + 16 * 2048;

export function mastOwner(colliderId: number): { ship: number; mast: number } | null {
  if (colliderId < MAST_ID_BASE || colliderId >= MAST_ID_END) return null;
  const n = colliderId - MAST_ID_BASE;
  return { ship: Math.floor(n / 16), mast: Math.floor((n % 16) / 2) };
}

interface MastState {
  visual: MastVisual;
  hp: number;
  down: boolean;
  /** 0 standing .. 1 lying over the side. */
  fall: number;
  fallSpeed: number;
  side: number;
  /** Share of the ship's sail this mast carries. */
  weight: number;
  /** The wood for a replacement has been paid. */
  paid: boolean;
  colliders: Collider[];
}

/**
 * The state of a ship's masts: each can be shot away, topples over the side,
 * and is stepped again by the crew once the shooting stops. A ship with masts
 * down sails slower.
 */
export class MastRig {
  private readonly masts: MastState[];
  private sinceHit = 99;
  /** Called when a mast goes by the board / is standing again. */
  onFall: ((index: number, top: THREE.Vector3) => void) | null = null;
  onRaised: ((index: number) => void) | null = null;

  constructor(visuals: MastVisual[], weights: number[], shipId: number) {
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    this.masts = visuals.slice(0, 8).map((visual, i) => ({
      visual,
      hp: MAST.hp,
      down: false,
      fall: 0,
      fallSpeed: 0,
      side: i % 2 ? -1 : 1,
      weight: (weights[i] ?? 1) / total,
      paid: false,
      colliders: [0.55, 0.85].map((f, part) => ({ id: MAST_ID_BASE + shipId * 16 + i * 2 + part, position: new THREE.Vector3(0, 1e5, 0), radius: 0.75 + f * 0.2 })),
    }));
  }

  get count(): number {
    return this.masts.length;
  }

  get standing(): number {
    return this.masts.filter((m) => !m.down).length;
  }

  isDown(i: number): boolean {
    return this.masts[i]?.down ?? true;
  }

  health(i: number): number {
    return (this.masts[i]?.hp ?? 0) / MAST.hp;
  }

  /** 1 with every mast standing, down to MAST.jury with none. */
  get drive(): number {
    if (this.masts.length === 0) return 1;
    const up = this.masts.reduce((n, m) => n + (m.down ? 0 : m.weight), 0);
    return MAST.jury + (1 - MAST.jury) * up;
  }

  /** Hitboxes of the masts still standing. */
  colliders(out: Collider[] = []): Collider[] {
    for (const m of this.masts) if (!m.down) out.push(...m.colliders);
    return out;
  }

  /** The standing mast nearest a point along the hull (ship-space z), or -1. */
  nearest(localZ: number): number {
    let best = -1;
    let bestD = Infinity;
    this.masts.forEach((m, i) => {
      const d = Math.abs(m.visual.foot.z - localZ);
      if (!m.down && d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** A shot of `kind` struck mast `i`. Returns true if that brought it down. */
  hit(i: number, kind: number, side = 0): boolean {
    const m = this.masts[i];
    if (!m || m.down) return false;
    this.sinceHit = 0;
    m.hp -= MAST.damage[kind] ?? MAST.damage[0];
    if (m.hp > 0) return false;
    m.hp = 0;
    m.down = true;
    m.paid = false;
    m.fallSpeed = 0.25;
    if (side) m.side = Math.sign(side);
    _top.set(0, m.visual.height * 0.7, 0).add(m.visual.foot);
    this.onFall?.(i, m.visual.group.parent ? m.visual.group.parent.localToWorld(_top) : _top);
    return true;
  }

  /** Online: make mast `i` match what its owner's copy of the game says. */
  setDown(i: number, down: boolean): void {
    const m = this.masts[i];
    if (!m || m.down === down) return;
    if (!down) {
      m.hp = MAST.hp;
      m.down = false;
      return;
    }
    m.hp = 0;
    m.down = true;
    m.paid = false;
    m.fallSpeed = 0.25;
    _top.set(0, m.visual.height * 0.7, 0).add(m.visual.foot);
    this.onFall?.(i, m.visual.group.parent ? m.visual.group.parent.localToWorld(_top) : _top);
  }

  /** Which masts are down, as a bit mask. */
  get downMask(): number {
    return this.masts.reduce((n, m, i) => n | (m.down ? 1 << i : 0), 0);
  }

  /** Stand everything back up, good as new (a new ship, or a respawn). */
  restore(): void {
    for (const m of this.masts) {
      m.hp = MAST.hp;
      m.down = false;
      m.fall = 0;
      m.visual.group.rotation.set(0, 0, 0);
      m.visual.group.position.copy(m.visual.foot);
    }
  }

  /**
   * @param spend asked once per fallen mast for the wood to replace it; return false to wait
   * @param position @param quaternion the ship's pose, to place the hitboxes
   */
  update(dt: number, position: THREE.Vector3, quaternion: THREE.Quaternion, spend: ((wood: number) => boolean) | null): void {
    this.sinceHit += dt;
    const mending = this.sinceHit > MAST.repairDelay;
    this.masts.forEach((m, i) => {
      if (mending && m.hp < MAST.hp) {
        if (m.down && !m.paid) m.paid = spend ? spend(MAST.woodCost) : true;
        if (!m.down || m.paid) m.hp = Math.min(MAST.hp, m.hp + MAST.repairRate * dt);
        if (m.down && m.hp >= MAST.hp) {
          m.down = false;
          this.onRaised?.(i);
        }
      }
      // topple, or be hauled upright again
      if (m.down && m.fall < 1) {
        m.fallSpeed += dt * 2.2;
        m.fall = Math.min(1, m.fall + m.fallSpeed * dt);
      } else if (!m.down && m.fall > 0) {
        m.fall = Math.max(0, m.fall - dt * 0.6);
        m.fallSpeed = 0;
      }
      const g = m.visual.group;
      const k = m.fall * m.fall * (3 - 2 * m.fall);
      g.rotation.z = -m.side * k * 1.62;
      g.rotation.x = k * 0.22 * (i % 2 ? 1 : -1);
      g.position.y = m.visual.foot.y + k * 0.25;
      m.colliders.forEach((c, part) => {
        c.position.set(0, m.visual.foot.y + m.visual.height * (part ? 0.85 : 0.55), m.visual.foot.z).applyQuaternion(quaternion).add(position);
      });
    });
  }
}

const _top = new THREE.Vector3();
