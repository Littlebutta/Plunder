import * as THREE from 'three';
import type { Island } from './Islands';
import { EDGE_MARGIN, WORLD_RADIUS } from './worldConfig';

const _want = new THREE.Vector3();

/**
 * Rudder input (-1..1) that takes a ship toward `dest` while keeping it off
 * the islands and away from the edge of the world.
 * @param fwd the ship's heading (unit, flat)
 */
export function steerToward(pos: THREE.Vector3, fwd: THREE.Vector3, dest: THREE.Vector3, islands: Island[]): number {
  const want = _want.set(dest.x - pos.x, 0, dest.z - pos.z).normalize();
  for (const island of islands) {
    const dx = pos.x - island.center.x;
    const dz = pos.z - island.center.z;
    const d = Math.hypot(dx, dz) || 1;
    const clear = d - island.radius;
    // islands that hold the destination (a port, a beach) are approached, not shunned
    const destClear = Math.hypot(dest.x - island.center.x, dest.z - island.center.z) - island.radius;
    const keep = destClear < 45 ? 12 : 60;
    if (clear < keep) {
      const k = ((keep - clear) / keep) * 3;
      want.x += (dx / d) * k;
      want.z += (dz / d) * k;
    }
  }
  const r = Math.hypot(pos.x, pos.z);
  if (r > WORLD_RADIUS - EDGE_MARGIN * 1.5) {
    const k = ((r - (WORLD_RADIUS - EDGE_MARGIN * 1.5)) / EDGE_MARGIN) * 3;
    want.x -= (pos.x / r) * k;
    want.z -= (pos.z / r) * k;
  }
  want.normalize();
  const turn = fwd.x * want.z - fwd.z * want.x;
  return fwd.dot(want) < -0.2 ? Math.sign(turn || 1) : THREE.MathUtils.clamp(turn * 2.5, -1, 1);
}

/**
 * The current at the world's edge: pushes a body back toward the middle,
 * harder the closer it gets, and never lets it over the rim.
 * Returns 0..1: how deep into the current the body is (for a warning).
 */
export function edgeCurrent(position: THREE.Vector3, velocity: THREE.Vector3, dt: number): number {
  const r = Math.hypot(position.x, position.z);
  const into = (r - (WORLD_RADIUS - EDGE_MARGIN)) / EDGE_MARGIN;
  if (into <= 0) return 0;
  const nx = position.x / r;
  const nz = position.z / r;
  // take away outward speed and add an inward shove
  const out = velocity.x * nx + velocity.z * nz;
  const push = into * into * 14 * dt + Math.max(0, out) * Math.min(1, into * 4 * dt + (into > 0.8 ? 1 : 0));
  velocity.x -= nx * push;
  velocity.z -= nz * push;
  const limit = WORLD_RADIUS - 12;
  if (r > limit) {
    position.x = nx * limit;
    position.z = nz * limit;
  }
  return Math.min(1, into);
}
