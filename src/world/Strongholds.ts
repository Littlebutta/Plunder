import * as THREE from 'three';
import type { Collider } from '../combat/ProjectileSystem';
import { ballisticVelocity } from '../combat/ballistics';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import type { Island } from './Islands';
import { emptyStock, Hold, RESOURCE_IDS, RESOURCES, ResourceId, Stock } from './Resources';

/** Collider ids of strongholds: one per island, 300 + the island's index. */
export const STRONGHOLD_ID_BASE = 300;
export const STRONGHOLD_ID_END = 400;

export interface StrongholdLevel {
  name: string;
  hp: number;
  /** Cannon that fire on hostile ships in range. */
  guns: number;
  /** What it costs to upgrade TO this level (from the hold of the ship alongside). */
  cost: Stock;
}

/** The upgrade ladder, hut to fort. */
export const LEVELS: StrongholdLevel[] = [
  { name: 'Hut', hp: 80, guns: 0, cost: { wood: 0, stone: 0, salvage: 0 } },
  { name: 'Stockade', hp: 150, guns: 0, cost: { wood: 12, stone: 4, salvage: 0 } },
  { name: 'Watchtower', hp: 230, guns: 1, cost: { wood: 14, stone: 12, salvage: 4 } },
  { name: 'Fort', hp: 340, guns: 3, cost: { wood: 12, stone: 20, salvage: 8 } },
];

export const STRONGHOLD = {
  /** Founding an outpost on an island nobody holds. */
  outpostCost: { wood: 10, stone: 2, salvage: 0 } as Stock,
  /** Outposts are smaller and weaker than the same level at home. */
  outpostScale: 0.72,
  outpostHp: 0.6,
  /** A ship must be this close to the island's shore to build or upgrade (m). */
  buildRange: 75,
  /** Damage per hit by projectile kind: swivel shot, cannon shell. */
  damage: [3, 14],
  /** A shell landing this close to the walls still shakes them (m, beyond the collider). */
  nearMiss: 3,
  gunRange: 125,
  gunReload: 5,
  gunSpeed: 50,
  /** How far fort gunnery strays, as a share of the range. */
  gunScatter: 0.045,
  /** A ruined stronghold falls to a hostile ship that stays this close (m) for this long (s). */
  captureRange: 110,
  captureTime: 10,
  /** Repairs start this long after the last hit (s), at this rate (hp/s). */
  repairDelay: 12,
  repairRate: 4,
  /** Every this many seconds each island you hold sends (1 + its stronghold's level) units to your stores. */
  incomeEvery: 12,
  /** A new escort ship, and how many the fleet can hold. */
  shipCost: { wood: 30, stone: 0, salvage: 8 } as Stock,
  fleetMax: 4,
};

export type Side = 'player' | 'npc';

export function costLabel(cost: Stock): string {
  return (
    RESOURCE_IDS.filter((id) => cost[id] > 0)
      .map((id) => `${cost[id]} ${RESOURCES[id].label.toLowerCase()}`)
      .join(', ') || 'free'
  );
}

/** Can `cost` be met from the stores, plus the hold of a ship alongside (if one is)? */
export function canAfford(cost: Stock, stores: Stock, hold: Hold | null): boolean {
  return RESOURCE_IDS.every((id) => stores[id] + (hold ? hold.stock[id] : 0) >= cost[id]);
}

/** Take `cost` from the hold first (if a ship is alongside), then from the stores. */
export function pay(cost: Stock, stores: Stock, hold: Hold | null): void {
  for (const id of RESOURCE_IDS) {
    const fromHold = hold ? Math.min(hold.stock[id], cost[id]) : 0;
    if (hold) hold.stock[id] -= fromHold;
    stores[id] -= cost[id] - fromHold;
  }
}

