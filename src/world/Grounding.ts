import * as THREE from 'three';
import type { Island } from './Islands';

/**
 * Islands are solid. A hull that runs onto a beach is pushed back off it and
 * loses the speed it carried into the shore; rocks out in the sea (sea stacks
 * and reefs) do the same but also stove in the hull, harder the faster she hit.
 */
export const GROUNDING = {
  /** How far the hull may reach past the waterline, as a share of her collider radius. */
  overlap: 0.45,
  /** Speed into a rock (m/s) that does no harm; above it each m/s costs this much hull. */
  safeSpeed: 1.2,
  damagePerSpeed: 4,
  /** Most a single knock can take off. */
  maxKnock: 25,
  /** Seconds before the same hull can be hurt by rocks again. */
  knockCooldown: 0.8,
};

const _n = new THREE.Vector3();

/**
 * Keep a hull out of the land and off the rocks.
 * @returns hull damage from striking a rock this step (0 for a beach or a gentle touch)
 */
export function ground(position: THREE.Vector3, velocity: THREE.Vector3, radius: number, islands: Island[]): number {
  let knock = 0;
  for (const island of islands) {
    const dx = position.x - island.center.x;
    const dz = position.z - island.center.z;
    const d = Math.hypot(dx, dz);
    if (d > island.radius * 1.7 + radius + 20) continue;
    // the beach
    if (d > 1e-3) {
      const edge = island.shoreAt(Math.atan2(dz, dx)) + radius * GROUNDING.overlap;
      if (d < edge) {
        _n.set(dx / d, 0, dz / d);
        push(position, velocity, _n, edge - d);
      }
    }
    // rocks
    for (const r of island.rocks) {
      const rx = position.x - (island.center.x + r.x);
      const rz = position.z - (island.center.z + r.z);
      const rd = Math.hypot(rx, rz);
      const lim = r.r + radius * 0.6;
      if (rd >= lim || rd < 1e-3) continue;
      _n.set(rx / rd, 0, rz / rd);
      const into = -velocity.dot(_n);
      push(position, velocity, _n, lim - rd);
      if (into > GROUNDING.safeSpeed) knock = Math.max(knock, Math.min(GROUNDING.maxKnock, (into - GROUNDING.safeSpeed) * GROUNDING.damagePerSpeed));
    }
  }
  return knock;
}

/** Move out along `n` by `depth` and take away the speed going into the obstacle (with a little bounce). */
function push(position: THREE.Vector3, velocity: THREE.Vector3, n: THREE.Vector3, depth: number): void {
  position.x += n.x * depth;
  position.z += n.z * depth;
  const vn = velocity.x * n.x + velocity.z * n.z;
  if (vn < 0) {
    velocity.x -= n.x * vn * 1.25;
    velocity.z -= n.z * vn * 1.25;
    // grinding along the shore slows her
    velocity.x *= 0.97;
    velocity.z *= 0.97;
  }
}

/** Per-hull cooldown so one grounding is one knock, not one per frame. */
export class KnockTimer {
  private readonly last = new Map<number, number>();
  /** True if this hull may take a knock now (and starts its cooldown). */
  ready(id: number, now: number): boolean {
    const t = this.last.get(id) ?? -Infinity;
    if (now - t < GROUNDING.knockCooldown) return false;
    this.last.set(id, now);
    return true;
  }
}

/**
 * Steering help: add a push away from any rock close ahead to `want` (a flat
 * direction, not yet normalised). Rocks behind the ship are ignored.
 */
export function shunRocks(pos: THREE.Vector3, fwd: THREE.Vector3, want: THREE.Vector3, islands: Island[], margin = 16): void {
  for (const island of islands) {
    const cx = pos.x - island.center.x;
    const cz = pos.z - island.center.z;
    if (cx * cx + cz * cz > (island.radius * 2.2 + 40) ** 2) continue;
    for (const r of island.rocks) {
      const dx = pos.x - (island.center.x + r.x);
      const dz = pos.z - (island.center.z + r.z);
      const d = Math.hypot(dx, dz) || 1;
      const reach = r.r + margin;
      if (d > reach * 2) continue;
      // only rocks ahead or abeam matter
      if (-(dx * fwd.x + dz * fwd.z) / d < -0.3) continue;
      const k = Math.max(0, (reach * 2 - d) / reach) * 2;
      want.x += (dx / d) * k;
      want.z += (dz / d) * k;
    }
  }
}
