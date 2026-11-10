import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { plainOutline } from './toon';

/**
 * Static scenery batching. A palm is twenty-odd little meshes and a fort about a
 * hundred, and every mesh is a draw call (twice, with the shadow pass), so an
 * eight-captain map ran to a few thousand calls a frame. `bakeMerged` folds
 * every plain mesh under `root` into one mesh per material, positioned in
 * `root`'s own space. Ink outlines (see `addOutline`) are pushed out here, in
 * each part's own space, so they keep exactly the thickness they had.
 *
 * The source objects are left as they are; the caller decides whether to
 * remove them (`replaceWithMerged`) or keep them aside to bake again later.
 */
export function bakeMerged(root: THREE.Object3D): THREE.Mesh[] {
  const buckets = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; order: number; parts: THREE.BufferGeometry[] }>();
  const rel = new THREE.Matrix4();
  const visit = (o: THREE.Object3D, parent: THREE.Matrix4): void => {
    if (!o.visible) return;
    o.updateMatrix();
    const m = o === root ? new THREE.Matrix4() : new THREE.Matrix4().multiplyMatrices(parent, o.matrix);
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(mesh.material) && !o.userData.keep) {
      const src = mesh.material as THREE.Material;
      const thickness = src.userData.outline as number | undefined;
      const material = thickness ? plainOutline((src as THREE.MeshBasicMaterial).color) : src;
      const geo = prepare(mesh.geometry, material, thickness ?? 0, rel.copy(m));
      if (geo) {
        const key = `${material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${mesh.renderOrder}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { material, cast: mesh.castShadow, receive: mesh.receiveShadow, order: mesh.renderOrder, parts: [] }));
        b.parts.push(geo);
      }
    }
    for (const c of o.children) visit(c, m);
  };
  visit(root, new THREE.Matrix4());
  const out: THREE.Mesh[] = [];
  for (const b of buckets.values()) {
    const merged = b.parts.length === 1 ? b.parts[0] : mergeGeometries(b.parts, false);
    if (merged && b.parts.length > 1) for (const g of b.parts) g.dispose();
    // parts that would not merge (mismatched attributes) are kept one by one rather than lost
    for (const geo of merged ? [merged] : b.parts) {
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.renderOrder = b.order;
      mesh.matrixAutoUpdate = false;
      mesh.userData.merged = true;
      out.push(mesh);
    }
  }
  return out;
}

/**
 * Bake `root`'s children into merged meshes and put those in their place.
 * `dispose`: the parts' geometries belonged to them alone, so free them.
 */
export function replaceWithMerged(root: THREE.Object3D, dispose: boolean): THREE.Mesh[] {
  const merged = bakeMerged(root);
  const old = [...root.children];
  if (dispose) {
    const geos = new Set<THREE.BufferGeometry>();
    for (const c of old) c.traverse((o) => (o as THREE.Mesh).isMesh && geos.add((o as THREE.Mesh).geometry));
    for (const g of geos) g.dispose();
  }
  for (const c of old) root.remove(c);
  for (const m of merged) root.add(m);
  return merged;
}

/** Free merged meshes made by `bakeMerged` (their geometry is their own). */
export function disposeMerged(meshes: THREE.Object3D[]): void {
  for (const m of meshes) if (m.userData.merged) (m as THREE.Mesh).geometry.dispose();
}

/** A part's geometry in root space, with only the attributes its material uses. */
function prepare(source: THREE.BufferGeometry, material: THREE.Material, outline: number, m: THREE.Matrix4): THREE.BufferGeometry | null {
  if (!source.attributes.position) return null;
  let g = source.clone();
  for (const name of Object.keys(g.attributes)) {
    const keep = name === 'position' || name === 'normal' || (name === 'uv' && 'map' in material && !!(material as THREE.MeshBasicMaterial).map) || (name === 'color' && material.vertexColors);
    if (!keep) g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (outline > 0) {
    // the inverted-hull shell, pushed out along the (smooth) normals in the part's own space
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(n, i).normalize().multiplyScalar(outline);
      p.setXYZ(i, p.getX(i) + v.x, p.getY(i) + v.y, p.getZ(i) + v.z);
    }
  }
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  return g;
}

/** A mirrored part turns its triangles inside out: put them right. */
function flipWinding(g: THREE.BufferGeometry): void {
  for (const attr of Object.values(g.attributes) as THREE.BufferAttribute[]) {
    const a = attr.array;
    const s = attr.itemSize;
    for (let t = 0; t + 2 < attr.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = a[i1];
        a[i1] = a[i2];
        a[i2] = tmp;
      }
    }
  }
}
