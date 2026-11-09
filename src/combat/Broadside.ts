import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { WaveField } from '../ocean/waves';
import { GRAVITY, KINDS } from './ProjectileSim';
import { solveElevation } from './SwivelGun';

export const BROADSIDE = {
  muzzleSpeed: 46, // m/s
  reload: 3.2, // s per side
  /** Small side-to-side aim either way; the ship's heading does the rest. */
  traverse: THREE.MathUtils.degToRad(12),
  minElevation: THREE.MathUtils.degToRad(1),
  maxElevation: THREE.MathUtils.degToRad(28),
  elevateRate: 0.9, // rad/s
  traverseRate: 0.7, // rad/s
  rippleDelay: 0.09, // s between guns in a ripple
  kind: 1, // ProjectileSim KINDS index (cannon shell)
};

const RIBBON_POINTS = 28;

interface Gun {
  side: 1 | -1;
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
  barrel: THREE.Group;
  recoil: number;
}

export interface BroadsideShot {
  position: THREE.Vector3;
  direction: THREE.Vector3;
}

/**
 * A ship's broadside battery.
 *
 * Unlike the swivel gun, the battery can barely traverse: you aim it by
 * turning the ship and by elevation (range). The aim point picks the side,
 * its distance sets the elevation, and its bearing gives a few degrees of
 * side-to-side adjustment.
 *
 * The firing preview is an outlined white ribbon draped on the water from the
 * ship to the impact zone.
 *
 * Arcade rule: the gun crews fully correct for the ship's roll and pitch, and
 * shots do not inherit the ship's own motion. The ribbon therefore only moves
 * when you turn the ship or move the aim point, never because of the swell.
 */
export class Broadside {
  readonly guns: Gun[] = [];
  /** Active side: 1 = starboard, -1 = port. */
  side: 1 | -1 = 1;
  elevation = 0.12;
  traverse = 0;
  private targetElevation = 0.12;
  private targetTraverse = 0;
  /** True when the aim point is outside what the battery can reach by itself. */
  outOfArc = false;
  private readonly cooldown = { '1': 0, '-1': 0 };

  readonly ribbon: THREE.Mesh;
  private readonly ribbonPos: Float32Array;
  private readonly ribbonGeo = new THREE.BufferGeometry();
  private readonly trackA: THREE.Vector3[] = [];
  private readonly trackB: THREE.Vector3[] = [];

  private queue: { delay: number; gun: Gun }[] = [];

