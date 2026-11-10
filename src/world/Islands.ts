import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { mulberry32 } from '../util/random';
import { Noise2D } from '../util/noise';
import { buildWreck } from './Wreck';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ShoreField } from '../ocean/shore';
import { islandCapacity, Stock } from './Resources';

/**
 * Procedural islands. Each island is a single heightfield mesh on a polar
 * grid with an irregular coastline, coloured per vertex (sand, grass, rock,
 * dark rock) and flat-shaded for a faceted storybook look. Types vary the
 * terrain shape and dressing; not every island gets a mountain.
 */
export type IslandType = 'peak' | 'ridge' | 'mesa' | 'hills' | 'cay' | 'stacks' | 'wreck';

export interface Island {
  type: IslandType;
  group: THREE.Group;
  center: THREE.Vector3;
  /** Rough radius of the coastline (m). */
  radius: number;
  /** Coastline radius in a given world direction (for collisions). */
  coastAt(angle: number): number;
  /** Terrain height at a point in the island's own space (negative = under water). */
  heightAt(x: number, z: number): number;
  /** Distance from the centre to the waterline in a given world direction. */
  shoreAt(angle: number): number;
  /** Highest point of the terrain (m). */
  topY: number;
  name: string;
  /** Resources the island holds when untouched, and what is left right now. */
  capacity: Stock;
  stock: Stock;
  /** World position of the end of the island's pier, if it has a port. */
  port: THREE.Vector3 | null;
  /** Who holds the island: a faction id, or -1 for nobody. */
  owner: number;
  /** Fair maps: this island is the home of the n-th captain. */
  start?: number;
  /** Rocks standing out of the sea (sea stacks, reefs), in the island's own space: hulls that hit them are holed. */
  rocks: { x: number; z: number; r: number; mesh?: THREE.Object3D }[];
}

export interface IslandWorld {
  group: THREE.Group;
  islands: Island[];
  /** Terrain height map of every island, for shorelines, calm shallows and shell impacts. */
  shore: ShoreField;
}

/** Order islands are dealt in; cycled if more are requested. Nearest-first. */
const TYPE_DECK: IslandType[] = ['peak', 'wreck', 'cay', 'mesa', 'hills', 'ridge', 'stacks', 'cay', 'wreck', 'hills', 'peak', 'ridge'];

/**
 * @param fairPlayers 2 or more: deal every captain the same islands. The map is
 *   one wedge repeated around the centre, so each home has the same neighbours
 *   at the same distances, with one contested island in the middle.
 */
