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

function buildPalm(rand: () => number): THREE.Group {
  const palm = new THREE.Group();
  const trunkMat = toonMaterial(PALETTE.palmTrunk);
  const leafMat = toonMaterial(PALETTE.palmLeaf, { side: THREE.DoubleSide });
  const h = 6 + rand() * 3;
  const lean = (rand() - 0.5) * 0.5;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, h, 6), trunkMat);
  trunk.position.y = h / 2;
  palm.add(trunk);
  palm.rotation.z = lean;
  const crown = new THREE.Group();
  crown.position.y = h;
  palm.add(crown);
  const leaves = 6;
  for (let i = 0; i < leaves; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4, 4, 1), leafMat);
    leaf.scale.set(1, 1, 0.25);
    leaf.geometry.translate(0, 2, 0);
    leaf.rotation.set(0, (i / leaves) * Math.PI * 2, 1.2 + rand() * 0.3, 'YXZ');
    crown.add(leaf);
  }
  return palm;
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
