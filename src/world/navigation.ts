import * as THREE from 'three';
import type { Island } from './Islands';
import { EDGE_MARGIN, WORLD_RADIUS } from './worldConfig';
import { shunRocks } from './Grounding';

const _want = new THREE.Vector3();
const _via = new THREE.Vector3();

/** How far out from an island's centre a ship must keep: the coast, its reefs and stacks, and a margin. */
const reachCache = new WeakMap<Island, number>();
export function islandReach(island: Island): number {
  let r = reachCache.get(island);
  if (r === undefined) {
    r = island.radius;
    for (const rock of island.rocks) r = Math.max(r, Math.hypot(rock.x, rock.z) + rock.r);
    reachCache.set(island, r);
  }
  return r;
}

/**
 * Where to head first on the way from `pos` to `dest`: `dest` itself when the
 * way is clear, else a point beside the first island in the way, on the side
 * that makes the shorter trip round it. Islands that hold the destination (a
 * port, a beach to build on) are not in the way. Writes to `out`.
 */
export function routeVia(pos: THREE.Vector3, dest: THREE.Vector3, islands: Island[], out: THREE.Vector3, margin = 26): THREE.Vector3 {
  out.set(dest.x, 0, dest.z);
  const dx = dest.x - pos.x;
  const dz = dest.z - pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1) return out;
  const ux = dx / len;
  const uz = dz / len;
  let first: Island | null = null;
  let firstT = Infinity;
  let firstR = 0;
  for (const island of islands) {
    const r = islandReach(island) + margin;
    // the island the destination lies by is where we are going, not something to go round
    if (Math.hypot(dest.x - island.center.x, dest.z - island.center.z) < r + 10) continue;
    const cx = island.center.x - pos.x;
    const cz = island.center.z - pos.z;
    const t = cx * ux + cz * uz; // along the line
    if (t < -r || t > len + r * 0.5) continue;
    const side = Math.abs(cx * uz - cz * ux); // off the line
    if (side >= r) continue;
    // already inside its margin (rounding it): the steering's shove handles that
    if (Math.hypot(cx, cz) < r * 0.85) continue;
    if (t < firstT) {
      firstT = t;
      first = island;
      firstR = r;
    }
  }
  if (!first) return out;
  // pass on the side of the island that the line already leans toward
  const cx = first.center.x - pos.x;
  const cz = first.center.z - pos.z;
  // (px, pz) is square to the line and points away from the island's centre
  const cross = cx * uz - cz * ux;
  const px = -uz * Math.sign(cross || 1);
  const pz = ux * Math.sign(cross || 1);
  // a point abeam of the island, a little past its middle so she keeps clear on the way round
  out.set(first.center.x + px * firstR * 1.1 + ux * firstR * 0.25, 0, first.center.z + pz * firstR * 1.1 + uz * firstR * 0.25);
  return out;
}

/**
 * Rudder (-1..1) to bring a ship's head round to `want`, eased off as she
 * starts to swing so she does not overshoot and weave: the cause of ships
 * snaking about under orders.
 * @param yawRate the hull's turn rate (body angular velocity y, rad/s)
 */
export function helm(fwd: THREE.Vector3, want: THREE.Vector3, yawRate: number): number {
  const cross = fwd.x * want.z - fwd.z * want.x;
  const dot = fwd.x * want.x + fwd.z * want.z;
  const angle = Math.atan2(cross, dot); // + = turn to starboard
  if (Math.abs(angle) > 2.2) return Math.sign(angle); // well off: hard over
  // a positive rudder yaws her negatively about y; lead the swing by about 0.9 s
  return THREE.MathUtils.clamp(angle * 1.7 + yawRate * 1.5, -1, 1);
}

/** Stay this far off a coast (beyond its reefs) unless the destination is there. */
const COAST_KEEP = 16;

/**
 * Rudder input (-1..1) that takes a ship toward `dest` while keeping it off
 * the islands and away from the edge of the world.
 * @param fwd the ship's heading (unit, flat)
 */
export function steerToward(pos: THREE.Vector3, fwd: THREE.Vector3, dest: THREE.Vector3, islands: Island[], yawRate = 0): number {
  const to = routeVia(pos, dest, islands, _via);
  const want = _want.set(to.x - pos.x, 0, to.z - pos.z).normalize();
  for (const island of islands) {
    const dx = pos.x - island.center.x;
    const dz = pos.z - island.center.z;
    const d = Math.hypot(dx, dz) || 1;
    const clear = d - islandReach(island);
    // islands that hold the destination (a port, a beach) are approached, not shunned
    const destClear = Math.hypot(dest.x - island.center.x, dest.z - island.center.z) - island.radius;
    const keep = destClear < 45 ? 6 : COAST_KEEP;
    if (clear < keep) {
      const k = ((keep - clear) / keep) * 2;
      want.x += (dx / d) * k;
      want.z += (dz / d) * k;
    }
  }
  shunRocks(pos, fwd, want, islands);
  const r = Math.hypot(pos.x, pos.z);
  if (r > WORLD_RADIUS - EDGE_MARGIN * 1.5) {
    const k = ((r - (WORLD_RADIUS - EDGE_MARGIN * 1.5)) / EDGE_MARGIN) * 3;
    want.x -= (pos.x / r) * k;
    want.z -= (pos.z / r) * k;
  }
  want.normalize();
  return helm(fwd, want, yawRate);
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
