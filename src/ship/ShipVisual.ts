import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, sailTint, toonMaterial } from '../render/toon';
import { createWaterMask } from '../render/waterMask';
import { cannonMount, deckAt, gunHeight, halfBeamAt, HullDesign, hullHalfWidthAt, hullPoint, keelAt, mastSize, SailType, sheerAt, STATIONS, zAt } from './HullDesign';

export interface ShipVisual {
  group: THREE.Group;
  /**
   * One per mast. Square: `pivot` is the yard, swinging to the wind, and the
   * sail furls upward. Lateen: `pivot` swings the whole triangle round the mast.
   */
  sails: { type: SailType; pivot: THREE.Group; mesh: THREE.Mesh }[];
  /** Headsail, if fitted. */
  jib: THREE.Mesh | null;
  flag: THREE.Mesh | null;
  rudder: THREE.Group;
  /** Where the swivel gun stands, and which way it faces (0 = bow, PI = stern). */
  swivelMount: THREE.Vector3;
  swivelFacing: number;
  /** One per cannon in the design, in the same order. */
  gunMounts: THREE.Vector3[];
  /** Shared by every sail / the pennant, so the owner's colour can be changed later. */
  sailMaterial: THREE.MeshToonMaterial;
  flagMaterial: THREE.MeshToonMaterial;
  /** Places on deck where cargo can be stacked, in the order they fill. */
  cargoPlaces: THREE.Vector3[];
  /**
   * One per mast, in design order. `group` holds the mast with its yard, sail
   * and rigging and is hinged at the deck, so a shot-away mast can topple.
   */
  masts: MastVisual[];
}

export interface MastVisual {
  group: THREE.Group;
  /** Foot of the mast in ship space, and its height above that. */
  foot: THREE.Vector3;
  height: number;
}

/** Points around half a cross-section, keel to rail. */
const SECTION = 8;
/** Lengthwise subdivisions of the lofted skin (finer than the drawn stations). */
const LOFT = 96;
/** Half the width of the gap cut in the rail and bulwark for a deck gun (m). */
const EMBRASURE = 0.42;
/** Lateen yard: how steeply it rakes up toward the stern (radians). */
const LATEEN_RAKE = 0.6;

