import * as THREE from 'three';

/**
 * Global wind. Direction wanders slowly so the player can't sit in irons
 * forever, and strength gusts a little. `direction` is where the wind blows
 * TOWARD (unit vector on XZ).
 */
export class Wind {
  /** Radians, angle of the downwind direction (0 = +X, PI/2 = +Z). */
  angle: number;
  /** 0..1 base strength. */
  baseStrength = 0.8;
  /** How fast the direction drifts (rad/s at most). */
  wander = 0.01;

  readonly direction = new THREE.Vector3();
  strength = 0.8;
  private time = 0;

  constructor(angle = -Math.PI / 2 + 0.6) {
    this.angle = angle;
    this.update(0);
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.angle += Math.sin(t * 0.021) * Math.sin(t * 0.0137 + 1.3) * this.wander * dt;
    const gust = Math.sin(t * 0.31) * 0.06 + Math.sin(t * 0.83 + 2.1) * 0.04 + Math.sin(t * 1.9) * 0.02;
    this.strength = THREE.MathUtils.clamp(this.baseStrength + gust, 0, 1.2);
    this.direction.set(Math.cos(this.angle), 0, Math.sin(this.angle));
  }
}
