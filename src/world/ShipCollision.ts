import * as THREE from 'three';
import type { FloatingBody } from '../physics/FloatingBody';

/**
 * Ships bump into each other instead of sliding through one another into one
 * heap. Each hull is a flat capsule seen from above: a line from bow to stern
 * with a radius of half her beam. Where two overlap they are pushed apart
 * (the lighter one further), and the speed that carried them together is
 * taken away, with a little bounce.
 */
export interface Hull {
  body: FloatingBody;
  /** Sailed by another copy of the game: she pushes others but is not moved here. */
  fixed?: boolean;
}

const COLLIDE = {
  /** Share of the closing speed given back as a bounce. */
  bounce: 0.25,
  /** Overlap fixed per step (1 = all of it at once). */
  push: 0.8,
  /** Capsule radius as a share of the beam's half (a little under, so the rails can just touch). */
  girth: 0.9,
};

interface Capsule {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  cx: number;
  cz: number;
  reach: number;
  invMass: number;
  body: FloatingBody;
}

const pool: Capsule[] = [];
const _f = new THREE.Vector3();

function capsuleOf(h: Hull, c: Capsule): Capsule {
  const b = h.body;
  const half = b.spec.size.z / 2;
  const r = (b.spec.size.x / 2) * COLLIDE.girth;
  b.forward(_f).setY(0);
  if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
  _f.normalize();
  // the rounded ends already reach r past the line, so the line stops short of bow and stern
  const along = Math.max(0, half - r * 0.6);
  c.cx = b.position.x;
  c.cz = b.position.z;
  c.ax = c.cx + _f.x * along;
  c.az = c.cz + _f.z * along;
  c.bx = c.cx - _f.x * along;
  c.bz = c.cz - _f.z * along;
  c.r = r;
  c.reach = along + r;
  c.invMass = h.fixed ? 0 : 1 / Math.max(50, b.spec.mass);
  c.body = b;
  return c;
}

/** Closest points between segments p1q1 and p2q2 (2D). Writes them to out: [x1, z1, x2, z2]. */
function closest(c1: Capsule, c2: Capsule, out: number[]): void {
  const d1x = c1.bx - c1.ax;
  const d1z = c1.bz - c1.az;
  const d2x = c2.bx - c2.ax;
  const d2z = c2.bz - c2.az;
  const rx = c1.ax - c2.ax;
  const rz = c1.az - c2.az;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s = 0;
  let t = 0;
  if (a < 1e-6 && e < 1e-6) {
    s = t = 0;
  } else if (a < 1e-6) {
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1z * rz;
    if (e < 1e-6) {
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-6 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  out[0] = c1.ax + d1x * s;
  out[1] = c1.az + d1z * s;
  out[2] = c2.ax + d2x * t;
  out[3] = c2.az + d2z * t;
}

const pts = [0, 0, 0, 0];

/**
 * Push overlapping hulls apart. Call once a frame after the physics.
 * Returns the hardest closing speed of any bump this frame (m/s), for a thud.
 */
export function collideShips(hulls: Hull[], onBump?: (x: number, z: number, speed: number) => void): number {
  const n = hulls.length;
  for (let i = 0; i < n; i++) capsuleOf(hulls[i], (pool[i] ??= {} as Capsule));
  let hardest = 0;
  for (let i = 0; i < n; i++) {
    const A = pool[i];
    for (let j = i + 1; j < n; j++) {
      const B = pool[j];
      if (A.invMass + B.invMass === 0) continue;
      // broad phase: bounding circles
      const reach = A.reach + B.reach;
      if (Math.abs(A.cx - B.cx) > reach || Math.abs(A.cz - B.cz) > reach) continue;
      closest(A, B, pts);
      let nx = pts[0] - pts[2];
      let nz = pts[1] - pts[3];
      let d = Math.hypot(nx, nz);
      const min = A.r + B.r;
      if (d >= min) continue;
      if (d < 1e-4) {
        // dead on top of each other: split along the line between their middles
        nx = A.cx - B.cx || 1;
        nz = A.cz - B.cz;
        d = Math.hypot(nx, nz);
        nx /= d;
        nz /= d;
        d = 0;
      } else {
        nx /= d;
        nz /= d;
      }
      const overlap = (min - d) * COLLIDE.push;
      const wsum = A.invMass + B.invMass;
      const ka = A.invMass / wsum;
      const kb = B.invMass / wsum;
      const pa = A.body.position;
      const pb = B.body.position;
      pa.x += nx * overlap * ka;
      pa.z += nz * overlap * ka;
      pb.x -= nx * overlap * kb;
      pb.z -= nz * overlap * kb;
      A.cx = pa.x;
      A.cz = pa.z;
      B.cx = pb.x;
      B.cz = pb.z;
      // take away the speed that brings them together, and bounce a little
      const va = A.body.velocity;
      const vb = B.body.velocity;
      const closing = (va.x - vb.x) * nx + (va.z - vb.z) * nz;
      if (closing < 0) {
        const j = -(1 + COLLIDE.bounce) * closing;
        va.x += nx * j * ka;
        va.z += nz * j * ka;
        vb.x -= nx * j * kb;
        vb.z -= nz * j * kb;
        hardest = Math.max(hardest, -closing);
        if (onBump && -closing > 1.5) onBump((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2, -closing);
      }
    }
  }
  return hardest;
}
