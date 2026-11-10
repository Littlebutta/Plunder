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
 * Plundering (E alongside an island that is not yours): the crew storm ashore
 * and strip it, far faster than gathering. Afterwards the island lies bare and
 * regrows nothing for a while.
 */
export const PLUNDER = {
  /** Seconds per haul while plundering, and units per haul. */
  haulTime: 0.45,
  haulSize: 4,
  /** Most a single raid carries off (units). */
  most: 60,
  /** Seconds the island regrows nothing after being plundered. */
  scorched: 75,
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

  /** Gather from the island in range without being asked (off: islands are plundered with E instead). */
  auto = false;
  /** The island being plundered right now, if any. */
  plundering: Island | null = null;
  /** Units carried off in the current raid. */
  plundered = 0;
  /** Whether the player may plunder an island (not their own). */
  canPlunder: (island: Island) => boolean = () => true;
  /** Seconds each island lies bare after a raid. */
  private readonly scorched = new Map<Island, number>();
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

  status: 'idle' | 'working' | 'out-of-range' | 'hold-full' | 'empty' | 'plundering' = 'idle';

  /** Seconds an island has left before it starts to regrow after a raid (0 if it is not bare). */
  bareFor(island: Island): number {
    return Math.max(0, this.scorched.get(island) ?? 0);
  }

  /** Can the island in range be plundered now? Returns why not, or ''. */
  plunderProblem(island: Island | null = this.inRange): string {
    if (!island) return 'No island close enough.';
    if (!this.canPlunder(island)) return 'This island is yours: it sends you its goods already.';
    if (RESOURCE_IDS.every((id) => island.stock[id] <= 0)) return `${island.name} has been stripped bare.`;
    return '';
  }

  /** E: storm the island in range and carry off what it has. Returns why not, or ''. */
  plunder(): string {
    const why = this.plunderProblem();
    if (why) return why;
    this.plundering = this.inRange;
    this.plundered = 0;
    this.progress = 0;
    this.select(this.inRange);
    this.progress = 0;
    return '';
  }

  select(island: Island | null): void {
    if (island !== this.selected) this.progress = 0;
    this.selected = island;
  }

  /** Select the island in range, or let go of the current one. */
  toggle(): void {
    this.select(this.selected ? null : this.inRange);
  }

  update(dt: number, ship: THREE.Vector3): void {
    // Islands regrow, all but those lying bare after a raid.
    for (const [i, t] of this.scorched) {
      if (t - dt <= 0) this.scorched.delete(i);
      else this.scorched.set(i, t - dt);
    }
    this.regrow += dt;
    while (this.regrow >= GATHER.regrowTime) {
      this.regrow -= GATHER.regrowTime;
      for (const i of this.islands) if (!this.scorched.has(i)) for (const id of RESOURCE_IDS) if (i.stock[id] < i.capacity[id]) i.stock[id]++;
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
    // a raid under way: fast hauls until the island is bare, the raid has carried all it can, or she sails off
    const raid = this.plundering;
    if (raid) {
      const left = RESOURCE_IDS.filter((id) => raid.stock[id] > 0);
      if (!this.isInRange(raid, ship) || left.length === 0 || this.plundered >= PLUNDER.most) {
        if (this.plundered > 0) this.scorched.set(raid, PLUNDER.scorched);
        this.plundering = null;
        this.select(null);
        this.status = 'idle';
        return;
      }
      this.status = 'plundering';
      this.progress += dt / PLUNDER.haulTime;
      if (this.progress < 1) return;
      this.progress = 0;
      const got: Partial<Stock> = {};
      for (let n = 0; n < PLUNDER.haulSize && this.plundered < PLUNDER.most; n++) {
        const avail = RESOURCE_IDS.filter((id) => raid.stock[id] > 0);
        if (avail.length === 0) break;
        const id: ResourceId = avail[this.next++ % avail.length];
        raid.stock[id]--;
        this.hold.stock[id]++;
        this.plundered++;
        got[id] = (got[id] ?? 0) + 1;
      }
      this.onHaul?.(raid, got);
      return;
    }
    // with auto on, the crew work whatever island the ship lies off, and stop when she leaves
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
