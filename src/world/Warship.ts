import * as THREE from 'three';
import { shunRocks } from './Grounding';
import { Broadside, BROADSIDE, BroadsideShot } from '../combat/Broadside';
import type { Collider } from '../combat/ProjectileSystem';
import { ballisticVelocity } from '../combat/ballistics';
import { WaveField } from '../ocean/waves';
import { DesignedShip } from '../ship/DesignedShip';
import { cloneDesign, HullDesign, PRESETS, sanitizeDesign } from '../ship/HullDesign';
import { MAST } from '../ship/Masts';
import type { Island } from './Islands';
import { ECONOMY, ResourceId } from './Resources';
import { Wind } from './Wind';

/** Collider ids of warships: 1000 up (the player's flagship is 0, barrels 100+, strongholds 300+, weather 700+, masts 2000+). */
export const WARSHIP_ID_BASE = 1000;
export const WARSHIP_ID_END = 2000;
/** Online: a human captain's flagship, as the other copies of the game see her, is this plus her faction id. */
export const HUMAN_ID_BASE = 1900;
let nextId = 0;
/** A fresh collider id for a new warship. */
export function warshipId(): number {
  return WARSHIP_ID_BASE + (nextId++ % (HUMAN_ID_BASE - WARSHIP_ID_BASE));
}

export const ENEMY = {
  hp: 100,
  /** Damage per hit by projectile kind: swivel shot, cannon shell. */
  damage: [7, 16],
  /** Starts a fight when the player comes this close (m), and gives up beyond the second figure. */
  engageRange: 150,
  loseRange: 230,
  /** Distance it tries to hold while trading broadsides (m). */
  standoff: 60,
  /** Distance it holds from a stronghold it is bombarding (m). */
  raidStandoff: 85,
  /** How far its shots scatter (radians). */
  scatter: THREE.MathUtils.degToRad(3.2),
  /** Seconds a wreck takes to go down, and until the next one sails in. */
  sinkTime: 7,
  respawnTime: 25,
  /** Hull repairs start this long after the last hit (s), at this rate (hp/s). */
  repairDelay: 12,
  repairRate: 1.5,
  /** Patrol circle (m) around the map centre. */
  patrolRadius: 190,
};

export interface WarshipHooks {
  /** A shot leaves one of its guns. */
  fire(ship: Warship, position: THREE.Vector3, direction: THREE.Vector3): void;
  /** It has just been sunk. */
  sunk(ship: Warship): void;
  /** Take `n` of a resource from her owner's stores (shot for the guns, timber for repairs). False if they cannot pay. */
  pay(ship: Warship, id: ResourceId, n: number): boolean;
}

export interface WarshipOptions {
  /** Collider id, also the owner id of its shots. */
  id: number;
  name: string;
  /** Whose ship she is (a faction id). */
  faction: number;
  colour: THREE.ColorRepresentation;
  /** Raiders and captains' flagships are replaced after a while; escorts are gone for good. */
  respawn: boolean;
  /** Where a replacement appears (a captain's home berth). Without it: out on the patrol circle. */
  berth?: () => { x: number; z: number; heading: number } | null;
  /** A captain's own ship, rather than an escort. */
  flagship?: boolean;
  /** Index into the shipyard presets. */
  preset?: number;
  /** Or a design of the player's own. */
  design?: HullDesign;
  /** Online: sailed by another copy of the game (see `Warship.remote`). */
  remote?: boolean;
}

/**
 * A ship that sails and fights on its own. The raiders' *Marauder* patrols
 * the middle of the map, closes with any enemy that comes near and trades
 * broadsides; the player's escorts follow the flagship or go where the chart
 * sends them, and fight what they meet. Either kind can be sent to shell a
 * stronghold. They are built from shipyard designs and sail on the same
 * physics as the player.
 */
