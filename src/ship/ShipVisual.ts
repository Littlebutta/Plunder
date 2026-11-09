import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { CANNON_MIN_HALF_BEAM, deckAt, halfBeamAt, HullDesign, keelAt, mastSize, sheerAt, STATIONS, zAt } from './HullDesign';

export interface ShipVisual {
  group: THREE.Group;
  /** One per mast: the yard pivot (swings to the wind) and its sail (furls). */
  sails: { pivot: THREE.Group; mesh: THREE.Mesh }[];
  flag: THREE.Mesh | null;
  rudder: THREE.Group;
  bowMount: THREE.Vector3;
  gunMounts: THREE.Vector3[];
}

/** Points around half a cross-section, keel to rail. */
const SECTION = 8;
/** Lengthwise subdivisions of the lofted skin (finer than the drawn stations). */
const LOFT = 48;

/**
 * Loft a drawn design into a ship model.
 *
 * Each cross-section runs from the keel out and up to the rail along a
 * rounded curve; sections are skinned along the length into one hull mesh.
 * Deck, rail, transom, rudder, masts, yards, sails and a pennant are added
 * from the same curves, and mount points for the bow gun and each cannon
 * pair are returned for the game to hang weapons on.
 */
export function buildShipVisual(d: HullDesign): ShipVisual {
  const group = new THREE.Group();
  group.name = 'ship';
  const wood = toonMaterial(PALETTE.wood, { side: THREE.DoubleSide });
  const woodDark = toonMaterial(PALETTE.woodDark);
  const woodLight = toonMaterial(PALETTE.woodLight, { side: THREE.DoubleSide });

  // --- Hull skin ------------------------------------------------------------
  const cols = SECTION * 2 + 1; // port rail .. keel .. starboard rail
  const pos: number[] = [];
  const section = (t: number, k: number, out: THREE.Vector3) => {
    const s = k / SECTION - 1; // -1 port rail, 0 keel, 1 starboard rail
    const u = Math.abs(s);
    const hb = Math.max(0.03, halfBeamAt(d, t));
    const kd = keelAt(d, t);
    const top = sheerAt(d, t);
    // round bilge: the side goes out quickly, then turns up to the rail
    const x = hb * Math.pow(Math.sin((u * Math.PI) / 2), 0.7);
    const y = -kd + (top + kd) * Math.pow(1 - Math.cos((u * Math.PI) / 2), 1.25);
    return out.set(Math.sign(s) * x, y, zAt(d, t));
  };
  const v = new THREE.Vector3();
  for (let i = 0; i <= LOFT; i++) {
    for (let k = 0; k < cols; k++) {
      section(i / LOFT, k, v);
      pos.push(v.x, v.y, v.z);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < LOFT; i++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = i * cols + k;
      const b = a + 1;
      const c = a + cols;
      const e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  // close bow and stern with fans to a point on the centreline
  for (const end of [0, LOFT]) {
    const t = end / LOFT;
    const centre = pos.length / 3;
    pos.push(0, (sheerAt(d, t) - keelAt(d, t)) / 2, zAt(d, t));
    for (let k = 0; k < cols - 1; k++) {
      const a = end * cols + k;
      if (end === 0) idx.push(centre, a, a + 1);
      else idx.push(centre, a + 1, a);
    }
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.setIndex(idx);
  hullGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hullGeo, wood);
  hull.castShadow = true;
  addOutline(hull, Math.min(0.09, 0.03 + d.length * 0.003), PALETTE.outline);
  group.add(hull);

  // --- Deck -------------------------------------------------------------------
  const deckPos: number[] = [];
  const deckIdx: number[] = [];
  for (let i = 0; i <= LOFT; i++) {
    const t = i / LOFT;
    const hb = Math.max(0.02, halfBeamAt(d, t) * 0.93);
    const y = deckAt(d, t);
    deckPos.push(-hb, y, zAt(d, t), hb, y, zAt(d, t));
    if (i < LOFT) {
      const a = i * 2;
      deckIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3));
  deckGeo.setIndex(deckIdx);
  deckGeo.computeVertexNormals();
  const deck = new THREE.Mesh(deckGeo, woodLight);
  deck.receiveShadow = true;
  group.add(deck);

  // --- Rails: a dark strake along the top of each side ---------------------------
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= STATIONS * 2; i++) {
      const t = i / (STATIONS * 2);
      pts.push(new THREE.Vector3(side * Math.max(0.03, halfBeamAt(d, t)), sheerAt(d, t), zAt(d, t)));
    }
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.07 + d.length * 0.003, 5), woodDark);
    rail.castShadow = true;
    group.add(rail);
  }

  // --- Keel timber + bowsprit ----------------------------------------------------
  const keelPts: THREE.Vector3[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = i / STATIONS;
    keelPts.push(new THREE.Vector3(0, -keelAt(d, t) - 0.04, zAt(d, t)));
  }
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(keelPts), 40, 0.09, 5), woodDark));
  if (d.length >= 9) {
    const len = d.length * 0.2;
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, len, 7), woodDark);
    sprit.rotation.x = -Math.PI / 2 + 0.28;
    sprit.position.set(0, sheerAt(d, 0) + Math.sin(0.28) * len * 0.5 - 0.1, zAt(d, 0) - Math.cos(0.28) * len * 0.4);
    addOutline(sprit, 0.025, PALETTE.outline);
    sprit.castShadow = true;
    group.add(sprit);
  }

  // --- Rudder --------------------------------------------------------------------
  const rudder = new THREE.Group();
  const rh = keelAt(d, 1) + sheerAt(d, 1) * 0.6;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, rh, 0.5 + d.length * 0.03), woodDark);
  blade.position.set(0, 0, 0.25 + d.length * 0.015);
  addOutline(blade, 0.025, PALETTE.outline);
  rudder.add(blade);
  rudder.position.set(0, sheerAt(d, 1) * 0.6 - rh / 2, zAt(d, 1) + 0.02);
  group.add(rudder);

  // --- Masts, yards, sails -------------------------------------------------------
  const sails: ShipVisual['sails'] = [];
  let flag: THREE.Mesh | null = null;
  d.masts.forEach((t, i) => {
    const m = mastSize(d, i);
    const base = deckAt(d, t);
    const z = zAt(d, t);
    const r = 0.06 + m.height * 0.012;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.65, r, m.height, 8), woodDark);
    mast.position.set(0, base + m.height / 2, z);
    mast.castShadow = true;
    addOutline(mast, 0.03, PALETTE.outline);
    group.add(mast);

    const pivot = new THREE.Group();
    pivot.position.set(0, base + m.height * 0.9, z + r + 0.08);
    group.add(pivot);
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, m.yard, 6), woodDark);
    yard.rotation.z = Math.PI / 2;
    yard.castShadow = true;
    addOutline(yard, 0.025, PALETTE.outline);
    pivot.add(yard);

    const sailGeo = new THREE.PlaneGeometry(m.sailW, m.sailH, 10, 10);
    const sp = sailGeo.attributes.position as THREE.BufferAttribute;
    for (let n = 0; n < sp.count; n++) {
      const u = sp.getX(n) / (m.sailW / 2);
      const w = sp.getY(n) / (m.sailH / 2);
      // billow forward
      sp.setZ(n, -m.sailW * 0.2 * (1 - u * u) * (1 - w * w * 0.6));
    }
    sailGeo.translate(0, -m.sailH / 2, 0);
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, toonMaterial(PALETTE.sail, { side: THREE.DoubleSide }));
    sail.castShadow = true;
    pivot.add(sail);
    sails.push({ pivot, mesh: sail });

    if (i === 0) {
      const flagGeo = new THREE.PlaneGeometry(1.1, 0.45, 6, 1);
      flagGeo.translate(0.55, 0, 0);
      flag = new THREE.Mesh(flagGeo, toonMaterial(PALETTE.flag, { side: THREE.DoubleSide }));
      flag.position.set(0, base + m.height + 0.1, z);
      group.add(flag);
    }
  });

  // --- Mount points --------------------------------------------------------------
  const bowT = 0.09;
  const bowMount = new THREE.Vector3(0, deckAt(d, bowT) + 0.02, zAt(d, bowT));
  const gunMounts: THREE.Vector3[] = [];
  for (const t of d.cannons) {
    const hb = halfBeamAt(d, t);
    if (hb < CANNON_MIN_HALF_BEAM) continue;
    for (const side of [1, -1]) gunMounts.push(new THREE.Vector3(side * (hb * 0.93 - 0.42), deckAt(d, t), zAt(d, t)));
  }

  return { group, sails, flag, rudder, bowMount, gunMounts };
}

/** Free the GPU memory of a built ship (the shipyard rebuilds its preview on every edit). */
export function disposeShipVisual(group: THREE.Object3D): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
