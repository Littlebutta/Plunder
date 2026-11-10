import * as THREE from 'three';
import type { Faction, Factions } from './Factions';
import type { Island } from './Islands';
import { RESOURCE_IDS, Stock } from './Resources';
import { canAfford, LEVELS, STRONGHOLD, Stronghold, Territory } from './Strongholds';
import type { Warship } from './Warship';

export type AiLevel = 'easy' | 'normal' | 'hard';

/** How an AI captain plays at each level. */
export const AI: Record<AiLevel, { stipend: number; escorts: number; attackAfter: number; outposts: number }> = {
  // stipend: units a minute, standing in for the gathering a human does by hand
  easy: { stipend: 10, escorts: 1, attackAfter: 300, outposts: 2 },
  normal: { stipend: 20, escorts: 2, attackAfter: 180, outposts: 3 },
  hard: { stipend: 36, escorts: 3, attackAfter: 100, outposts: 5 },
};

export interface AiWorld {
  territory: Territory;
  factions: Factions;
  islands: Island[];
  /** The escorts a faction has afloat. */
  escortsOf(faction: number): Warship[];
  /** Build an escort for a faction at its home, if it can pay. */
  launchEscort(faction: number): boolean;
  /** What the captain's next ship would cost, or null when they already sail one (not the starting raft). */
  refitCost(faction: number): Stock | null;
  /** Trade the raft for that ship at home. False if it cannot be done now. */
  refit(faction: number): boolean;
  /** Hostile ships afloat near a point. */
  threatNear(faction: number, at: THREE.Vector3, range: number): boolean;
}

/**
 * An AI captain: runs one faction the way a player would. It claims the free
 * islands near home, upgrades its home, builds a few escorts, and then goes
 * after the nearest hostile stronghold with everything it has, coming home if
 * its own island is attacked.
 */
export class AiCaptain {
  /** It has picked a new stronghold to attack (for the captain's taunt). */
  onAttack: (target: Stronghold) => void = () => {};
  private lastRaid: Stronghold | null = null;
  /** What it is doing, for the chart and for tests. */
  goal = 'idle';
  private think = 1 + Math.random() * 2;
  private elapsed = 0;
  private stipend = 0;
  private stipendN = 0;
  private readonly at = new THREE.Vector3();

  constructor(
    readonly faction: Faction,
    public flagship: Warship,
    private readonly world: AiWorld,
    readonly level: AiLevel,
  ) {}

  update(dt: number): void {
    const f = this.faction;
    if (!f.alive) return;
    const cfg = AI[this.level];
    this.elapsed += dt;
    // supplies trickle in: timber, stone for the walls and metal for the guns
    this.stipend += (dt * cfg.stipend) / 60;
    while (this.stipend >= 1) {
      this.stipend -= 1;
      const n = this.stipendN++ % 10;
      f.stores[n < 4 ? 'wood' : n < 6 ? 'stone' : 'salvage']++;
    }
    this.think -= dt;
    if (this.think > 0) return;
    this.think = 1.5;

    const { territory, islands } = this.world;
    const home = territory.homes.get(f.id);
    if (!home) return;
    const held = territory.held(f.id);
    const free = islands.filter((i) => !territory.at(i)).sort((a, b) => a.center.distanceTo(home.site) - b.center.distanceTo(home.site));
    const wantOutpost = free.length > 0 && held.length - 1 < cfg.outposts;
    const escorts = this.world.escortsOf(f.id);

    // --- spending: keep enough back for the next outpost, then home, then ships ---
    const reserve: Stock = wantOutpost ? STRONGHOLD.outpostCost : { wood: 0, stone: 0, salvage: 0 };
    const afford = (cost: Stock) => canAfford(plus(cost, reserve), f.stores, null);
    if (home.level < LEVELS.length - 1 && afford(LEVELS[home.level + 1].cost) && (home.level === 0 || escorts.length >= Math.min(1, cfg.escorts))) {
      territory.build(home.island, false, f.id);
    } else if (escorts.length < (f.stores.wood > 160 ? cfg.escorts + 2 : cfg.escorts) && home.level >= 1 && (!this.world.refitCost(f.id) || f.stores.wood > 120)) {
      // (a captain still on the raft saves for a ship of their own before building escorts)
      this.world.launchEscort(f.id);
    } else if (this.level !== 'easy') {
      const outpost = held.find((s) => s !== home && s.level < 1 && afford(LEVELS[1].cost));
      if (outpost) territory.build(outpost.island, false, f.id);
    }

    // --- the flagship: off the raft and into a proper ship as soon as the stores allow ---
    const refit = this.world.refitCost(f.id);
    const wantShip = !!refit && home.level >= 1 && canAfford(plus(refit, wantOutpost ? STRONGHOLD.outpostCost : { wood: 0, stone: 0, salvage: 0 }), f.stores, null);
    let ship = this.flagship;
    if (wantShip && ship.alive && territory.islandInReach(ship.position) === home.island && this.world.refit(f.id)) ship = this.flagship;
    if (!ship.alive) return;
    const pos = ship.position;
    let raid: Stronghold | null = null;
    if (wantShip && !((home.sinceHit < 20 || home.ruined) && this.world.threatNear(f.id, home.site, 240))) {
      this.goal = 'refit at home';
      ship.order = this.offShore(home.island, pos);
    } else if ((home.sinceHit < 20 || home.ruined) && this.world.threatNear(f.id, home.site, 240)) {
      // home is under attack: everything else waits
      this.goal = 'defend';
      ship.order = this.offShore(home.island, pos);
    } else if (wantOutpost && canAfford(STRONGHOLD.outpostCost, f.stores, null)) {
      const island = free[0];
      this.goal = `settle ${island.name}`;
      ship.order = this.offShore(island, pos);
      if (territory.islandInReach(pos) === island) territory.build(island, true, f.id);
    } else if (this.elapsed > cfg.attackAfter || escorts.length >= cfg.escorts) {
      const marks = territory.strongholds.filter((s) => this.world.factions.hostile(f.id, s.side)).sort((a, b) => a.site.distanceTo(home.site) - b.site.distanceTo(home.site));
      raid = marks[0] ?? null;
      this.goal = raid ? `attack ${raid.island.name}` : 'idle';
      if (!raid) ship.order = this.offShore(home.island, pos);
    } else {
      this.goal = 'gather strength';
      ship.order = this.offShore(home.island, pos);
    }
    if (raid && raid !== this.lastRaid) this.onAttack(raid);
    this.lastRaid = raid;
    ship.raidTarget = raid ? raid.site : null;
    if (raid) ship.order = null;
    for (const e of escorts) {
      e.escort = pos;
      e.order = null;
      e.raidTarget = raid && e.position.distanceTo(raid.site) < 260 ? raid.site : null;
    }
  }

  /** A point off an island's shore on the side nearest `from`, close enough to build there. */
  private offShore(island: Island, from: THREE.Vector3): THREE.Vector3 {
    const a = Math.atan2(from.z - island.center.z, from.x - island.center.x);
    const r = island.shoreAt(a) + 42;
    return this.at.set(island.center.x + Math.cos(a) * r, 0, island.center.z + Math.sin(a) * r).clone();
  }
}

function plus(a: Stock, b: Stock): Stock {
  const out = { ...a };
  for (const id of RESOURCE_IDS) out[id] += b[id];
  return out;
}
