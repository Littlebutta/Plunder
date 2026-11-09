import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { WaveField } from '../ocean/waves';
import { GRAVITY, KINDS } from './ProjectileSim';

const PREVIEW_DOTS = 48;

export const SWIVEL = {
  muzzleSpeed: 38, // m/s: slow enough for a readable, lobbed arc
  reload: 1.1, // s
  /** Furthest the gun will aim (m). Upgrades will extend this later. */
  maxRange: 90,
  traverseRate: 3.2, // rad/s
  elevateRate: 2.2, // rad/s
  maxYaw: THREE.MathUtils.degToRad(160), // either side of the bow
  minPitch: THREE.MathUtils.degToRad(-12),
  maxPitch: THREE.MathUtils.degToRad(42),
  kind: 0, // ProjectileSim KINDS index
};

/**
 * A small bronze swivel gun on a post at the bow: the raft's bare-minimum
 * defence. It traverses toward an aim point on the water, works out the
 * ballistic elevation itself (low arc, air drag included, so the shot lands
 * on the aim point), and shows a dotted trajectory with an impact ring.
 *
 * Arcade rule: shots do not inherit the raft's own motion. A raft bobbing on
 * the swell would otherwise throw every shot (and the preview) around.
 */
export class SwivelGun {
  readonly mount = new THREE.Group();
  private readonly yawPivot = new THREE.Group();
  private readonly pitchPivot = new THREE.Group();
  private readonly barrel = new THREE.Group();
  private readonly muzzleLocal = new THREE.Vector3(0, 0, -0.78);

  yaw = 0;
  pitch = 0.05;
  private targetYaw = 0;
  private targetPitch = 0.05;
  cooldown = 0;
  private recoil = 0;
  /** True when the aim point is beyond max range (the ring turns red and stops at the limit). */
  outOfRange = false;

  // aim preview
  readonly preview = new THREE.Group();
  private readonly dots: THREE.InstancedMesh;
  private readonly ring: THREE.Mesh;
  private readonly dummy = new THREE.Object3D();

