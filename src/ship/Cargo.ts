import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { bakeMerged, disposeMerged } from '../render/merge';
import { RESOURCE_IDS, ResourceId, Stock } from '../world/Resources';

const mats = {
  crate: toonMaterial(PALETTE.woodLight),
  plank: toonMaterial(PALETTE.wood),
  stone: toonMaterial(0xb9b2a6),
  metal: toonMaterial(0x6f8796),
  band: toonMaterial(0x33363c),
};

/** Cargo pieces come in a handful of shapes: one geometry per shape, shared by every ship. */
const geos = new Map<string, THREE.BufferGeometry>();
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const k = `b${w},${h},${d}`;
  let g = geos.get(k);
  if (!g) geos.set(k, (g = new THREE.BoxGeometry(w, h, d)));
  return g;
}
function shared(k: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geos.get(k);
  if (!g) geos.set(k, (g = make()));
  return g;
}

/** One piece of cargo for a resource: timber crates, cut stone, bound metal ingots. */
function piece(id: ResourceId, n: number): THREE.Object3D {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number, outline = 0.025) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = true;
    if (outline > 0) addOutline(m, outline, PALETTE.outline);
    g.add(m);
    return m;
  };
  if (id === 'wood') {
    if (n % 3 === 2) {
      // a stack of planks
      for (let i = 0; i < 3; i++) add(box(0.5, 0.1, 0.78), i % 2 ? mats.crate : mats.plank, 0.06 + i * 0.11, 0.015).rotation.y = (i - 1) * 0.08;
    } else if (n % 3 === 1) {
      const barrel = add(shared('barrel', () => new THREE.CylinderGeometry(0.23, 0.23, 0.54, 10)), mats.plank, 0.27);
      for (const y of [-0.15, 0.15]) {
        const hoop = new THREE.Mesh(shared('hoop', () => new THREE.TorusGeometry(0.235, 0.022, 4, 14)), mats.band);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = y;
        barrel.add(hoop);
      }
    } else add(box(0.48, 0.42, 0.48), mats.crate, 0.21);
  } else if (id === 'stone') {
    add(box(0.5, 0.3, 0.42), mats.stone, 0.15);
    if (n % 2) add(box(0.36, 0.24, 0.34), mats.stone, 0.42).rotation.y = 0.5;
  } else {
    // metal: ingots stacked on a pallet
    add(box(0.5, 0.06, 0.5), mats.plank, 0.03, 0);
    for (let i = 0; i < 3; i++) add(box(0.14, 0.1, 0.42), mats.metal, 0.11, 0.012).position.x = (i - 1) * 0.16;
    for (let i = 0; i < 2; i++) add(box(0.14, 0.1, 0.42), mats.metal, 0.21, 0.012).position.x = (i - 0.5) * 0.16;
  }
  g.rotation.y = ((n * 37) % 10) * 0.06 - 0.3;
  return g;
}

/**
 * Cargo lashed down on deck: the fuller the hold, the more of it shows, and
 * what shows is what is in the hold (timber, stone, metals).
 */
export class CargoPile {
  /** What is drawn: the pieces on show, baked into a mesh per material. */
  readonly group = new THREE.Group();
  /** Every piece for every place, kept out of the scene. */
  private readonly parts = new THREE.Group();
  private readonly slots: Record<ResourceId, THREE.Object3D>[] = [];
  private key = '';
  private shown = '';

  constructor(places: THREE.Vector3[]) {
    this.group.name = 'cargo';
    places.forEach((at, n) => {
      const set = {} as Record<ResourceId, THREE.Object3D>;
      for (const id of RESOURCE_IDS) {
        const p = piece(id, n);
        p.position.copy(at);
        p.visible = false;
        this.parts.add(p);
        set[id] = p;
      }
      this.slots.push(set);
    });
  }

  set(stock: Stock, capacity: number): void {
    const key = RESOURCE_IDS.map((id) => stock[id]).join(',') + ':' + capacity;
    if (key === this.key) return;
    this.key = key;
    const used = RESOURCE_IDS.reduce((n, id) => n + stock[id], 0);
    const show = used <= 0 ? 0 : Math.max(1, Math.min(this.slots.length, Math.round((used / Math.max(1, capacity)) * this.slots.length)));
    // share the visible slots out between the resources in proportion
    const order: ResourceId[] = [];
    const acc = { wood: 0, stone: 0, salvage: 0 } as Stock;
    for (let i = 0; i < show; i++) {
      for (const id of RESOURCE_IDS) acc[id] += stock[id] / used;
      const pick = RESOURCE_IDS.reduce((a, b) => (acc[b] > acc[a] ? b : a));
      acc[pick] -= 1;
      order.push(pick);
    }
    // a few crates are a few dozen meshes: bake what shows, and only when that changes
    const shown = order.join(',');
    if (shown === this.shown) return;
    this.shown = shown;
    this.slots.forEach((set, i) => {
      for (const id of RESOURCE_IDS) set[id].visible = i < show && order[i] === id;
    });
    disposeMerged(this.group.children);
    this.group.clear();
    for (const m of bakeMerged(this.parts)) this.group.add(m);
  }
}
