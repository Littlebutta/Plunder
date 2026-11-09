import * as THREE from 'three';
import { toonMaterial, addOutline } from '../render/toon';
import type { WaveField } from '../ocean/waves';
import type { Collider } from '../combat/ProjectileSystem';

/** Collider ids for cursed ships: CURSED_ID_BASE + slot. */
export const CURSED_ID_BASE = 800;

export interface FleetTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

export interface FleetHooks {
  splash(at: THREE.Vector3, size: number): void;
  splinters(at: THREE.Vector3, count: number): void;
  /** Fire a cannonball (owner = the ship's collider id). */
  fire(from: THREE.Vector3, velocity: THREE.Vector3, owner: number, muzzleDir: THREE.Vector3): void;
  sunk(remaining: number): void;
  cleared(): void;
}

const LEVELS = {
  total: [3, 5, 8],
  alive: [2, 3, 4],
  hp: [5, 6, 7],
  speed: [4.6, 5.2, 5.8],
  reload: [6, 4.8, 3.8],
  volley: [1, 2, 3],
  spread: [0.07, 0.05, 0.035],
};
const MUZZLE_SPEED = 46;
const RISE_TIME = 4.5;
const SINK_TIME = 6;

interface CursedShip {
  id: number;
  group: THREE.Group;
  state: 'rising' | 'sail' | 'sinking';
  timer: number;
  pos: THREE.Vector3;
  heading: number; // radians, 0 = +X (the model's bow points along +X)
  hp: number;
  reload: number;
  volleyLeft: number;
  volleyTimer: number;
  orbit: number;
  collider: Collider;
  lanterns: THREE.Mesh[];
}

/**
 * The cursed fleet of the red-sea ("armageddon") event: charred ghost ships
 * with tattered red sails that burst up out of the sea, circle the player at
 * cannon range and fire volleys. Sink them all to end the event early.
 */
export class CursedFleet {
  readonly group = new THREE.Group();
  private ships: CursedShip[] = [];
  private level = 1;
  private spawned = 0;
  private nextId = 0;
  private readonly mats = {
    hull: toonMaterial(0x2c1e1b),
    hullDark: toonMaterial(0x1a1110),
    bone: toonMaterial(0xd8ccb0),
    sail: toonMaterial(0x6a1216, { side: THREE.DoubleSide, emissive: 0x3a0505, emissiveIntensity: 0.4 }),
    lantern: new THREE.MeshBasicMaterial({ color: 0x8dffb8 }),
    mast: toonMaterial(0x3a2a22),
  };
  private readonly hullGeo = buildHullGeometry();
  running = false;

  constructor(
    private readonly waves: WaveField,
    private readonly hooks: FleetHooks,
  ) {
    this.group.name = 'cursed-fleet';
  }

  get alive(): number {
    return this.ships.filter((s) => s.state !== 'sinking').length;
  }

  get left(): number {
    return LEVELS.total[this.level - 1] - this.spawned + this.alive;
  }

  start(level: number): void {
    this.clear();
    this.level = THREE.MathUtils.clamp(level, 1, 3);
    this.spawned = 0;
    this.running = true;
  }

  /** Stop spawning; ships still afloat sink back into the sea. */
  stop(): void {
    this.running = false;
    for (const s of this.ships) if (s.state !== 'sinking') this.beginSink(s);
  }

  clear(): void {
    for (const s of this.ships) this.group.remove(s.group);
    this.ships = [];
    this.running = false;
  }

  colliders(): Collider[] {
    const out: Collider[] = [];
    for (const s of this.ships) if (s.state === 'sail' || (s.state === 'rising' && s.timer < RISE_TIME * 0.5)) out.push(s.collider);
    return out;
  }

  hit(id: number, damage: number): THREE.Vector3 | null {
    const s = this.ships.find((x) => x.id === id);
    if (!s || s.state === 'sinking') return null;
    s.hp -= damage;
    const at = s.collider.position.clone();
    this.hooks.splinters(at, 10);
    if (s.hp <= 0) {
      this.beginSink(s);
      this.hooks.sunk(this.left);
    }
    return at;
  }