  /**
   * @param ship group the guns are parented to (forward = -Z)
   * @param mounts gun positions in ship space; x sign picks the side
   */
  constructor(
    private readonly ship: THREE.Object3D,
    mounts: THREE.Vector3[],
    private readonly waves: WaveField,
  ) {
    for (const m of mounts) this.guns.push(this.buildGun(m));

    // Ribbon strip: 2 verts per sample, uv.x across, uv.y along.
    this.ribbonPos = new Float32Array(RIBBON_POINTS * 2 * 3);
    const uv = new Float32Array(RIBBON_POINTS * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i < RIBBON_POINTS; i++) {
      uv[i * 4] = 0;
      uv[i * 4 + 1] = i / (RIBBON_POINTS - 1);
      uv[i * 4 + 2] = 1;
      uv[i * 4 + 3] = i / (RIBBON_POINTS - 1);
      if (i < RIBBON_POINTS - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    this.ribbonGeo.setAttribute('position', new THREE.BufferAttribute(this.ribbonPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.ribbonGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.ribbonGeo.setIndex(idx);
    this.ribbon = new THREE.Mesh(
      this.ribbonGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        uniforms: {
          uTime: { value: 0 },
          uReady: { value: 1 },
          uAspect: { value: 10 }, // ribbon length / width, keeps the outline even
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime, uReady, uAspect;
          varying vec2 vUv;
          void main() {
            float edgeX = min(vUv.x, 1.0 - vUv.x);
            float edgeY = (1.0 - vUv.y) * uAspect;       // distance to the far end, in widths
            float startFade = smoothstep(0.02, 0.1, vUv.y);
            // crisp white outline along both sides and across the far end
            float outline = max(1.0 - smoothstep(0.05, 0.075, edgeX), 1.0 - smoothstep(0.05, 0.075, edgeY));
            // impact zone: the last stretch is filled more strongly
            float zone = smoothstep(1.6, 1.2, edgeY);
            // chevrons marching toward the target
            float chev = step(0.5, fract(vUv.y * uAspect * 0.6 - uTime * 1.2 + abs(vUv.x - 0.5) * 1.2));
            float fill = 0.1 + chev * 0.08 + zone * 0.3;
            float a = max(outline * 0.95, fill) * startFade;
            vec3 ready = vec3(1.0);
            vec3 loading = vec3(1.0, 0.72, 0.5);
            gl_FragColor = vec4(mix(loading, ready, uReady), a * mix(0.55, 1.0, uReady));
          }
        `,
      }),
    );
    this.ribbon.frustumCulled = false;
    this.ribbon.name = 'broadside-ribbon';
    this.ribbon.renderOrder = 5;
    for (let i = 0; i < 400; i++) {
      this.trackA.push(new THREE.Vector3());
      this.trackB.push(new THREE.Vector3());
    }
  }

  setVisible(v: boolean): void {
    for (const g of this.guns) g.root.visible = v;
    this.ribbon.visible = v;
  }

  get visible(): boolean {
    return this.guns[0]?.root.visible ?? false;
  }

  /** 0..1 reload progress of the active side. */
  get reloadProgress(): number {
    return 1 - Math.max(this.cooldown[this.side], 0) / BROADSIDE.reload;
  }

  get ready(): boolean {
    return this.cooldown[this.side] <= 0;
  }

  /** Aim at a world point: picks the side, sets elevation from range, small traverse from bearing. */
  aimAt(target: THREE.Vector3): void {
    const local = this.ship.worldToLocal(_t.copy(target));
    // A little hysteresis so the side doesn't flicker when aiming dead ahead/astern.
    if (Math.abs(local.x) > 1.5) this.side = local.x >= 0 ? 1 : -1;
    const s = this.side;
    // Bearing off the beam, positive toward the bow.
    const bearing = Math.atan2(-local.z, s * local.x);
    this.outOfArc = Math.abs(bearing) > BROADSIDE.traverse + 0.02 || s * local.x < 0;
    this.targetTraverse = THREE.MathUtils.clamp(bearing, -BROADSIDE.traverse, BROADSIDE.traverse);
    const origin = this.ship.getWorldPosition(_p);
    const range = Math.max(4, Math.hypot(target.x - origin.x, target.z - origin.z) - 1.2);
    // guns sit a little above the water; aim for mean sea level
    const elev = solveElevation(range, -0.9, BROADSIDE.muzzleSpeed, KINDS[BROADSIDE.kind].drag) ?? BROADSIDE.maxElevation;
    this.targetElevation = THREE.MathUtils.clamp(elev, BROADSIDE.minElevation, BROADSIDE.maxElevation);
  }

  /** Returns shots to spawn this frame (ripple fire is spread over a few frames). */
  update(dt: number, out: BroadsideShot[]): void {
    this.cooldown['1'] -= dt;
    this.cooldown['-1'] -= dt;
    const step = (cur: number, target: number, rate: number) => cur + THREE.MathUtils.clamp(target - cur, -rate * dt, rate * dt);
    this.elevation = step(this.elevation, this.targetElevation, BROADSIDE.elevateRate);
    this.traverse = step(this.traverse, this.targetTraverse, BROADSIDE.traverseRate);

    // Roll toward the active side: how far the ship's beam axis tips up or down.
    const outward = _x.set(this.side, 0, 0).transformDirection(this.ship.matrixWorld);
    const roll = Math.asin(THREE.MathUtils.clamp(outward.y, -1, 1));
    const corrected = THREE.MathUtils.clamp(this.elevation - roll, -0.35, BROADSIDE.maxElevation + 0.35);

    for (const g of this.guns) {
      const active = g.side === this.side;
      // yaw toward the bow is +traverse for starboard guns and -traverse for port guns
      g.yawPivot.rotation.y = THREE.MathUtils.damp(g.yawPivot.rotation.y, active ? this.traverse * g.side : 0, 8, dt);
      g.pitchPivot.rotation.x = active ? corrected : THREE.MathUtils.damp(g.pitchPivot.rotation.x, 0.05, 14, dt);
      g.recoil = Math.max(0, g.recoil - dt * 1.8);
      g.barrel.position.z = Math.sin(Math.min(g.recoil, 1) * Math.PI) * 0.22;
    }

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      q.delay -= dt;
      if (q.delay > 0) continue;
      const shot = { position: new THREE.Vector3(), direction: new THREE.Vector3() };
      this.muzzle(q.gun, shot.position, shot.direction);
      q.gun.recoil = 1;
      out.push(shot);
      this.queue.splice(i, 1);
    }

    if (this.visible) this.updateRibbon(dt);
  }

  /** Fire the active side as a ripple, bow to stern. Returns false if still reloading. */
  tryFire(): boolean {
    if (!this.visible || !this.ready) return false;
    this.cooldown[this.side] = BROADSIDE.reload;
    const side = this.guns.filter((g) => g.side === this.side).sort((a, b) => a.root.position.z - b.root.position.z);
    side.forEach((gun, i) => this.queue.push({ delay: i * BROADSIDE.rippleDelay, gun }));
    return true;
  }

  private muzzle(g: Gun, pos: THREE.Vector3, dir: THREE.Vector3): void {
    g.barrel.updateWorldMatrix(true, false);
    pos.set(0, 0, -0.95).applyMatrix4(g.barrel.matrixWorld);
    this.fireDirection(dir);
  }

  /**
   * Stabilised firing direction of the active side: the ship's heading plus
   * the small traverse, at the set elevation above the true horizon.
   */
  private fireDirection(out: THREE.Vector3): THREE.Vector3 {
    const m = this.ship.matrixWorld;
    const beam = _x.set(this.side, 0, 0).transformDirection(m).setY(0).normalize();
    const bow = _c.set(0, 0, -1).transformDirection(m).setY(0).normalize();
    out.copy(beam).multiplyScalar(Math.cos(this.traverse)).addScaledVector(bow, Math.sin(this.traverse)).normalize();
    out.multiplyScalar(Math.cos(this.elevation));
    out.y = Math.sin(this.elevation);
    return out;
  }

  /** Simulated ground track of one gun's shot; returns the number of points written. */
  private track(g: Gun, out: THREE.Vector3[]): number {
    const pos = _p;
    const dir = _d;
    this.muzzle(g, pos, dir);
    const vel = _v.copy(dir).multiplyScalar(BROADSIDE.muzzleSpeed);
    const drag = KINDS[BROADSIDE.kind].drag;
    const h = 1 / 40;
    let n = 0;
    out[n++].copy(pos);
    for (let i = 0; i < out.length - 2; i++) {
      const speed = vel.length();
      vel.x -= vel.x * drag * speed * h;
      vel.y -= (vel.y * drag * speed + GRAVITY) * h;
      vel.z -= vel.z * drag * speed * h;
      pos.addScaledVector(vel, h);
      out[n++].copy(pos);
      // end at mean sea level, not the passing wave, so the ribbon holds still
      if (pos.y <= 0) break;
    }
    return n;
  }

  private updateRibbon(dt: number): void {
    const side = this.guns.filter((g) => g.side === this.side).sort((a, b) => a.root.position.z - b.root.position.z);
    if (side.length === 0) return;
    const na = this.track(side[0], this.trackA);
    const nb = this.track(side[side.length - 1], this.trackB);

    // Widen the ribbon a little beyond the outer guns (shot scatter).
    const pad = side.length > 1 ? 0.9 : 1.4;
    let length = 0;
    let width = 0;
    for (let i = 0; i < RIBBON_POINTS; i++) {
      const u = i / (RIBBON_POINTS - 1);
      const a = sampleTrack(this.trackA, na, u, _a);
      const b = sampleTrack(this.trackB, nb, u, _b);
      const across = _x.subVectors(b, a).setY(0);
      if (across.lengthSq() < 1e-4) {
        // single gun: build the width perpendicular to the track
        const a2 = sampleTrack(this.trackA, na, Math.min(1, u + 0.03), _c);
        across.set(-(a2.z - a.z), 0, a2.x - a.x);
      }
      across.normalize();
      // spread grows with distance: tighter at the ship, wider at the impact zone
      const spread = pad * (0.5 + u * 1.6);
      a.addScaledVector(across, -spread);
      b.addScaledVector(across, spread);
      const o = i * 6;
      this.ribbonPos[o] = a.x;
      this.ribbonPos[o + 1] = this.waves.heightAt(a.x, a.z) + 0.14;
      this.ribbonPos[o + 2] = a.z;
      this.ribbonPos[o + 3] = b.x;
      this.ribbonPos[o + 4] = this.waves.heightAt(b.x, b.z) + 0.14;
      this.ribbonPos[o + 5] = b.z;
      if (i > 0) length += Math.hypot(a.x - _prev.x, a.z - _prev.z);
      _prev.copy(a);
      width = Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.ribbonGeo.attributes.position.needsUpdate = true;
    const u = (this.ribbon.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value += dt;
    u.uReady.value = this.ready ? 1 : 0;
    u.uAspect.value = length / Math.max(width, 0.5);
  }

  private buildGun(mount: THREE.Vector3): Gun {
    const side: 1 | -1 = mount.x >= 0 ? 1 : -1;
    const root = new THREE.Group();
    root.position.copy(mount);
    // local -Z of the gun points out over the ship's side
    root.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2;
    const iron = toonMaterial(0x2f2c2a);
    const wood = toonMaterial(PALETTE.woodDark);

    // Stubby wooden carriage with four trucks (wheels)
    const carriage = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.7), wood);
    carriage.position.y = 0.14;
    addOutline(carriage, 0.02, PALETTE.outline);
    root.add(carriage);
    for (const x of [-0.24, 0.24]) {
      for (const z of [-0.22, 0.22]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 10), wood);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x, 0.09, z);
        root.add(wheel);
      }
    }
    const yawPivot = new THREE.Group();
    yawPivot.position.y = 0.3;
    root.add(yawPivot);
    const pitchPivot = new THREE.Group();
    yawPivot.add(pitchPivot);
    const barrel = new THREE.Group();
    pitchPivot.add(barrel);
    const tube = new THREE.CylinderGeometry(0.085, 0.13, 1.3, 12);
    tube.rotateX(Math.PI / 2);
    tube.translate(0, 0, -0.3);
    const tubeMesh = new THREE.Mesh(tube, iron);
    addOutline(tubeMesh, 0.02, PALETTE.outline);
    barrel.add(tubeMesh);
    for (const z of [-0.9, -0.5, 0.05]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(z < -0.8 ? 0.1 : 0.125, 0.025, 6, 14), iron);
      ring.position.z = z;
      barrel.add(ring);
    }
    const knob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 1), iron);
    knob.position.z = 0.42;
    barrel.add(knob);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.name.endsWith('-outline')) o.castShadow = true;
    });
    this.ship.add(root);
    return { side, root, yawPivot, pitchPivot, barrel, recoil: 0 };
  }
}

function sampleTrack(track: THREE.Vector3[], n: number, u: number, out: THREE.Vector3): THREE.Vector3 {
  const f = u * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  return out.lerpVectors(track[i], track[i + 1], f - i);
}

const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x = new THREE.Vector3();
const _prev = new THREE.Vector3();