export class Warship {
  readonly ship: DesignedShip;
  readonly name: string;
  readonly id: number;
  readonly faction: number;
  readonly flagship: boolean;
  /** Chart order: sail here and hold. */
  order: THREE.Vector3 | null = null;
  /** Chained orders: where to go after `order`, in turn. */
  queue: THREE.Vector3[] = [];
  /** With an order: fight whatever comes in range on the way (true), or sail past it, firing only as the guns bear (false). */
  attackMove = true;
  /** A zone to patrol when there is no order: she sails round inside it and fights what enters. */
  patrol: { x: number; z: number; r: number } | null = null;
  private patrolLeg = 0;
  /** With no order: keep station on this point (the flagship). */
  escort: THREE.Vector3 | null = null;
  hp = ENEMY.hp;
  readonly maxHp: number;
  /** 'patrol' | 'fight' | 'raid' while afloat; 'sinking' on the way down; 'gone' until the next one arrives. */
  state: 'patrol' | 'fight' | 'raid' | 'sinking' | 'gone' = 'patrol';
  /** A place ashore to bombard (a stronghold). While set, it sails there instead of patrolling. */
  raidTarget: THREE.Vector3 | null = null;
  sunkCount = 0;
  /**
   * Online: she is sailed by another copy of the game (a friend's flagship,
   * or any ship when this copy is not the host). She keeps floating on the
   * local sea but goes where the network says, and takes no damage here.
   */
  remote = false;
  private readonly net = { x: 0, z: 0, heading: 0, vx: 0, vz: 0, sail: 0, rudder: 0, age: 0, fresh: false };
  private sinceHit = 99;
  private woodDue = 0;
  /** How much of her the local player can see: 0 hidden in the fog of war, 1 in plain sight. */
  reveal = 1;
  /** True once she has been put on the water somewhere. */
  private placed = false;
  private fadeMats: THREE.Material[] | null = null;
  private readonly fadeOutlines: THREE.Object3D[] = [];
  /** Which way she circles a target: chosen so the side that carries her guns faces it. */
  private circle = 1;
  private retired = false;

  private readonly battery: Broadside;
  private readonly shots: BroadsideShot[] = [];
  private timer = 0;
  private waypoint = 0;
  readonly collider: Collider;
  private readonly dest = new THREE.Vector3();

  constructor(
    waves: WaveField,
    wind: Wind,
    private readonly islands: Island[],
    private readonly hooks: WarshipHooks,
    private readonly opts: WarshipOptions,
  ) {
    this.name = opts.name;
    this.id = opts.id;
    this.faction = opts.faction;
    this.flagship = !!opts.flagship;
    const design = sanitizeDesign({ ...cloneDesign(opts.design ?? PRESETS[opts.preset ?? 1]), name: this.name });
    this.ship = new DesignedShip(design, waves, wind, opts.colour, opts.id);
    // bigger hulls take more sinking
    this.maxHp = Math.round(ENEMY.hp * THREE.MathUtils.clamp(design.length / 11, 0.6, 2.2));
    this.hp = this.maxHp;
    this.ship.group.name = 'warship';
    this.battery = new Broadside(this.ship.group, this.ship.gunMounts, waves);
    this.battery.ribbon.visible = false; // NPCs show no aiming ribbon
    // guns on one side only: circle the other way round, so that side bears
    const starboard = this.battery.guns.filter((g) => g.side === 1).length;
    if (starboard === 0 && this.battery.guns.length > 0) this.circle = -1;
    this.collider = { id: opts.id, position: this.ship.body.position, radius: Math.max(1.7, this.ship.length * 0.36) };
    if (opts.remote) {
      this.remote = true;
      this.ship.spendWood = () => false; // her masts go up when her owner says so
    } else if (opts.respawn && !opts.berth) this.spawn();
  }

  /** Put it on the water somewhere, ready to sail. */
  placeAt(x: number, z: number, heading: number): void {
    this.placed = true;
    this.ship.body.placeOnWater(x, z, heading);
    this.ship.body.velocity.set(0, 0, 0);
    this.ship.sail = 0.4;
    this.ship.group.visible = true;
    this.ship.rig.restore();
    this.ship.crew.reset();
    this.ship.syncVisuals(0);
    this.hp = this.maxHp;
    this.state = 'patrol';
    this.timer = 0;
  }