  constructor(private readonly waves: WaveField) {
    this.mount.name = 'swivel-gun';
    const iron = toonMaterial(0x34302c);
    const bronze = toonMaterial(0xb7853b);
    const wood = toonMaterial(PALETTE.woodDark);

    // Post bolted to the deck
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.55, 8), wood);
    post.position.y = 0.27;
    addOutline(post, 0.02, PALETTE.outline);
    this.mount.add(post);

    this.yawPivot.position.y = 0.6;
    this.mount.add(this.yawPivot);
    // Iron yoke (fork)
    const yokeBase = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.1), iron);
    this.yawPivot.add(yokeBase);
    for (const x of [-0.15, 0.15]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.08), iron);
      arm.position.set(x, 0.1, 0);
      this.yawPivot.add(arm);
    }

    this.pitchPivot.position.y = 0.17;
    this.yawPivot.add(this.pitchPivot);
    this.pitchPivot.add(this.barrel);

    // Barrel along -Z: tapered bronze tube with reinforcing rings and a tiller handle.
    const tube = new THREE.CylinderGeometry(0.06, 0.085, 1.05, 12);
    tube.rotateX(Math.PI / 2);
    tube.translate(0, 0, -0.25);
    const tubeMesh = new THREE.Mesh(tube, bronze);
    addOutline(tubeMesh, 0.018, PALETTE.outline);
    this.barrel.add(tubeMesh);
    for (const z of [-0.74, -0.42, 0.12]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(z < -0.6 ? 0.075 : 0.09, 0.02, 6, 14), bronze);
      ring.position.z = z;
      this.barrel.add(ring);
    }
    const trunnion = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 6), iron);
    trunnion.rotation.z = Math.PI / 2;
    this.barrel.add(trunnion);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.5, 6), wood);
    handle.rotation.x = Math.PI / 2 - 0.25;
    handle.position.set(0, -0.03, 0.5);
    this.barrel.add(handle);
    const bore = new THREE.Mesh(new THREE.CircleGeometry(0.04, 10), new THREE.MeshBasicMaterial({ color: 0x0d0b0a }));
    bore.position.z = -0.776;
    bore.rotation.y = Math.PI;
    this.barrel.add(bore);

    this.mount.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.name.endsWith('-outline')) o.castShadow = true;
    });

    // Aim preview: white dots along the arc + a foam ring at the impact.
    this.dots = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      PREVIEW_DOTS,
    );
    this.dots.frustumCulled = false;
    const ringGeo = new THREE.TorusGeometry(1, 0.08, 4, 32);
    ringGeo.rotateX(Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.frustumCulled = false;
    this.preview.add(this.dots, this.ring);
    this.preview.name = 'aim-preview';
  }

  get ready(): boolean {
    return this.cooldown <= 0;
  }

  /** 0..1 reload progress for the HUD. */
  get reloadProgress(): number {
    return 1 - Math.max(this.cooldown, 0) / SWIVEL.reload;
  }

  /**
   * Aim at a world-space point. Solves the ballistic elevation in world space,
   * then converts that firing direction into the mount's local frame (so the
   * raft's pitch and roll are compensated automatically).
   */
  aimAt(target: THREE.Vector3): void {
    const muzzle = this.pivotWorld(_m);
    let dx = target.x - muzzle.x;
    let dz = target.z - muzzle.z;
    let dy = target.y - muzzle.y;
    let d = Math.hypot(dx, dz);
    // Beyond max range the gun aims at the edge of its range, in the same direction.
    const tooFar = d > SWIVEL.maxRange;
    if (tooFar) {
      dx *= SWIVEL.maxRange / d;
      dz *= SWIVEL.maxRange / d;
      d = SWIVEL.maxRange;
      dy = this.waves.heightAt(muzzle.x + dx, muzzle.z + dz) - muzzle.y;
    }
    // the ball leaves the muzzle, a barrel length ahead of the pivot
    const reach = Math.max(0.5, d + this.muzzleLocal.z);
    let elev = d < 1e-3 ? null : solveElevation(reach, dy, SWIVEL.muzzleSpeed, KINDS[SWIVEL.kind].drag);
    this.outOfRange = tooFar || (elev === null && d >= 1e-3);
    elev ??= Math.PI / 4;
    const dirWorld = _d.set((dx / (d || 1)) * Math.cos(elev), Math.sin(elev), (dz / (d || 1)) * Math.cos(elev));
    const inv = _q.copy(this.mount.getWorldQuaternion(_q2)).invert();
    const local = dirWorld.applyQuaternion(inv);
    this.targetYaw = THREE.MathUtils.clamp(Math.atan2(-local.x, -local.z), -SWIVEL.maxYaw, SWIVEL.maxYaw);
    this.targetPitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)), SWIVEL.minPitch, SWIVEL.maxPitch);
  }

  update(dt: number): void {
    this.cooldown -= dt;
    const step = (cur: number, target: number, rate: number) => cur + THREE.MathUtils.clamp(target - cur, -rate * dt, rate * dt);
    this.yaw = step(this.yaw, this.targetYaw, SWIVEL.traverseRate);
    this.pitch = step(this.pitch, this.targetPitch, SWIVEL.elevateRate);
    this.yawPivot.rotation.y = this.yaw;
    this.pitchPivot.rotation.x = this.pitch;
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.barrel.position.z = Math.sin(Math.min(this.recoil, 1) * Math.PI) * 0.12;

    this.updatePreview();
  }

  /** Muzzle position and barrel direction in world space. */
  muzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.barrel.updateWorldMatrix(true, false);
    outPos.copy(this.muzzleLocal).applyMatrix4(this.barrel.matrixWorld);
    outDir.set(0, 0, -1).transformDirection(this.barrel.matrixWorld);
  }

  /** Returns true if it fired. */
  tryFire(): boolean {
    if (!this.ready) return false;
    this.cooldown = SWIVEL.reload;
    this.recoil = 1;
    return true;
  }

  private pivotWorld(out: THREE.Vector3): THREE.Vector3 {
    this.pitchPivot.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.pitchPivot.matrixWorld);
  }

  /** Simulate the shot on the CPU (same integrator as the worker) for the dotted arc. */
  private updatePreview(): void {
    const pos = _pp;
    const dir = _pd;
    this.muzzle(pos, dir);
    const vel = _pv.copy(dir).multiplyScalar(SWIVEL.muzzleSpeed);
    const drag = KINDS[SWIVEL.kind].drag;
    const h = 1 / 60;
    let n = 0;
    let hit = false;
    for (let i = 0; i < 600 && n < PREVIEW_DOTS; i++) {
      const speed = vel.length();
      vel.x -= vel.x * drag * speed * h;
      vel.y -= (vel.y * drag * speed + GRAVITY) * h;
      vel.z -= vel.z * drag * speed * h;
      pos.addScaledVector(vel, h);
      // Only sample the sea once the shot is low enough to touch it.
      if (pos.y < 4 && (i & 1) === 0) {
        const water = this.waves.heightAt(pos.x, pos.z);
        if (pos.y <= water) {
          pos.y = water;
          hit = true;
          break;
        }
      }
      if (i % 6 === 0) {
        this.dummy.position.copy(pos);
        this.dummy.scale.setScalar(0.07 + n * 0.002);
        this.dummy.updateMatrix();
        this.dots.setMatrixAt(n++, this.dummy.matrix);
      }
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    this.ring.visible = hit;
    if (hit) {
      this.ring.position.set(pos.x, pos.y + 0.08, pos.z);
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08;
      this.ring.scale.setScalar(1.1 * pulse);
    }
    const mat = this.ring.material as THREE.MeshBasicMaterial;
    mat.color.set(this.outOfRange ? 0xff6a5a : this.ready ? 0xffffff : 0xffb27a);
  }
}

/**
 * Low-arc launch elevation that lands a shot `d` metres away and `dy` metres
 * up, with quadratic air drag. Starts from the drag-free answer and corrects
 * it by flying the shot a few times. Null if the target is out of range.
 */
export function solveElevation(d: number, dy: number, v: number, drag: number): number | null {
  const v2 = v * v;
  let aimDy = dy;
  let elev = 0;
  for (let it = 0; it < 4; it++) {
    const disc = v2 * v2 - GRAVITY * (GRAVITY * d * d + 2 * aimDy * v2);
    if (disc < 0) return null;
    elev = Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * d));
    if (it === 3) break;
    // fly it (same integrator as the projectile sim) and see how high it is at range d
    const h = 1 / 60;
    let x = 0;
    let y = 0;
    let px = 0;
    let py = 0;
    let vx = v * Math.cos(elev);
    let vy = v * Math.sin(elev);
    for (let i = 0; i < 900 && x < d; i++) {
      const speed = Math.hypot(vx, vy);
      vx -= vx * drag * speed * h;
      vy -= (vy * drag * speed + GRAVITY) * h;
      px = x;
      py = y;
      x += vx * h;
      y += vy * h;
    }
    if (x < d) return null;
    const yAtD = py + ((y - py) * (d - px)) / (x - px || 1);
    aimDy += dy - yAtD;
  }
  return elev;
}

const _m = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pp = new THREE.Vector3();
const _pd = new THREE.Vector3();
const _pv = new THREE.Vector3();