  update(dt: number, target: FleetTarget, presence: number): void {
    const lv = this.level - 1;
    if (this.running && presence > 0.5 && this.alive < LEVELS.alive[lv] && this.spawned < LEVELS.total[lv]) {
      this.spawn(target);
    }
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const s = this.ships[i];
      s.timer -= dt;
      if (s.state === 'rising') this.updateRising(s, dt);
      else if (s.state === 'sail') this.updateSail(s, dt, target, lv);
      else if (this.updateSinking(s, dt)) {
        this.group.remove(s.group);
        this.ships.splice(i, 1);
        continue;
      }
      // lanterns flicker
      const f = 0.85 + Math.sin(performance.now() * 0.011 + s.id) * 0.15;
      for (const l of s.lanterns) l.scale.setScalar(f);
    }
    if (this.running && this.spawned >= LEVELS.total[lv] && this.ships.length === 0) {
      this.running = false;
      this.hooks.cleared();
    }
  }

  private spawn(target: FleetTarget): void {
    const lv = this.level - 1;
    const a = Math.random() * Math.PI * 2;
    const r = 70 + Math.random() * 50;
    const pos = new THREE.Vector3(target.position.x + Math.cos(a) * r, -8, target.position.z + Math.sin(a) * r);
    const id = CURSED_ID_BASE + (this.nextId++ % 64);
    const group = this.buildShip();
    const ship: CursedShip = {
      id,
      group,
      state: 'rising',
      timer: RISE_TIME,
      pos,
      heading: a + Math.PI + (Math.random() - 0.5) * 0.8,
      hp: LEVELS.hp[lv],
      reload: 3 + Math.random() * 3,
      volleyLeft: 0,
      volleyTimer: 0,
      orbit: Math.random() < 0.5 ? 1 : -1,
      collider: { id, position: new THREE.Vector3(), radius: 3.6 },
      lanterns: group.userData.lanterns as THREE.Mesh[],
    };
    this.spawned++;
    this.ships.push(ship);
    this.group.add(group);
    this.place(ship, 0, -0.6);
    this.hooks.splash(_v.set(pos.x, this.waves.heightAt(pos.x, pos.z), pos.z), 2.5);
  }

  private updateRising(s: CursedShip, dt: number): void {
    const k = 1 - Math.max(0, s.timer) / RISE_TIME;
    const e = 1 - (1 - k) * (1 - k);
    const sea = this.waves.heightAt(s.pos.x, s.pos.z);
    s.pos.y = THREE.MathUtils.lerp(sea - 9, sea - 0.35, e);
    // water pours off as it breaks the surface
    if (Math.random() < dt * 7) {
      const along = (Math.random() - 0.5) * 9;
      _v.set(s.pos.x + Math.cos(s.heading) * along, sea, s.pos.z + Math.sin(s.heading) * along);
      this.hooks.splash(_v, 0.6 + Math.random() * 0.8);
    }
    this.place(s, dt, -0.55 * (1 - e)); // bow-up as it surfaces
    if (s.timer <= 0) s.state = 'sail';
  }

  private updateSail(s: CursedShip, dt: number, target: FleetTarget, lv: number): void {
    const dx = target.position.x - s.pos.x;
    const dz = target.position.z - s.pos.z;
    const dist = Math.hypot(dx, dz);
    // circle the player at cannon range, coming round to bring a side to bear
    const around = Math.atan2(-dz, -dx) + s.orbit * 0.5;
    const ring = 38;
    const gx = target.position.x + Math.cos(around) * ring;
    const gz = target.position.z + Math.sin(around) * ring;
    let want = Math.atan2(gz - s.pos.z, gx - s.pos.x);
    // keep clear of other cursed ships
    for (const o of this.ships) {
      if (o === s || o.state === 'sinking') continue;
      const ox = s.pos.x - o.pos.x;
      const oz = s.pos.z - o.pos.z;
      const d = Math.hypot(ox, oz);
      if (d < 14 && d > 0.01) want = Math.atan2(Math.sin(want) + (oz / d) * 1.2, Math.cos(want) + (ox / d) * 1.2);
    }
    s.heading += THREE.MathUtils.clamp(wrap(want - s.heading), -0.45 * dt, 0.45 * dt);
    const speed = LEVELS.speed[lv] * (dist > 110 ? 1.5 : 1);
    s.pos.x += Math.cos(s.heading) * speed * dt;
    s.pos.z += Math.sin(s.heading) * speed * dt;
    s.pos.y = this.waves.heightAt(s.pos.x, s.pos.z) - 0.35;
    this.place(s, dt, 0);

    // gunnery: a volley of shots a moment apart, from the side facing the player
    s.reload -= dt;
    if (s.reload <= 0 && dist < 90 && s.volleyLeft === 0) {
      s.volleyLeft = LEVELS.volley[lv];
      s.volleyTimer = 0;
      s.reload = LEVELS.reload[lv] * (0.85 + Math.random() * 0.3);
    }
    if (s.volleyLeft > 0) {
      s.volleyTimer -= dt;
      if (s.volleyTimer <= 0) {
        s.volleyLeft--;
        s.volleyTimer = 0.22;
        this.fireAt(s, target, lv);
      }
    }
  }

  private fireAt(s: CursedShip, target: FleetTarget, lv: number): void {
    // the gun port on the side facing the player
    const side = Math.cos(s.heading) * (target.position.z - s.pos.z) - Math.sin(s.heading) * (target.position.x - s.pos.x) > 0 ? 1 : -1;
    const along = (Math.random() - 0.5) * 5;
    const from = new THREE.Vector3(
      s.pos.x + Math.cos(s.heading) * along - Math.sin(s.heading) * 1.8 * side,
      s.pos.y + 1.4,
      s.pos.z + Math.sin(s.heading) * along + Math.cos(s.heading) * 1.8 * side,
    );
    const dist = Math.hypot(target.position.x - from.x, target.position.z - from.z);
    const flight = dist / (MUZZLE_SPEED * 0.85);
    const aim = _v.copy(target.position).addScaledVector(target.velocity, flight * 0.8);
    const vel = ballistic(from, aim, MUZZLE_SPEED);
    const spread = LEVELS.spread[lv];
    vel.applyAxisAngle(_up, (Math.random() - 0.5) * 2 * spread);
    vel.multiplyScalar(1 + (Math.random() - 0.5) * spread * 1.5);
    this.hooks.fire(from, vel, s.id, _d.copy(vel).normalize());
  }

  private beginSink(s: CursedShip): void {
    s.state = 'sinking';
    s.timer = SINK_TIME;
  }

  /** Returns true when the ship has gone under for good. */
  private updateSinking(s: CursedShip, dt: number): boolean {
    const k = 1 - Math.max(0, s.timer) / SINK_TIME;
    const sea = this.waves.heightAt(s.pos.x, s.pos.z);
    s.pos.y = sea - 0.35 - k * k * 12;
    s.group.position.copy(s.pos);
    s.group.rotation.set(0, -s.heading, 0);
    s.group.rotateZ(k * 0.5);
    s.group.rotateX(k * 0.35);
    if (Math.random() < dt * 4) this.hooks.splash(_v.set(s.pos.x + (Math.random() - 0.5) * 6, sea, s.pos.z + (Math.random() - 0.5) * 6), 0.7);
    return s.timer <= 0;
  }

  /** Put the model on the sea, tilted with the waves; pitch > 0 noses down. */
  private place(s: CursedShip, _dt: number, pitch: number): void {
    const n = this.waves.sample(s.pos.x, s.pos.z, _sample).normal;
    s.group.position.copy(s.pos);
    s.group.quaternion.setFromUnitVectors(_up, _n.copy(n).lerp(_up, 0.4).normalize());
    s.group.rotateY(-s.heading);
    s.group.rotateZ(-pitch);
    s.collider.position.set(s.pos.x, s.pos.y + 1.2, s.pos.z);
  }

  private buildShip(): THREE.Group {
    const g = new THREE.Group();
    const m = this.mats;
    const hull = new THREE.Mesh(this.hullGeo, m.hull);
    hull.castShadow = true;
    addOutline(hull, 0.06, 0x0a0505);
    g.add(hull);
    // bone-white rail along each side
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.16, 0.16), m.bone);
      rail.position.set(-0.3, 1.55, side * 1.45);
      g.add(rail);
      // gun ports
      for (let i = 0; i < 3; i++) {
        const port = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.1), m.hullDark);
        port.position.set(-2.4 + i * 2, 0.95, side * 1.55);
        g.add(port);
      }
    }
    // two masts with tattered sails
    for (const [x, h] of [
      [1.2, 9],
      [-2.4, 7.5],
    ] as const) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, h, 6), m.mast);
      mast.position.set(x, 1.2 + h / 2, 0);
      g.add(mast);
      const sail = new THREE.Mesh(tatteredSail(3.6, h * 0.55), m.sail);
      sail.rotation.y = Math.PI / 2;
      sail.position.set(x + 0.15, 1.2 + h * 0.55, 0);
      g.add(sail);
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 4.2, 5), m.mast);
      yard.rotation.x = Math.PI / 2;
      yard.position.set(x + 0.15, 1.2 + h * 0.82, 0);
      g.add(yard);
    }
    // sickly green lanterns at bow and stern
    const lanterns: THREE.Mesh[] = [];
    for (const x of [4.6, -4.3]) {
      const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), m.lantern);
      l.position.set(x, 2.1, 0);
      g.add(l);
      lanterns.push(l);
    }
    g.userData.lanterns = lanterns;
    return g;
  }
}

