import * as THREE from 'three';
import { addOutline, toonMaterial } from '../render/toon';
import { PALETTE } from '../render/palette';
import type { WaveField } from '../ocean/waves';
import { Stock } from './Resources';
import { mulberry32 } from '../util/random';

/** Wreckage left where a ship went down: sail over it to haul the salvage aboard. */
export const FLOTSAM = {
  /** How close a hull must come to pick it up (m). */
  reach: 14,
  /** Seconds before it sinks out of reach. */
  life: 100,
  /** Wreckage of a hull of this many hit points carries 1x the base haul. */
  baseHp: 100,
  base: { wood: 14, stone: 0, salvage: 10 } as Stock,
  /** The killer's bounty, straight into their stores, as a share of the wreckage. */
  bounty: 0.6,
};

export interface FlotsamItem {
  id: number;
  position: THREE.Vector3;
  stock: Stock;
  age: number;
  group: THREE.Group;
}

export interface Collector {
  position: THREE.Vector3;
  faction: number;
}

const mats = {
  plank: toonMaterial(PALETTE.wood),
  dark: toonMaterial(PALETTE.woodDark),
  barrel: toonMaterial(0x9a6a3c),
  hoop: toonMaterial(0x5b5b62),
};

/** What the wreck of a ship this tough is worth. */
export function wreckValue(maxHp: number): Stock {
  const k = THREE.MathUtils.clamp(maxHp / FLOTSAM.baseHp, 0.5, 3);
  return { wood: Math.round(FLOTSAM.base.wood * k), stone: Math.round(FLOTSAM.base.stone * k), salvage: Math.round(FLOTSAM.base.salvage * k) };
}

export class FlotsamField {
  readonly group = new THREE.Group();
  readonly items: FlotsamItem[] = [];
  private nextId = 1;
  private t = 0;

  constructor(private readonly waves: WaveField) {
    this.group.name = 'flotsam';
  }

  /** Scatter wreckage at a point. `id` is given when the host told us of it. */
  spawn(at: THREE.Vector3, stock: Stock, id = this.nextId++): FlotsamItem {
    this.nextId = Math.max(this.nextId, id + 1);
    const g = new THREE.Group();
    const rand = mulberry32(id * 9301 + 49297);
    // planks
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(2.6 + rand() * 1.8, 0.18, 0.45), i % 2 ? mats.plank : mats.dark);
      p.position.set((rand() - 0.5) * 7, 0.05, (rand() - 0.5) * 7);
      p.rotation.y = rand() * Math.PI;
      addOutline(p, 0.04, PALETTE.outline);
      g.add(p);
    }
    // barrels and a crate, the part worth having
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.1, 10), mats.barrel);
      b.rotation.set(Math.PI / 2, 0, rand() * Math.PI);
      b.position.set((rand() - 0.5) * 5, 0.25, (rand() - 0.5) * 5);
      addOutline(b, 0.04, PALETTE.outline);
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.05, 4, 12), mats.hoop);
      hoop.rotation.x = Math.PI / 2;
      b.add(hoop);
      g.add(b);
    }
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), mats.plank);
    crate.position.set((rand() - 0.5) * 3, 0.3, (rand() - 0.5) * 3);
    crate.rotation.y = rand() * Math.PI;
    addOutline(crate, 0.05, PALETTE.outline);
    g.add(crate);
    g.position.copy(at).setY(0);
    this.group.add(g);
    const item: FlotsamItem = { id, position: g.position, stock: { ...stock }, age: 0, group: g };
    this.items.push(item);
    return item;
  }

  remove(id: number): void {
    const i = this.items.findIndex((f) => f.id === id);
    if (i < 0) return;
    const [f] = this.items.splice(i, 1);
    f.group.removeFromParent();
    f.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }

  /**
   * Bob on the swell, sink when old, and (on the copy that decides) hand the
   * salvage to the first hull that comes close.
   */
  update(dt: number, collectors: Collector[], authority: boolean, collected: (item: FlotsamItem, by: number) => void): void {
    this.t += dt;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const f = this.items[i];
      f.age += dt;
      const sink = Math.max(0, f.age - (FLOTSAM.life - 8)) * 0.25;
      f.group.position.y = this.waves.heightAt(f.position.x, f.position.z) - 0.1 - sink;
      f.group.rotation.y += dt * 0.05;
      if (!authority) continue;
      if (f.age > FLOTSAM.life) {
        collected(f, -1);
        this.remove(f.id);
        continue;
      }
      for (const c of collectors) {
        if (Math.hypot(c.position.x - f.position.x, c.position.z - f.position.z) > FLOTSAM.reach) continue;
        collected(f, c.faction);
        this.remove(f.id);
        break;
      }
    }
  }
}
