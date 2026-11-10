import * as THREE from 'three';
import type { WaveField } from '../ocean/waves';
import type { Island } from '../world/Islands';
import type { ShipState } from './Weather';

/**
 * A mountain island wakes up: smoke pours from the summit and it lobs
 * fireballs out over the sea. Each one shows where it will come down (a red
 * ring on the water that tightens as it falls), so a ship can dodge.
 */
export interface VolcanoHooks {
  splash(at: THREE.Vector3, size: number): void;
  /** A fireball came down here: hurt whatever is within `radius`. */
  blast(at: THREE.Vector3, radius: number, damage: number): void;
  boom?(at: THREE.Vector3): void;
}

const LEVELS = [
  { every: [1.6, 2.6], reach: [80, 260], aimAtShip: 0.2, damage: 10 },
  { every: [0.8, 1.5], reach: [70, 320], aimAtShip: 0.3, damage: 13 },
  { every: [0.45, 0.9], reach: [60, 380], aimAtShip: 0.35, damage: 15 },
];
const RADIUS = 9;
const MAX_BALLS = 24;
const MAX_SMOKE = 40;
const EMBERS = 90;
const LAVA_HOT = new THREE.Color(0xffd25a);
const LAVA_DEEP = new THREE.Color(0xe2380f);
const CRUST = new THREE.Color(0x3a2622);

interface Ball {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  flight: number;
  peak: number;
  mesh: THREE.Mesh;
  ring: THREE.Mesh;
  trail: THREE.Points;
  trailPos: Float32Array;
}

interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  vel: THREE.Vector3;
}