/** A settlement on an island: the thing that holds it, and what a raider must break to take it. */
export class Stronghold {
  readonly group = new THREE.Group();
  /** World position of the ground it stands on. */
  readonly site = new THREE.Vector3();
  readonly collider: Collider;
  level = 0;
  hp = 0;
  /** Seconds a hostile ship has stood over the ruins. */
  capture = 0;
  sinceHit = 99;
  /** Running shares that decide which resource the next unit of income is. */
  readonly yieldAcc = emptyStock();
  private readonly gunTimers: number[] = [];
  private readonly body = new THREE.Group();
  private readonly barBack: THREE.Sprite;
  private readonly barFill: THREE.Sprite;
  private readonly flagMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  private top = 4;

  constructor(
    readonly island: Island,
    readonly id: number,
    public side: Side,
    readonly home: boolean,
    preferAngle: number,
  ) {
    this.group.name = 'stronghold';
    findSite(island, preferAngle, this.site);
    this.group.position.copy(this.site);
    // face the sea
    this.group.rotation.y = -Math.atan2(this.site.z - island.center.z, this.site.x - island.center.x);
    this.collider = { id, position: new THREE.Vector3(), radius: 5 };
    this.barBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x2a1708, depthTest: false }));
    this.barFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x7ed957, depthTest: false }));
    this.barFill.center.set(0, 0.5);
    this.barBack.renderOrder = 8;
    this.barFill.renderOrder = 9;
    this.group.add(this.body, this.barBack, this.barFill);
    this.setLevel(0);
  }

  get scale(): number {
    return this.home ? 1 : STRONGHOLD.outpostScale;
  }

  get maxHp(): number {
    return Math.round(LEVELS[this.level].hp * (this.home ? 1 : STRONGHOLD.outpostHp));
  }

  get ruined(): boolean {
    return this.hp <= 0;
  }

  /** "Hut", "Stockade"… an outpost's first level is called an outpost. */
  get levelName(): string {
    return !this.home && this.level === 0 ? 'Outpost' : LEVELS[this.level].name;
  }

  get guns(): number {
    // an outpost carries one gun fewer than the same level at home
    return Math.max(0, LEVELS[this.level].guns - (this.home ? 0 : this.level === 3 ? 1 : 0));
  }

  /** Where its guns fire from (world). */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.site).setY(this.site.y + this.top * 0.8);
  }

  setLevel(level: number): void {
    this.level = THREE.MathUtils.clamp(level, 0, LEVELS.length - 1);
    this.hp = this.maxHp;
    this.capture = 0;
    this.gunTimers.length = 0;
    for (let i = 0; i < this.guns; i++) this.gunTimers.push(1 + i * (STRONGHOLD.gunReload / Math.max(1, this.guns)));
    this.rebuild();
  }

  setColour(colour: THREE.ColorRepresentation): void {
    this.flagMat.color.set(colour);
  }

  /** Take a hit. Returns true if that reduced it to ruins. */
  damage(amount: number): boolean {
    if (this.ruined) return false;
    this.sinceHit = 0;
    this.hp = Math.max(0, this.hp - amount);
    this.refreshBar();
    if (this.hp > 0) return false;
    this.showRuin(true);
    return true;
  }

  /** Per-frame upkeep. `contested`: a hostile ship is close enough to stop repairs. */
  update(dt: number, contested: boolean): void {
    this.sinceHit += dt;
    if (!contested && this.sinceHit > STRONGHOLD.repairDelay && this.hp < this.maxHp) {
      const was = this.ruined;
      this.hp = Math.min(this.maxHp, this.hp + STRONGHOLD.repairRate * dt);
      if (was) this.showRuin(false);
      this.refreshBar();
    }
  }

  /** Counts each gun's reload down; returns how many are ready to fire this frame. */
  gunsReady(dt: number, hasTarget: boolean): number {
    let n = 0;
    for (let i = 0; i < this.gunTimers.length; i++) {
      this.gunTimers[i] = Math.max(0, this.gunTimers[i] - dt);
      if (hasTarget && this.gunTimers[i] <= 0) {
        this.gunTimers[i] = STRONGHOLD.gunReload * (0.85 + Math.random() * 0.3);
        n++;
      }
    }
    return n;
  }

  private showRuin(ruined: boolean): void {
    this.body.scale.y = ruined ? 0.42 : 1;
    this.body.rotation.z = ruined ? 0.07 : 0;
  }

  private refreshBar(): void {
    const f = this.hp / this.maxHp;
    const show = f < 0.999;
    this.barBack.visible = this.barFill.visible = show;
    this.barFill.scale.set(Math.max(0.001, 5.6 * f), 0.42, 1);
    (this.barFill.material as THREE.SpriteMaterial).color.set(f > 0.5 ? 0x7ed957 : f > 0.25 ? 0xffc04d : 0xe23b3b);
  }

  private rebuild(): void {
    for (const child of [...this.body.children]) this.body.remove(child);
    this.top = buildStronghold(this.body, this.level, this.flagMat) * this.scale;
    this.body.scale.setScalar(1);
    this.group.scale.setScalar(this.scale);
    this.showRuin(false);
    const y = this.top / this.scale + 2.4;
    this.barBack.position.set(0, y, 0);
    this.barBack.scale.set(6, 0.8, 1);
    this.barFill.position.set(-2.8, y, 0);
    this.refreshBar();
    const r = (this.level === 0 ? 4.6 : this.level === 3 ? 7.5 : 6) * this.scale;
    this.collider.radius = r;
    this.collider.position.copy(this.site).setY(this.site.y + Math.min(this.top * 0.45, r * 0.7));
  }
}

