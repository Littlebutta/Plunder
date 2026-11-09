import * as THREE from 'three';
import { toonMaterial } from '../render/toon';
import { WaveField } from '../ocean/waves';

/**
 * Cartoon impact effects, all drawn with a handful of InstancedMeshes so a
 * barrage of hundreds of splashes is still only a few draw calls.
 * Particles never fade with alpha: they grow and shrink, which reads well with
 * cel shading and keeps everything opaque (cheap, no sorting).
 */

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size: number;
  spin: number;
  /** Gravity multiplier (0 for smoke). */
  grav: number;
  /** Float on the water surface instead of falling through it. */
  surface: boolean;
  shape: (t: number) => THREE.Vector3; // scale over normalized age
}

class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly items: Particle[] = [];
  private cursor = 0;
  private readonly dummy = new THREE.Object3D();

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) {
      this.items.push({
        alive: false,
        age: 0,
        life: 1,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        size: 1,
        spin: 0,
        grav: 0,
        surface: false,
        shape: () => _one,
      });
    }
  }

  emit(init: Partial<Omit<Particle, 'pos' | 'vel'>> & { pos: THREE.Vector3; vel?: THREE.Vector3 }): void {
    // Ring buffer: when full, the oldest particle is recycled.
    const p = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.capacity;
    p.alive = true;
    p.age = 0;
    p.life = init.life ?? 1;
    p.pos.copy(init.pos);
    p.vel.copy(init.vel ?? _zero);
    p.size = init.size ?? 1;
    p.spin = init.spin ?? 0;
    p.grav = init.grav ?? 0;
    p.surface = init.surface ?? false;
    p.shape = init.shape ?? (() => _one);
  }

  update(dt: number, waves: WaveField): void {
    let n = 0;
    const d = this.dummy;
    for (const p of this.items) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      p.vel.y -= 9.81 * p.grav * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.surface) p.pos.y = waves.heightAt(p.pos.x, p.pos.z) + 0.04;
      const t = p.age / p.life;
      d.position.copy(p.pos);
      d.rotation.set(p.spin * p.age, p.spin * p.age * 0.7, 0);
      d.scale.copy(p.shape(t)).multiplyScalar(p.size);
      d.updateMatrix();
      this.mesh.setMatrixAt(n++, d.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export class Effects {
  readonly group = new THREE.Group();
  private readonly columns: ParticlePool;
  private readonly rings: ParticlePool;
  private readonly droplets: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly debris: ParticlePool;
  private readonly flashes: ParticlePool;

  constructor(private readonly waves: WaveField) {
    this.group.name = 'effects';
    const white = toonMaterial(0xffffff, { emissive: 0x9fd4ef, emissiveIntensity: 0.35 });

    // Splash column: a tapered, open-topped cone of water.
    const colGeo = new THREE.CylinderGeometry(0.35, 1, 1, 10, 1, true);
    colGeo.translate(0, 0.5, 0);
    this.columns = new ParticlePool(colGeo, toonMaterial(0xffffff, { side: THREE.DoubleSide, emissive: 0x9fd4ef, emissiveIntensity: 0.35 }), 512);

    // Foam ring lying on the water.
    const ringGeo = new THREE.TorusGeometry(1, 0.12, 4, 20);
    ringGeo.rotateX(Math.PI / 2);
    this.rings = new ParticlePool(ringGeo, white, 512);

    this.droplets = new ParticlePool(new THREE.IcosahedronGeometry(1, 0), white, 2048);
    this.smoke = new ParticlePool(new THREE.IcosahedronGeometry(1, 1), toonMaterial(0xe9e4dc, { emissive: 0x554433, emissiveIntensity: 0.15 }), 512);
    this.debris = new ParticlePool(new THREE.BoxGeometry(1, 0.35, 0.5), toonMaterial(0x9a5a2c), 512);
    this.flashes = new ParticlePool(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffd36a }), 128);

    for (const pool of [this.columns, this.rings, this.droplets, this.smoke, this.debris, this.flashes]) this.group.add(pool.mesh);
  }

  /** Water splash. `size` ~0.5 for swivel balls, ~1.5 for cannon shells. */
  splash(pos: THREE.Vector3, size = 1): void {
    const h = 2.2 * size;
    this.columns.emit({
      pos,
      life: 0.55 + size * 0.15,
      size: 1,
      shape: (t) => _s.set(0.5 * size * (1 + t * 0.6), h * Math.sin(Math.PI * Math.min(1, t * 1.15)), 0.5 * size * (1 + t * 0.6)),
    });
    this.rings.emit({
      pos,
      life: 1.4,
      surface: true,
      shape: (t) => _s.set(0.4 + t * 2.4 * size, 1 - t * 0.6, 0.4 + t * 2.4 * size).multiplyScalar(t < 0.8 ? 1 : (1 - t) * 5),
    });
    const drops = Math.round(5 + size * 6);
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = (1 + Math.random() * 2) * size;
      _v.set(Math.cos(a) * out, (4 + Math.random() * 4) * Math.sqrt(size), Math.sin(a) * out);
      this.droplets.emit({
        pos,
        vel: _v,
        grav: 1,
        life: 0.6 + Math.random() * 0.4,
        size: 0.12 * Math.sqrt(size) + Math.random() * 0.06,
        spin: 5,
        shape: (t) => _s.setScalar(1 - t * t),
      });
    }
  }

  /** Muzzle flash + smoke puffs along the barrel direction. */
  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, inherit: THREE.Vector3, size = 1): void {
    this.flashes.emit({ pos, life: 0.08, size: 0.35 * size, shape: (t) => _s.setScalar(1 - t * 0.5) });
    for (let i = 0; i < 4; i++) {
      _v.copy(dir).multiplyScalar((1.5 + i * 1.2) * size).add(inherit);
      _v.x += (Math.random() - 0.5) * 0.6;
      _v.y += 0.4 + Math.random() * 0.5;
      _v.z += (Math.random() - 0.5) * 0.6;
      this.smoke.emit({
        pos,
        vel: _v,
        life: 1.2 + Math.random() * 0.8,
        size: (0.22 + i * 0.06) * size,
        spin: 0.5,
        shape: (t) => _s.setScalar(Math.min(1, t * 6) * (1 + t * 2.2) * (1 - t * t)),
      });
    }
  }

  /** Wooden splinters (barrel / hull hits). */
  splinters(pos: THREE.Vector3, count = 12): void {
    for (let i = 0; i < count; i++) {
      _v.set((Math.random() - 0.5) * 7, 3 + Math.random() * 5, (Math.random() - 0.5) * 7);
      this.debris.emit({
        pos,
        vel: _v,
        grav: 1,
        life: 1 + Math.random() * 0.6,
        size: 0.12 + Math.random() * 0.15,
        spin: 8 + Math.random() * 6,
        shape: (t) => _s.setScalar(t < 0.8 ? 1 : (1 - t) * 5),
      });
    }
    this.smoke.emit({ pos, life: 0.9, size: 0.7, shape: (t) => _s.setScalar((0.4 + t) * (1 - t)) });
  }

  update(dt: number): void {
    this.columns.update(dt, this.waves);
    this.rings.update(dt, this.waves);
    this.droplets.update(dt, this.waves);
    this.smoke.update(dt, this.waves);
    this.debris.update(dt, this.waves);
    this.flashes.update(dt, this.waves);
  }
}