/** A straight round bar between two points (spars, ropes, posts). */
function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material, sides = 5): THREE.Mesh {
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, sides), mat);
  mesh.position.copy(a).lerp(b, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

/** A triangular sail a-b-c, subdivided and bellied out along +x. */
function triangleSail(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, belly: number): THREE.BufferGeometry {
  const N = 8;
  const pos: number[] = [];
  const idx: number[] = [];
  const at: number[][] = [];
  for (let i = 0; i <= N; i++) {
    at.push([]);
    for (let j = 0; j <= N - i; j++) {
      const wa = i / N;
      const wb = j / N;
      const wc = 1 - wa - wb;
      at[i].push(pos.length / 3);
      pos.push(a.x * wa + b.x * wb + c.x * wc + belly * 27 * wa * wb * wc, a.y * wa + b.y * wb + c.y * wc, a.z * wa + b.z * wb + c.z * wc);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) {
      idx.push(at[i][j], at[i + 1][j], at[i][j + 1]);
      if (j < N - i - 1) idx.push(at[i + 1][j], at[i + 1][j + 1], at[i][j + 1]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Loft a drawn design into a ship model.
 *
 * Each cross-section runs from the keel out and up to the rail along a
 * rounded curve; sections are skinned along the length into one hull mesh.
 * Deck, rails, strakes, stem, rudder, masts, sails, rigging, gun ports and
 * deck fittings are added from the same curves, and mount points for the
 * swivel gun and each cannon are returned for the game to hang weapons on.
 *
 * @param colour the owner's colour for sails and pennant (NPC ships are white)
 */
export function buildShipVisual(d: HullDesign, colour: THREE.ColorRepresentation = PALETTE.sail): ShipVisual {
  const group = new THREE.Group();
  group.name = 'ship';
  const wood = toonMaterial(PALETTE.wood, { side: THREE.DoubleSide });
  const woodDark = toonMaterial(PALETTE.woodDark);
  const woodLight = toonMaterial(PALETTE.woodLight, { side: THREE.DoubleSide });
  const rope = toonMaterial(PALETTE.rope);
  const iron = toonMaterial(0x2f2c2a);
  const sailMaterial = toonMaterial(colour === PALETTE.sail ? colour : sailTint(colour), { side: THREE.DoubleSide });
  const flagMaterial = toonMaterial(colour === PALETTE.sail ? PALETTE.flag : colour, { side: THREE.DoubleSide });
  const big = d.length >= 10;
  const add = (mesh: THREE.Mesh, outline = 0, shadow = true) => {
    if (outline > 0) addOutline(mesh, outline, PALETTE.outline);
    mesh.castShadow = shadow;
    group.add(mesh);
    return mesh;
  };

  // Deck guns fire through gaps in the rail.
  const deckGuns = d.cannons.filter((c) => c.level === 0);
  const inEmbrasure = (t: number, side: number) => deckGuns.some((c) => c.side === side && Math.abs(c.t - t) * d.length < EMBRASURE);

  // --- Hull skin ------------------------------------------------------------
  const cols = SECTION * 2 + 1; // port rail .. keel .. starboard rail
  const pos: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i <= LOFT; i++) {
    for (let k = 0; k < cols; k++) {
      const s = k / SECTION - 1; // -1 port rail, 0 keel, 1 starboard rail
      const t = i / LOFT;
      hullPoint(d, t, Math.abs(s), Math.sign(s), v);
      // an embrasure for each deck gun: the bulwark is cut down to the deck there
      if ((k === 0 || k === cols - 1) && inEmbrasure(t, Math.sign(s))) {
        v.y = deckAt(d, t) + 0.03;
        v.x = Math.sign(s) * hullHalfWidthAt(d, t, v.y);
      }
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
    // and across the top, rail to rail, so the end is a solid board
    const first = end * cols;
    const last = end * cols + cols - 1;
    if (end === 0) idx.push(centre, last, first);
    else idx.push(centre, first, last);
  }
  const hullGeo = new THREE.BufferGeometry();
  hullGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hullGeo.setIndex(idx);
  hullGeo.computeVertexNormals();
  const hull = add(new THREE.Mesh(hullGeo, wood), Math.min(0.09, 0.03 + d.length * 0.003));

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

  // Deck planking: seams running fore and aft, wherever the deck is wide enough.
  const seams: number[] = [];
  const plank = 0.42;
  for (let n = -8; n <= 8; n++) {
    const x = n * plank;
    for (let i = 0; i < LOFT; i++) {
      const t0 = i / LOFT;
      const t1 = (i + 1) / LOFT;
      if (Math.abs(x) > halfBeamAt(d, t0) * 0.9 || Math.abs(x) > halfBeamAt(d, t1) * 0.9) continue;
      seams.push(x, deckAt(d, t0) + 0.012, zAt(d, t0), x, deckAt(d, t1) + 0.012, zAt(d, t1));
    }
  }
  const seamGeo = new THREE.BufferGeometry();
  seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(seams, 3));
  group.add(new THREE.LineSegments(seamGeo, new THREE.LineBasicMaterial({ color: PALETTE.wood })));

  // --- Lid at rail height that keeps the sea from showing inside the hull ------
  const lidPos: number[] = [];
  const lidIdx: number[] = [];
  for (let i = 0; i <= LOFT; i++) {
    const t = i / LOFT;
    const hb = Math.max(0.02, halfBeamAt(d, t) * 0.99);
    const y = sheerAt(d, t) - 0.02;
    lidPos.push(-hb, y, zAt(d, t), hb, y, zAt(d, t));
    if (i < LOFT) {
      const a = i * 2;
      // wound to face up (z runs bow to stern)
      lidIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const lidGeo = new THREE.BufferGeometry();
  lidGeo.setAttribute('position', new THREE.Float32BufferAttribute(lidPos, 3));
  lidGeo.setIndex(lidIdx);
  group.add(createWaterMask(lidGeo));

  // --- Rails and strakes: dark timbers running the length of each side ----------
  const sideLine = (u: number, radius: number, from = 0, to = 1) => {
    for (const side of [-1, 1]) {
      // the rail stops either side of each deck gun
      const cuts = u === 1 ? deckGuns.filter((c) => c.side === side).map((c) => c.t).sort((a, b) => a - b) : [];
      const gap = (EMBRASURE + 0.05) / d.length;
      const runs: [number, number][] = [];
      let start = from;
      for (const t of cuts) {
        if (t - gap > start + 0.01) runs.push([start, t - gap]);
        start = Math.max(start, t + gap);
      }
      if (to > start + 0.01) runs.push([start, to]);
      for (const [a, b] of runs) {
        const n = Math.max(3, Math.round((b - a) * STATIONS * 2));
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= n; i++) pts.push(hullPoint(d, a + ((b - a) * i) / n, u, side, new THREE.Vector3()));
        add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(6, n * 2), radius, 5), woodDark), 0, u === 1);
        if (cuts.length) {
          // a short post squares off each end of the gap
          for (const end of [pts[0], pts[n]]) {
            if (end.z < zAt(d, from + 0.02) || end.z > zAt(d, to - 0.02)) continue;
            add(strut(new THREE.Vector3(end.x, end.y - 0.3, end.z), new THREE.Vector3(end.x, end.y + 0.06, end.z), radius * 1.25, woodDark, 5), 0, false);
          }
        }
      }
    }
  };
  sideLine(1, 0.07 + d.length * 0.003); // rail
  sideLine(0.86, 0.035 + d.length * 0.002, 0.03, 0.98); // wale
  sideLine(0.7, 0.022 + d.length * 0.001, 0.05, 0.97);
  if (big) sideLine(0.55, 0.022 + d.length * 0.001, 0.08, 0.95);

  // --- Keel timber, stem post, bowsprit -----------------------------------------
  const keelPts: THREE.Vector3[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = i / STATIONS;
    keelPts.push(new THREE.Vector3(0, -keelAt(d, t) - 0.04, zAt(d, t)));
  }
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(keelPts), 40, 0.09, 5), woodDark));
  const bowZ = zAt(d, 0);
  add(strut(new THREE.Vector3(0, -keelAt(d, 0) - 0.05, bowZ - 0.02), new THREE.Vector3(0, sheerAt(d, 0) + 0.3 + d.length * 0.012, bowZ - 0.1 - d.length * 0.012), 0.07 + d.length * 0.004, woodDark, 6), 0.025);
  const hasSprit = d.length >= 9 || d.jib;
  const spritLen = d.length * 0.2;
  const spritTip = new THREE.Vector3(0, sheerAt(d, 0) + Math.sin(0.28) * spritLen * 0.9 - 0.1, bowZ - Math.cos(0.28) * spritLen * 0.8);
  if (hasSprit) add(strut(new THREE.Vector3(0, sheerAt(d, 0) - 0.15, bowZ + spritLen * 0.15), spritTip, 0.08, woodDark, 7), 0.025);

  // --- Rudder --------------------------------------------------------------------
  const rudder = new THREE.Group();
  const rh = keelAt(d, 1) + sheerAt(d, 1) * 0.6;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, rh, 0.5 + d.length * 0.03), woodDark);
  blade.position.set(0, 0, 0.25 + d.length * 0.015);
  addOutline(blade, 0.025, PALETTE.outline);
  rudder.add(blade);
  rudder.position.set(0, sheerAt(d, 1) * 0.6 - rh / 2, zAt(d, 1) + 0.02);
  group.add(rudder);

  // --- Masts, yards, sails, rigging ----------------------------------------------
  const sails: ShipVisual['sails'] = [];
  let flag: THREE.Mesh | null = null;
  const masts: MastVisual[] = [];
  d.masts.forEach((fit, i) => {
    const t = fit.t;
    const m = mastSize(d, i);
    const base = deckAt(d, t);
    const z = zAt(d, t);
    const r = 0.06 + m.height * 0.012;
    // everything this mast carries hangs off one group hinged at its foot
    const mg = new THREE.Group();
    mg.position.set(0, base, z);
    group.add(mg);
    masts.push({ group: mg, foot: mg.position.clone(), height: m.height });
    const add = <T extends THREE.Object3D>(o: T, outline = 0, shadow = true): T => {
      const mesh = o as unknown as THREE.Mesh;
      if (mesh.isMesh) {
        if (outline > 0) addOutline(mesh, outline, PALETTE.outline);
        mesh.castShadow = shadow;
      }
      mg.add(o);
      return o;
    };
    /** Place something given in ship space into the mast's own frame. */
    const rel = <T extends THREE.Object3D>(o: T): T => {
      o.position.sub(mg.position);
      return o;
    };
    const mast = add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.65, r, m.height, 8), woodDark), 0.03);
    mast.position.set(0, base + m.height / 2, z);
    rel(mast);
    const truck = add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.95, 8, 6), woodDark), 0, false);
    truck.position.set(0, base + m.height, z);
    rel(truck);

    // shrouds: two ropes a side from the rail up to the mast
    for (const side of [-1, 1]) {
      for (const dt of [-0.02, 0.035]) {
        const foot = hullPoint(d, THREE.MathUtils.clamp(t + dt, 0.02, 0.98), 1, side, new THREE.Vector3());
        rel(add(strut(foot, new THREE.Vector3(0, base + m.height * 0.8, z), 0.022, rope, 4), 0, false));
      }
    }
    // crow's nest on a tall main mast
    if (i === 0 && m.height >= 9) {
      const nest = add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.38, 0.4, 10, 1, true), toonMaterial(PALETTE.woodDark, { side: THREE.DoubleSide })), 0.025);
      nest.position.set(0, base + m.height * 0.82, z);
      rel(nest);
      const floor = add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 10), woodLight), 0, false);
      floor.position.set(0, base + m.height * 0.82 - 0.18, z);
      rel(floor);
    }

    const pivot = new THREE.Group();
    mg.add(pivot);
    let sail: THREE.Mesh;
    if (fit.sail === 'square') {
      pivot.position.set(0, m.height * 0.9, r + 0.08);
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
      sail = new THREE.Mesh(sailGeo, sailMaterial);
      pivot.add(sail);
    } else {
      // Lateen: a long yard raked up toward the stern with a triangle of sail under it.
      pivot.position.set(0, m.height * 0.78, 0);
      const rig = new THREE.Group();
      rig.rotation.x = -LATEEN_RAKE; // local +z (aft) tips upward
      rig.position.x = r + 0.06;
      pivot.add(rig);
      const len = m.height * 0.95;
      const tack = new THREE.Vector3(0, 0, -len * 0.4);
      const peak = new THREE.Vector3(0, 0, len * 0.6);
      const yard = strut(tack, peak, r * 0.45, woodDark, 6);
      yard.castShadow = true;
      addOutline(yard, 0.025, PALETTE.outline);
      rig.add(yard);
      // clew: low and aft in the mast's frame, turned into the raked frame
      const clew = new THREE.Vector3(0, -m.height * 0.56, len * 0.42).applyAxisAngle(new THREE.Vector3(1, 0, 0), LATEEN_RAKE);
      sail = new THREE.Mesh(triangleSail(tack, peak, clew, len * 0.11), sailMaterial);
      rig.add(sail);
    }
    sail.castShadow = true;
    sails.push({ type: fit.sail, pivot, mesh: sail });

    if (i === 0) {
      const flagGeo = new THREE.PlaneGeometry(1.1, 0.45, 6, 1);
      flagGeo.translate(0.55, 0, 0);
      flag = new THREE.Mesh(flagGeo, flagMaterial);
      flag.position.set(0, m.height + 0.25, 0);
      mg.add(flag);
    }
  });

  // Jib: from the bowsprit up the forestay to the foremast.
  let jib: THREE.Mesh | null = null;
  if (d.jib && d.masts.length > 0) {
    const fi = d.masts.reduce((best, m, i) => (m.t < d.masts[best].t ? i : best), 0);
    const ft = d.masts[fi].t;
    const fm = mastSize(d, fi);
    const head = new THREE.Vector3(0, deckAt(d, ft) + fm.height * 0.86, zAt(d, ft) - 0.15);
    const fg = masts[fi].group;
    const stay = add(strut(spritTip, head, 0.02, rope, 4), 0, false);
    stay.position.sub(fg.position);
    fg.add(stay);
    const tack = spritTip.clone().lerp(head, 0.06);
    const top = spritTip.clone().lerp(head, 0.82);
    const clew = new THREE.Vector3(0, deckAt(d, ft) + 1.0 + fm.height * 0.05, zAt(d, ft) - 0.7);
    jib = new THREE.Mesh(triangleSail(tack, top, clew, tack.distanceTo(top) * 0.09), sailMaterial);
    jib.castShadow = true;
    jib.position.sub(fg.position);
    fg.add(jib);
  }

  // --- Deck fittings ---------------------------------------------------------------
  const clearOfMasts = (t: number, gap: number) => d.masts.every((m) => Math.abs(m.t - t) * d.length > gap);
  if (big) {
    // cargo hatch with a grating
    const ht = [0.56, 0.5, 0.62, 0.42].find((t) => clearOfMasts(t, 1.3));
    if (ht !== undefined && halfBeamAt(d, ht) > 1.2) {
      const hw = Math.min(1.5, halfBeamAt(d, ht) * 0.7);
      const hatch = add(new THREE.Mesh(new THREE.BoxGeometry(hw, 0.14, 1.3), woodDark), 0.02);
      hatch.position.set(0, deckAt(d, ht) + 0.07, zAt(d, ht));
      const grate = new THREE.Mesh(new THREE.BoxGeometry(hw - 0.2, 0.03, 1.1), woodLight);
      grate.position.y = 0.075;
      hatch.add(grate);
    }
    // ship's wheel and stern lantern
    const wt = 0.87;
    if (clearOfMasts(wt, 0.8) && halfBeamAt(d, wt) > 0.8) {
      const wy = deckAt(d, wt);
      const post = add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.7, 0.16), woodDark), 0.02);
      post.position.set(0, wy + 0.35, zAt(d, wt));
      const wheel = add(new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 14), woodLight), 0.015);
      wheel.position.set(0, wy + 0.72, zAt(d, wt) + 0.12); // on the after side: the helmsman stands behind it, facing the bow
      for (let n = 0; n < 4; n++) {
        const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.84, 4), woodLight);
        spoke.rotation.z = (n * Math.PI) / 4;
        wheel.add(spoke);
      }
    }
    const lampPost = add(strut(new THREE.Vector3(0, sheerAt(d, 1) - 0.1, zAt(d, 1) - 0.05), new THREE.Vector3(0, sheerAt(d, 1) + 0.9, zAt(d, 1) + 0.15), 0.035, iron, 5), 0, false);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.26), new THREE.MeshBasicMaterial({ color: 0xffd98a }));
    lamp.position.set(0, sheerAt(d, 1) + 1.05, zAt(d, 1) + 0.17);
    addOutline(lamp, 0.03, PALETTE.outline);
    group.add(lamp);
    void lampPost;
  }
  // a barrel and a crate lashed down amidships, clear of the guns' recoil
  if (d.beam >= 3 && clearOfMasts(0.4, 0.9)) {
    const y = deckAt(d, 0.4);
    const barrel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.58, 10), wood), 0.025);
    barrel.position.set(0.28, y + 0.29, zAt(d, 0.4));
    const crate = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.5), woodLight), 0.025);
    crate.position.set(-0.3, y + 0.21, zAt(d, 0.4) + 0.1);
    crate.rotation.y = 0.3;
  }

  // --- Places for cargo: rows down the middle of the deck, clear of masts, guns and fittings ---
  const cargoPlaces: THREE.Vector3[] = [];
  const upper: THREE.Vector3[] = [];
  const rowStep = 0.62 / d.length;
  for (let t = 0.3; t <= 0.8; t += rowStep) {
    if (!clearOfMasts(t, 0.75)) continue;
    const gunsHere = deckGuns.some((c) => Math.abs(c.t - t) * d.length < 0.8);
    const room = halfBeamAt(d, t) * 0.93 - (gunsHere ? 1.75 : 0.45);
    for (const x of [0.3, -0.3, 0.9, -0.9, 1.5, -1.5]) {
      if (Math.abs(x) > room) continue;
      if (Math.abs(t - 0.4) * d.length < 0.7 && Math.abs(x) < 0.7) continue; // the lashed barrel and crate
      if (big && Math.abs(t - 0.87) * d.length < 1) continue; // the wheel
      const at = new THREE.Vector3(x, deckAt(d, t) + 0.01, zAt(d, t));
      cargoPlaces.push(at);
      if (Math.abs(x) < 0.5) upper.push(at.clone().setY(at.y + 0.44));
    }
  }
  // fill from amidships outward, then a second tier down the middle
  const mid = zAt(d, 0.55);
  cargoPlaces.sort((a, b) => Math.abs(a.z - mid) + Math.abs(a.x) * 0.6 - (Math.abs(b.z - mid) + Math.abs(b.x) * 0.6));
  cargoPlaces.splice(26);
  cargoPlaces.push(...upper.slice(0, 8));

  // --- Gun ports for the guns below deck ---------------------------------------------
  const portDark = new THREE.MeshBasicMaterial({ color: 0x1a0f08 });
  for (const c of d.cannons) {
    if (c.level === 0) continue;
    const y = gunHeight(d, c.t, c.level);
    const x = hullHalfWidthAt(d, c.t, y);
    const z = zAt(d, c.t);
    const hole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.46, 0.56), portDark);
    hole.position.set(c.side * (x - 0.02), y, z);
    group.add(hole);
    const frame = add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.7), woodDark), 0, false);
    frame.position.set(c.side * (x - 0.05), y, z);
    // lid swung up and out on its hinge
    const lid = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.56), woodLight), 0.015, false);
    lid.position.set(c.side * (x + 0.2), y + 0.38, z);
    lid.rotation.z = c.side * 1.05;
  }

  // --- Mount points --------------------------------------------------------------
  const atStern = d.swivel === 'stern';
  const swT = atStern ? 0.94 : 0.09;
  const swivelMount = new THREE.Vector3(0, deckAt(d, swT) + 0.02, zAt(d, swT));
  const gunMounts = d.cannons.map((c) => cannonMount(d, c));
  void hull;

  return { group, sails, jib, flag, rudder, swivelMount, swivelFacing: atStern ? Math.PI : 0, gunMounts, sailMaterial, flagMaterial, cargoPlaces, masts };
}

/** Free the GPU memory of a built ship (the shipyard rebuilds its preview on every edit). */
export function disposeShipVisual(group: THREE.Object3D): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh || (o as THREE.LineSegments).isLineSegments) mesh.geometry.dispose();
  });
}
