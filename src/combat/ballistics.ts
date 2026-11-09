import * as THREE from 'three';

/** Low-arc launch velocity from a to b at muzzle speed v (drag ignored). */
export function ballisticVelocity(a: THREE.Vector3, b: THREE.Vector3, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dz) || 1e-6;
  const g = 9.81;
  const disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
  const elev = disc < 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * d));
  return out.set((dx / d) * Math.cos(elev) * v, Math.sin(elev) * v, (dz / d) * Math.cos(elev) * v);
}
