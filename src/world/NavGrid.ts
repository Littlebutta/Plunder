import * as THREE from 'three';
import type { Island } from './Islands';
import { EDGE_MARGIN, WORLD_RADIUS } from './worldConfig';

/**
 * A coarse chart of where a ship can sail, for finding a way across the map.
 *
 * Ships used to steer straight for where they were going and only swerve round
 * the first island in the way. With islands close together, or a destination
 * tucked behind a headland or a reef, that steering pulled one way and the push
 * off the shore the other, and ships (merchants most, as they sail the same
 * runs over and over) sat against a coast going nowhere. This grid knows every
 * island, reef and stack, padded with sea room, and A* finds a real way round.
 */
export class NavGrid {
  /** Size of a cell (m). */
  static readonly CELL = 8;
  readonly n: number;
  /** 1 where a ship may not sail. */
  readonly blocked: Uint8Array;
  private readonly origin: number;
  // A* scratch, reused between searches
  private readonly g: Float32Array;
  private readonly from: Int32Array;
  private readonly seen: Uint32Array;
  private stamp = 0;
  private readonly heap = new MinHeap();

  /**
   * @param clearance sea room kept off every shore (m)
   */
  constructor(islands: Island[], clearance = 13) {
    const C = NavGrid.CELL;
    this.n = Math.ceil((WORLD_RADIUS * 2) / C);
    this.origin = -WORLD_RADIUS;
    const n = this.n;
    this.blocked = new Uint8Array(n * n);
    this.g = new Float32Array(n * n);
    this.from = new Int32Array(n * n);
    this.seen = new Uint32Array(n * n);
    // the rim, where the current turns ships back
    const rim = WORLD_RADIUS - EDGE_MARGIN * 0.8;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = this.origin + (i + 0.5) * C;
        const z = this.origin + (j + 0.5) * C;
        if (Math.hypot(x, z) > rim) this.blocked[j * n + i] = 1;
      }
    }
    for (const island of islands) {
      let reach = island.radius * 1.5 + clearance;
      for (const r of island.rocks) reach = Math.max(reach, Math.hypot(r.x, r.z) + r.r + clearance);
      const i0 = Math.max(0, this.cellOf(island.center.x - reach));
      const i1 = Math.min(n - 1, this.cellOf(island.center.x + reach));
      const j0 = Math.max(0, this.cellOf(island.center.z - reach));
      const j1 = Math.min(n - 1, this.cellOf(island.center.z + reach));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          if (this.blocked[k]) continue;
          const dx = this.origin + (i + 0.5) * C - island.center.x;
          const dz = this.origin + (j + 0.5) * C - island.center.z;
          const d = Math.hypot(dx, dz);
          if (d < island.shoreAt(Math.atan2(dz, dx)) + clearance) {
            this.blocked[k] = 1;
            continue;
          }
          for (const r of island.rocks) {
            if (Math.hypot(dx - r.x, dz - r.z) < r.r + clearance * 0.75) {
              this.blocked[k] = 1;
              break;
            }
          }
        }
      }
    }
  }

  private cellOf(v: number): number {
    return Math.floor((v - this.origin) / NavGrid.CELL);
  }

  private index(x: number, z: number): number {
    const i = THREE.MathUtils.clamp(this.cellOf(x), 0, this.n - 1);
    const j = THREE.MathUtils.clamp(this.cellOf(z), 0, this.n - 1);
    return j * this.n + i;
  }

  private centre(k: number, out: THREE.Vector3): THREE.Vector3 {
    const i = k % this.n;
    const j = (k - i) / this.n;
    return out.set(this.origin + (i + 0.5) * NavGrid.CELL, 0, this.origin + (j + 0.5) * NavGrid.CELL);
  }

  /** Open water at this point? */
  free(x: number, z: number): boolean {
    return !this.blocked[this.index(x, z)];
  }

  /** The nearest open cell to `k` (k itself if open), searching outward ring by ring. */
  private nearestFree(k: number): number {
    if (!this.blocked[k]) return k;
    const n = this.n;
    const ci = k % n;
    const cj = (k - ci) / n;
    for (let r = 1; r < 40; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= n || j >= n) continue;
          const q = j * n + i;
          if (this.blocked[q]) continue;
          const d = (i - ci) ** 2 + (j - cj) ** 2;
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
      }
      if (best >= 0) return best;
    }
    return k;
  }

  /** Can a ship sail straight from a to b without crossing a blocked cell? */
  clear(ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (NavGrid.CELL * 0.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.blocked[this.index(ax + (bx - ax) * t, az + (bz - az) * t)]) return false;
    }
    return true;
  }

  /**
   * A way from `a` to `b` round everything in between: corner points only
   * (straight runs pulled tight), ending at `b` (or the open water nearest it).
   * Null if there is no way at all.
   */
  path(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] | null {
    const n = this.n;
    const start = this.nearestFree(this.index(a.x, a.z));
    const goal = this.nearestFree(this.index(b.x, b.z));
    const goalOpen = !this.blocked[this.index(b.x, b.z)];
    const end = goalOpen ? new THREE.Vector3(b.x, 0, b.z) : this.centre(goal, new THREE.Vector3());
    if (start === goal) return [end];
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const gi = goal % n;
    const gj = (goal - gi) / n;
    const h = (k: number) => {
      const i = k % n;
      const j = (k - i) / n;
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    const heap = this.heap;
    heap.clear();
    this.g[start] = 0;
    this.from[start] = -1;
    this.seen[start] = stamp;
    heap.push(start, h(start));
    let found = false;
    let expanded = 0;
    while (heap.size) {
      const k = heap.pop();
      if (k === goal) {
        found = true;
        break;
      }
      if (++expanded > 40000) break;
      const i = k % n;
      const j = (k - i) / n;
      const gk = this.g[k];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const q = nj * n + ni;
          if (this.blocked[q]) continue;
          // no cutting a corner between two blocked cells
          if (di && dj && (this.blocked[j * n + ni] || this.blocked[nj * n + i])) continue;
          const cost = gk + (di && dj ? 1.4142 : 1);
          if (this.seen[q] === stamp && this.g[q] <= cost) continue;
          this.seen[q] = stamp;
          this.g[q] = cost;
          this.from[q] = k;
          heap.push(q, cost + h(q));
        }
      }
    }
    if (!found) return null;
    // walk back, then pull the string tight: keep only the cells a straight run cannot skip
    const cells: number[] = [];
    for (let k = goal; k !== -1; k = this.from[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => this.centre(k, new THREE.Vector3()));
    pts[0].set(a.x, 0, a.z);
    pts[pts.length - 1] = end;
    const out: THREE.Vector3[] = [];
    let at = 0;
    while (at < pts.length - 1) {
      let next = pts.length - 1;
      while (next > at + 1 && !this.clear(pts[at].x, pts[at].z, pts[next].x, pts[next].z)) next--;
      out.push(pts[next]);
      at = next;
    }
    return out;
  }
}

