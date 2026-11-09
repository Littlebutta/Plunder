import * as THREE from 'three';
import { Input } from '../input/Input';
import { WaveField } from '../ocean/waves';

/**
 * Third-person orbit camera that follows the ship smoothly.
 *
 * - Drag to orbit, wheel to zoom.
 * - After a moment without input it eases back behind the ship.
 * - The focus point ignores the ship's roll/pitch, so the horizon stays calm
 *   while the ship rocks in front of you.
 * - Never dips below the water surface.
 */
export class FollowCamera {
  yaw = 0; // world-space orbit angle (radians)
  pitch = 0.32;
  distance = 14;

  minDistance = 5;
  maxDistance = 60;
  /** Seconds of no orbit input before auto-recentering kicks in. */
  recenterDelay = 2.5;

  private readonly focus = new THREE.Vector3();
  private readonly smoothPos = new THREE.Vector3();
  private initialised = false;
  private targetDistance = this.distance;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly input: Input,
    private readonly waves: WaveField,
  ) {}

  /** Point the camera keeps centred on (smoothed ship position). */
  get focusPoint(): THREE.Vector3 {
    return this.focus;
  }

  update(dt: number, targetPos: THREE.Vector3, targetHeading: number, targetSpeed: number): void {
    const { dx, dy, wheel } = this.input.consumeMouse();
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.08, 1.35);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance * (1 + wheel * 0.12), this.minDistance, this.maxDistance);
    this.distance = THREE.MathUtils.damp(this.distance, this.targetDistance, 8, dt);

    // Ease back behind the ship when the player isn't orbiting.
    if (this.input.idleOrbit > this.recenterDelay) {
      const behind = targetHeading; // camera yaw that looks along the ship's heading
      const diff = Math.atan2(Math.sin(behind - this.yaw), Math.cos(behind - this.yaw));
      const rate = 0.6 + Math.min(Math.abs(targetSpeed), 6) * 0.25;
      this.yaw += diff * (1 - Math.exp(-rate * dt));
    }

    // Smooth the focus: tight horizontally, soft vertically so swell doesn't jerk the view.
    const goal = _goal.set(targetPos.x, targetPos.y + 1.4, targetPos.z);
    if (!this.initialised) {
      this.focus.copy(goal);
      this.initialised = true;
    }
    this.focus.x = THREE.MathUtils.damp(this.focus.x, goal.x, 10, dt);
    this.focus.z = THREE.MathUtils.damp(this.focus.z, goal.z, 10, dt);
    this.focus.y = THREE.MathUtils.damp(this.focus.y, goal.y, 2.5, dt);

    const cp = Math.cos(this.pitch);
    const offset = _off.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.distance);
    const desired = _des.copy(this.focus).add(offset);

    // Keep above the water.
    // Keep above the water at the camera and along the sight line, so a swell
    // between camera and ship doesn't hide the ship.
    const water = this.waves.heightAt(desired.x, desired.z);
    desired.y = Math.max(desired.y, water + 2);
    for (const t of [0.35, 0.65]) {
      const mx = THREE.MathUtils.lerp(this.focus.x, desired.x, t);
      const mz = THREE.MathUtils.lerp(this.focus.z, desired.z, t);
      const wy = this.waves.heightAt(mx, mz) + 0.8;
      const lineY = THREE.MathUtils.lerp(this.focus.y, desired.y, t);
      if (lineY < wy) desired.y += (wy - lineY) / t;
    }

    if (this.smoothPos.lengthSq() === 0) this.smoothPos.copy(desired);
    this.smoothPos.lerp(desired, 1 - Math.exp(-14 * dt));
    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.focus);
  }
}

const _goal = new THREE.Vector3();
const _off = new THREE.Vector3();
const _des = new THREE.Vector3();
