import * as THREE from 'three';
import type { Island } from '../world/Islands';
import { toonMaterial } from '../render/toon';

/**
 * Seagulls. A few wheel over the islands near the camera and a couple trail
 * the player's ship; now and then one drops down and perches on her (a
 * masthead, the rail, the cargo) for a while. Any fighting sends them all
 * off at once, and none land again until it has been quiet a while.
 *
 * Drawn as three instanced meshes (bodies and the two wings), so a whole
 * flock is three draw calls.
 */
const COUNT = 18;
const SPEED = 9;

type Mode = 'circle' | 'land' | 'perched' | 'leave';

interface Gull {
  mode: Mode;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** What it wheels round: an island (by index) or the ship (-1). */
  anchor: number;
  angle: number;
  radius: number;
  height: number;
  /** Which way round (1 or -1). */
  dir: number;
  flap: number;
  /** Perched: where on the ship (ship space), and for how long yet. */
  perch: THREE.Vector3;
  timer: number;
  bank: number;
}

export interface GullShip {
  group: THREE.Object3D;
  /** Places a gull may perch, in ship space. */
  perches: THREE.Vector3[];
}

export class Gulls {
  readonly group = new THREE.Group();
  private readonly gulls: Gull[] = [];
  private readonly bodies: THREE.InstancedMesh;
  private readonly wingsL: THREE.InstancedMesh;
  private readonly wingsR: THREE.InstancedMesh;
  private landIn = 12;
  private calmFor = 0;

