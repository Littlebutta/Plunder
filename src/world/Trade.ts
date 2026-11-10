import * as THREE from 'three';
import type { Island } from './Islands';
import type { Warship } from './Warship';
import type { Stronghold } from './Strongholds';
import { navGrid } from './NavGrid';
import { RESOURCE_IDS, Stock, emptyStock } from './Resources';
import { CannonFit, HullDesign, sanitizeDesign } from '../ship/HullDesign';

/**
 * Trade ships: built at home, they sail a round from home to each of the
 * captain's other islands and back, and each return pays a cargo into the
 * stores. They carry no guns, so they want guarding.
 */
export const TRADE = {
  cost: { wood: 40, stone: 0, salvage: 10 } as Stock,
  /** Units in a cargo, before distance and the island's port. */
  base: 3,
  /** One more unit for each this many metres between home and the island. */
  perMetres: 60,
  /** A trading post (an island with a pier) pays this much more. */
  portBonus: 1.5,
  /** Seconds alongside to load. */
  loadTime: 12,
};

/** A broad, slow merchant hull with one big sail and nothing to fight with. */
export const MERCHANT: HullDesign = sanitizeDesign({
  name: 'Merchantman',
  length: 13,
  beam: 5.2,
  depth: 1.2,
  freeboard: 1.3,
  plan: Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    return Math.max(0.05, Math.pow(Math.sin((Math.PI / 2) * Math.min(1, t / 0.45)), 0.45) * (t < 0.6 ? 1 : 1 - 0.3 * ((t - 0.6) / 0.4) ** 2));
  }),
  keel: Array.from({ length: 25 }, (_, i) => Math.max(0.05, Math.pow(Math.sin(Math.PI * (0.06 + 0.86 * (i / 24))), 0.3))),
  masts: [{ t: 0.46, sail: 'square' }],
  jib: true,
  cannons: [] as CannonFit[],
  swivel: 'stern',
});

export interface TradeHooks {
  /** Every island on the map (to find open water to lie in). */
  islands: Island[];
  /** The faction's home stronghold, if it still has one. */
  home(faction: number): Stronghold | null;
  /** Islands the faction holds. */
  held(faction: number): Stronghold[];
  /** A cargo came home. */
  deliver(faction: number, cargo: Stock, from: Island): void;
}

interface Run {
  ship: Warship;
  leg: 'out' | 'load' | 'back';
  target: Island | null;
  wait: number;
  cargo: Stock;
  /** Which of the captain's islands is next. */
  turn: number;
}

export class TradeRoutes {
  private readonly runs: Run[] = [];

  constructor(private readonly hooks: TradeHooks) {}

  add(ship: Warship): void {
    ship.trader = true;
    this.runs.push({ ship, leg: 'out', target: null, wait: 0, cargo: emptyStock(), turn: Math.floor(Math.random() * 8) });
  }

  count(faction: number): number {
    return this.runs.filter((r) => r.ship.faction === faction && r.ship.alive).length;
  }

  /** What this ship is doing, for the chart. */
  note(ship: Warship): string {
    const r = this.runs.find((x) => x.ship === ship);
    if (!r) return '';
    if (!r.target) return 'Idle: hold another island to trade with';
    return r.leg === 'out' ? `Sailing to ${r.target.name}` : r.leg === 'load' ? `Loading at ${r.target.name}` : `Bringing a cargo home from ${r.target.name}`;
  }

  update(dt: number): void {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i];
      const w = r.ship;
      if (w.lost || !w.alive) {
        if (w.lost) this.runs.splice(i, 1);
        continue;
      }
      const home = this.hooks.home(w.faction);
      if (!home) continue;
      const pos = w.position;
      if (r.leg === 'out') {
        // the island may have been lost on the way
        if (!r.target || r.target.owner !== w.faction) r.target = this.next(r, home);
        if (!r.target) {
          w.order = this.offShore(home.island, pos, 40);
          continue;
        }
        const to = this.offShore(r.target, home.site, 34);
        if (!w.order || w.order.distanceToSquared(to) > 4) w.order = to;
        if (alongside(w, to)) {
          r.leg = 'load';
          r.wait = TRADE.loadTime;
          r.cargo = cargoFrom(r.target, home.island);
        }
      } else if (r.leg === 'load') {
        r.wait -= dt;
        if (r.wait <= 0) r.leg = 'back';
      } else {
        const to = this.offShore(home.island, r.target?.center ?? pos, 34);
        if (!w.order || w.order.distanceToSquared(to) > 4) w.order = to;
        if (alongside(w, to)) {
          if (r.target) this.hooks.deliver(w.faction, r.cargo, r.target);
          r.cargo = emptyStock();
          r.leg = 'out';
          r.target = this.next(r, home);
        }
      }
    }
  }

  /**
   * Open water off an island's shore on the side facing `from`, or the nearest
   * open water round the coast from there: the side facing home can be all reef,
   * or under the shore of a neighbour, and a merchant sent there would never arrive.
   */
  private offShore(island: Island, from: THREE.Vector3, gap: number): THREE.Vector3 {
    const grid = navGrid(this.hooks.islands);
    const a = Math.atan2(from.z - island.center.z, from.x - island.center.x);
    for (let k = 0; k < 18; k++) {
      // 0, +20, -20, +40, -40 … degrees round the coast
      const turn = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (Math.PI / 9);
      const p = offShore(island, a + turn, gap);
      if (grid.free(p.x, p.z) && grid.free((p.x + island.center.x * 0.15) / 1.15, (p.z + island.center.z * 0.15) / 1.15)) return p;
    }
    return offShore(island, a, gap);
  }

  private next(r: Run, home: Stronghold): Island | null {
    const others = this.hooks.held(r.ship.faction).filter((s) => s !== home && !s.ruined);
    if (!others.length) return null;
    r.turn = (r.turn + 1) % others.length;
    return others[r.turn].island;
  }
}

/**
 * Close enough to load or unload: within hail, or lying where the ship herself
 * reckons she has arrived (a broad hull that slid a little past the mark stops
 * there rather than turning back, and used to wait for ever).
 */
function alongside(w: Warship, to: THREE.Vector3): boolean {
  const d = Math.hypot(to.x - w.position.x, to.z - w.position.z);
  return d < 42 || (w.arrived && d < 95);
}

/** A point `gap` off an island's shore at angle `a` from its centre. */
function offShore(island: Island, a: number, gap: number): THREE.Vector3 {
  const r = island.shoreAt(a) + gap;
  return new THREE.Vector3(island.center.x + Math.cos(a) * r, 0, island.center.z + Math.sin(a) * r);
}

/** What a run to this island brings home: more from far islands and trading posts, in the island's own goods. */
function cargoFrom(island: Island, home: Island): Stock {
  const far = Math.hypot(island.center.x - home.center.x, island.center.z - home.center.z);
  let units = (TRADE.base + far / TRADE.perMetres) * (island.port ? TRADE.portBonus : 1);
  units = Math.round(units);
  const total = RESOURCE_IDS.reduce((n, id) => n + island.capacity[id], 0) || 1;
  const out = emptyStock();
  let given = 0;
  for (const id of RESOURCE_IDS) {
    out[id] = Math.floor((units * island.capacity[id]) / total);
    given += out[id];
  }
  // the rest, and always a little metal from the market
  out.salvage += Math.max(1, units - given);
  return out;
}
