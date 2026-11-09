import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { mulberry32 } from '../util/random';

/**
 * Placeholder scenery: a few hand-placed toon islands so there is something to
 * sail toward and judge speed against. Procedural islands + resources come in
 * a later step; this module is where they will live.
 */
export function createIslands(seed = 3): THREE.Group {
  const group = new THREE.Group();
  group.name = 'islands';
  const rand = mulberry32(seed);
  const spots: [number, number, number][] = [
    [90, -160, 1.2],
    [-220, -80, 0.8],
    [-60, 260, 1.0],
    [320, 140, 1.5],
  ];
  for (const [x, z, s] of spots) {
    const island = buildIsland(rand, s);
    island.position.set(x, 0, z);
    island.rotation.y = rand() * Math.PI * 2;
    group.add(island);
  }
  return group;
}

function buildIsland(rand: () => number, scale: number): THREE.Group {
  const g = new THREE.Group();
  const sand = toonMaterial(PALETTE.sand);
  const rock = toonMaterial(PALETTE.rock);

  // Sandy beach: a flattened, jittered dome that sits through the waterline.
  const beachGeo = new THREE.SphereGeometry(22, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  jitter(beachGeo, rand, 1.5);
  beachGeo.scale(1, 0.18, 1);
  beachGeo.translate(0, -1.2, 0);
  const beach = new THREE.Mesh(beachGeo, sand);
  g.add(beach);

  // Rocky peak(s)
  const peaks = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < peaks; i++) {
    const h = 18 + rand() * 14;
    const geo = new THREE.ConeGeometry(8 + rand() * 4, h, 7, 3);
    jitter(geo, rand, 1.2);
    const peak = new THREE.Mesh(geo, rock);
    peak.position.set((rand() - 0.5) * 10, h / 2 - 1, (rand() - 0.5) * 10);
    addOutline(peak, 0.25, PALETTE.outline);
    g.add(peak);
  }

  // Palms around the beach
  const palms = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < palms; i++) {
    const a = rand() * Math.PI * 2;
    const r = 9 + rand() * 7;
    const palm = buildPalm(rand);
    palm.position.set(Math.cos(a) * r, 1.6, Math.sin(a) * r);
    g.add(palm);
  }

  g.scale.setScalar(scale);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
  });
  return g;
}

/**
 * Palm tree: curved, segmented trunk; a crown of drooping fronds, each with a
 * tapered midrib and two rows of leaflets; a cluster of coconuts.
 * Frond geometry is shared between palms (a few variants), so a whole island
 * of palms costs very little.
 */
function buildPalm(rand: () => number): THREE.Group {
  const palm = new THREE.Group();
  const mats = palmMaterials();
  const h = 6 + rand() * 3;
  const lean = 0.25 + rand() * 0.35;
  const leanDir = rand() * Math.PI * 2;

  // Trunk: stacked, slightly flared rings following a gentle curve.
  // Horizontal offset bend(t) = lean * 0.45h * t^1.6; each ring tilts along its tangent.
  const rings = 9;
  const ringGeo = palmRingGeometry();
  const reach = lean * h * 0.45;
  const lx = Math.cos(leanDir);
  const lz = Math.sin(leanDir);
  for (let i = 0; i < rings; i++) {
    const t = i / rings;
    const bend = Math.pow(t, 1.6) * reach;
    const ring = new THREE.Mesh(ringGeo, i % 2 ? mats.trunk : mats.trunkDark);
    const r = THREE.MathUtils.lerp(0.42, 0.24, t);
    ring.scale.set(r, (h / rings) * 1.05, r);
    ring.position.set(lx * bend, t * h, lz * bend);
    const slope = Math.atan((1.6 * Math.pow(t + 0.5 / rings, 0.6) * reach) / h);
    ring.rotation.set(lz * slope, 0, -lx * slope, 'XYZ');
    palm.add(ring);
  }
  const top = new THREE.Vector3(lx * reach, h, lz * reach);

  const crown = new THREE.Group();
  crown.position.copy(top);
  palm.add(crown);

  const fronds = 9 + Math.floor(rand() * 3);
  const variants = palmFrondVariants();
  for (let i = 0; i < fronds; i++) {
    const v = variants[Math.floor(rand() * variants.length)];
    const frond = new THREE.Mesh(v, i % 3 === 0 ? mats.leafLight : mats.leaf);
    const yaw = (i / fronds) * Math.PI * 2 + rand() * 0.3;
    // Upper fronds stand up, lower ones droop.
    const pitch = THREE.MathUtils.lerp(-0.35, 0.55, (i % 3) / 2) + (rand() - 0.5) * 0.2;
    frond.rotation.set(0, yaw, 0);
    frond.rotateX(-pitch);
    frond.scale.setScalar(0.85 + rand() * 0.35);
    crown.add(frond);
  }

  // Coconuts tucked under the crown.
  const nuts = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < nuts; i++) {
    const nut = new THREE.Mesh(palmNutGeometry(), mats.nut);
    const a = (i / nuts) * Math.PI * 2 + rand();
    nut.position.set(Math.cos(a) * 0.32, -0.35 - rand() * 0.15, Math.sin(a) * 0.32);
    crown.add(nut);
  }
  return palm;
}

