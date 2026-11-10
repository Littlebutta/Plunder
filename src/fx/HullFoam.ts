import * as THREE from 'three';
import type { FloatingBody } from '../physics/FloatingBody';
import type { WaveField } from '../ocean/waves';
import { Wake } from './Wake';

/**
 * White water round a moving hull: a bow wave that peels off both sides of
 * the stem and runs down along the hull, and a stern wake as wide as she is.
 * The player's ship always has it; the nearest few other ships under way
 * borrow a set from a small pool.
 */
interface Set {
  bow: Wake;
  stern: Wake;
  body: FloatingBody | null;
  /** Where bow and stern were last, so foam left behind fades in place. */
  bowAt: THREE.Vector3;
  sternAt: THREE.Vector3;
  side: THREE.Vector3;
}

const SEEN = 170;

export class HullFoam {
  readonly group = new THREE.Group();
  private readonly sets: Set[] = [];

  constructor(
    waves: WaveField,
    pool = 6,
  ) {
    this.group.name = 'hull-foam';
    for (let i = 0; i < pool; i++) {
      const s: Set = { bow: new Wake(waves, 24, 1.7, 0.6), stern: new Wake(waves, 48, 5, 1.4), body: null, bowAt: new THREE.Vector3(), sternAt: new THREE.Vector3(), side: new THREE.Vector3(1, 0, 0) };
      this.group.add(s.bow.mesh, s.stern.mesh);
      this.sets.push(s);
    }
  }

  /**
   * @param bodies the hulls afloat (the player's first); the nearest to `eye` that are moving get foam
   */
  update(dt: number, bodies: FloatingBody[], eye: THREE.Vector3): void {
    // the player's own ship keeps the first set; the rest go to the closest movers
    const wanted: FloatingBody[] = [];
    if (bodies[0]) wanted.push(bodies[0]);
    const others = bodies
      .slice(1)
      .filter((b) => b.velocity.lengthSq() > 0.6 && b.position.distanceToSquared(eye) < SEEN * SEEN)
      .sort((a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye));
    for (const b of others) {
      if (wanted.length >= this.sets.length) break;
      wanted.push(b);
    }
    // keep a ship on the set she had last frame, so her foam does not jump between ribbons
    const free = this.sets.filter((s) => !s.body || !wanted.includes(s.body));
    for (const b of wanted) {
      if (this.sets.some((s) => s.body === b)) continue;
      const s = free.shift();
      if (s) {
        s.body = b;
        s.bow.reset();
        s.stern.reset();
      }
    }
    for (const s of this.sets) {
      const b = s.body && wanted.includes(s.body) ? s.body : null;
      if (!b) {
        s.body = null;
        // let what is on the water fade away
        s.bow.update(dt, s.bowAt, s.side, 0);
        s.stern.update(dt, s.sternAt, s.side, 0);
        continue;
      }
      const len = b.spec.size.z;
      const beam = b.spec.size.x;
      _side.set(1, 0, 0).applyQuaternion(b.quaternion).setY(0).normalize();
      _fwd.set(0, 0, -1).applyQuaternion(b.quaternion).setY(0).normalize();
      const speed = b.velocity.dot(_fwd);
      // the bow wave starts just aft of the stem and spreads along both sides
      _p.copy(b.position).addScaledVector(_fwd, len * 0.42);
      s.bow.baseWidth = beam * 0.5;
      s.bow.update(dt, _p, _side, speed * 1.3);
      s.bowAt.copy(_p);
      s.side.copy(_side);
      _p.copy(b.position).addScaledVector(_fwd, -len * 0.5 - 0.1);
      s.stern.baseWidth = Math.max(1.2, beam * 0.45);
      s.stern.update(dt, _p, _side, speed);
      s.sternAt.copy(_p);
    }
  }
}

const _p = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwd = new THREE.Vector3();