  get group(): THREE.Group {
    return this.ship.group;
  }

  get position(): THREE.Vector3 {
    return this.ship.body.position;
  }

  get alive(): boolean {
    return this.state === 'patrol' || this.state === 'fight' || this.state === 'raid';
  }

  /**
   * Set how much of her shows (see `reveal`). She fades in and out at the edge
   * of what the player's ships and islands can see. Call every frame.
   */
  showAs(k: number): void {
    const group = this.ship.group;
    group.visible = this.placed && this.state !== 'gone' && k > 0.02;
    if (k === this.reveal) return;
    this.reveal = k;
    if (!this.fadeMats) {
      const mats = new Set<THREE.Material>();
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (o.name.endsWith('-outline')) this.fadeOutlines.push(o);
        else for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
      });
      this.fadeMats = [...mats];
    }
    const solid = k >= 1;
    for (const m of this.fadeMats) {
      m.transparent = !solid;
      m.opacity = solid ? 1 : k;
      m.depthWrite = solid || k > 0.5;
    }
    // outlines share their material between ships, so they simply wait until she is solid
    for (const o of this.fadeOutlines) o.visible = solid;
  }

  /** Go down for good: her captain is out of the game. */
  scuttle(): void {
    this.retired = true;
    if (!this.alive) return;
    this.hp = 0;
    this.state = 'sinking';
    this.timer = 0;
  }

  /** True once she is gone and will not be replaced. */
  get lost(): boolean {
    return !this.remote && this.state === 'gone' && (this.retired || !this.opts.respawn);
  }

  /** Colliders for the projectile sim: nothing while it is sinking or gone. */
  colliders(): Collider[] {
    return this.alive ? this.ship.rig.colliders([this.collider]) : [];
  }

  /** A projectile struck one of her mast hitboxes. Returns true if the mast came down. */
  hitMast(mast: number, kind: number): boolean {
    return this.alive && this.ship.rig.hit(mast, kind);
  }

  /** A projectile of `kind` hit it. Returns true if that sank it. */
  hit(kind: number): boolean {
    if (!this.alive) return false;
    this.sinceHit = 0;
    // a shell through the hull sometimes carries rigging away with it
    if (kind === 1 && Math.random() < MAST.hullHitChance) {
      const m = this.ship.rig.nearest((Math.random() - 0.5) * this.ship.length);
      if (m >= 0) this.ship.rig.hit(m, 0);
    }
    this.hp -= ENEMY.damage[kind] ?? ENEMY.damage[0];
    if (this.hp > 0) return false;
    this.hp = 0;
    this.state = 'sinking';
    this.timer = 0;
    this.sunkCount++;
    this.hooks.sunk(this);
    return true;
  }

  /** She struck a rock: the hull takes `amount` like a shot would. Returns true if that sank her. */
  scrape(amount: number): boolean {
    if (!this.alive || amount <= 0) return false;
    this.hp -= amount;
    if (this.hp > 0) return false;
    this.hp = 0;
    this.state = 'sinking';
    this.timer = 0;
    this.sunkCount++;
    this.hooks.sunk(this);
    return true;
  }

  /** Fixed-step physics. */
  physicsStep(h: number): void {
    if (this.alive) this.ship.physicsStep(h);
  }

  /**
   * Per-frame: steer, fight, sink or wait.
   * @param foe the nearest enemy ship's position, if there is one afloat
   * @param hostile false in menus: it only patrols
   */
  update(dt: number, foe: THREE.Vector3 | null, hostile: boolean): void {
    const player = foe ?? _far;
    const ship = this.ship;
    if (this.state === 'gone') {
      this.timer += dt;
      if (!this.remote && this.opts.respawn && !this.retired && this.timer > ENEMY.respawnTime) {
        const berth = this.opts.berth?.();
        if (berth) this.placeAt(berth.x, berth.z, berth.heading);
        else if (!this.opts.berth) this.spawn(foe ?? undefined);
        else this.timer = ENEMY.respawnTime - 5; // no home to come back to yet: look again shortly
      }
      return;
    }
    if (this.state === 'sinking') {
      this.timer += dt;
      const k = this.timer / ENEMY.sinkTime;
      // settle by the stern and roll over as she goes down
      ship.group.position.y -= dt * (0.25 + k * 1.1);
      ship.group.rotateZ(dt * 0.16);
      ship.group.rotateX(dt * 0.07);
      if (k >= 1) {
        this.state = 'gone';
        this.timer = 0;
        ship.group.visible = false;
      }
      return;
    }

    if (this.remote) return this.followNet(dt);

    // the crew patch the hull once the shooting stops
    this.sinceHit += dt;
    if (this.sinceHit > ENEMY.repairDelay && this.hp < this.maxHp) {
      // repairs take timber from her owner's stores
      this.woodDue += (ENEMY.repairRate * dt) / ECONOMY.hullPerWood;
      if (this.woodDue < 1 || this.hooks.pay(this, 'wood', 1)) {
        if (this.woodDue >= 1) this.woodDue -= 1;
        this.hp = Math.min(this.maxHp, this.hp + ENEMY.repairRate * dt);
      } else this.woodDue = 1;
    }

    const pos = this.position;
    const range = Math.hypot(player.x - pos.x, player.z - pos.z);
    // on to the next waypoint of a chained order
    if (this.order && this.queue.length && Math.hypot(this.order.x - pos.x, this.order.z - pos.z) < 36) this.order = this.queue.shift()!;
    // under a plain move order she does not stop to fight; on patrol she fights what comes into her zone
    const zone = this.order ? null : this.patrol;
    const mayEngage = this.order ? this.attackMove : !zone || Math.hypot(player.x - zone.x, player.z - zone.z) < zone.r + 50;
    if (this.state === 'patrol' && hostile && foe && mayEngage && range < ENEMY.engageRange) this.state = 'fight';
    else if (this.state === 'fight' && (!hostile || !foe || !mayEngage || range > ENEMY.loseRange)) this.state = 'patrol';
    // A raid goes ahead until the player comes close enough to fight instead.
    if (this.state === 'patrol' && hostile && this.raidTarget) this.state = 'raid';
    else if (this.state === 'raid' && (!hostile || !this.raidTarget)) this.state = 'patrol';
    else if (this.state === 'raid' && foe && range < ENEMY.engageRange) this.state = 'fight';
    const raid = this.state === 'raid' ? this.raidTarget : null;

    // Where to head.
    let cruise = 0.55;
    const want = _want.set(0, 0, 0);
    if (this.state === 'fight' || raid) {
      // circle the player (or the stronghold) at standoff range, which keeps it on the beam
      const focus = raid ?? player;
      const fr = Math.hypot(focus.x - pos.x, focus.z - pos.z) || 1;
      const rx = (pos.x - focus.x) / fr;
      const rz = (pos.z - focus.z) / fr;
      const k = THREE.MathUtils.clamp((fr - (raid ? ENEMY.raidStandoff : ENEMY.standoff)) / 40, -1, 1);
      want.set(-rz * this.circle - rx * k, 0, rx * this.circle - rz * k);
    } else if (this.order || zone || this.escort) {
      // go where the chart says, round the patrol zone, or keep station on the flagship; loiter in a slow circle on arrival
      let to = this.order ?? this.escort!;
      if (!this.order && zone) {
        const a = (this.patrolLeg / 5) * Math.PI * 2;
        to = _leg.set(zone.x + Math.cos(a) * zone.r * 0.6, 0, zone.z + Math.sin(a) * zone.r * 0.6);
        if (Math.hypot(to.x - pos.x, to.z - pos.z) < 34) this.patrolLeg = (this.patrolLeg + 1) % 5;
      }
      const dx = to.x - pos.x;
      const dz = to.z - pos.z;
      const left = Math.hypot(dx, dz) || 1;
      const hold = this.order ? 30 : zone ? 6 : 42;
      const k = THREE.MathUtils.clamp((left - hold) / 30, -0.4, 1);
      want.set(dx / left, 0, dz / left).multiplyScalar(k).add(_v.set(-dz / left, 0, dx / left).multiplyScalar(1 - Math.abs(k)));
      cruise = left > hold + 90 ? 0.9 : left > hold + 15 ? 0.6 : 0.22;
    } else {
      const a = (this.waypoint / 6) * Math.PI * 2;
      this.dest.set(Math.cos(a) * ENEMY.patrolRadius, 0, Math.sin(a) * ENEMY.patrolRadius);
      if (Math.hypot(this.dest.x - pos.x, this.dest.z - pos.z) < 40) this.waypoint = (this.waypoint + 1) % 6;
      want.set(this.dest.x - pos.x, 0, this.dest.z - pos.z).normalize();
    }
    // keep off the islands
    for (const island of this.islands) {
      const dx = pos.x - island.center.x;
      const dz = pos.z - island.center.z;
      const d = Math.hypot(dx, dz);
      const clear = d - island.radius;
      const keepOff = raid ? 38 : 70; // a raider has to come in close to shell the shore
      if (clear < keepOff) want.addScaledVector(_v.set(dx / d, 0, dz / d), ((keepOff - clear) / keepOff) * 3);
    }
    const fwd = ship.body.forward(_fwd).setY(0).normalize();
    shunRocks(pos, fwd, want, this.islands);
    want.normalize();
    const turn = fwd.x * want.z - fwd.z * want.x;
    const ahead = fwd.dot(want);
    const steer = ahead < -0.2 ? Math.sign(turn || 1) : THREE.MathUtils.clamp(turn * 2.5, -1, 1);
    const sailTarget = this.state === 'fight' ? 0.7 : raid ? 0.5 : cruise;
    ship.control(dt, ship.sail < sailTarget - 0.03 ? 1 : ship.sail > sailTarget + 0.03 ? -1 : 0, steer);
    ship.syncVisuals(dt);
    ship.group.updateMatrixWorld();

    // Guns: in a fight or a raid, and at any enemy she passes within range of.
    if (this.state === 'fight' || raid || (hostile && foe && range < BROADSIDE.maxRange)) {
      const mark = raid ?? player;
      const reach = Math.hypot(mark.x - pos.x, mark.z - pos.z);
      this.battery.aimAt(mark, dt);
      // every shell is paid for in metal
      if (!this.battery.outOfArc && !this.battery.outOfRange && reach < BROADSIDE.maxRange && this.battery.ready && this.hooks.pay(this, 'salvage', this.battery.loaded * ECONOMY.shotMetal)) this.battery.tryFire(true);
    }
    this.shots.length = 0;
    this.battery.update(dt, this.shots);
    for (const shot of this.shots) {
      // shelling a stronghold: lob each shot at the walls themselves, over the beach in front of them
      if (raid) {
        _mark.copy(raid).setY(raid.y + 2.5);
        shot.direction.copy(ballisticVelocity(shot.position, _mark, BROADSIDE.muzzleSpeed, _vel)).normalize();
      }
      // NPC gunnery is honest but not perfect
      const yaw = (Math.random() - 0.5) * 2 * ENEMY.scatter;
      shot.direction.applyAxisAngle(_up, yaw);
      shot.direction.y += (Math.random() - 0.5) * ENEMY.scatter;
      shot.direction.normalize();
      this.hooks.fire(this, shot.position, shot.direction);
    }
  }

  /** Where she is and how she fares, for the other copies of an online match. */
  netState(): number[] {
    const b = this.ship.body;
    const fwd = b.forward(_fwd);
    const code = NET_STATES.indexOf(this.state);
    return [this.id, r1(b.position.x), r1(b.position.z), r2(Math.atan2(-fwd.x, -fwd.z)), r1(b.velocity.x), r1(b.velocity.z), r2(this.ship.sail), r2(this.ship.rudder), Math.round((this.hp / this.maxHp) * 100), code, this.ship.rig.downMask];
  }

  /** Online: take her state from the copy of the game that sails her (same layout as `netState`). */
  applyNet(a: number[]): void {
    const [, x, z, heading, vx, vz, sail, rudder, hp, code, masts] = a;
    const state = NET_STATES[code] ?? 'patrol';
    const afloat = state !== 'sinking' && state !== 'gone';
    if (afloat && (!this.alive || !this.placed)) {
      this.placeAt(x, z, heading); // a fresh ship
    } else if (!afloat && this.alive) {
      this.state = 'sinking';
      this.timer = 0;
      this.hooks.sunk(this);
    }
    if (afloat) this.state = state;
    this.hp = (hp / 100) * this.maxHp;
    for (let i = 0; i < this.ship.rig.count; i++) this.ship.rig.setDown(i, (masts & (1 << i)) !== 0);
    Object.assign(this.net, { x, z, heading, vx, vz, sail, rudder, age: 0, fresh: true });
  }

  /** A remote ship: ride the local waves, but be pulled to where her owner says she is. */
  private followNet(dt: number): void {
    const n = this.net;
    const ship = this.ship;
    const b = ship.body;
    if (n.fresh) {
      n.age += dt;
      const tx = n.x + n.vx * n.age;
      const tz = n.z + n.vz * n.age;
      const ex = tx - b.position.x;
      const ez = tz - b.position.z;
      if (ex * ex + ez * ez > 45 * 45) {
        b.placeOnWater(tx, tz, n.heading);
        b.velocity.set(n.vx, 0, n.vz);
      } else {
        const k = 1 - Math.exp(-dt * 3.5);
        b.position.x += ex * k;
        b.position.z += ez * k;
        b.velocity.x += (n.vx - b.velocity.x) * k;
        b.velocity.z += (n.vz - b.velocity.z) * k;
        const fwd = b.forward(_fwd);
        const off = Math.atan2(Math.sin(n.heading - Math.atan2(-fwd.x, -fwd.z)), Math.cos(n.heading - Math.atan2(-fwd.x, -fwd.z)));
        b.quaternion.premultiply(_q.setFromAxisAngle(_up, off * k));
      }
      ship.sail = n.sail;
    }
    ship.control(dt, 0, n.rudder);
    ship.syncVisuals(dt);
    ship.group.updateMatrixWorld();
  }

  /** Bring a fresh ship in on the patrol circle, on the far side from the player if there is one. */
  private spawn(player?: THREE.Vector3): void {
    const away = player ? Math.atan2(-player.z, -player.x) : 0.9;
    let best = { x: ENEMY.patrolRadius, z: 0, score: -Infinity };
    for (let i = 0; i < 12; i++) {
      const a = away + (i / 12) * Math.PI * 2;
      const x = Math.cos(a) * ENEMY.patrolRadius;
      const z = Math.sin(a) * ENEMY.patrolRadius;
      const clear = Math.min(...this.islands.map((isl) => Math.hypot(x - isl.center.x, z - isl.center.z) - isl.radius));
      const far = player ? Math.hypot(x - player.x, z - player.z) : 200;
      const score = Math.min(clear, 90) + Math.min(far, 260) * 0.4;
      if (score > best.score) best = { x, z, score };
    }
    const heading = Math.atan2(-best.z, best.x) + Math.PI / 2;
    this.placed = true;
    this.ship.body.placeOnWater(best.x, best.z, heading);
    this.ship.body.velocity.set(0, 0, 0);
    this.ship.sail = 0.5;
    this.ship.group.visible = true;
    this.ship.rig.restore();
    this.ship.crew.reset();
    this.ship.syncVisuals(0);
    this.hp = this.maxHp;
    this.state = 'patrol';
    this.timer = 0;
    this.waypoint = Math.round(((Math.atan2(best.z, best.x) / (Math.PI * 2)) * 6 + 7) % 6) % 6;
  }
}

const NET_STATES: Warship['state'][] = ['patrol', 'fight', 'raid', 'sinking', 'gone'];
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const _q = new THREE.Quaternion();
const _leg = new THREE.Vector3();
const _want = new THREE.Vector3();
const _mark = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _far = new THREE.Vector3(1e6, 0, 1e6);