  constructor(private readonly islands: Island[]) {
    this.group.name = 'gulls';
    // a plump body tapering to the tail, with an orange beak folded in
    const body = new THREE.SphereGeometry(0.22, 8, 6);
    body.scale(1, 0.85, 2.1);
    const head = new THREE.SphereGeometry(0.13, 8, 6);
    head.translate(0, 0.15, -0.42);
    const beak = new THREE.ConeGeometry(0.045, 0.2, 5);
    beak.rotateX(-Math.PI / 2);
    beak.translate(0, 0.13, -0.6);
    const tail = new THREE.ConeGeometry(0.12, 0.3, 4);
    tail.rotateX(Math.PI / 2);
    tail.scale(1.4, 0.4, 1);
    tail.translate(0, 0.02, 0.55);
    const bodyGeo = mergeColoured([
      [body, 0xf6f4ee],
      [head, 0xffffff],
      [beak, 0xf2a330],
      [tail, 0x7d868e],
    ]);
    // a wing: a long narrow blade, pivoting at the shoulder (x = 0), grey tipped
    const wing = new THREE.BufferGeometry();
    const v = [0, 0, -0.14, 0.55, 0, -0.18, 1.05, 0, 0.02, 0.55, 0, 0.16, 0, 0, 0.18];
    wing.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    wing.setIndex([0, 1, 4, 1, 3, 4, 1, 2, 3]);
    wing.computeVertexNormals();
    const wingR = wing.clone();
    wingR.scale(-1, 1, 1);
    wingR.setIndex([0, 4, 1, 1, 4, 3, 1, 3, 2]);
    wingR.computeVertexNormals();
    const wingMat = toonMaterial(0xffffff, { side: THREE.DoubleSide, vertexColors: true });
    for (const g of [wing, wingR]) {
      const c = new Float32Array(15);
      const tip = new THREE.Color(0x5a6168);
      const base = new THREE.Color(0xf2f1ec);
      for (let i = 0; i < 5; i++) (i === 2 ? tip : base).toArray(c, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    this.bodies = new THREE.InstancedMesh(bodyGeo, toonMaterial(0xffffff, { vertexColors: true }), COUNT);
    this.wingsL = new THREE.InstancedMesh(wing, wingMat, COUNT);
    this.wingsR = new THREE.InstancedMesh(wingR, wingMat, COUNT);
    for (const m of [this.bodies, this.wingsL, this.wingsR]) {
      m.frustumCulled = false;
      m.castShadow = false;
      this.group.add(m);
    }
    for (let i = 0; i < COUNT; i++) {
      this.gulls.push({
        mode: 'circle',
        pos: new THREE.Vector3(0, -100, 0),
        vel: new THREE.Vector3(SPEED, 0, 0),
        anchor: -2,
        angle: Math.random() * Math.PI * 2,
        radius: 18 + Math.random() * 30,
        height: 14 + Math.random() * 18,
        dir: Math.random() < 0.5 ? 1 : -1,
        flap: Math.random() * 10,
        perch: new THREE.Vector3(),
        timer: 0,
        bank: 0,
      });
    }
  }

  /**
   * @param ship the player's ship (null when there is none afloat)
   * @param calm true when she is out of combat: gulls may land on her
   * @param view where the camera looks: gulls keep to the islands near it
   */
  update(dt: number, ship: GullShip | null, calm: boolean, view: THREE.Vector3): void {
    this.calmFor = calm ? this.calmFor + dt : 0;
    // islands near the view, for the flock to wheel over
    const near: number[] = [];
    this.islands.forEach((isl, i) => {
      if (Math.hypot(isl.center.x - view.x, isl.center.z - view.z) < 420) near.push(i);
    });
    const shipPos = ship ? ship.group.getWorldPosition(_s) : null;

    // now and then, in quiet times, one comes down to perch
    this.landIn -= dt;
    if (this.landIn <= 0) {
      this.landIn = 9 + Math.random() * 14;
      if (ship && shipPos && this.calmFor > 8 && ship.perches.length) {
        const taken = new Set(this.gulls.filter((g) => g.mode === 'land' || g.mode === 'perched').map((g) => g.perch));
        const perched = this.gulls.filter((g) => g.mode === 'land' || g.mode === 'perched').length;
        const free = ship.perches.filter((p) => ![...taken].some((t) => t.distanceToSquared(p) < 0.5));
        const g = this.gulls.filter((x) => x.mode === 'circle' && x.pos.distanceTo(shipPos) < 160).sort((a, b) => a.pos.distanceTo(shipPos) - b.pos.distanceTo(shipPos))[0];
        if (g && free.length && perched < 3) {
          g.mode = 'land';
          g.perch.copy(free[Math.floor(Math.random() * free.length)]);
        }
      }
    }

    for (let i = 0; i < this.gulls.length; i++) {
      const g = this.gulls[i];
      g.flap += dt;
      // a fight scares them off the ship
      if (!calm && (g.mode === 'land' || g.mode === 'perched')) this.takeOff(g);
      if (!ship && (g.mode === 'land' || g.mode === 'perched')) this.takeOff(g);
      // give each a place to wheel: about a third follow the ship, the rest the islands near the view
      const anchorOk = g.anchor === -1 ? !!shipPos : near.includes(g.anchor);
      if (g.mode === 'circle' && !anchorOk) {
        g.anchor = shipPos && (i % 3 === 0 || !near.length) ? -1 : near.length ? near[Math.floor(Math.random() * near.length)] : -1;
        const c = g.anchor === -1 ? shipPos : this.islands[g.anchor]?.center;
        // far off and out of sight: appear on station rather than fly in from the other end of the map
        if (c && g.pos.distanceTo(c) > 500) g.pos.set(c.x + Math.cos(g.angle) * g.radius, 20 + g.height, c.z + Math.sin(g.angle) * g.radius);
      }

      if (g.mode === 'perched' && ship) {
        g.timer -= dt;
        _t.copy(g.perch);
        ship.group.localToWorld(_t);
        g.pos.copy(_t);
        g.vel.set(0, 0, 0);
        if (g.timer <= 0) this.takeOff(g);
        const q = ship.group.getWorldQuaternion(_q);
        // sits facing the ship's bow, give or take, and bobs its head now and then
        _m.makeRotationFromQuaternion(q);
        _m.multiply(_r.makeRotationY(i * 1.7 + Math.sin(g.flap * 0.3) * 0.2));
        _m.setPosition(g.pos.x, g.pos.y + 0.18, g.pos.z);
        this.write(i, _m, 0.15, true);
        continue;
      }

      // where to fly
      let target: THREE.Vector3;
      if (g.mode === 'land' && ship) {
        target = ship.group.localToWorld(_t.copy(g.perch));
        if (g.pos.distanceTo(target) < 0.7) {
          g.mode = 'perched';
          g.timer = 8 + Math.random() * 14;
          continue;
        }
      } else {
        if (g.mode === 'leave') {
          g.timer -= dt;
          if (g.timer <= 0) g.mode = 'circle';
        }
        const c = g.anchor === -1 && shipPos ? shipPos : g.anchor >= 0 ? this.islands[g.anchor].center : view;
        const top = g.anchor >= 0 ? Math.max(0, this.islands[g.anchor].topY) : 0;
        g.angle += (g.dir * SPEED * 0.8 * dt) / g.radius;
        const lead = g.angle + g.dir * 0.5;
        target = _t.set(c.x + Math.cos(lead) * g.radius, top + g.height + Math.sin(g.flap * 0.4 + i) * 2, c.z + Math.sin(lead) * g.radius);
        if (g.mode === 'leave') target.y += 10;
      }
      // steer: turn the velocity toward the target, slow right down on the final approach to a perch
      const want = _w.subVectors(target, g.pos);
      const dist = want.length();
      const speed = g.mode === 'land' ? Math.min(SPEED, 1.5 + dist * 0.9) : SPEED;
      want.multiplyScalar(speed / Math.max(dist, 1e-3));
      const before = Math.atan2(g.vel.x, g.vel.z);
      g.vel.lerp(want, Math.min(1, dt * (g.mode === 'land' && dist < 12 ? 6 : 1.6)));
      g.pos.addScaledVector(g.vel, dt);
      const after = Math.atan2(g.vel.x, g.vel.z);
      let turn = after - before;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      g.bank = THREE.MathUtils.lerp(g.bank, THREE.MathUtils.clamp(-turn / Math.max(dt, 1e-3) * 0.35, -0.8, 0.8), Math.min(1, dt * 3));
      // face along the flight, banked into turns
      _look.copy(g.pos).add(g.vel);
      _m.lookAt(g.pos, _look, _up);
      _m.multiply(_r.makeRotationZ(g.bank));
      _m.setPosition(g.pos);
      // flap on the climb and the landing, glide otherwise
      const climbing = g.vel.y > 0.8 || g.mode === 'land' || g.mode === 'leave';
      const beat = climbing ? Math.sin(g.flap * 14) * 0.7 : Math.sin(g.flap * 2.2) * 0.12 + 0.08;
      this.write(i, _m, beat, false);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.wingsL.instanceMatrix.needsUpdate = true;
    this.wingsR.instanceMatrix.needsUpdate = true;
  }

  private takeOff(g: Gull): void {
    g.mode = 'leave';
    g.timer = 2.5;
    g.vel.set((Math.random() - 0.5) * 4, 5, (Math.random() - 0.5) * 4);
  }

  /** Body and both wings of gull i at `m`: wings raised by `beat` (radians), or folded along the back. */
  private write(i: number, m: THREE.Matrix4, beat: number, folded: boolean): void {
    this.bodies.setMatrixAt(i, m);
    for (const [mesh, side] of [
      [this.wingsL, 1],
      [this.wingsR, -1],
    ] as const) {
      _wm.copy(m);
      _wm.multiply(_r.makeTranslation(side * 0.1, 0.06, -0.05));
      if (folded) {
        // laid back along the body
        _wm.multiply(_r.makeRotationY(side * -1.35)).multiply(_r2.makeScale(0.55, 1, 0.8));
      } else _wm.multiply(_r.makeRotationZ(side * beat));
      mesh.setMatrixAt(i, _wm);
    }
  }
}

/** Merge geometries, painting each a flat vertex colour. */
function mergeColoured(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const [geo, colour] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    c.set(colour);
    const p = g.attributes.position;
    const n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _w = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _wm = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _r2 = new THREE.Matrix4();
