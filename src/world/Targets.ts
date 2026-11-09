import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { WaveField } from '../ocean/waves';
import type { Collider } from '../combat/ProjectileSystem';

interface Target {
  id: number;
  mesh: THREE.Group;
  collider: Collider;
  alive: boolean;
  respawn: number;
  spin: number;
  phase: number;
}

/** Collider ids >= this are floating targets. */
export const TARGET_ID_BASE = 100;

/**
 * Floating powder barrels with a red flag, scattered near the start: something
 * to shoot at with the swivel gun until enemy ships exist. They bob on the
 * same wave field and respawn a while after being smashed.
 */
export class Targets {
  readonly group = new THREE.Group();
  private readonly targets: Target[] = [];
  score = 0;

  constructor(
    private readonly waves: WaveField,
    count = 10,
  ) {
    this.group.name = 'targets';
    const wood = toonMaterial(PALETTE.wood);
    const dark = toonMaterial(PALETTE.woodDark);
    const flagMat = toonMaterial(PALETTE.flag, { side: THREE.DoubleSide });
    const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.0, 14);
    // bulge the staves a little
    const pos = barrelGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = 1 + 0.16 * (1 - (y / 0.5) ** 2);
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
    barrelGeo.computeVertexNormals();

    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(barrelGeo, wood);
      addOutline(b, 0.03, PALETTE.outline);
      g.add(b);
      for (const y of [-0.3, 0.3]) {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.03, 4, 18), dark);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = y;
        g.add(hoop);
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 5), dark);
      pole.position.y = 1.1;
      g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.3), flagMat);
      flag.position.set(0.25, 1.6, 0);
      g.add(flag);
      g.traverse((o) => ((o as THREE.Mesh).isMesh ? (o.castShadow = true) : null));
      this.group.add(g);
      const t: Target = {
        id: TARGET_ID_BASE + i,
        mesh: g,
        collider: { id: TARGET_ID_BASE + i, position: new THREE.Vector3(), radius: 0.65 },
        alive: true,
        respawn: 0,
        spin: Math.random() * Math.PI * 2,
        phase: Math.random() * 10,
      };
      this.place(t, i);
      this.targets.push(t);
    }
  }

  private place(t: Target, i = Math.floor(Math.random() * 1000)): void {
    const a = i * 2.39996 + Math.random() * 0.5; // golden-angle spiral
    const r = 25 + ((i * 17) % 60) + Math.random() * 20;
    t.mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    t.mesh.visible = true;
    t.alive = true;
  }

  /** Colliders for live targets (sent to the projectile worker each frame). */
  colliders(): Collider[] {
    return this.targets.filter((t) => t.alive).map((t) => t.collider);
  }

  /** Returns the target's position if it was live and is now destroyed. */
  hit(id: number): THREE.Vector3 | null {
    const t = this.targets.find((x) => x.id === id);
    if (!t || !t.alive) return null;
    t.alive = false;
    t.mesh.visible = false;
    t.respawn = 12;
    this.score++;
    return t.mesh.position.clone();
  }

  update(dt: number, time: number): void {
    for (const t of this.targets) {
      if (!t.alive) {
        t.respawn -= dt;
        if (t.respawn <= 0) this.place(t);
        continue;
      }
      const p = t.mesh.position;
      const s = this.waves.sample(p.x, p.z, _sample);
      p.y = s.height - 0.25 + Math.sin(time * 1.7 + t.phase) * 0.05;
      // tilt with the surface normal
      t.mesh.quaternion.setFromUnitVectors(_up, s.normal);
      t.mesh.rotateY(t.spin + time * 0.1);
      t.collider.position.set(p.x, p.y + 0.2, p.z);
    }
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _sample = { height: 0, normal: new THREE.Vector3() };