export function createIslands(seed = 3, count = 11, worldRadius = 640, fairPlayers = 0): IslandWorld {
  const group = new THREE.Group();
  group.name = 'islands';
  const rand = mulberry32(seed);
  // names and ports draw from their own stream so they never disturb the island layout
  const extraRand = mulberry32(seed * 7919 + 17);
  const islands: Island[] = [];
  const place = (type: IslandType, radius: number, shapeSeed: number, center: THREE.Vector3, portJitter: number): Island => {
    const island = buildIsland(type, radius, mulberry32(shapeSeed));
    island.center.copy(center);
    island.group.position.copy(center);
    island.name = islandName(type, extraRand);
    // Trading-post islands get a pier on the side facing the middle of the map.
    if (type === 'hills' || type === 'mesa') addPort(island, (center.lengthSq() > 1 ? Math.atan2(-center.z, -center.x) : 0) + portJitter);
    group.add(island.group);
    islands.push(island);
    return island;
  };

  if (fairPlayers >= 2) {
    const n = fairPlayers;
    const wedge = (Math.PI * 2) / n;
    const turn = rand() * Math.PI * 2;
    const per = Math.max(2, Math.round((count - 1) / n));
    const clear = (c: THREE.Vector3, radius: number) => !islands.some((o) => o.center.distanceTo(c) < o.radius + radius + 60);
    // the prize in the middle: a port island everyone can reach
    place('mesa', 38, Math.floor(rand() * 1e9), new THREE.Vector3(), rand() * Math.PI * 2);
    // one wedge's worth of islands, each copied round to every captain: home first, a port, then the rest
    const deck: IslandType[] = ['ridge', 'hills', 'cay', 'wreck', 'stacks', 'peak', 'cay', 'mesa', 'wreck'];
    for (let k = 0; k < per; k++) {
      const type = deck[k % deck.length];
      const radius = k === 0 ? 36 : radiusFor(type, rand);
      const shapeSeed = Math.floor(rand() * 1e9);
      const jitter = (rand() - 0.5) * 0.8;
      for (let tries = 0; tries < 120; tries++) {
        const a = k === 0 ? wedge / 2 : rand() * wedge;
        const d = k === 0 ? worldRadius * 0.6 : 130 + rand() * (worldRadius - 190);
        const spots = Array.from({ length: n }, (_, c) => new THREE.Vector3(Math.cos(turn + a + c * wedge) * d, 0, Math.sin(turn + a + c * wedge) * d));
        // clear of everything already down, and of its own copies
        if (!spots.every((c) => clear(c, radius)) || spots[0].distanceTo(spots[1]) < radius * 2 + 60) continue;
        spots.forEach((c, i) => {
          const island = place(type, radius, shapeSeed, c, jitter);
          if (k === 0) island.start = i;
        });
        break;
      }
    }
    const shore = new ShoreField();
    for (const island of islands) shore.stamp(island.center.x, island.center.z, island.radius * 2, island.heightAt);
    return { group, islands, shore };
  }

  for (let n = 0; n < count; n++) {
    const type = TYPE_DECK[n % TYPE_DECK.length];
    const radius = radiusFor(type, rand);
    // Try several spots for this island before giving up on it.
    for (let tries = 0; tries < 80; tries++) {
      const a = rand() * Math.PI * 2;
      // earlier islands in the deck land closer to the start
      const near = 110 + (n / count) * (worldRadius - 260);
      const d = near + rand() * 150;
      const center = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
      if (islands.some((o) => o.center.distanceTo(center) < o.radius + radius + 60)) continue;
      place(type, radius, Math.floor(rand() * 1e9), center, (extraRand() - 0.5) * 0.8);
      break;
    }
  }
  const shore = new ShoreField();
  for (const island of islands) shore.stamp(island.center.x, island.center.z, island.radius * 2, island.heightAt);
  return { group, islands, shore };
}

/** The terrain mesh reaches this many radii out, sloping away under water. */
const SKIRT = 1.45;

function radiusFor(type: IslandType, rand: () => number): number {
  switch (type) {
    case 'cay':
      return 14 + rand() * 10;
    case 'stacks':
      return 16 + rand() * 12;
    case 'wreck':
      return 20 + rand() * 10;
    case 'hills':
      return 28 + rand() * 22;
    default:
      return 32 + rand() * 26;
  }
}

const COLORS = {
  sand: new THREE.Color(PALETTE.sand),
  wetSand: new THREE.Color(0xd9b874),
  grass: new THREE.Color(0x5cb85a),
  grassDark: new THREE.Color(0x3f9a4a),
  rock: new THREE.Color(PALETTE.rock),
  rockDark: new THREE.Color(0x8a5d55),
  cliff: new THREE.Color(0xc29a7a),
  seabed: new THREE.Color(0x2f86b4),
};

