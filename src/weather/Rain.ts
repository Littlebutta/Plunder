import * as THREE from 'three';

const MAX_DROPS = 5000;
const BOX = 70; // half-width of the rain volume around the camera
const TOP = 40;

/**
 * Rain streaks in a box that follows the camera, slanted by the wind.
 * `amount` 0..1 sets how many drops fall and how visible they are.
 */
export interface RainLook {
  /** Fall speed range (m/s). */
  speed: [number, number];
  /** Base colour (before day and night). */
  colour: [number, number, number];
  /** Streak length, in seconds of travel. */
  streak: number;
  /** How hard the wind carries it sideways. */
  drift: number;
  opacity: [number, number];
}
const RAIN: RainLook = { speed: [26, 36], colour: [0.83, 0.87, 0.93], streak: 0.045, drift: 9, opacity: [0.18, 0.32] };
/** Volcanic ash: slow grey flakes that drift with the wind. */
export const ASH: RainLook = { speed: [2.5, 5.5], colour: [0.42, 0.38, 0.36], streak: 0.12, drift: 5, opacity: [0.35, 0.4] };

export class Rain {
  readonly mesh: THREE.LineSegments;
  amount = 0;
  private readonly pos: Float32Array;
  private readonly drops: Float32Array; // x, y, z, speed (relative to the box origin)
  private readonly material: THREE.LineBasicMaterial;

  constructor(private readonly look: RainLook = RAIN) {
    this.pos = new Float32Array(MAX_DROPS * 6);
    this.drops = new Float32Array(MAX_DROPS * 4);
    for (let i = 0; i < MAX_DROPS; i++) {
      this.drops[i * 4] = (Math.random() * 2 - 1) * BOX;
      this.drops[i * 4 + 1] = Math.random() * TOP;
      this.drops[i * 4 + 2] = (Math.random() * 2 - 1) * BOX;
      this.drops[i * 4 + 3] = look.speed[0] + Math.random() * (look.speed[1] - look.speed[0]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({ color: 0xd4dfee, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rain';
    this.mesh.visible = false;
  }

  update(dt: number, cameraPos: THREE.Vector3, wind: THREE.Vector3, windStrength: number, brightness: number): void {
    const n = Math.floor(MAX_DROPS * Math.min(this.amount, 1));
    this.mesh.visible = n > 0;
    if (!n) return;
    const look = this.look;
    this.material.opacity = look.opacity[0] + look.opacity[1] * Math.min(this.amount, 1);
    this.material.color.setRGB(...look.colour).multiplyScalar(0.35 + 0.65 * brightness);
    const wx = wind.x * windStrength * look.drift;
    const wz = wind.z * windStrength * look.drift;
    const d = this.drops;
    const p = this.pos;
    const ox = cameraPos.x;
    const oz = cameraPos.z;
    const oy = Math.max(cameraPos.y - 12, -2);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const speed = d[j + 3];
      d[j] += wx * dt;
      d[j + 1] -= speed * dt;
      d[j + 2] += wz * dt;
      if (d[j + 1] < 0) {
        d[j + 1] += TOP;
        d[j] = (Math.random() * 2 - 1) * BOX;
        d[j + 2] = (Math.random() * 2 - 1) * BOX;
      }
      // wrap horizontally so the box stays centred as the camera moves
      let x = ((d[j] - ox) % (2 * BOX) + 3 * BOX) % (2 * BOX) - BOX + ox;
      let z = ((d[j + 2] - oz) % (2 * BOX) + 3 * BOX) % (2 * BOX) - BOX + oz;
      const y = d[j + 1] + oy;
      const k = i * 6;
      const len = look.streak; // streak length in seconds of travel
      p[k] = x;
      p[k + 1] = y;
      p[k + 2] = z;
      x -= wx * len;
      z -= wz * len;
      p[k + 3] = x;
      p[k + 4] = y + speed * len;
      p[k + 5] = z;
    }
    const attr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, n * 2);
  }
}

/**
 * Lightning: a jagged camera-facing ribbon from the clouds to the sea that
 * flickers for a fraction of a second, plus the flash value that lights up
 * the sky and sea.
 */
export class Lightning {
  readonly mesh: THREE.Mesh;
  flash = 0;
  private life = 0;
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: 0xf2f5ff, transparent: true, opacity: 1, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'lightning';
  }

  /** Strike at `at` (on the sea), seen from `camera`. */
  strike(at: THREE.Vector3, camera: THREE.Vector3, strength = 1): void {
    const pts: THREE.Vector3[] = [];
    const top = new THREE.Vector3(at.x + (Math.random() - 0.5) * 60, 180 + Math.random() * 60, at.z + (Math.random() - 0.5) * 60);
    const segs = 16;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().lerp(at, t);
      if (i > 0 && i < segs) {
        const j = 14 * Math.sin(t * Math.PI);
        p.x += (Math.random() - 0.5) * j;
        p.z += (Math.random() - 0.5) * j;
        p.y += (Math.random() - 0.5) * 6;
      }
      pts.push(p);
    }
    // one fork off the main bolt
    const forkFrom = 4 + Math.floor(Math.random() * 6);
    const fork: THREE.Vector3[] = [pts[forkFrom].clone()];
    for (let i = 1; i < 6; i++) fork.push(fork[i - 1].clone().add(new THREE.Vector3((Math.random() - 0.5) * 18, -14 - Math.random() * 10, (Math.random() - 0.5) * 18)));

    const dist = camera.distanceTo(at);
    const width = THREE.MathUtils.clamp(dist * 0.012, 1, 7);
    const verts: number[] = [];
    for (const [line, w] of [
      [pts, width],
      [fork, width * 0.55],
    ] as const) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const dir = _d.subVectors(b, a);
        const side = _s.subVectors(a, camera).cross(dir).normalize().multiplyScalar(w * 0.5);
        verts.push(a.x - side.x, a.y - side.y, a.z - side.z, a.x + side.x, a.y + side.y, a.z + side.z, b.x + side.x, b.y + side.y, b.z + side.z);
        verts.push(a.x - side.x, a.y - side.y, a.z - side.z, b.x + side.x, b.y + side.y, b.z + side.z, b.x - side.x, b.y - side.y, b.z - side.z);
      }
    }
    const geo = this.mesh.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeBoundingSphere();
    this.mesh.visible = true;
    this.life = 0.32;
    this.flash = Math.min(1, 0.55 + 0.45 * strength * THREE.MathUtils.clamp(1 - dist / 900, 0.3, 1));
  }

  update(dt: number): void {
    if (this.life > 0) {
      this.life -= dt;
      // double flicker
      const on = this.life > 0.22 || (this.life > 0.08 && this.life < 0.16);
      this.material.opacity = on ? 1 : 0.15;
      if (this.life <= 0) this.mesh.visible = false;
    }
    this.flash = Math.max(0, this.flash - dt * 3.2);
  }
}

const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
