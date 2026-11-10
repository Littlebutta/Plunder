import * as THREE from 'three';
import type { Island } from './Islands';
import { Hold, RESOURCE_IDS, ResourceId, Stock } from './Resources';

export const GATHER = {
  /** How close to the shore the ship must be to work an island without a port (m). */
  islandRange: 60,
  /** How close to the pier the ship must be when the island has a port (m). */
  portRange: 48,
  /** Seconds per haul. */
  haulTime: 2,
  /** Units brought aboard per haul; ports are better organised. */
  haulSize: 3,
  portHaulSize: 5,
  /** Seconds for an island to regrow one unit of each resource it offers. */
  regrowTime: 12,
};

/**
 * Gathering resources from islands.
 *
 * Rule (from Devin): sail within range of an island and you can select it;
 * if the island has a port you must be within range of the port instead.
 * While an island is selected and the ship stays in range, the crew hauls
 * resources aboard every few seconds until the hold is full or the island
 * runs dry. Islands regrow slowly.
 */
export class Gathering {
  /** Island the ship could select right now (nearest one in range), if any. */
  inRange: Island | null = null;
  selected: Island | null = null;
  /** 0..1 progress of the current haul. */
  progress = 0;
  /** Called with what was just brought aboard. */
  onHaul: ((island: Island, what: Partial<Stock>) => void) | null = null;

  /** Gather from the island in range without being asked. */
  auto = true;
  private regrow = 0;
  private next = 0;

  constructor(
    private readonly islands: Island[],
    readonly hold: Hold,
  ) {}

  /** Distance the ship still has to close to be in range (<= 0 means in range). */
  distanceOutside(island: Island, ship: THREE.Vector3): number {
    if (island.port) return Math.hypot(ship.x - island.port.x, ship.z - island.port.z) - GATHER.portRange;
    const dx = ship.x - island.center.x;
    const dz = ship.z - island.center.z;
    return Math.hypot(dx, dz) - island.shoreAt(Math.atan2(dz, dx)) - GATHER.islandRange;
  }

  isInRange(island: Island, ship: THREE.Vector3): boolean {
    return this.distanceOutside(island, ship) <= 0;
  }

  /** True while the selected island is being worked. */
  get working(): boolean {
    return this.status === 'working';
  }

  status: 'idle' | 'working' | 'out-of-range' | 'hold-full' | 'empty' = 'idle';

  select(island: Island | null): void {
    if (island !== this.selected) this.progress = 0;
    this.selected = island;
  }

  /** Select the island in range, or let go of the current one. */
  toggle(): void {
    this.select(this.selected ? null : this.inRange);
  }

  update(dt: number, ship: THREE.Vector3): void {
    // Islands regrow.
    this.regrow += dt;
    while (this.regrow >= GATHER.regrowTime) {
      this.regrow -= GATHER.regrowTime;
      for (const i of this.islands) for (const id of RESOURCE_IDS) if (i.stock[id] < i.capacity[id]) i.stock[id]++;
    }

    let best: Island | null = null;
    let bestD = 0;
    for (const i of this.islands) {
      const d = this.distanceOutside(i, ship);
      if (d <= 0 && (!best || d < bestD)) {
        best = i;
        bestD = d;
      }
    }
    this.inRange = best;
    // nothing to press: the crew work whatever island the ship lies off, and stop when she leaves
    if (this.auto && best !== this.selected) this.select(best);

    const sel = this.selected;
    if (!sel) {
      this.status = 'idle';
      return;
    }
    const left = RESOURCE_IDS.filter((id) => sel.stock[id] > 0);
    if (!this.isInRange(sel, ship)) this.status = 'out-of-range';
    else if (this.hold.free <= 0) this.status = 'hold-full';
    else if (left.length === 0) this.status = 'empty';
    else this.status = 'working';
    if (this.status !== 'working') {
      this.progress = 0;
      return;
    }

    this.progress += dt / GATHER.haulTime;
    if (this.progress < 1) return;
    this.progress = 0;
    // One haul: take turns between the resources the island still has.
    const got: Partial<Stock> = {};
    const size = sel.port ? GATHER.portHaulSize : GATHER.haulSize;
    for (let n = 0; n < size && this.hold.free > 0; n++) {
      const avail = RESOURCE_IDS.filter((id) => sel.stock[id] > 0);
      if (avail.length === 0) break;
      const id: ResourceId = avail[this.next++ % avail.length];
      sel.stock[id]--;
      this.hold.stock[id]++;
      got[id] = (got[id] ?? 0) + 1;
    }
    this.onHaul?.(sel, got);
  }
}