/** A flat-ish spot near the shore, as close as it can get to the preferred side of the island. */
function findSite(island: Island, preferAngle: number, out: THREE.Vector3): THREE.Vector3 {
  let best = { x: 0, z: 0, h: 1, score: -Infinity };
  for (let i = 0; i < 24; i++) {
    const a = preferAngle + (i / 24) * Math.PI * 2;
    const off = Math.abs(Math.atan2(Math.sin(a - preferAngle), Math.cos(a - preferAngle)));
    const shore = island.shoreAt(a);
    for (const f of [0.8, 0.7, 0.6, 0.5]) {
      const x = Math.cos(a) * shore * f;
      const z = Math.sin(a) * shore * f;
      const h = island.heightAt(x, z);
      if (h < 0.5) continue;
      let slope = 0;
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) slope = Math.max(slope, Math.abs(island.heightAt(x + dx, z + dz) - h));
      const score = -off * 1.6 - Math.abs(h - 1.4) * 0.9 - slope * 1.8 + f * 2.5;
      if (score > best.score) best = { x, z, h, score };
    }
  }
  return out.set(island.center.x + best.x, Math.max(0.4, best.h), island.center.z + best.z);
}

const mats = {
  wall: toonMaterial(PALETTE.woodLight),
  wood: toonMaterial(PALETTE.wood),
  dark: toonMaterial(PALETTE.woodDark),
  thatch: toonMaterial(0xd9b75f),
  stone: toonMaterial(0xb9b2a6),
  stoneDark: toonMaterial(0x8e887d),
  roof: toonMaterial(0xb5523a),
  ground: toonMaterial(0xd8c088),
  iron: toonMaterial(0x33363c),
};