export class Volcano {
  readonly group = new THREE.Group();
  island: Island | null = null;
  level = 1;
  /** 0..1 how awake it is (follows the event's weight). */
  presence = 0;
  private readonly balls: Ball[] = [];
  private readonly puffs: Puff[] = [];
  private next = 2;
  private puffIn = 0;
  private readonly glow: THREE.PointLight;
  /** The lit-up mountain: a lava lake in the crater, a glowing rim and rivers of lava down the gullies. Built per eruption, parented to the island. */
  private vent: THREE.Group | null = null;
  private readonly lavaMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private readonly poolMat = new THREE.MeshBasicMaterial({ color: 0xffb03a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  private readonly rimMat = new THREE.MeshBasicMaterial({ color: 0xff5a14 });
  private rivers: { geo: THREE.BufferGeometry; count: number }[] = [];
  private flow = 0;
  private readonly embers: THREE.Points;
  private readonly emberPos = new Float32Array(EMBERS * 3);
  private readonly emberVel = new Float32Array(EMBERS * 3);
  private readonly emberAge = new Float32Array(EMBERS);
  private readonly ballGeo = new THREE.IcosahedronGeometry(1.6, 1);
  private readonly ballMat = new THREE.MeshBasicMaterial({ color: 0xffa13a });
  private readonly ringGeo = new THREE.RingGeometry(0.92, 1, 40);
  private readonly smokeMat: THREE.SpriteMaterial;

  constructor(private readonly waves: WaveField, private readonly hooks: VolcanoHooks) {
    this.group.name = 'volcano';
    this.glow = new THREE.PointLight(0xff5a1a, 0, 160, 1.6);
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(this.emberPos, 3));
    this.embers = new THREE.Points(eg, new THREE.PointsMaterial({ color: 0xffa040, size: 0.9, transparent: true, opacity: 0.95, depthWrite: false }));
    this.embers.frustumCulled = false;
    this.embers.visible = false;
    this.group.add(this.glow, this.embers);
    this.smokeMat = new THREE.SpriteMaterial({ map: puffTexture(), color: 0x3a3330, transparent: true, depthWrite: false, opacity: 0.8 });
  }

  /** One of each thing an eruption throws up, for compiling their shaders before the first one. */
  warmup(): THREE.Object3D[] {
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    return [
      new THREE.Mesh(this.ballGeo, this.ballMat),
      new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })),
      new THREE.Points(tg, _trailMat),
      new THREE.Sprite(this.smokeMat),
      new THREE.Mesh(this.ringGeo, this.lavaMat),
      new THREE.Mesh(this.ringGeo, this.poolMat),
      new THREE.Mesh(this.ringGeo, this.rimMat),
      new THREE.Points(tg, this.embers.material as THREE.PointsMaterial),
    ];
  }

  get active(): boolean {
    return !!this.island && (this.presence > 0 || this.balls.length > 0 || this.puffs.length > 0);
  }

  start(island: Island, level: number): void {
    this.clear();
    this.island = island;
    this.level = level;
    this.next = 3;
    this.buildVent(island);
  }

  /** Light the mountain up: lava in the crater, a glowing rim, and rivers running down its gullies to the sea. */
  private buildVent(island: Island): void {
    const v = new THREE.Group();
    v.name = 'volcano-vent';
    const c = island.vent;
    // how wide the crater is: walk out from the vent until the ground has risen to the rim
    let craterR = 2;
    for (let r = 1; r < island.radius * 0.5; r += 0.5) {
      let h = 0;
      for (let k = 0; k < 8; k++) h += island.heightAt(c.x + Math.cos((k / 8) * Math.PI * 2) * r, c.z + Math.sin((k / 8) * Math.PI * 2) * r);
      craterR = r;
      if (h / 8 < c.y - 0.5) break; // past the rim and going down the outside
    }
    const pool = new THREE.Mesh(new THREE.CircleGeometry(Math.max(1.5, craterR * 0.7), 24), this.poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(c.x, c.y + 0.5, c.z);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(Math.max(1.8, craterR * 0.85), 0.35, 6, 32), this.rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(c.x, c.y + 0.9, c.z);
    v.add(pool, rim);
    // rivers of lava: each starts at the rim and runs downhill, picking the lowest ground a little to either side
    this.rivers = [];
    const n = 3 + this.level;
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      let a = a0 + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      let x = c.x + Math.cos(a) * craterR * 0.8;
      let z = c.z + Math.sin(a) * craterR * 0.8;
      const pts: THREE.Vector3[] = [];
      for (let step = 0; step < 140; step++) {
        const y = island.heightAt(x, z);
        pts.push(new THREE.Vector3(x, y + 0.3, z));
        if (y < 0.4) break;
        let best = a;
        let low = Infinity;
        for (const da of [-0.45, -0.2, 0, 0.2, 0.45]) {
          const h = island.heightAt(x + Math.cos(a + da) * 1.6, z + Math.sin(a + da) * 1.6);
          if (h < low) {
            low = h;
            best = a + da;
          }
        }
        a = a * 0.4 + best * 0.6 + (Math.random() - 0.5) * 0.15;
        x += Math.cos(a) * 1.4;
        z += Math.sin(a) * 1.4;
      }
      if (pts.length < 4) continue;
      const geo = ribbon(pts, 0.9, 2.2);
      geo.setDrawRange(0, 0);
      this.rivers.push({ geo, count: geo.index!.count });
      v.add(new THREE.Mesh(geo, this.lavaMat));
    }
    this.flow = 0;
    island.group.add(v);
    this.vent = v;
  }

  clear(): void {
    for (const b of this.balls) this.group.remove(b.mesh, b.ring, b.trail);
    this.balls.length = 0;
    for (const p of this.puffs) this.group.remove(p.sprite);
    this.puffs.length = 0;
    this.island = null;
    this.glow.intensity = 0;
    this.embers.visible = false;
    if (this.vent) {
      this.vent.removeFromParent();
      this.vent.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.vent = null;
    }
    this.rivers = [];
  }

  /** The crater, in world space. */
  private top(out: THREE.Vector3): THREE.Vector3 {
    const i = this.island!;
    return out.copy(i.vent).add(i.center).setY(Math.max(i.vent.y, 2) + 1);
  }

  update(dt: number, ship: ShipState): void {
    if (!this.island) return;
    const top = this.top(_top);
    const lv = LEVELS[this.level - 1];
    // the lava: the rivers run further down as the eruption builds, glow while it lasts and crust over as it dies
    if (this.vent) {
      this.vent.visible = this.presence > 0.02 || this.flow > 0;
      this.flow = this.presence > 0.3 ? Math.min(1, this.flow + dt / 9) : this.flow;
      for (const r of this.rivers) r.geo.setDrawRange(0, Math.floor((r.count * this.flow) / 6) * 6);
      const heat = THREE.MathUtils.clamp(this.presence * 1.4, 0, 1);
      const flicker = 0.85 + Math.sin(performance.now() * 0.006) * 0.1 + Math.random() * 0.05;
      this.lavaMat.color.setScalar(1).lerp(CRUST, 1 - heat).multiplyScalar(heat > 0 ? flicker : 1);
      this.poolMat.color.copy(LAVA_HOT).lerp(CRUST, 1 - heat).multiplyScalar(flicker);
      this.rimMat.color.copy(LAVA_DEEP).lerp(CRUST, 1 - heat);
    }
    this.updateEmbers(dt, top);
    this.glow.position.copy(top).setY(top.y + 6);
    this.glow.intensity = this.presence * (60 + Math.sin(performance.now() * 0.013) * 15) * this.level;

    // smoke column
    this.puffIn -= dt;
    if (this.presence > 0.1 && this.puffIn <= 0 && this.puffs.length < MAX_SMOKE) {
      this.puffIn = 0.25 / this.level;
      const s = new THREE.Sprite(this.smokeMat.clone());
      s.position.copy(top).add(_v.set((Math.random() - 0.5) * 3, 1, (Math.random() - 0.5) * 3));
      s.scale.setScalar(6);
      this.group.add(s);
      this.puffs.push({ sprite: s, age: 0, life: 9 + Math.random() * 5, vel: new THREE.Vector3((Math.random() - 0.5) * 2, 5 + Math.random() * 3, (Math.random() - 0.5) * 2) });
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      p.vel.y *= 1 - 0.12 * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.scale.setScalar(6 + p.age * 3.5);
      const k = p.age / p.life;
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.75 * Math.min(1, p.age * 2) * (1 - k);
      if (k >= 1) {
        this.group.remove(p.sprite);
        (p.sprite.material as THREE.Material).dispose();
        this.puffs.splice(i, 1);
      }
    }

    // fireballs
    this.next -= dt;
    if (this.presence > 0.6 && this.next <= 0 && this.balls.length < MAX_BALLS) {
      this.next = lv.every[0] + Math.random() * (lv.every[1] - lv.every[0]);
      this.launch(top, ship, lv);
    }
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.flight);
      b.mesh.position.lerpVectors(b.from, b.to, k);
      b.mesh.position.y = THREE.MathUtils.lerp(b.from.y, b.to.y, k) + 4 * b.peak * k * (1 - k);
      b.mesh.rotation.x += dt * 3;
      // trail: the last few places it has been
      const tp = b.trailPos;
      tp.copyWithin(3, 0, tp.length - 3);
      tp[0] = b.mesh.position.x;
      tp[1] = b.mesh.position.y;
      tp[2] = b.mesh.position.z;
      (b.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      // the warning ring tightens and brightens as it falls
      b.ring.position.set(b.to.x, this.waves.heightAt(b.to.x, b.to.z) + 0.25, b.to.z);
      b.ring.scale.setScalar(RADIUS * (1.9 - 0.9 * k));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.6 * k;
      if (k >= 1) {
        const at = _v.copy(b.to);
        at.y = this.waves.heightAt(at.x, at.z);
        // a hiss of steam where it hits, not a tall column of water (that read as a cone standing in the sea)
        this.hooks.splash(at, 0.9);
        this.steam(at);
        this.hooks.boom?.(at);
        this.hooks.blast(at, RADIUS, lv.damage);
        this.group.remove(b.mesh, b.ring, b.trail);
        b.trail.geometry.dispose();
        (b.ring.material as THREE.Material).dispose();
        this.balls.splice(i, 1);
      }
    }
  }

  /** White steam boiling off the sea where a fireball came down. */
  private steam(at: THREE.Vector3): void {
    for (let k = 0; k < 4 && this.puffs.length < MAX_SMOKE + 12; k++) {
      const m = this.smokeMat.clone();
      m.color.set(0xf4eee6);
      const s = new THREE.Sprite(m);
      s.position.set(at.x + (Math.random() - 0.5) * 4, at.y + 0.5, at.z + (Math.random() - 0.5) * 4);
      s.scale.setScalar(3);
      this.group.add(s);
      this.puffs.push({ sprite: s, age: 0, life: 1.6 + Math.random(), vel: new THREE.Vector3((Math.random() - 0.5) * 2, 3 + Math.random() * 2, (Math.random() - 0.5) * 2) });
    }
  }

  /** Sparks thrown up out of the crater. */
  private updateEmbers(dt: number, top: THREE.Vector3): void {
    const on = this.presence > 0.2;
    this.embers.visible = on || this.embers.visible;
    let alive = 0;
    for (let i = 0; i < EMBERS; i++) {
      this.emberAge[i] -= dt;
      const p = i * 3;
      if (this.emberAge[i] <= 0) {
        if (!on) {
          this.emberPos[p + 1] = -1000;
          continue;
        }
        this.emberAge[i] = 1.2 + Math.random() * 1.8;
        this.emberPos[p] = top.x + (Math.random() - 0.5) * 3;
        this.emberPos[p + 1] = top.y;
        this.emberPos[p + 2] = top.z + (Math.random() - 0.5) * 3;
        const a = Math.random() * Math.PI * 2;
        const out = 2 + Math.random() * 6 * this.level;
        this.emberVel[p] = Math.cos(a) * out;
        this.emberVel[p + 1] = 12 + Math.random() * 10 * this.level;
        this.emberVel[p + 2] = Math.sin(a) * out;
      }
      alive++;
      this.emberVel[p + 1] -= 14 * dt;
      this.emberPos[p] += this.emberVel[p] * dt;
      this.emberPos[p + 1] += this.emberVel[p + 1] * dt;
      this.emberPos[p + 2] += this.emberVel[p + 2] * dt;
    }
    if (!alive) this.embers.visible = false;
    (this.embers.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private launch(top: THREE.Vector3, ship: ShipState, lv: (typeof LEVELS)[number]): void {
    const i = this.island!;
    const to = new THREE.Vector3();
    const dShip = Math.hypot(ship.position.x - i.center.x, ship.position.z - i.center.z);
    if (Math.random() < lv.aimAtShip && dShip < lv.reach[1] + 40) {
      // lead the ship a little, with enough scatter to be dodged
      to.copy(ship.position).addScaledVector(ship.velocity, 2.5);
      to.x += (Math.random() - 0.5) * 30;
      to.z += (Math.random() - 0.5) * 30;
    } else {
      const a = Math.random() * Math.PI * 2;
      const r = i.shoreAt(a) + lv.reach[0] + Math.random() * (lv.reach[1] - lv.reach[0]);
      to.set(i.center.x + Math.cos(a) * r, 0, i.center.z + Math.sin(a) * r);
    }
    to.y = 0;
    const dist = Math.hypot(to.x - top.x, to.z - top.z);
    const mesh = new THREE.Mesh(this.ballGeo, this.ballMat);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const trailPos = new Float32Array(14 * 3);
    for (let k = 0; k < 14; k++) trailPos.set([top.x, top.y, top.z], k * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const trail = new THREE.Points(tg, _trailMat);
    trail.frustumCulled = false;
    this.group.add(mesh, ring, trail);
    this.balls.push({ from: top.clone(), to, t: 0, flight: 3 + dist / 120, peak: 40 + dist * 0.35, mesh, ring, trail, trailPos });
  }
}

const _top = new THREE.Vector3();
const _v = new THREE.Vector3();
const _trailMat = new THREE.PointsMaterial({ color: 0xff7a2a, size: 1.6, transparent: true, opacity: 0.8, depthWrite: false });

/**
 * A flat strip along a path, laid on the ground: narrow at the start, wider
 * where it spreads at the foot. Vertex colours run from white-hot to deep red.
 */
function ribbon(pts: THREE.Vector3[], w0: number, w1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const k = i / (pts.length - 1);
    const w = (w0 + (w1 - w0) * k) * (0.8 + Math.random() * 0.4);
    const p = pts[i];
    pos.push(p.x - (dz / l) * w, p.y, p.z + (dx / l) * w, p.x + (dz / l) * w, p.y, p.z - (dx / l) * w);
    c.copy(LAVA_HOT).lerp(LAVA_DEEP, Math.min(1, k * 1.3));
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    if (i > 0) {
      const q = (i - 1) * 2;
      idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

let _puff: THREE.Texture | null = null;
function puffTexture(): THREE.Texture {
  if (_puff) return _puff;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _puff = new THREE.CanvasTexture(c);
  return _puff;
}