/** A blunt-sterned hull with a pointed bow along +X, deck at y = 1.4. */
function buildHullGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(10, 2.2, 3, 10, 2, 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    let y = p.getY(i);
    let z = p.getZ(i);
    const t = (x + 5) / 10; // 0 stern .. 1 bow
    let w = 1;
    if (t > 0.6) w = 1 - Math.pow((t - 0.6) / 0.4, 1.6) * 0.92;
    if (t < 0.1) w = 0.88 + t * 1.2;
    if (y < 0) w *= 0.55; // narrow keel
    z *= w;
    // sheer: deck rises toward bow and stern
    y += 0.3 + (y > 0 ? 0.35 * Math.pow(Math.abs(t - 0.45) * 2, 2) : 0);
    p.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Sail with a ragged, holed lower edge. Lies in the XY plane. */
function tatteredSail(width: number, height: number): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, height / 2);
  s.lineTo(width / 2, height / 2);
  const teeth = 7;
  for (let i = 0; i <= teeth; i++) {
    const x = width / 2 - (i / teeth) * width;
    const y = -height / 2 + (i % 2 ? height * 0.22 : 0) + Math.sin(i * 12.9) * height * 0.06;
    s.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absellipse(width * 0.18, height * 0.05, width * 0.1, height * 0.08, 0, Math.PI * 2, false, 0);
  s.holes.push(hole);
  return new THREE.ShapeGeometry(s);
}

/** Low-arc launch velocity from a to b at muzzle speed v (drag ignored). */
function ballistic(a: THREE.Vector3, b: THREE.Vector3, v: number): THREE.Vector3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const d = Math.max(Math.hypot(dx, dz), 0.1);
  const g = 9.81;
  const disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
  const elev = disc < 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * d));
  return new THREE.Vector3((dx / d) * Math.cos(elev) * v, Math.sin(elev) * v, (dz / d) * Math.cos(elev) * v);
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _sample = { height: 0, normal: new THREE.Vector3() };
