import * as THREE from 'three';
import type { WaveField } from '../ocean/waves';
import type { Island } from '../world/Islands';
import { WORLD_RADIUS } from '../world/worldConfig';
import type { LurkerTarget } from './Lurkers';

/**
 * Ocean tornadoes (waterspouts): twisting grey funnels that wander the sea at
 * random. Near one the wind drags a ship round and in; one that sails into the
 * foot of it is lifted off the water, whirled round and flung out, and comes
 * down hard some way off.
 */
const LEVELS = [
  { count: 1, speed: 7, pull: 55, core: 11, carry: 2.4, damage: 8 },
  { count: 2, speed: 8.5, pull: 65, core: 13, carry: 3, damage: 12 },
  { count: 3, speed: 10, pull: 75, core: 15, carry: 3.6, damage: 16 },
];
const HEIGHT = 120;

interface Spout {
  group: THREE.Group;
  funnel: THREE.Mesh;
  skirt: THREE.Mesh;
  debris: THREE.InstancedMesh;
  pos: THREE.Vector3;
  heading: number;
  turn: number;
  turnIn: number;
  spin: number;
  /** 0..1 grown in or dying away. */
  grow: number;
}

interface Carried {
  target: LurkerTarget;
  spout: Spout;
  time: number;
  angle: number;
  radius: number;
}

export interface WaterspoutHooks {
  splash(at: THREE.Vector3, size: number): void;
}

export class Waterspouts {
  readonly group = new THREE.Group();
  presence = 0;
  level = 1;
  private readonly spouts: Spout[] = [];
  private readonly carried: Carried[] = [];
  /** Ships just thrown clear: not caught again straight away. */
  private readonly cooldown = new Map<THREE.Vector3, number>();
  private readonly mat: THREE.ShaderMaterial;
  private readonly skirtMat: THREE.ShaderMaterial;
  private readonly debrisMat = new THREE.MeshBasicMaterial({ color: 0x4a4038 });
  private readonly funnelGeo: THREE.BufferGeometry;
  private readonly skirtGeo = new THREE.CylinderGeometry(1, 1.25, 1, 32, 3, true);
  private readonly debrisGeo = new THREE.BoxGeometry(0.8, 0.3, 0.5);
  private sprayIn = 0;
  private time = 0;

