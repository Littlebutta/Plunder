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
  private readonly crater: THREE.Mesh;
  private readonly ballGeo = new THREE.IcosahedronGeometry(1.6, 1);
  private readonly ballMat = new THREE.MeshBasicMaterial({ color: 0xffa13a });
  private readonly ringGeo = new THREE.RingGeometry(0.92, 1, 40);
  private readonly smokeMat: THREE.SpriteMaterial;

  constructor(private readonly waves: WaveField, private readonly hooks: VolcanoHooks) {
    this.group.name = 'volcano';
    this.glow = new THREE.PointLight(0xff5a1a, 0, 160, 1.6);
    this.crater = new THREE.Mesh(new THREE.ConeGeometry(4, 3, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xff4d12, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    this.crater.rotation.x = Math.PI;
    this.group.add(this.glow, this.crater);
    this.smokeMat = new THREE.SpriteMaterial({ map: puffTexture(), color: 0x3a3330, transparent: true, depthWrite: false, opacity: 0.8 });
  }

  get active(): boolean {
    return !!this.island && (this.presence > 0 || this.balls.length > 0 || this.puffs.length > 0);
  }

  start(island: Island, level: number): void {
    this.clear();
    this.island = island;
    this.level = level;
    this.next = 3;
  }

  clear(): void {
    for (const b of this.balls) this.group.remove(b.mesh, b.ring, b.trail);
    this.balls.length = 0;
    for (const p of this.puffs) this.group.remove(p.sprite);
    this.puffs.length = 0;
    this.island = null;
    this.glow.intensity = 0;
    this.crater.visible = false;
  }

  private top(out: THREE.Vector3): THREE.Vector3 {
    const i = this.island!;
    return out.copy(i.summit).add(i.center);
  }

  update(dt: number, ship: ShipState): void {
    if (!this.island) return;
    const top = this.top(_top);
    const lv = LEVELS[this.level - 1];
    this.crater.visible = this.presence > 0.05;
    this.crater.position.copy(top).setY(top.y + 0.6);
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
        this.hooks.splash(at, 2.4);
        this.hooks.boom?.(at);
        this.hooks.blast(at, RADIUS, lv.damage);
        this.group.remove(b.mesh, b.ring, b.trail);
        b.trail.geometry.dispose();
        (b.ring.material as THREE.Material).dispose();
        this.balls.splice(i, 1);
      }
    }
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
