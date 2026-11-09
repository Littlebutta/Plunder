import * as THREE from 'three';

let cachedGradient: THREE.DataTexture | null = null;

/** 3-step ramp used by every MeshToonMaterial for consistent cel bands. */
export function toonGradient(): THREE.DataTexture {
  if (cachedGradient) return cachedGradient;
  const steps = new Uint8Array([90, 175, 255]);
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cachedGradient = tex;
  return tex;
}

export function toonMaterial(color: THREE.ColorRepresentation, opts: Partial<THREE.MeshToonMaterialParameters> = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...opts });
}

const outlineMaterials = new Map<string, THREE.MeshBasicMaterial>();

/**
 * Inverted-hull outline: a back-face-only copy of the mesh pushed out along
 * its normals. Cheap, works on any closed mesh, reads as an ink line.
 */
export function addOutline(mesh: THREE.Mesh, thickness = 0.04, color: THREE.ColorRepresentation = 0x2a1708): THREE.Mesh {
  const key = `${new THREE.Color(color).getHexString()}:${thickness}`;
  let mat = outlineMaterials.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uThickness = { value: thickness };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uThickness;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uThickness;');
    };
    mat.customProgramCacheKey = () => key;
    outlineMaterials.set(key, mat);
  }
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = `${mesh.name}-outline`;
  outline.castShadow = false;
  mesh.add(outline);
  return outline;
}
