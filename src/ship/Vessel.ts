import * as THREE from 'three';
import type { Stock } from '../world/Resources';
import { FloatingBody, HullSpec } from '../physics/FloatingBody';
import { WaveField } from '../ocean/waves';
import { Wind } from '../world/Wind';

/** Tunables for sail, paddle and rudder. */
export interface DriveSpec {
  /** N at full sail with no help from the wind. */
  baseThrust: number;
  /** Extra N at full sail running dead downwind in a strength-1 wind. */
  windBoost: number;
  /** How much a headwind slows you (0 = not at all, 1 = cancels the base drive). */
  headwindPenalty: number;
  /** N when backing. */
  reverseThrust: number;
  /** N·m at full rudder. */
  steerTorque: number;
  /** Extra steering per m/s of forward speed. */
  steerSpeedGain: number;
  /** Sail fraction per second when raising/lowering. */
  sailRate: number;
  maxTrim: number;
}

/** Wind speed in m/s at strength 1. */
export const WIND_SPEED = 9;

/**
 * Anything the player can sail: the starter raft or a ship from the shipyard.
 * Holds the floating body and the arcade sail/rudder model; subclasses build
 * the visuals and say where guns mount.
 */
export abstract class Vessel {
  readonly group = new THREE.Group();
  readonly body: FloatingBody;

  /** 0 = furled, 1 = full sail. */
  sail = 0;
  /** Backing water: only while the helm holds "back" with the sail already struck. Never a state she stays in. */
  backing = false;
  rudder = 0;
  /** Yard angle in radians (0 = square across the hull); swings to the wind on its own. */
  trim = 0;
  /** 0..1, how much the wind is boosting you right now (for HUD/audio/FX). */
  windBoost = 0;
  /** Share of her drive the rig can deliver: below 1 with masts shot away. */
  driveFactor = 1;
  /** Upgrades: sail thrust, fair-wind push and rudder bite, as multiples. */
  speedMul = 1;
  windMul = 1;
  turnMul = 1;
  /** Called once each time the sail fills: full sail AND a good wind. */
  onSailFilled: (() => void) | null = null;

  /** Where the swivel gun stands, in ship space. */
  abstract readonly swivelMount: THREE.Vector3;
  /** Which way the swivel faces when centred: 0 = over the bow, PI = over the stern. */
  readonly swivelFacing: number = 0;
  /** Broadside cannon positions in ship space; the sign of x picks the side. */
  abstract readonly gunMounts: THREE.Vector3[];
  /** Overall length (m). */
  abstract readonly length: number;
  abstract readonly holdCapacity: number;
  abstract readonly displayName: string;

  private filled = false;
  /** Apparent wind in ship space (m/s). */
  readonly apparentLocal = new THREE.Vector3();

  constructor(
    hull: HullSpec,
    readonly drive: DriveSpec,
    waves: WaveField,
    protected readonly wind: Wind,
  ) {
    this.body = new FloatingBody(hull, waves);
  }

  /**
   * Per-frame: read player input into sail / rudder state.
   * throttle -1..1 (S/W) raises/lowers the sail, steer -1..1 (A/D).
   */
  control(dt: number, throttleInput: number, steerInput: number): void {
    // "back" strikes the sail; held on after that, the crew back her with the sweeps until it is let go
    this.backing = throttleInput < 0 && this.sail <= 0.001;
    this.sail = THREE.MathUtils.clamp(this.sail + throttleInput * this.drive.sailRate * dt, 0, 1);
    this.rudder = THREE.MathUtils.damp(this.rudder, steerInput, 6, dt);
    // Purely visual: the yard swings to catch the wind.
    this.trim = THREE.MathUtils.damp(this.trim, this.bestTrim(), 2.5, dt);

    const wasFilled = this.filled;
    this.filled = this.sail > 0.97 && this.windBoost > 0.6;
    if (this.filled && !wasFilled) this.onSailFilled?.();
    if (this.sail < 0.9 || this.windBoost < 0.4) this.filled = false;
  }

  /** Apparent wind (wind minus own velocity) in raft space, m/s. */
  private updateApparentWind(): THREE.Vector3 {
    const w = _aw.copy(this.wind.direction).multiplyScalar(this.wind.strength * WIND_SPEED).sub(this.body.velocity);
    w.y = 0;
    return this.apparentLocal.copy(w).applyQuaternion(_qi.copy(this.body.quaternion).invert());
  }

  /** Yard angle that squares the sail to the apparent wind (for looks). */
  private bestTrim(): number {
    const a = this.updateApparentWind();
    if (a.lengthSq() < 0.01) return 0;
    // sail normal (-sin t, -cos t) should point along the apparent wind
    let t = Math.atan2(-a.x, -a.z);
    // wind from ahead: can't fill, so just let the yard swing square-ish
    if (Math.abs(t) > Math.PI / 2) t = 0;
    return THREE.MathUtils.clamp(t, -this.drive.maxTrim, this.drive.maxTrim);
  }

  /** Fixed-step: turn sail / rudder into forces and integrate. */
  physicsStep(h: number): void {
    const b = this.body;
    if (!this.backing) {
      // How well the rig takes this wind: a square sail wants it astern, a lateen on the beam.
      const fwd = b.forward(_fw).setY(0).normalize();
      const along = fwd.dot(this.wind.direction);
      this.windBoost = this.rigBoost(along) * Math.min(this.wind.strength, 1.2);
      const headwind = Math.max(0, -along) * this.wind.strength * this.drive.headwindPenalty;
      b.thrust = this.sail * (this.drive.baseThrust * (1 - headwind) + this.drive.windBoost * this.windBoost * this.windMul) * this.driveFactor * this.speedMul;
      b.sideForce = 0;
    } else {
      b.thrust = -this.drive.reverseThrust;
      b.sideForce = 0;
      this.windBoost = 0;
    }
    const speed = b.forwardSpeed;
    const gain = 1 + this.drive.steerSpeedGain * Math.abs(speed);
    // Steering reverses when moving backwards, like a real rudder.
    b.yawTorque = -this.rudder * this.drive.steerTorque * this.turnMul * gain * (speed < -0.2 ? -1 : 1);
    b.step(h);
  }

  /**
   * Share of the wind's boost this rig takes at a point of sail, 0..1.
   * `along` = heading . wind direction (1 running downwind, 0 beam, -1 head to wind).
   * Default: a square sail, best with the wind astern.
   */
  protected rigBoost(along: number): number {
    return THREE.MathUtils.clamp((along + 0.3) / 1.3, 0, 1);
  }

  /** Show what is in the hold as cargo on deck. */
  setCargo(_stock: Stock, _capacity: number): void {}

  /** Paint the sails and pennant in the owner's colour. */
  abstract setColour(colour: THREE.ColorRepresentation): void;

  /** Per-frame: copy physics state to the visuals and animate rigging. */
  abstract syncVisuals(dt: number): void;
}

const _aw = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _qi = new THREE.Quaternion();
