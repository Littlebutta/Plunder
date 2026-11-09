import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';

/**
 * A beached shipwreck: keel, exposed ribs, a few surviving hull planks, a
 * snapped mast with a torn sail, and scattered debris. Bow points along -Z.
 * Built from the same parts language as the raft so it reads as "a ship".
 */
export function buildWreck(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'wreck';
  const dark = toonMaterial(0x4f3220);
  const wood = toonMaterial(0x7a5234);
  const pale = toonMaterial(0xa88a66);
  const cloth = toonMaterial(0xd8ccb0, { side: THREE.DoubleSide });

  const length = 15 + rand() * 6;
  const beam = length * 0.3;
  const depth = beam * 0.75;
  const part = (mesh: THREE.Mesh, outline = 0.05) => {
    mesh.castShadow = true;
    addOutline(mesh, outline, PALETTE.outline);
    g.add(mesh);
    return mesh;
  };

  // Half-breadth of the hull along its length (0 at bow, full amidships, narrower stern).
  const halfBeam = (t: number) => (beam / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.85 + 0.08)), 0.7);

  // Keel
  const keel = part(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, length), dark));
  keel.position.y = 0.1;
  // Curved stem post at the bow
  const stem = part(new THREE.Mesh(new THREE.BoxGeometry(0.3, depth * 1.5, 0.35), dark));
  stem.position.set(0, depth * 0.6, -length / 2 - 0.3);
  stem.rotation.x = 0.45;

  // Ribs: U-shaped frames; several are broken off short.
  const ribs = 11;
  for (let i = 0; i < ribs; i++) {
    const t = (i + 0.5) / ribs;
    const z = -length / 2 + t * length;
    const hb = halfBeam(t);
    for (const side of [-1, 1]) {
      const broken = rand() < 0.3 ? 0.35 + rand() * 0.4 : 1;
      const pts: THREE.Vector3[] = [];
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const u = (k / steps) * broken;
        // quarter-ellipse from keel out and up to the gunwale
        pts.push(new THREE.Vector3(side * hb * Math.sin((u * Math.PI) / 2), depth * (1 - Math.cos((u * Math.PI) / 2)) + 0.2, z));
      }
      const rib = part(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.11, 5), wood), 0.035);
      rib.rotation.z = (rand() - 0.5) * 0.06;
    }
  }

  // Surviving planks on one side (the side lying against the sand).
  const plankSide = rand() < 0.5 ? -1 : 1;
  for (let row = 0; row < 4; row++) {
    const u = 0.25 + row * 0.17;
    const from = 0.1 + rand() * 0.25;
    const to = 0.6 + rand() * 0.3;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = from + (to - from) * (k / 8);
      const hb = halfBeam(t) + 0.08;
      pts.push(new THREE.Vector3(plankSide * hb * Math.sin((u * Math.PI) / 2), depth * (1 - Math.cos((u * Math.PI) / 2)) + 0.2, -length / 2 + t * length));
    }
    const plank = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.2, 4), row % 2 ? wood : pale);
    plank.scale.set(1, 1.6, 1);
    plank.castShadow = true;
    g.add(plank);
  }

  // Snapped mast, leaning, with the top half lying on the sand.
  const mastH = length * 0.45;
  const mast = part(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, mastH, 7), dark));
  mast.position.set(0, mastH / 2, -length * 0.08);
  mast.rotation.set(0.12, 0, plankSide * 0.22);
  const fallen = part(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, mastH * 1.1, 7), dark));
  fallen.position.set(-plankSide * (beam * 0.9), 0.6, length * 0.1);
  fallen.rotation.set(Math.PI / 2 - 0.08, 0, 0.5 * plankSide);

  // Torn sail hanging from a yard
  const yard = part(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, beam * 1.3, 6), dark), 0.03);
  yard.position.set(0, mastH * 0.82, -length * 0.08 + 0.2);
  yard.rotation.set(0, 0, Math.PI / 2 + 0.3 * plankSide);
  const sailGeo = new THREE.PlaneGeometry(beam * 0.9, mastH * 0.5, 6, 5);
  const sp = sailGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i);
    const x = sp.getX(i);
    // ragged lower edge + sag
    if (y < -mastH * 0.2) sp.setY(i, y + Math.abs(Math.sin(x * 3.1)) * mastH * 0.16);
    sp.setZ(i, Math.sin(x * 1.3) * 0.3 + (y / mastH) * 0.8);
  }
  sailGeo.computeVertexNormals();
  const sail = new THREE.Mesh(sailGeo, cloth);
  sail.position.set(0.3 * plankSide, mastH * 0.56, -length * 0.08 + 0.35);
  sail.rotation.z = 0.3 * plankSide;
  sail.castShadow = true;
  g.add(sail);

  // Debris: barrels, crates and loose planks around the hull
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2;
    const d = beam * 0.8 + rand() * beam * 1.2;
    const kind = rand();
    let m: THREE.Mesh;
    if (kind < 0.35) m = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.95, 10), wood);
    else if (kind < 0.6) m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.8), pale);
    else m = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.1, 2 + rand() * 2), wood);
    part(m, 0.03);
    m.position.set(Math.cos(a) * d, 0.35, Math.sin(a) * d * 1.4);
    m.rotation.set(rand() < 0.5 ? Math.PI / 2 : rand() * 0.3, rand() * Math.PI, rand() * 0.3);
  }

  // The whole wreck lies heeled over on its planked side.
  const tilt = new THREE.Group();
  tilt.add(g);
  g.rotation.z = -plankSide * (0.3 + rand() * 0.2);
  g.rotation.x = (rand() - 0.5) * 0.12;
  g.position.y = 0.6;
  tilt.name = 'wreck';
  return tilt;
}