function buildIsland(type: IslandType, radius: number, rand: () => number): Island {
  const noise = new Noise2D(rand);
  const g = new THREE.Group();
  g.name = `island-${type}`;

  // Irregular coastline: radius varies with angle (seamless around the circle).
  const coastSeed = rand() * 100;
  const lobes = 0.18 + rand() * 0.2;
  const coastAt = (angle: number) => {
    const n = noise.fbm(Math.cos(angle) * 1.3 + coastSeed, Math.sin(angle) * 1.3 + coastSeed, 3);
    return radius * (1 - lobes + lobes * 2 * n);
  };

  // Feature parameters per type
  const peakCount = type === 'peak' ? 1 + Math.floor(rand() * 2) : 0;
  const peaks = Array.from({ length: peakCount }, (_, i) => ({
    x: (rand() - 0.5) * radius * (i ? 0.7 : 0.35),
    z: (rand() - 0.5) * radius * (i ? 0.7 : 0.35),
    h: (i ? 0.55 : 1) * (26 + rand() * 22) * (radius / 45),
    r: radius * (0.55 + rand() * 0.25),
    crater: rand() < 0.3,
  }));
  const ridgeDir = rand() * Math.PI;
  const ridgeH = (18 + rand() * 16) * (radius / 45);
  const mesaH = 9 + rand() * 9;
  const mesaR = radius * (0.45 + rand() * 0.2);
  const hillsH = 4 + rand() * 6;

  const height = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const coast = coastAt(Math.atan2(z, x));
    const t = r / coast; // 0 centre, 1 coastline
    // Base: beach dome that crosses the waterline at the coast.
    const beach = 2.2 * (1 - t * t) - 1.0 + (noise.fbm(x * 0.05, z * 0.05) - 0.5) * 1.2;
    let h = beach;
    switch (type) {
      case 'peak':
      case 'wreck':
        for (const p of type === 'peak' ? peaks : []) {
          const d = Math.hypot(x - p.x, z - p.z) / p.r;
          if (d >= 1) continue;
          const ridge = noise.ridged(x * 0.04 + 5, z * 0.04 + 5);
          let m = Math.pow(1 - d, 1.7) * p.h * (0.75 + ridge * 0.5);
          if (p.crater && d < 0.18) m -= (0.18 - d) * p.h * 1.6;
          h = Math.max(h, beach + m);
        }
        if (type === 'wreck') h = beach + Math.max(0, (1 - t) * 3 * noise.fbm(x * 0.06, z * 0.06));
        break;
      case 'ridge': {
        const ax = Math.cos(ridgeDir);
        const az = Math.sin(ridgeDir);
        const along = x * ax + z * az;
        const across = -x * az + z * ax;
        const len = 1 - Math.min(1, Math.abs(along) / (coast * 0.85));
        const w = Math.max(0, 1 - Math.abs(across) / (coast * 0.45));
        const ridge = noise.ridged(along * 0.05, across * 0.08 + 3, 5);
        h = Math.max(h, beach + Math.pow(w, 1.4) * Math.pow(len, 0.6) * ridgeH * (0.5 + ridge));
        break;
      }
      case 'mesa': {
        const d = r / mesaR + (noise.fbm(x * 0.04, z * 0.04) - 0.5) * 0.35;
        // terraced cliffs: two steps
        const step1 = 1 - THREE.MathUtils.smoothstep(d, 0.92, 1.0);
        const step2 = 1 - THREE.MathUtils.smoothstep(d, 0.55, 0.62);
        h = Math.max(h, beach + step1 * mesaH * 0.6 + step2 * mesaH * 0.5);
        break;
      }
      case 'hills':
        h = beach + Math.max(0, 1 - t) * hillsH * noise.fbm(x * 0.035 + 7, z * 0.035 + 7, 4) * 2;
        break;
      case 'cay':
        h = beach * 0.6 - 0.2;
        break;
      case 'stacks':
        h = beach * 0.5 - 0.6;
        break;
    }
    // Past the coast the sand keeps sloping away as a shallow shelf, then drops off.
    if (t > 1) h -= (t - 1) * 9 + (t - 1) * (t - 1) * 30;
    return h;
  };

  // --- Polar heightfield mesh ---------------------------------------------
  const rings = 36;
  const segs = 72;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, height(0, 0), 0);
  for (let ri = 1; ri <= rings; ri++) {
    const ring = Math.pow(ri / rings, 1.15) * SKIRT;
    for (let si = 0; si < segs; si++) {
      const a = (si / segs) * Math.PI * 2 + (ri % 2) * (Math.PI / segs);
      // rings follow the coastline, so the shelf is the same width all the way round
      const rr = ring * coastAt(a);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      pos.push(x, height(x, z), z);
    }
  }
  for (let si = 0; si < segs; si++) idx.push(0, 1 + ((si + 1) % segs), 1 + si);
  for (let ri = 1; ri < rings; ri++) {
    const a0 = 1 + (ri - 1) * segs;
    const b0 = 1 + ri * segs;
    for (let si = 0; si < segs; si++) {
      const a = a0 + si;
      const a1 = a0 + ((si + 1) % segs);
      const b = b0 + si;
      const b1 = b0 + ((si + 1) % segs);
      if (ri % 2) {
        idx.push(a, a1, b, a1, b1, b);
      } else {
        idx.push(a, a1, b1, a, b1, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // Vertex colours from height + slope (+ a little noise so bands look painted).
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array((pos.length / 3) * 3);
  const c = new THREE.Color();
  const peakTop = Math.max(...peaks.map((p) => p.h), ridgeH * 0.9);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const slope = 1 - nrm.getY(i);
    const n = noise.fbm(x * 0.12, z * 0.12, 2) - 0.5;
    const sandLine = 1.3 + n * 1.2;
    if (y < -0.6) c.copy(COLORS.wetSand).lerp(COLORS.seabed, Math.min(1, (-0.6 - y) / 3.5));
    else if (y < 0.5 + n * 0.3) c.copy(COLORS.wetSand);
    else if (y < sandLine) c.copy(COLORS.sand);
    else if (type === 'cay' || type === 'stacks') c.copy(COLORS.sand);
    else if (slope > 0.42 + n * 0.2) c.copy(type === 'mesa' ? COLORS.cliff : COLORS.rock);
    else if ((type === 'peak' || type === 'ridge') && y > peakTop * 0.62 + n * 4) c.copy(COLORS.rockDark);
    else c.copy(n > 0.05 ? COLORS.grassDark : COLORS.grass);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const terrain = new THREE.Mesh(facet(geo), terrainMaterial());
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  g.add(terrain);

  // --- Dressing -----------------------------------------------------------
  const rocks: Island['rocks'] = [];
  if (type === 'stacks') addSeaStacks(g, radius, rand, rocks);

  const palmCount = { peak: 5, ridge: 4, mesa: 3, hills: 7, cay: 6, stacks: 1, wreck: 4 }[type] + Math.floor(rand() * 3);
  for (let i = 0, tries = 0; i < palmCount && tries < 200; tries++) {
    const a = rand() * Math.PI * 2;
    const r = coastAt(a) * (0.35 + rand() * 0.5);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = height(x, z);
    if (y < 0.9 || y > 9) continue;
    const palm = buildPalm(rand);
    palm.position.set(x, y - 0.2, z);
    palm.scale.setScalar(0.85 + rand() * 0.4);
    g.add(palm);
    i++;
  }

  addFerns(g, type, radius, coastAt, height, rand);

  const boulders = type === 'cay' ? 2 : 5 + Math.floor(rand() * 5);
  for (let i = 0; i < boulders; i++) {
    const a = rand() * Math.PI * 2;
    const r = coastAt(a) * (0.75 + rand() * 0.35);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const bg = new THREE.IcosahedronGeometry(1, 1);
    jitter(bg, rand, 0.35);
    const b = rockMesh(bg, 0.06);
    const s = 0.8 + rand() * 2.2;
    b.scale.set(s, s * (0.6 + rand() * 0.5), s);
    b.position.set(x, height(x, z) - 0.3, z);
    b.rotation.y = rand() * Math.PI * 2;
    g.add(b);
    // a boulder standing in the water is a rock to steer round
    if (height(x, z) < 0.2) {
      b.userData.rock = true;
      rocks.push({ x, z, r: s * 0.9, mesh: b });
    }
  }

  if (type === 'wreck') {
    const wreck = buildWreck(rand);
    wreck.name = 'wreck';
    const a = rand() * Math.PI * 2;
    const r = coastAt(a) * 0.82;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    wreck.position.set(x, height(x, z) - 0.6, z);
    // beached bow-first: point the bow inland
    wreck.rotation.y = -a - Math.PI / 2 + (rand() - 0.5) * 0.6;
    g.add(wreck);
  }

  // Reefs: a few rocks breaking the surface a little way off the beach. Drawn from their own
  // stream so they never change the rest of the island.
  if (type !== 'cay') addReefs(g, coastAt, mulberry32(Math.floor(rand() * 1e9)), rocks);

  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.receiveShadow = true;
  });

  // Waterline radius, tabulated around the island (scan inward from the shelf).
  const SHORE_STEPS = 72;
  const shoreTable = new Float32Array(SHORE_STEPS);
  let topY = 0;
  for (let i = 0; i < SHORE_STEPS; i++) {
    const a = (i / SHORE_STEPS) * Math.PI * 2;
    const coast = coastAt(a);
    shoreTable[i] = coast * 0.5;
    for (let k = 0; k <= 30; k++) {
      const r = coast * (1.05 - k * 0.03);
      const h = height(Math.cos(a) * r, Math.sin(a) * r);
      topY = Math.max(topY, h);
      if (h > 0 && shoreTable[i] === coast * 0.5) shoreTable[i] = r;
    }
  }
  const shoreAt = (angle: number) => {
    const f = (((angle / (Math.PI * 2)) % 1) + 1) % 1 * SHORE_STEPS;
    const i = Math.floor(f) % SHORE_STEPS;
    return THREE.MathUtils.lerp(shoreTable[i], shoreTable[(i + 1) % SHORE_STEPS], f - Math.floor(f));
  };
  const capacity = islandCapacity(type, radius);

  return { type, group: g, center: new THREE.Vector3(), radius, coastAt, heightAt: height, shoreAt, topY, name: '', capacity, stock: { ...capacity }, port: null, owner: -1, rocks };
}

const NAME_A = ['Skull', 'Parrot', 'Rum', 'Gull', 'Coral', 'Turtle', 'Crab', 'Mango', 'Thunder', 'Driftwood', 'Anchor', 'Lantern', 'Shark', 'Pelican', 'Barnacle', 'Monkey'];
const NAME_B: Record<IslandType, string[]> = {
  peak: ['Peak', 'Mount', 'Horn'],
  ridge: ['Ridge', 'Spine', 'Reach'],
  mesa: ['Table', 'Bluff', 'Landing'],
  hills: ['Haven', 'Downs', 'Isle'],
  cay: ['Cay', 'Key', 'Sands'],
  stacks: ['Rocks', 'Teeth', 'Stacks'],
  wreck: ['Wreck', 'Graveyard', 'Shoal'],
};
function islandName(type: IslandType, rand: () => number): string {
  const a = NAME_A[Math.floor(rand() * NAME_A.length)];
  const b = NAME_B[type][Math.floor(rand() * NAME_B[type].length)];
  return `${a} ${b}`;
}

/**
 * A small port: a pier running out from the beach into deeper water, a hut,
 * some cargo and a flag. `island.port` is set to the pier head (world space);
 * ships must come alongside it to trade or gather here.
 */
function addPort(island: Island, angle: number): void {
  const dark = toonMaterial(PALETTE.woodDark);
  const wood = toonMaterial(PALETTE.wood);
  const light = toonMaterial(PALETTE.woodLight);
  const port = new THREE.Group();
  port.name = 'port';
  const part = (mesh: THREE.Mesh, outline = 0.04) => {
    mesh.castShadow = true;
    if (outline > 0) addOutline(mesh, outline, PALETTE.outline);
    port.add(mesh);
    return mesh;
  };

  // keep the approach to the pier clear of reefs
  island.rocks = island.rocks.filter((r) => {
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(r.z, r.x) - angle), Math.cos(Math.atan2(r.z, r.x) - angle)));
    if (off > 0.6 || !r.mesh) return true;
    r.mesh.removeFromParent();
    return false;
  });

  // The port group sits on the waterline with +X pointing out to sea.
  const shore = island.shoreAt(angle);
  port.position.set(Math.cos(angle) * shore, 0, Math.sin(angle) * shore);
  port.rotation.y = -angle;

  const PIER = 16;
  const DECK_Y = 1.0;
  const deck = part(new THREE.Mesh(new THREE.BoxGeometry(PIER + 4, 0.22, 2.6), wood));
  deck.position.set(PIER / 2 - 2, DECK_Y, 0);
  for (let x = -3; x <= PIER; x += 3.2) {
    for (const z of [-1.15, 1.15]) {
      const post = part(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 5.5, 7), dark), 0.03);
      post.position.set(x, DECK_Y - 2.2, z);
    }
  }
  // pier head: a wider platform with mooring posts and cargo
  const head = part(new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.24, 5), wood));
  head.position.set(PIER, DECK_Y + 0.01, 0);
  for (const z of [-2.3, 2.3]) {
    const bollard = part(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 6.4, 7), dark), 0.03);
    bollard.position.set(PIER + 1.8, DECK_Y - 1.8, z);
  }
  const crate = part(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), light), 0.03);
  crate.position.set(PIER - 0.8, DECK_Y + 0.5, -1.5);
  crate.rotation.y = 0.4;
  const barrel = part(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.95, 10), wood), 0.03);
  barrel.position.set(PIER + 0.6, DECK_Y + 0.6, 1.5);
  // flag pole at the pier head
  const pole = part(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 6, 6), dark), 0.02);
  pole.position.set(PIER - 1.6, DECK_Y + 3, 1.9);
  const flagGeo = new THREE.PlaneGeometry(1.8, 1.0, 6, 2);
  flagGeo.translate(0.9, 0, 0);
  const fp = flagGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < fp.count; i++) fp.setZ(i, Math.sin(fp.getX(i) * 3) * 0.12);
  flagGeo.computeVertexNormals();
  const flag = new THREE.Mesh(flagGeo, toonMaterial(0xf3e6c8, { side: THREE.DoubleSide }));
  flag.position.set(PIER - 1.6, DECK_Y + 5.4, 1.9);
  flag.rotation.y = 0.5;
  port.add(flag);

  // hut on the beach behind the pier
  const hx = -7;
  const local = new THREE.Vector3(hx, 0, 3.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), -angle).add(port.position);
  const ground = Math.max(0.4, island.heightAt(local.x, local.z));
  const walls = part(new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.6, 3.6), light));
  walls.position.set(hx, ground + 1.2, 3.5);
  const roofGeo = new THREE.ConeGeometry(3.6, 2.2, 4);
  roofGeo.rotateY(Math.PI / 4);
  const roof = part(new THREE.Mesh(roofGeo, toonMaterial(0xb5523a)));
  roof.scale.set(1, 1, 0.9);
  roof.position.set(hx, ground + 3.6, 3.5);
  const door = part(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.7, 0.9), dark), 0);
  door.position.set(hx + 2.12, ground + 0.85, 3.5);

  island.group.add(port);
  island.port = new THREE.Vector3(PIER, DECK_Y, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -angle).add(port.position).add(island.center);
}