  constructor(
    private readonly waves: WaveField,
    private readonly islands: Island[],
    private readonly hooks: WaterspoutHooks,
  ) {
    this.group.name = 'waterspouts';
    // a funnel: narrow at the sea, flaring wide into the cloud base
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push(new THREE.Vector2(2.2 + Math.pow(t, 2.2) * 26 + Math.sin(t * 9) * 0.6, t * HEIGHT));
    }
    this.funnelGeo = new THREE.LatheGeometry(pts, 36);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uSway: { value: new THREE.Vector2() } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec2 uSway;
        varying vec2 vUv;
        varying float vY;
        void main() {
          vUv = uv;
          vec3 p = position;
          float t = p.y / ${HEIGHT.toFixed(1)};
          // the funnel snakes: its middle swings off the line between foot and cloud
          float bend = sin(t * 3.14159);
          p.x += (sin(uTime * 0.7 + t * 4.0) * 3.0 + uSway.x) * bend;
          p.z += (cos(uTime * 0.55 + t * 3.0) * 3.0 + uSway.y) * bend;
          vY = t;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uFade;
        varying vec2 vUv;
        varying float vY;
        void main() {
          // spiral bands winding up the funnel
          float band = sin((vUv.x * 6.28318 * 3.0) + vY * 18.0 - uTime * 6.0);
          float streak = smoothstep(0.2, 0.9, band);
          vec3 dark = vec3(0.36, 0.39, 0.42);
          vec3 light = vec3(0.78, 0.82, 0.85);
          vec3 col = mix(dark, light, streak * 0.7 + vY * 0.2);
          // solid in the middle, thin at the foot and lost in the cloud at the top
          float a = smoothstep(0.0, 0.08, vY) * (1.0 - smoothstep(0.75, 1.0, vY));
          a *= 0.55 + 0.3 * streak;
          gl_FragColor = vec4(col, a * uFade);
        }
      `,
    });
    this.skirtMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uFade;
        varying vec2 vUv;
        void main() {
          // a ring of thrown spray at the foot
          float n = sin(vUv.x * 6.28318 * 7.0 + uTime * 9.0) * 0.5 + 0.5;
          float a = (1.0 - vUv.y) * (0.45 + 0.4 * n);
          gl_FragColor = vec4(vec3(0.93, 0.96, 0.98), a * uFade);
        }
      `,
    });
  }

  get active(): boolean {
    return this.spouts.length > 0;
  }

  /** Props for compiling the shaders up front. */
  warmup(): THREE.Object3D[] {
    return [new THREE.Mesh(this.funnelGeo, this.mat), new THREE.Mesh(this.skirtGeo, this.skirtMat)];
  }

  start(level: number, near: THREE.Vector3): void {
    this.clear();
    this.level = level;
    const L = LEVELS[level - 1];
    for (let i = 0; i < L.count; i++) {
      // touch down at sea, some way off: never on top of a ship, never on land
      const pos = new THREE.Vector3();
      for (let tries = 0; tries < 30; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = 220 + Math.random() * 260;
        pos.set(near.x + Math.cos(a) * r, 0, near.z + Math.sin(a) * r);
        if (Math.hypot(pos.x, pos.z) < WORLD_RADIUS * 0.8 && !this.overLand(pos, 20)) break;
      }
      const group = new THREE.Group();
      const funnel = new THREE.Mesh(this.funnelGeo, this.mat);
      funnel.renderOrder = 3;
      const skirt = new THREE.Mesh(this.skirtGeo, this.skirtMat);
      skirt.scale.set(9, 7, 9);
      skirt.position.y = 3;
      skirt.renderOrder = 3;
      const debris = new THREE.InstancedMesh(this.debrisGeo, this.debrisMat, 14);
      debris.frustumCulled = false;
      group.add(funnel, skirt, debris);
      group.position.copy(pos);
      this.group.add(group);
      this.spouts.push({ group, funnel, skirt, debris, pos, heading: Math.random() * Math.PI * 2, turn: 0, turnIn: 0, spin: Math.random() * 10, grow: 0 });
    }
  }

  clear(): void {
    for (const c of this.carried) this.release(c, false);
    this.carried.length = 0;
    for (const s of this.spouts) {
      this.group.remove(s.group);
      s.debris.dispose();
    }
    this.spouts.length = 0;
    this.cooldown.clear();
  }

  private overLand(p: THREE.Vector3, margin: number): boolean {
    return this.islands.some((i) => Math.hypot(p.x - i.center.x, p.z - i.center.z) < i.radius + margin);
  }

  update(dt: number, prey: LurkerTarget[]): void {
    if (!this.spouts.length) return;
    this.time += dt;
    const L = LEVELS[this.level - 1];
    this.mat.uniforms.uTime.value = this.time;
    this.skirtMat.uniforms.uTime.value = this.time;
    for (const [k, t] of this.cooldown) {
      if (t - dt <= 0) this.cooldown.delete(k);
      else this.cooldown.set(k, t - dt);
    }
    for (const s of this.spouts) {
      s.grow = THREE.MathUtils.clamp(s.grow + (this.presence > 0.05 ? dt / 6 : -dt / 4), 0, 1);
      const fade = Math.min(s.grow, this.presence * 1.5);
      // wander aimlessly: the heading drifts, and it veers off land and back in from the rim
      s.turnIn -= dt;
      if (s.turnIn <= 0) {
        s.turnIn = 3 + Math.random() * 6;
        s.turn = (Math.random() - 0.5) * 0.7;
      }
      let turn = s.turn;
      const r = Math.hypot(s.pos.x, s.pos.z);
      const ahead = _a.set(s.pos.x + Math.cos(s.heading) * 40, 0, s.pos.z + Math.sin(s.heading) * 40);
      if (r > WORLD_RADIUS * 0.75 || this.overLand(ahead, 10)) turn = 0.9;
      s.heading += turn * dt;
      s.pos.x += Math.cos(s.heading) * L.speed * dt;
      s.pos.z += Math.sin(s.heading) * L.speed * dt;
      s.pos.y = this.waves.heightAt(s.pos.x, s.pos.z);
      s.group.position.copy(s.pos);
      s.spin += dt * 2.4;
      s.funnel.rotation.y = -s.spin;
      s.group.scale.set(0.3 + 0.7 * s.grow, s.grow, 0.3 + 0.7 * s.grow);
      s.group.visible = fade > 0.01;
      this.mat.uniforms.uFade.value = fade;
      this.skirtMat.uniforms.uFade.value = fade;
      // debris whirled round the foot
      for (let i = 0; i < s.debris.count; i++) {
        const a = s.spin * (1.4 + (i % 3) * 0.3) + i * 2.4;
        const h = 2 + ((i * 7.3 + this.time * (3 + (i % 4))) % 26);
        const rad = 5 + (i % 5) * 1.6 + h * 0.18;
        _m.makeRotationFromEuler(_e.set(a * 1.3, a, i));
        _m.setPosition(Math.cos(a) * rad, h, Math.sin(a) * rad);
        s.debris.setMatrixAt(i, _m);
      }
      s.debris.instanceMatrix.needsUpdate = true;
      // spray at the foot, when anyone is near enough to see it
      this.sprayIn -= dt;
      if (this.sprayIn <= 0 && fade > 0.3 && prey.some((p) => p.position.distanceToSquared(s.pos) < 300 * 300)) {
        this.sprayIn = 0.15;
        const a = Math.random() * Math.PI * 2;
        this.hooks.splash(_a.set(s.pos.x + Math.cos(a) * 8, s.pos.y, s.pos.z + Math.sin(a) * 8), 1.2);
      }
      if (fade < 0.4) continue;

      // the wind round it: drag every ship near it round and in
      for (const p of prey) {
        if (this.carried.some((c) => c.target.position === p.position) || this.cooldown.has(p.position)) continue;
        const dx = p.position.x - s.pos.x;
        const dz = p.position.z - s.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > L.pull) continue;
        const k = (1 - d / L.pull) * fade;
        // round (anticlockwise) and in
        p.velocity.x += ((-dz / d) * 7 - (dx / d) * 3.5) * k * dt;
        p.velocity.z += ((dx / d) * 7 - (dz / d) * 3.5) * k * dt;
        // caught in the foot: up she goes
        if (d < L.core && p.body) this.carried.push({ target: p, spout: s, time: 0, angle: Math.atan2(dz, dx), radius: Math.max(4, d) });
      }
    }

    // ships in the air: whirled round and up, then flung clear
    for (let i = this.carried.length - 1; i >= 0; i--) {
      const c = this.carried[i];
      const body = c.target.body!;
      c.time += dt;
      const lift = Math.min(1, c.time / 1.2);
      c.angle += dt * (2.2 + lift * 1.5);
      c.radius = THREE.MathUtils.lerp(c.radius, 7, dt);
      const s = c.spout.pos;
      const height = 4 + lift * (10 + this.level * 4) + Math.sin(c.time * 3) * 0.8;
      _a.set(s.x + Math.cos(c.angle) * c.radius, s.y + height, s.z + Math.sin(c.angle) * c.radius);
      // steer the hull there (gravity is cancelled by setting the velocity each frame)
      body.velocity.subVectors(_a, body.position).multiplyScalar(5);
      body.angularVelocity.set(Math.sin(c.time * 2.1) * 0.6, 3.2, Math.cos(c.time * 1.7) * 0.6);
      if (c.time >= LEVELS[this.level - 1].carry || this.presence < 0.2) {
        this.release(c, true);
        this.carried.splice(i, 1);
      }
    }
  }

  /** Let go of a carried ship: flung outward (or simply dropped when the event is cleared). */
  private release(c: Carried, fling: boolean): void {
    const body = c.target.body!;
    if (fling) {
      const out = _b.set(Math.cos(c.angle), 0, Math.sin(c.angle));
      const tangent = _a.set(-out.z, 0, out.x);
      body.velocity.copy(out.multiplyScalar(11)).addScaledVector(tangent, 9).setY(5);
      const L = LEVELS[this.level - 1];
      c.target.hit(L.damage, body.position, _z);
    }
    body.angularVelocity.multiplyScalar(0.4);
    this.cooldown.set(c.target.position, 8);
  }

  /** Is this ship up in a waterspout right now? */
  carrying(position: THREE.Vector3): boolean {
    return this.carried.some((c) => c.target.position === position);
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