/** Build the model for a level into `root` (unit scale). Returns its height. */
function buildStronghold(root: THREE.Group, level: number, flagMat: THREE.Material): number {
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, outline = 0.05) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    if (outline > 0) addOutline(mesh, outline, PALETTE.outline);
    root.add(mesh);
    return mesh;
  };
  const flag = (x: number, y: number, z: number, h: number, size = 1) => {
    part(new THREE.CylinderGeometry(0.07, 0.09, h, 6), mats.dark, x, y + h / 2, z, 0.02);
    const geo = new THREE.PlaneGeometry(1.9 * size, 1.1 * size, 4, 1);
    geo.translate(0.95 * size, 0, 0);
    const cloth = new THREE.Mesh(geo, flagMat);
    cloth.position.set(x, y + h - 0.6 * size, z);
    cloth.rotation.y = 0.5;
    root.add(cloth);
  };
  const cannon = (x: number, y: number, z: number, yaw: number) => {
    const geo = new THREE.CylinderGeometry(0.2, 0.26, 1.8, 8);
    geo.rotateZ(Math.PI / 2);
    const barrel = part(geo, mats.iron, x, y, z, 0.03);
    barrel.rotation.y = yaw;
  };

  // A packed-earth footing hides whatever slope it stands on.
  const pad = level === 3 ? 8.6 : level === 0 ? 4.4 : 6.6;
  part(new THREE.CylinderGeometry(pad, pad + 0.8, 3, 20), mats.ground, 0, -1.4, 0, 0);

  // The hut is there at every level short of a fort.
  if (level < 3) {
    part(new THREE.BoxGeometry(3.6, 2.3, 3.2), mats.wall, 0, 1.25, 0);
    const roof = new THREE.ConeGeometry(3.3, 2.1, 4);
    roof.rotateY(Math.PI / 4);
    part(roof, mats.thatch, 0, 3.4, 0);
    part(new THREE.BoxGeometry(0.1, 1.6, 0.9), mats.dark, 1.82, 0.9, 0, 0);
    part(new THREE.CylinderGeometry(0.4, 0.4, 0.9, 8), mats.wood, 1.2, 0.55, 2.2, 0.03);
  }
  let top = 4.4;

  if (level === 1 || level === 2) {
    // palisade: a ring of sharpened stakes with a gap for the gate, facing the sea (+X)
    const stakes = 26;
    for (let i = 0; i < stakes; i++) {
      const a = (i / stakes) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.26) continue;
      const h = 2.5 + ((i * 7) % 3) * 0.22;
      const geo = new THREE.CylinderGeometry(0.1, 0.34, h, 5);
      part(geo, i % 2 ? mats.wood : mats.dark, Math.cos(a) * 5.4, h / 2 - 0.1, Math.sin(a) * 5.4, 0.03);
    }
  }
  if (level === 2) {
    // a stone watchtower with a gun on its platform
    part(new THREE.CylinderGeometry(1.5, 1.9, 6.4, 10), mats.stone, -1.2, 3.2, -3.1);
    part(new THREE.CylinderGeometry(2.1, 2.1, 0.5, 10), mats.stoneDark, -1.2, 6.6, -3.1);
    const cap = new THREE.ConeGeometry(2.3, 1.8, 10);
    part(cap, mats.roof, -1.2, 9.2, -3.1);
    for (const [dx, dz] of [[1.5, 1.5], [-1.5, 1.5], [1.5, -1.5], [-1.5, -1.5]]) part(new THREE.CylinderGeometry(0.09, 0.09, 1.7, 5), mats.dark, -1.2 + dx * 0.9, 7.7, -3.1 + dz * 0.9, 0);
    cannon(-0.2, 7.2, -3.1, 0);
    top = 10;
  }
  if (level === 3) {
    // curtain walls, corner towers, a keep, guns on the seaward wall
    const half = 6;
    for (const [x, z, w, d] of [[half, 0, 1.3, half * 2], [-half, 0, 1.3, half * 2], [0, half, half * 2, 1.3], [0, -half, half * 2, 1.3]] as const) {
      part(new THREE.BoxGeometry(w, 3.6, d), mats.stone, x, 1.7, z);
    }
    // crenellations on the seaward wall
    for (let i = -2; i <= 2; i++) part(new THREE.BoxGeometry(1.4, 0.7, 1), mats.stoneDark, half, 3.85, i * 2.3, 0.03);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        part(new THREE.CylinderGeometry(1.7, 1.95, 5.4, 10), mats.stone, sx * half, 2.6, sz * half);
        part(new THREE.CylinderGeometry(2.05, 2.05, 0.6, 10), mats.stoneDark, sx * half, 5.6, sz * half);
        if (sx > 0) part(new THREE.ConeGeometry(2.1, 1.7, 10), mats.roof, sx * half, 6.8, sz * half);
      }
    }
    part(new THREE.BoxGeometry(1.5, 2.4, 2.4), mats.dark, half + 0.05, 1.2, 0, 0); // gate
    part(new THREE.BoxGeometry(4.6, 7, 4.6), mats.stone, -1.4, 3.5, 0);
    part(new THREE.BoxGeometry(5.2, 0.6, 5.2), mats.stoneDark, -1.4, 7.2, 0);
    const roof = new THREE.ConeGeometry(3.7, 2.6, 4);
    roof.rotateY(Math.PI / 4);
    part(roof, mats.roof, -1.4, 8.8, 0);
    for (const z of [-3.4, 0, 3.4]) cannon(half + 0.6, 3.9, z + 1.15, 0);
    flag(-1.4, 10, 0, 4.2, 1.5);
    return 14;
  }
  flag(level === 2 ? -1.2 : -1.6, level === 2 ? 10 : 0, level === 2 ? -3.1 : -1.9, level === 2 ? 3 : 6.4, level === 0 ? 1 : 1.2);
  return Math.max(top, level === 2 ? 13 : 6.6);
}

