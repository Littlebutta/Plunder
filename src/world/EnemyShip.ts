import * as THREE from 'three';
import { Broadside, BROADSIDE, BroadsideShot } from '../combat/Broadside';
import type { Collider } from '../combat/ProjectileSystem';
import { WaveField } from '../ocean/waves';
import { DesignedShip } from '../ship/DesignedShip';
import { cloneDesign, PRESETS, sanitizeDesign } from '../ship/HullDesign';
import type { Island } from './Islands';
import { Wind } from './Wind';

/** Collider id of the enemy ship (the player is 0, barrels 100+, weather 700+). */
export const ENEMY_ID = 50;

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
  /** Patrol circle (m) around the map centre. */
  patrolRadius: 190,
};

export interface EnemyHooks {
  /** A shot leaves one of its guns. */
  fire(position: THREE.Vector3, direction: THREE.Vector3): void;
  /** It has just been sunk. */
  sunk(at: THREE.Vector3): void;
}

/**
 * An NPC raider: a white-sailed sloop that patrols the middle of the map,
 * closes with the player when they come near, and trades broadsides. It is
 * built from a shipyard design and sails on the same physics as the player,
 * so anything the shipyard can draw can be an enemy later.
 *
 * It can be shot (hull points), sinks, and a fresh one sails in after a while.
 */
export class EnemyShip {
  readonly ship: DesignedShip;
  readonly name = 'Marauder';
  hp = ENEMY.hp;
  readonly maxHp = ENEMY.hp;
  /** 'patrol' | 'fight' | 'raid' while afloat; 'sinking' on the way down; 'gone' until the next one arrives. */
  state: 'patrol' | 'fight' | 'raid' | 'sinking' | 'gone' = 'patrol';
  /** A place ashore to bombard (a stronghold). While set, it sails there instead of patrolling. */
  raidTarget: THREE.Vector3 | null = null;
  sunkCount = 0;

  private readonly battery: Broadside;
  private readonly shots: BroadsideShot[] = [];
  private timer = 0;
  private waypoint = 0;
  private readonly collider: Collider;
  private readonly dest = new THREE.Vector3();

  constructor(
    waves: WaveField,
    wind: Wind,
    private readonly islands: Island[],
    private readonly hooks: EnemyHooks,
    colour: THREE.ColorRepresentation = 0xffffff,
  ) {
    const design = sanitizeDesign({ ...cloneDesign(PRESETS[1]), name: this.name });
    this.ship = new DesignedShip(design, waves, wind, colour);
    this.ship.group.name = 'enemy-ship';
    this.battery = new Broadside(this.ship.group, this.ship.gunMounts, waves);
    this.battery.ribbon.visible = false; // NPCs show no aiming ribbon
    this.collider = { id: ENEMY_ID, position: this.ship.body.position, radius: Math.max(1.7, this.ship.length * 0.36) };
    this.spawn();
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

  /** Colliders for the projectile sim: nothing while it is sinking or gone. */
  colliders(): Collider[] {
    return this.alive ? [this.collider] : [];
  }

  /** A projectile of `kind` hit it. Returns true if that sank it. */
  hit(kind: number): boolean {
    if (!this.alive) return false;
    this.hp -= ENEMY.damage[kind] ?? ENEMY.damage[0];
    if (this.hp > 0) return false;
    this.hp = 0;
    this.state = 'sinking';
    this.timer = 0;
    this.sunkCount++;
    this.hooks.sunk(this.position);
    return true;
  }

  /** Fixed-step physics. */
  physicsStep(h: number): void {
    if (this.alive) this.ship.physicsStep(h);
  }

  /**
   * Per-frame: steer, fight, sink or wait.
   * @param player the player's position
   * @param hostile false in menus: it only patrols
   */
  update(dt: number, player: THREE.Vector3, hostile: boolean): void {
    const ship = this.ship;
    if (this.state === 'gone') {
      this.timer += dt;
      if (this.timer > ENEMY.respawnTime) this.spawn(player);
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

    const pos = this.position;
    const range = Math.hypot(player.x - pos.x, player.z - pos.z);
    if (this.state === 'patrol' && hostile && range < ENEMY.engageRange) this.state = 'fight';
    else if (this.state === 'fight' && (!hostile || range > ENEMY.loseRange)) this.state = 'patrol';
    // A raid goes ahead until the player comes close enough to fight instead.
    if (this.state === 'patrol' && hostile && this.raidTarget) this.state = 'raid';
    else if (this.state === 'raid' && (!hostile || !this.raidTarget)) this.state = 'patrol';
    else if (this.state === 'raid' && range < ENEMY.engageRange) this.state = 'fight';
    const raid = this.state === 'raid' ? this.raidTarget : null;

    // Where to head.
    const want = _want.set(0, 0, 0);
    if (this.state === 'fight' || raid) {
      // circle the player (or the stronghold) at standoff range, which keeps it on the beam
      const focus = raid ?? player;
      const fr = Math.hypot(focus.x - pos.x, focus.z - pos.z) || 1;
      const rx = (pos.x - focus.x) / fr;
      const rz = (pos.z - focus.z) / fr;
      const k = THREE.MathUtils.clamp((fr - (raid ? ENEMY.raidStandoff : ENEMY.standoff)) / 40, -1, 1);
      want.set(-rz - rx * k, 0, rx - rz * k);
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
    want.normalize();
    const fwd = ship.body.forward(_fwd).setY(0).normalize();
    const turn = fwd.x * want.z - fwd.z * want.x;
    const ahead = fwd.dot(want);
    const steer = ahead < -0.2 ? Math.sign(turn || 1) : THREE.MathUtils.clamp(turn * 2.5, -1, 1);
    const sailTarget = this.state === 'fight' ? 0.7 : raid ? 0.5 : 0.55;
    ship.control(dt, ship.sail < sailTarget - 0.03 ? 1 : ship.sail > sailTarget + 0.03 ? -1 : 0, steer);
    ship.syncVisuals(dt);
    ship.group.updateMatrixWorld();

    // Guns.
    if (this.state === 'fight' || raid) {
      const mark = raid ?? player;
      const reach = Math.hypot(mark.x - pos.x, mark.z - pos.z);
      this.battery.aimAt(mark, dt);
      if (!this.battery.outOfArc && !this.battery.outOfRange && reach < BROADSIDE.maxRange && this.battery.ready) this.battery.tryFire();
    }
    this.shots.length = 0;
    this.battery.update(dt, this.shots);
    for (const shot of this.shots) {
      // NPC gunnery is honest but not perfect
      const yaw = (Math.random() - 0.5) * 2 * ENEMY.scatter;
      shot.direction.applyAxisAngle(_up, yaw);
      shot.direction.y += (Math.random() - 0.5) * ENEMY.scatter;
      shot.direction.normalize();
      this.hooks.fire(shot.position, shot.direction);
    }
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
    this.ship.body.placeOnWater(best.x, best.z, heading);
    this.ship.body.velocity.set(0, 0, 0);
    this.ship.sail = 0.5;
    this.ship.group.visible = true;
    this.ship.syncVisuals(0);
    this.hp = this.maxHp;
    this.state = 'patrol';
    this.timer = 0;
    this.waypoint = Math.round(((Math.atan2(best.z, best.x) / (Math.PI * 2)) * 6 + 7) % 6) % 6;
  }
}

const _want = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
