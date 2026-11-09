import * as THREE from 'three';

/** Draw order: ship and world parts (0), then water masks, then the sea. */
export const WATER_MASK_ORDER = 1;
export const OCEAN_ORDER = 2;

const maskMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });

/**
 * An invisible lid that keeps the sea out of a hull.
 *
 * The sea is one big surface that knows nothing about boats, so a wave taller
 * than the deck would otherwise show inside the hull. The lid draws nothing
 * but fills the depth buffer after the boat and before the sea, so any water
 * that would appear through the opening is rejected. It faces up only: seen
 * from below it does nothing.
 *
 * @param geometry the opening, wound so its front faces look up
 */
export function createWaterMask(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, maskMaterial);
  mesh.name = 'water-mask';
  mesh.renderOrder = WATER_MASK_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