export interface TerritoryHooks {
  /** A stronghold gun fires. `owner` is its collider id. */
  fire(from: THREE.Vector3, velocity: THREE.Vector3, owner: number): void;
  /** Its walls have just been reduced to ruins. */
  ruined(s: Stronghold): void;
  /** A ruined stronghold has been taken by the other side (`by`). */
  captured(s: Stronghold, by: Side): void;
  /** Something the UI shows has changed (level, owner, a new outpost). */
  changed(): void;
}

/** A ship as the territory rules see it. */
export interface ShipSight {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
}

/**
 * Who holds which island. The player starts with a hut on a home island and
 * loses the game if it is taken; the raiders have a home of their own. Either
 * side's strongholds can be upgraded, shot to ruins and captured.
 */
export class Territory {
  readonly group = new THREE.Group();
  readonly strongholds: Stronghold[] = [];
  readonly home: Stronghold;
  /** The raiders' home island, if the map has a port for them. */
  readonly enemyHome: Stronghold | null = null;
  /** The player's stores: income from held islands lands here, and building draws on it from anywhere. */
  readonly stores = emptyStock();
  private incomeTimer = 0;
  private playerColour: THREE.ColorRepresentation = 0xd8343a;

  constructor(
    private readonly islands: Island[],
    private readonly hooks: TerritoryHooks,
  ) {
    this.group.name = 'territory';
    // Home: the unsettled island nearest the start.
    const free = islands.filter((i) => !i.port);
    const homeIsland = [...(free.length ? free : islands)].sort((a, b) => a.center.length() - b.center.length())[0];
    homeIsland.owner = 'player';
    this.home = this.add(homeIsland, 'player', true, Math.atan2(-homeIsland.center.z, -homeIsland.center.x));

    // The raiders hold the port furthest from it.
    const ports = islands.filter((i) => i.port && i !== homeIsland);
    if (ports.length) {
      const far = ports.sort((a, b) => b.center.distanceTo(homeIsland.center) - a.center.distanceTo(homeIsland.center))[0];
      const portAngle = Math.atan2(far.port!.z - far.center.z, far.port!.x - far.center.x);
      this.enemyHome = this.add(far, 'npc', true, portAngle + 1.1);
      this.enemyHome.setLevel(2);
      // ...and keep a stockade on every other port, each of which can be taken from them
      for (const port of ports.slice(1)) {
        const a = Math.atan2(port.port!.z - port.center.z, port.port!.x - port.center.x);
        this.add(port, 'npc', false, a + 1.1).setLevel(1);
      }
    }
  }