let _palmMats: Record<'trunk' | 'trunkDark' | 'leaf' | 'leafLight' | 'nut', THREE.Material> | null = null;
function palmMaterials() {
  return (_palmMats ??= {
    trunk: toonMaterial(PALETTE.palmTrunk),
    trunkDark: toonMaterial(0x6f4626),
    leaf: toonMaterial(PALETTE.palmLeaf, { side: THREE.DoubleSide }),
    leafLight: toonMaterial(0x63c25a, { side: THREE.DoubleSide }),
    nut: toonMaterial(0x5a3a1e),
  });
}

let _ringGeo: THREE.BufferGeometry | null = null;
function palmRingGeometry(): THREE.BufferGeometry {
  if (_ringGeo) return _ringGeo;
  // Unit-height ring, wider at the top so the stack reads as bark segments.
  const g = new THREE.CylinderGeometry(1.08, 0.85, 1, 8, 1);
  g.translate(0, 0.5, 0);
  return (_ringGeo = g);
}

let _nutGeo: THREE.BufferGeometry | null = null;
function palmNutGeometry(): THREE.BufferGeometry {
  return (_nutGeo ??= new THREE.IcosahedronGeometry(0.2, 1));
}

let _frondVariants: THREE.BufferGeometry[] | null = null;
function palmFrondVariants(): THREE.BufferGeometry[] {
  if (_frondVariants) return _frondVariants;
  const rand = mulberry32(99);
  _frondVariants = [0, 1, 2].map(() => buildFrondGeometry(rand, 4.2 + rand() * 1.2, 0.9 + rand() * 0.5));
  return _frondVariants;
}

/**
 * One frond along +Z: a midrib that arcs up then droops under its own weight,
 * with paired leaflets that are long in the middle and short at the ends,
 * each angled down and back like a real coconut palm.
 */
function buildFrondGeometry(rand: () => number, length: number, droop: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const segs = 16;
  const spine: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // rises a little, then droops (parabola) - gives the classic arch
    spine.push(new THREE.Vector3(0, 0.9 * t * length * 0.25 - droop * t * t * length * 0.45, t * length));
  }
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);

  // Midrib: thin tapered strip.
  for (let i = 0; i < segs; i++) {
    const w0 = 0.06 * (1 - i / segs) + 0.01;
    const w1 = 0.06 * (1 - (i + 1) / segs) + 0.01;
    const p0 = spine[i];
    const p1 = spine[i + 1];
    const a = new THREE.Vector3(p0.x - w0, p0.y, p0.z);
    const b = new THREE.Vector3(p0.x + w0, p0.y, p0.z);
    const c = new THREE.Vector3(p1.x - w1, p1.y, p1.z);
    const d = new THREE.Vector3(p1.x + w1, p1.y, p1.z);
    tri(a, c, b);
    tri(b, c, d);
  }

  // Leaflets: two per spine point, both sides.
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const base = spine[i];
    const next = spine[Math.min(i + 1, segs)];
    const tangent = new THREE.Vector3().subVectors(next, base).normalize();
    const leafLen = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 1.25 + 0.25;
    const leafW = 0.11 + 0.06 * Math.sin(Math.PI * t);
    for (const side of [-1, 1]) {
      const jitter = (rand() - 0.5) * 0.15;
      // leaflet points sideways, swept toward the tip, hanging down
      const dir = new THREE.Vector3(side, -0.55 - t * 0.4 + jitter, 0.55).normalize();
      const tip = base.clone().addScaledVector(dir, leafLen);
      const along = tangent.clone().multiplyScalar(leafW);
      const mid = base.clone().addScaledVector(dir, leafLen * 0.45);
      const midA = mid.clone().add(along);
      const midB = mid.clone().sub(along);
      tri(base, midA, tip);
      tri(base, tip, midB);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

function jitter(geo: THREE.BufferGeometry, rand: () => number, amount: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // Jitter by position hash so seams (shared positions) stay welded.
  const cache = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let off = cache.get(key);
    if (!off) {
      off = new THREE.Vector3(rand() - 0.5, (rand() - 0.5) * 0.5, rand() - 0.5).multiplyScalar(amount);
      cache.set(key, off);
    }
    pos.setXYZ(i, pos.getX(i) + off.x, pos.getY(i) + off.y, pos.getZ(i) + off.z);
  }
  geo.computeVertexNormals();
}
