import * as THREE from 'three';
import { WaveField } from '../ocean/waves';

/**
 * Hydrodynamic description of a hull. Today it is hand-authored for the raft;
 * later the hull generator will compute it from the player's drawing
 * (probe layout from the hull footprint, drag from beam/length ratio, etc.).
 */
export interface HullSpec {
  mass: number;
  /** Box dimensions used for the inertia tensor (x = beam, y = height, z = length). */
  size: THREE.Vector3;
  /** Buoyancy sample points in body space (near the bottom of the hull). */
  probes: THREE.Vector3[];
  /** Depth (m) at which a probe is fully submerged and its force stops growing. */
  probeMaxDepth: number;
  /** Draft (m) the hull should float at in calm water. Sets the buoyancy stiffness. */
  restDraft: number;
  /** Vertical damping per probe (N per m/s). */
  heaveDamping: number;
  /** Linear + quadratic drag along the keel (forward/back). */
  dragForward: { linear: number; quadratic: number };
  /** Linear + quadratic drag sideways; high values make it "grip" like a keel. */
  dragLateral: { linear: number; quadratic: number };
  /** Angular damping around the vertical axis. */
  yawDamping: number;
  /** Angular damping around roll/pitch (on top of probe damping). */
  tiltDamping: number;
}

const GRAVITY = 9.81;

/**
 * Rigid body that floats on the shared `WaveField`.
 *
 * Each probe samples the CPU wave height; the submerged depth produces an
 * upward spring force applied AT the probe, so torque (pitch/roll) falls out
 * naturally and the body rides the swell. Drag is applied in body space so the
 * hull slides easily forward but resists sideways motion.
 */
export class FloatingBody {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();

  /** External inputs, set by the controller each frame (body space). */
  thrust = 0; // N along forward (-Z)
  sideForce = 0; // N along body +X (leeway push from the sail)
  yawTorque = 0; // N·m around body up

  /** Fraction (0..1) of probes currently in the water, for UI/FX. */
  submergedFraction = 0;
  /** Latest world-space probe positions (for debug drawing). */
  readonly probeWorld: THREE.Vector3[];
  readonly probeDepth: number[];

  private readonly invInertia: THREE.Vector3;
  private readonly stiffness: number;
  /** Water height under each probe last step, for water vertical velocity. */
  private readonly prevWater: (number | null)[];
  /** Per probe: the sideways wave offset found last step, so the next height needs one refinement. */
  private readonly waterGuess: { x: number; z: number }[];
  private readonly waterVel: number[];
  private tick = 0;
  /** Far from the camera: each step samples the sea under only half the probes, alternating. */
  coarse = false;

  constructor(
    public spec: HullSpec,
    private readonly waves: WaveField,
  ) {
    const { mass, size } = spec;
    const ix = (mass / 12) * (size.y * size.y + size.z * size.z);
    const iy = (mass / 12) * (size.x * size.x + size.z * size.z);
    const iz = (mass / 12) * (size.x * size.x + size.y * size.y);
    this.invInertia = new THREE.Vector3(1 / ix, 1 / iy, 1 / iz);
    this.stiffness = (mass * GRAVITY) / (spec.probes.length * spec.restDraft);
    this.probeWorld = spec.probes.map(() => new THREE.Vector3());
    this.probeDepth = spec.probes.map(() => 0);
    this.prevWater = spec.probes.map(() => null);
    this.waterGuess = spec.probes.map(() => ({ x: NaN, z: NaN }));
    this.waterVel = spec.probes.map(() => 0);
  }