  private add(island: Island, side: Side, home: boolean, angle: number): Stronghold {
    const s = new Stronghold(island, STRONGHOLD_ID_BASE + this.islands.indexOf(island), side, home, angle);
    s.setColour(side === 'player' ? this.playerColour : 0xffffff);
    this.strongholds.push(s);
    this.group.add(s.group);
    return s;
  }

  at(island: Island): Stronghold | null {
    return this.strongholds.find((s) => s.island === island) ?? null;
  }

  setPlayerColour(colour: THREE.ColorRepresentation): void {
    this.playerColour = colour;
    for (const s of this.strongholds) if (s.side === 'player') s.setColour(colour);
  }

  /** The island the ship is close enough to build on, if any. */
  islandInReach(ship: THREE.Vector3): Island | null {
    let best: Island | null = null;
    let bestD = Infinity;
    for (const island of this.islands) {
      const d = Math.hypot(ship.x - island.center.x, ship.z - island.center.z) - island.radius;
      if (d < STRONGHOLD.buildRange && d < bestD) {
        best = island;
        bestD = d;
      }
    }
    return best;
  }

  /** What the player could build on an island right now: founding an outpost, or the next upgrade. */
  offer(island: Island): { act: 'build' | 'upgrade'; label: string; cost: Stock } | null {
    const s = this.at(island);
    if (!s) return island.owner === 'none' ? { act: 'build', label: 'Build an outpost', cost: STRONGHOLD.outpostCost } : null;
    if (s.side !== 'player' || s.level >= LEVELS.length - 1) return null;
    return { act: 'upgrade', label: `Upgrade to ${LEVELS[s.level + 1].name}`, cost: LEVELS[s.level + 1].cost };
  }

  /** Units a minute coming in from the islands the player holds. */
  get incomePerMinute(): number {
    return (this.strongholds.filter((s) => s.side === 'player' && !s.ruined).reduce((n, s) => n + 1 + s.level, 0) * 60) / STRONGHOLD.incomeEvery;
  }

  /**
   * Build or upgrade on an island. An upgrade can be ordered from anywhere and
   * is paid from the stores; a ship alongside (`hold`) pays from its hold
   * first, and is needed to found a new outpost.
   */
  build(island: Island, hold: Hold | null): boolean {
    const offer = this.offer(island);
    if (!offer || (offer.act === 'build' && !hold) || !canAfford(offer.cost, this.stores, hold)) return false;
    pay(offer.cost, this.stores, hold);
    const s = this.at(island);
    if (s) s.setLevel(s.level + 1);
    else {
      island.owner = 'player';
      this.add(island, 'player', false, Math.atan2(-island.center.z, -island.center.x));
    }
    this.hooks.changed();
    return true;
  }

  colliders(): Collider[] {
    return this.strongholds.filter((s) => !s.ruined).map((s) => s.collider);
  }

  owns(colliderId: number): boolean {
    return colliderId >= STRONGHOLD_ID_BASE && colliderId < STRONGHOLD_ID_END;
  }

  /** Which side a stronghold's shot came from, from its owner id. */
  sideOf(owner: number): Side | null {
    return this.strongholds.find((s) => s.id === owner)?.side ?? null;
  }

  /** A shot struck a stronghold's collider. Friendly fire does nothing. */
  hit(colliderId: number, kind: number, by: Side | null): Stronghold | null {
    const s = this.strongholds.find((x) => x.id === colliderId);
    if (!s || !by || by === s.side) return null;
    if (s.damage(STRONGHOLD.damage[kind] ?? STRONGHOLD.damage[0])) this.hooks.ruined(s);
    return s;
  }