/** Un-share vertices so each triangle gets its own normal: faceted cel shading. */
function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

let _terrainMat: THREE.Material | null = null;
function terrainMaterial(): THREE.Material {
  return (_terrainMat ??= toonMaterial(0xffffff, { vertexColors: true }));
}
let _rockMat: THREE.Material | null = null;
function rockMaterial(): THREE.Material {
  return (_rockMat ??= toonMaterial(PALETTE.rock));
}

/**
 * Faceted rock with a clean ink outline: the visible mesh has per-face
 * normals, while the outline shell uses a welded, smooth-normal copy so it
 * doesn't split open at the facets.
 */
function rockMesh(geo: THREE.BufferGeometry, outline: number): THREE.Mesh {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const smooth = mergeVertices(geo, 1e-3);
  smooth.computeVertexNormals();
  const mesh = new THREE.Mesh(facet(smooth), rockMaterial());
  addOutline(mesh, outline, PALETTE.outline).geometry = smooth;
  mesh.castShadow = true;
  return mesh;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
/**
 * Clear a patch of an island for building: palms, boulders, ferns and wreckage
 * whose footprint reaches within `radius` of the world point (x, z) are taken away.
 */
export function clearGround(island: Island, x: number, z: number, radius: number): void {
  const lx = x - island.center.x;
  const lz = z - island.center.z;
  for (const o of [...island.group.children]) {
    if (o.name === 'terrain' || o.name === 'port' || o.userData.rock) continue;
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      const inst = o as THREE.InstancedMesh;
      let changed = false;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, _m);
        _p.setFromMatrixPosition(_m);
        if (Math.hypot(_p.x - lx, _p.z - lz) < radius + 1) {
          inst.setMatrixAt(i, _zero);
          changed = true;
        }
      }
      if (changed) inst.instanceMatrix.needsUpdate = true;
      continue;
    }
    // how far the thing spreads: a wreck is a whole ship, a palm's crown a few metres
    const reach = o.name === 'wreck' ? 9 : o.type === 'Group' ? 3 : 2.5 * Math.max(o.scale.x, o.scale.z);
    if (Math.hypot(o.position.x - lx, o.position.z - lz) < radius + reach) o.removeFromParent();
  }
}

