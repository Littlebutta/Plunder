import * as THREE from 'three';
import type { Island } from './Islands';

/**
 * Ownership pips: a small banner on a pole on every island someone holds,
 * white for NPCs and the player's colour for the player's. Unheld islands
 * show nothing.
 */
export class IslandMarkers {
  readonly group = new THREE.Group();
  private readonly pips: { island: Island; root: THREE.Group; cloth: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  private playerColour = new THREE.Color(0xd8343a);
  private time = 0;

  constructor(islands: Island[]) {
    this.group.name = 'island-markers';
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x2a1708 });
    for (const island of islands) {
      const root = new THREE.Group();
      // stand it on the highest ground near the middle so it shows from every side
      let best = { x: 0, z: 0, h: -Infinity };
      for (let a = 0; a < 12; a++) {
        for (const f of [0, 0.2, 0.4]) {
          const x = Math.cos((a / 12) * Math.PI * 2) * island.radius * f;
          const z = Math.sin((a / 12) * Math.PI * 2) * island.radius * f;
          const h = island.heightAt(x, z);
          if (h > best.h) best = { x, z, h };
        }
      }
      root.position.set(island.center.x + best.x, Math.max(best.h, 0.5) - 0.3, island.center.z + best.z);
      const height = 7;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, height, 6), poleMat);
      pole.position.y = height / 2;
      const clothGeo = new THREE.PlaneGeometry(2.6, 1.5, 8, 1);
      clothGeo.translate(1.3, 0, 0);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      const cloth = new THREE.Mesh(clothGeo, mat);
      cloth.position.y = height - 0.85;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), mat);
      knob.position.y = height + 0.1;
      root.add(pole, cloth, knob);
      this.group.add(root);
      this.pips.push({ island, root, cloth, mat });
    }
    this.refresh();
  }

  setPlayerColour(colour: THREE.ColorRepresentation): void {
    this.playerColour.set(colour);
    this.refresh();
  }

  /** Call after any island changes hands. */
  refresh(): void {
    for (const p of this.pips) {
      p.root.visible = p.island.owner !== 'none';
      p.mat.color.copy(p.island.owner === 'player' ? this.playerColour : _white);
    }
  }

  /** Banners stream downwind. `windAngle`: where the wind blows toward (0 = +X). */
  update(dt: number, windAngle: number): void {
    this.time += dt;
    for (const p of this.pips) {
      if (!p.root.visible) continue;
      p.cloth.rotation.y = -windAngle + Math.sin(this.time * 5 + p.root.position.x) * 0.18;
    }
  }
}

const _white = new THREE.Color(0xffffff);
