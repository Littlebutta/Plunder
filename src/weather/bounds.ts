import type * as THREE from 'three';

/** Creatures and cursed ships stay inside this radius of the origin (the world rim is ~760 m). */
export const WEATHER_RADIUS = 700;

/** Pull a point on the sea back inside WEATHER_RADIUS (y untouched). */
export function keepInside(p: THREE.Vector3, radius = WEATHER_RADIUS): THREE.Vector3 {
  const r = Math.hypot(p.x, p.z);
  if (r > radius) {
    p.x *= radius / r;
    p.z *= radius / r;
  }
  return p;
}