/** Clusters of low rocks off the beach, wet and dark, the kind a careless helmsman finds. */
function addReefs(g: THREE.Group, coastAt: (a: number) => number, rand: () => number, rocks: Island['rocks']): void {
  const clusters = 1 + Math.floor(rand() * 3);
  for (let c = 0; c < clusters; c++) {
    const a0 = rand() * Math.PI * 2;
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = a0 + (rand() - 0.5) * 0.35;
      const d = coastAt(a) * (1.18 + rand() * 0.25) + 4;
      const s = 1.6 + rand() * 2.2;
      const geo = new THREE.IcosahedronGeometry(1, 1);
      jitter(geo, rand, 0.3);
      const rock = rockMesh(geo, 0.08);
      rock.scale.set(s, s * (0.55 + rand() * 0.4), s * (0.8 + rand() * 0.4));
      rock.position.set(Math.cos(a) * d, -s * 0.15, Math.sin(a) * d);
      rock.rotation.y = rand() * Math.PI * 2;
      rock.userData.rock = true;
      g.add(rock);
      rocks.push({ x: rock.position.x, z: rock.position.z, r: s * 0.95, mesh: rock });
    }
  }
}

/** Tall eroded rock pillars rising out of the sea, with a few birds-eye flat tops. */
function addSeaStacks(g: THREE.Group, radius: number, rand: () => number, rocks: Island['rocks']): void {
  const n = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const h = 8 + rand() * 20;
    const r = 2 + rand() * 3.5;
    const geo = new THREE.CylinderGeometry(r * (0.55 + rand() * 0.3), r, h, 7, 4);
    jitter(geo, rand, r * 0.25);
    const stack = rockMesh(geo, 0.12);
    const a = rand() * Math.PI * 2;
    const d = rand() * radius * 0.8;
    stack.position.set(Math.cos(a) * d, h / 2 - 2, Math.sin(a) * d);
    rocks.push({ x: stack.position.x, z: stack.position.z, r: r * 1.1 });
    stack.rotation.set((rand() - 0.5) * 0.15, rand() * Math.PI, (rand() - 0.5) * 0.15);
    stack.userData.rock = true;
    g.add(stack);
    // grassy cap on some
    if (rand() < 0.5) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.75, 0.6, 7), toonMaterial(0x5cb85a));
      cap.position.y = h / 2;
      stack.add(cap);
    }
  }
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
function buildFrondGeometry(rand: () => number, length: number, droop: number, segs = 16): THREE.BufferGeometry {
  const positions: number[] = [];
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
  // (denser fronds keep the same leaflet size; sparser ones get fatter leaflets)
  const fat = 16 / segs;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const base = spine[i];
    const next = spine[Math.min(i + 1, segs)];
    const tangent = new THREE.Vector3().subVectors(next, base).normalize();
    const leafLen = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 1.25 + 0.25;
    const leafW = (0.11 + 0.06 * Math.sin(Math.PI * t)) * fat;
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

/**
 * Ferns: low rosettes of arching fronds scattered over the grass (and a few
 * in the sand under the palms) to break up the big flat colour areas. One
 * instanced mesh per island, so hundreds of them cost a single draw call.
 */
function addFerns(
  g: THREE.Group,
  type: IslandType,
  radius: number,
  coastAt: (a: number) => number,
  height: (x: number, z: number) => number,
  rand: () => number,
): void {
  const sandy = type === 'cay' || type === 'stacks';
  const want = sandy ? 6 + Math.floor(rand() * 5) : Math.min(90, Math.round((radius * radius) / 32));
  const spots: { x: number; y: number; z: number }[] = [];
  for (let tries = 0; spots.length < want && tries < want * 12; tries++) {
    const a = rand() * Math.PI * 2;
    const r = coastAt(a) * Math.sqrt(rand()) * 0.92;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = height(x, z);
    if (y < (sandy ? 1.0 : 1.7) || y > 16) continue;
    // keep off cliffs and steep mountain sides
    const slope = Math.hypot(height(x + 0.8, z) - y, height(x, z + 0.8) - y) / 0.8;
    if (slope > 0.75) continue;
    spots.push({ x, y, z });
    // ferns grow in clumps: often add a neighbour or two
    for (let n = 0; n < 2 && rand() < 0.6 && spots.length < want; n++) {
      const nx = x + (rand() - 0.5) * 3.2;
      const nz = z + (rand() - 0.5) * 3.2;
      const ny = height(nx, nz);
      if (ny > 1.2 && Math.abs(ny - y) < 1.2) spots.push({ x: nx, y: ny, z: nz });
    }
  }
  if (spots.length === 0) return;

  const variants = fernVariants();
  const half = Math.ceil(spots.length / variants.length);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  variants.forEach((geo, v) => {
    const mine = spots.slice(v * half, (v + 1) * half);
    if (mine.length === 0) return;
    const mesh = new THREE.InstancedMesh(geo, fernMaterial(), mine.length);
    mine.forEach((s, i) => {
      dummy.position.set(s.x, s.y - 0.08, s.z);
      dummy.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI * 2, (rand() - 0.5) * 0.25);
      const scale = 0.7 + rand() * 0.9;
      dummy.scale.set(scale, scale * (0.8 + rand() * 0.4), scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // a few shades of green, some yellowed
      tint.setHSL(0.3 + (rand() - 0.5) * 0.08, 0.5 + rand() * 0.15, 0.33 + rand() * 0.14);
      mesh.setColorAt(i, tint);
    });
    mesh.name = 'ferns';
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    g.add(mesh);
  });
}

let _fernMat: THREE.Material | null = null;
function fernMaterial(): THREE.Material {
  return (_fernMat ??= toonMaterial(0xffffff, { side: THREE.DoubleSide }));
}

let _fernVariants: THREE.BufferGeometry[] | null = null;
function fernVariants(): THREE.BufferGeometry[] {
  if (_fernVariants) return _fernVariants;
  const rand = mulberry32(41);
  _fernVariants = [0, 1, 2].map(() => {
    const fronds: THREE.BufferGeometry[] = [];
    const count = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      // a palm-style frond, shrunk: arches up from the centre and droops at the tip
      const f = buildFrondGeometry(rand, 4.4, 0.75 + rand() * 0.5, 8);
      const s = 0.26 + rand() * 0.1;
      f.scale(s, s, s);
      f.rotateX(-(0.55 + rand() * 0.45));
      f.rotateY((i / count) * Math.PI * 2 + rand() * 0.5);
      fronds.push(f);
    }
    const merged = mergeGeometries(fronds)!;
    merged.computeVertexNormals();
    return merged;
  });
  return _fernVariants;
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