  /** A shot landed on the ground: one close under the walls counts for half. */
  landed(at: THREE.Vector3, kind: number, by: Side | null): void {
    if (!by) return;
    for (const s of this.strongholds) {
      if (s.side === by || s.ruined) continue;
      if (Math.hypot(at.x - s.site.x, at.z - s.site.z) > s.collider.radius + STRONGHOLD.nearMiss) continue;
      if (s.damage((STRONGHOLD.damage[kind] ?? STRONGHOLD.damage[0]) * 0.5)) this.hooks.ruined(s);
    }
  }

  /**
   * @param friends the player's ships afloat (flagship and escorts)
   * @param raiders the enemy's ships afloat
   */
  update(dt: number, friends: ShipSight[], raiders: ShipSight[], hostile: boolean): void {
    // income from the islands the player holds
    if (hostile) this.incomeTimer += dt;
    if (this.incomeTimer >= STRONGHOLD.incomeEvery) {
      this.incomeTimer -= STRONGHOLD.incomeEvery;
      for (const s of this.strongholds) {
        if (s.side !== 'player' || s.ruined) continue;
        const total = RESOURCE_IDS.reduce((n, id) => n + s.island.capacity[id], 0) || 1;
        for (let u = 0; u < 1 + s.level; u++) {
          for (const id of RESOURCE_IDS) s.yieldAcc[id] += s.island.capacity[id] / total;
          const pick = RESOURCE_IDS.reduce((a: ResourceId, b) => (s.yieldAcc[b] > s.yieldAcc[a] ? b : a));
          s.yieldAcc[pick] -= 1;
          this.stores[pick]++;
        }
      }
      this.hooks.changed();
    }

    for (let i = this.strongholds.length - 1; i >= 0; i--) {
      const s = this.strongholds[i];
      let foe: ShipSight = _nobody;
      let range = Infinity;
      for (const ship of s.side === 'player' ? raiders : friends) {
        if (!ship.alive || !hostile) continue;
        const d = Math.hypot(ship.position.x - s.site.x, ship.position.z - s.site.z);
        if (d < range) {
          range = d;
          foe = ship;
        }
      }
      s.update(dt, range < STRONGHOLD.captureRange);

      // guns
      const ready = s.gunsReady(dt, !s.ruined && range < STRONGHOLD.gunRange);
      for (let g = 0; g < ready; g++) {
        s.muzzle(_from);
        const lead = range / STRONGHOLD.gunSpeed;
        const stray = range * STRONGHOLD.gunScatter;
        _to.copy(foe.position).addScaledVector(foe.velocity, lead);
        _to.x += (Math.random() - 0.5) * 2 * stray;
        _to.z += (Math.random() - 0.5) * 2 * stray;
        _to.y = 1;
        this.hooks.fire(_from, ballisticVelocity(_from, _to, STRONGHOLD.gunSpeed, _vel), s.id);
      }

      // capture
      if (s.ruined && range < STRONGHOLD.captureRange) s.capture += dt;
      else s.capture = Math.max(0, s.capture - dt * 0.5);
      if (s.capture >= STRONGHOLD.captureTime) this.capture(s, i);
    }
  }

  private capture(s: Stronghold, index: number): void {
    s.capture = 0;
    const by: Side = s.side === 'npc' ? 'player' : 'npc';
    if (s.side === 'npc') {
      // the player takes it over, a level down from the fight
      s.side = 'player';
      s.island.owner = 'player';
      s.setColour(this.playerColour);
      s.setLevel(Math.max(0, s.level - 1));
    } else if (s.island.port) {
      // a port changes hands rather than burning
      s.side = 'npc';
      s.island.owner = 'npc';
      s.setColour(0xffffff);
      s.setLevel(Math.max(0, s.level - 1));
    } else if (!s.home) {
      // an outpost is burned to the ground
      s.island.owner = 'none';
      this.group.remove(s.group);
      this.strongholds.splice(index, 1);
    }
    this.hooks.captured(s, by);
    this.hooks.changed();
  }
}

const _nobody: ShipSight = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: false };
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _vel = new THREE.Vector3();