const grids = new WeakMap<Island[], NavGrid>();
/** The grid for this map's islands, built the first time it is asked for. */
export function navGrid(islands: Island[]): NavGrid {
  let g = grids.get(islands);
  if (!g) grids.set(islands, (g = new NavGrid(islands)));
  return g;
}

/**
 * A ship's way to wherever it is going: planned on the grid, followed corner
 * to corner, and planned again when the destination moves, the ship is pushed
 * off it, or she stops making headway.
 */
export class Pilot {
  private path: THREE.Vector3[] = [];
  private readonly dest = new THREE.Vector3(1e9, 0, 1e9);
  private replanIn = 0;
  private checkIn = 4;
  private readonly lastPos = new THREE.Vector3(1e9, 0, 1e9);
  /** Seconds left of backing away from whatever she is stuck on. */
  unstick = 0;

  /**
   * The point to steer for now on the way from `pos` to `to`. Writes to `out`.
   * @param moving she is meant to be under way (not lying at her station)
   */
  next(dt: number, pos: THREE.Vector3, to: THREE.Vector3, grid: NavGrid, out: THREE.Vector3, moving = true): THREE.Vector3 {
    this.replanIn -= dt;
    this.unstick = Math.max(0, this.unstick - dt);
    // no headway for a while under sail: plan again, and back off whatever she is lying against
    this.checkIn -= dt;
    if (this.checkIn <= 0) {
      this.checkIn = 4;
      if (moving && pos.distanceTo(this.lastPos) < 6 && pos.distanceTo(to) > 40) {
        this.unstick = 3;
        this.replanIn = 0;
      }
      this.lastPos.copy(pos);
    }
    const moved = Math.hypot(to.x - this.dest.x, to.z - this.dest.z);
    if (!this.path.length || (moved > 12 && this.replanIn <= 0) || moved > 120 || this.replanIn < -8) {
      this.dest.set(to.x, 0, to.z);
      this.replanIn = 1.5;
      // straight there if the water is open all the way
      this.path = grid.clear(pos.x, pos.z, to.x, to.z) ? [this.dest.clone()] : (grid.path(pos, to) ?? [this.dest.clone()]);
    }
    // on past each corner once she is near it, or as soon as she can see the one after
    while (this.path.length > 1) {
      const p = this.path[0];
      const q = this.path[1];
      if (Math.hypot(p.x - pos.x, p.z - pos.z) < 22 || grid.clear(pos.x, pos.z, q.x, q.z)) this.path.shift();
      else break;
    }
    // the last leg: right up to the mark itself, even if it lies close in under a shore
    if (this.path.length === 1) return out.set(to.x, 0, to.z);
    const p = this.path[0];
    // knocked well off the line (a collision, a current): plan again soon
    if (!grid.clear(pos.x, pos.z, p.x, p.z)) this.replanIn = Math.min(this.replanIn, 0);
    return out.set(p.x, 0, p.z);
  }

  /** Forget the plan (a new order). */
  reset(): void {
    this.path.length = 0;
    this.lastPos.set(1e9, 0, 1e9);
    this.checkIn = 4;
  }
}

/** A binary min-heap of cell indices keyed by priority. */
class MinHeap {
  private keys: number[] = [];
  private pri: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  clear(): void {
    this.keys.length = 0;
    this.pri.length = 0;
  }
  push(k: number, p: number): void {
    const keys = this.keys;
    const pri = this.pri;
    let i = keys.length;
    keys.push(k);
    pri.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pri[up] <= p) break;
      keys[i] = keys[up];
      pri[i] = pri[up];
      i = up;
    }
    keys[i] = k;
    pri[i] = p;
  }
  pop(): number {
    const keys = this.keys;
    const pri = this.pri;
    const top = keys[0];
    const k = keys.pop()!;
    const p = pri.pop()!;
    const n = keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= p) break;
        keys[i] = keys[c];
        pri[i] = pri[c];
        i = c;
      }
      keys[i] = k;
      pri[i] = p;
    }
    return top;
  }
}