  /** Forward direction in world space (body -Z). */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quaternion);
  }

  /** Signed speed along the keel in m/s. */
  get forwardSpeed(): number {
    return this.velocity.dot(this.forward(_v0));
  }

  placeOnWater(x: number, z: number, yaw = 0): void {
    const h = this.waves.heightAt(x, z);
    this.position.set(x, h + 0.1, z);
    this.quaternion.setFromAxisAngle(_up, yaw);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.prevWater.fill(null);
    for (const g of this.waterGuess) g.x = NaN;
  }

  /**
   * Advance one fixed physics step. Call AFTER advancing the WaveField by the
   * same dt (see `Simulation`), so the water moves between substeps too.
   */
  step(dt: number): void {
    const s = this.spec;
    const force = _force.set(0, -s.mass * GRAVITY, 0);
    const torque = _torque.set(0, 0, 0);

    // --- Buoyancy + heave damping per probe ---------------------------------
    let wet = 0;
    this.tick++;
    for (let i = 0; i < s.probes.length; i++) {
      const pw = this.probeWorld[i].copy(s.probes[i]).applyQuaternion(this.quaternion).add(this.position);
      const prev = this.prevWater[i];
      let water: number;
      let waterVy: number;
      if (this.coarse && prev !== null && ((i + this.tick) & 1) === 1) {
        // far away: half the probes carry the water on from last step's rise and fall
        waterVy = this.waterVel[i];
        water = prev + waterVy * dt;
      } else {
        water = this.waves.heightNear(pw.x, pw.z, this.waterGuess[i]);
        waterVy = prev === null ? 0 : (water - prev) / dt;
        this.waterVel[i] = waterVy;
      }
      this.prevWater[i] = water;
      const depth = water - pw.y;
      this.probeDepth[i] = depth;
      if (depth <= 0) continue;
      wet++;
      const sub = Math.min(depth, s.probeMaxDepth);
      // point velocity = v + w x r
      const r = _r.subVectors(pw, this.position);
      const pv = _pv.crossVectors(this.angularVelocity, r).add(this.velocity);
      // Damp velocity RELATIVE to the water, otherwise the hull resists
      // rising with a swell and gets buried by every crest.
      const relVy = pv.y - waterVy;
      const fy = this.stiffness * sub - s.heaveDamping * relVy * Math.min(1, depth / s.probeMaxDepth + 0.25);
      const f = _f.set(0, fy, 0);
      force.add(f);
      torque.add(_tq.crossVectors(r, f));
    }
    this.submergedFraction = wet / s.probes.length;

    // --- Hydrodynamic drag in body space -----------------------------------
    const inv = _qInv.copy(this.quaternion).invert();
    const vLocal = _vl.copy(this.velocity).applyQuaternion(inv);
    const wetK = this.submergedFraction;
    const dragX = -(s.dragLateral.linear * vLocal.x + s.dragLateral.quadratic * vLocal.x * Math.abs(vLocal.x));
    const dragZ = -(s.dragForward.linear * vLocal.z + s.dragForward.quadratic * vLocal.z * Math.abs(vLocal.z));
    const dragLocal = _dl.set(dragX * wetK, 0, dragZ * wetK);

    // --- Propulsion (thrust along keel, kept horizontal) --------------------
    dragLocal.z -= this.thrust * wetK;
    dragLocal.x += this.sideForce * wetK;
    const dragWorld = dragLocal.applyQuaternion(this.quaternion);
    force.add(dragWorld);

    // --- Steering + angular damping (body space) ---------------------------
    const wLocal = _wl.copy(this.angularVelocity).applyQuaternion(inv);
    const tLocal = _tl.set(
      -s.tiltDamping * wLocal.x,
      (this.yawTorque - s.yawDamping * wLocal.y) * Math.max(wetK, 0.15),
      -s.tiltDamping * wLocal.z,
    );
    torque.add(tLocal.applyQuaternion(this.quaternion));

    // --- Integrate (semi-implicit Euler) -----------------------------------
    this.velocity.addScaledVector(force, dt / s.mass);
    this.position.addScaledVector(this.velocity, dt);

    // angular: alpha = R * I^-1 * R^T * torque
    const tl = torque.applyQuaternion(inv);
    tl.multiply(this.invInertia);
    const alpha = tl.applyQuaternion(this.quaternion);
    this.angularVelocity.addScaledVector(alpha, dt);

    const w = this.angularVelocity;
    const dq = _dq.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(this.quaternion);
    this.quaternion.set(
      this.quaternion.x + dq.x,
      this.quaternion.y + dq.y,
      this.quaternion.z + dq.z,
      this.quaternion.w + dq.w,
    );
    this.quaternion.normalize();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _v0 = new THREE.Vector3();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _r = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _f = new THREE.Vector3();
const _tq = new THREE.Vector3();
const _vl = new THREE.Vector3();
const _dl = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _tl = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
