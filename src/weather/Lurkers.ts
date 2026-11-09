import * as THREE from 'three';
import { toonMaterial, addOutline } from '../render/toon';
import type { WaveField } from '../ocean/waves';
import type { Collider } from '../combat/ProjectileSystem';
import { MAX_LURKERS } from '../ocean/oceanMaterial';
import { keepInside } from './bounds';

/** Collider ids for the creatures: LURKER_ID_BASE + index. */
export const LURKER_ID_BASE = 700;

type LurkState = 'stalk' | 'windup' | 'strike' | 'retreat' | 'deep' | 'gone';

export interface LurkerTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Ship length in metres (a bigger ship is an easier target). */
  length: number;
}

export interface LurkerHooks {
  splash(at: THREE.Vector3, size: number): void;
  hitShip(damage: number, at: THREE.Vector3, shove: THREE.Vector3): void;
  /** A creature gave up the hunt for good (shot enough). */
  drivenOff(remaining: number): void;
}

/** Tunables per intensity level (index 0 = level 1). */
const LEVELS = {
  count: [1, 2, 3],
  speed: [3.2, 4.0, 4.8],
  scale: [1, 1.12, 1.25],
  hp: [3, 4, 5],
  damage: [12, 18, 25],
  windup: [1.7, 1.35, 1.05],
};

const SEGMENTS = 18; // joints along the tentacle
const SIDES = 10;
const STRIKE_TIME = 2.9;

class Tentacle {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly joints = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3());
  private readonly pos: Float32Array;

  constructor() {
    const ringVerts = (SEGMENTS + 1) * SIDES;
    this.pos = new Float32Array((ringVerts + 1) * 3);
    const colors = new Float32Array((ringVerts + 1) * 3);
    const body = new THREE.Color(0x4a2f6e);
    const belly = new THREE.Color(0xf0a48c);
    const spot = new THREE.Color(0x63e6d2);
    const c = new THREE.Color();
    for (let i = 0; i <= SEGMENTS; i++) {
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2;
        // underside (the side that curls toward the ship) is pale, with sucker bands
        const under = Math.max(0, Math.sin(a));
        c.copy(body).lerp(belly, THREE.MathUtils.smoothstep(under, 0.35, 0.7));
        if (under < 0.2 && (i * 7 + s * 3) % 11 === 0) c.copy(spot);
        if (under > 0.75 && i % 2 === 0) c.multiplyScalar(0.82);
        colors.set([c.r, c.g, c.b], (i * SIDES + s) * 3);
      }
    }
    colors.set([body.r, body.g, body.b], ringVerts * 3);
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      for (let s = 0; s < SIDES; s++) {
        const a = i * SIDES + s;
        const b = i * SIDES + ((s + 1) % SIDES);
        const c2 = a + SIDES;
        const d = b + SIDES;
        index.push(a, c2, b, b, c2, d);
      }
    }
    for (let s = 0; s < SIDES; s++) index.push(SEGMENTS * SIDES + s, ringVerts, SEGMENTS * SIDES + ((s + 1) % SIDES));
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geo.setIndex(index);
    this.mesh = new THREE.Mesh(this.geo, toonMaterial(0xffffff, { vertexColors: true }));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    addOutline(this.mesh, 0.06, 0x1a0e24);
  }

  /** Midpoint of the tentacle (for the collider). */
  get middle(): THREE.Vector3 {
    return this.joints[Math.floor(SEGMENTS * 0.55)];
  }

  get tip(): THREE.Vector3 {
    return this.joints[SEGMENTS];
  }

  /**
   * Lay the tentacle out in the vertical plane through `base` along `dir`.
   * @param emerge 0..1 how far it has slid up out of the water
   * @param pitch lean of the root from vertical, toward `dir` (radians)
   * @param curl extra bend per joint (radians)
   */
  pose(base: THREE.Vector3, dir: THREE.Vector3, length: number, scale: number, emerge: number, pitch: number, curl: number, time: number): void {
    const seg = length / SEGMENTS;
    const j = this.joints;
    j[0].copy(base).addScaledVector(_up, -(1 - emerge) * length);
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const th = pitch + curl * i + Math.sin(time * 3.1 - i * 0.45) * 0.06 * (0.3 + t);
      j[i + 1].copy(j[i]).addScaledVector(dir, Math.sin(th) * seg).addScaledVector(_up, Math.cos(th) * seg);
    }
    // ring frame: n1 is horizontal across the plane, n2 points to the curl side
    const n1 = _n1.crossVectors(_up, dir).normalize();
    const p = this.pos;
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const r = scale * (0.95 * Math.pow(1 - t, 0.85) + 0.07);
      const tan = _t.subVectors(j[Math.min(i + 1, SEGMENTS)], j[Math.max(i - 1, 0)]).normalize();
      const n2 = _n2.crossVectors(n1, tan).normalize();
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2;
        const k = (i * SIDES + s) * 3;
        const ca = Math.cos(a) * r;
        const sa = Math.sin(a) * r;
        p[k] = j[i].x + n1.x * ca + n2.x * sa;
        p[k + 1] = j[i].y + n1.y * ca + n2.y * sa;
        p[k + 2] = j[i].z + n1.z * ca + n2.z * sa;
      }
    }
    const tipK = (SEGMENTS + 1) * SIDES * 3;
    const tipDir = _t.subVectors(j[SEGMENTS], j[SEGMENTS - 1]).normalize();
    p[tipK] = j[SEGMENTS].x + tipDir.x * scale * 0.25;
    p[tipK + 1] = j[SEGMENTS].y + tipDir.y * scale * 0.25;
    p[tipK + 2] = j[SEGMENTS].z + tipDir.z * scale * 0.25;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

interface Lurker {
  id: number;
  state: LurkState;
  timer: number;
  pos: THREE.Vector3; // on the sea surface
  heading: number; // radians, 0 = +X
  /** 0..1 how close to the surface (how visible). */
  strength: number;
  hp: number;
  blink: number;
  nextBlink: number;
  tentacle: Tentacle;
  strikeBase: THREE.Vector3;
  strikeTarget: THREE.Vector3;
  strikeDir: THREE.Vector3;
  strikeLength: number;
  struck: boolean;
  collider: Collider;
}

/**
 * Original sea monsters for the "eyes in the deep" weather event. Each one is
 * drawn by the ocean shader as a dark shape with two glowing slit eyes just
 * under the surface; it drifts after the player's ship, and if it gets close it
 * rears a tentacle out of the water and smashes it down where the ship was
 * heading. Steer away during the wind-up and it misses. Shooting it (eyes or
 * tentacle) makes it flinch and dive; enough hits drive it off for good.
 */
export class Lurkers {
  readonly group = new THREE.Group();
  private lurkers: Lurker[] = [];
  private level = 1;
  /** 0..1 event fade, so creatures only surface once the event has set in. */
  presence = 0;
  private time = 0;

  constructor(
    private readonly waves: WaveField,
    private readonly uniforms: Record<string, THREE.IUniform>,
    private readonly hooks: LurkerHooks,
  ) {
    this.group.name = 'lurkers';
  }

  get active(): boolean {
    return this.lurkers.length > 0;
  }

  get remaining(): number {
    return this.lurkers.filter((l) => l.state !== 'gone').length;
  }

  start(level: number, target: LurkerTarget): void {
    this.clear();
    this.level = THREE.MathUtils.clamp(level, 1, 3);
    const n = Math.min(LEVELS.count[this.level - 1], MAX_LURKERS);
    for (let i = 0; i < n; i++) {
      const tentacle = new Tentacle();
      this.group.add(tentacle.mesh);
      const l: Lurker = {
        id: LURKER_ID_BASE + i,
        state: 'deep',
        timer: 3 + i * 6 + Math.random() * 3,
        pos: new THREE.Vector3(),
        heading: 0,
        strength: 0,
        hp: LEVELS.hp[this.level - 1],
        blink: 1,
        nextBlink: 2 + Math.random() * 3,
        tentacle,
        strikeBase: new THREE.Vector3(),
        strikeTarget: new THREE.Vector3(),
        strikeDir: new THREE.Vector3(),
        strikeLength: 12,
        struck: false,
        collider: { id: LURKER_ID_BASE + i, position: new THREE.Vector3(), radius: 3 },
      };
      this.lurkers.push(l);
      this.placeAway(l, target, 90);
    }
  }

  clear(): void {
    for (const l of this.lurkers) {
      this.group.remove(l.tentacle.mesh);
      l.tentacle.mesh.geometry.dispose();
    }
    this.lurkers = [];
    this.uniforms.uLurkCount.value = 0;
  }

  /** Surface somewhere around the target, mostly behind it. */
  private placeAway(l: Lurker, target: LurkerTarget, dist: number): void {
    const back = Math.atan2(-target.velocity.z, -target.velocity.x);
    const a = (target.velocity.lengthSq() > 0.5 ? back : Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 2.2;
    const r = dist + Math.random() * 30;
    keepInside(l.pos.set(target.position.x + Math.cos(a) * r, 0, target.position.z + Math.sin(a) * r), 660);
    l.heading = a + Math.PI;
  }

  colliders(): Collider[] {
    const out: Collider[] = [];
    for (const l of this.lurkers) {
      if (l.state === 'strike' && l.tentacle.mesh.visible) {
        l.collider.position.copy(l.tentacle.middle);
        l.collider.radius = 2.4;
        out.push(l.collider);
      } else if ((l.state === 'stalk' || l.state === 'windup') && l.strength > 0.5) {
        const s = LEVELS.scale[this.level - 1];
        l.collider.position.set(l.pos.x + Math.cos(l.heading) * 3.4 * s, l.pos.y, l.pos.z + Math.sin(l.heading) * 3.4 * s);
        l.collider.radius = 3.2 * s;
        out.push(l.collider);
      }
    }
    return out;
  }

  /** A shot hit a creature. Returns where, or null if the id isn't ours. */
  hit(id: number, damage: number): THREE.Vector3 | null {
    const l = this.lurkers.find((x) => x.id === id);
    if (!l || l.state === 'gone' || l.state === 'deep') return null;
    const at = l.collider.position.clone();
    l.hp -= damage;
    this.hooks.splash(at, 1.4);
    // flinch: whatever it was doing, it dives
    l.state = 'retreat';
    l.timer = 5;
    l.heading += Math.PI;
    if (l.hp <= 0) {
      l.state = 'gone';
      l.timer = 4;
      this.hooks.drivenOff(this.remaining);
    }
    return at;
  }

  update(dt: number, target: LurkerTarget): void {
    this.time += dt;
    const lv = this.level - 1;
    const scale = LEVELS.scale[lv];
    const u = this.uniforms;
    let shown = 0;
    for (const l of this.lurkers) {
      l.timer -= dt;
      const toX = target.position.x - l.pos.x;
      const toZ = target.position.z - l.pos.z;
      const dist = Math.hypot(toX, toZ);
      const strikeRange = 8 + target.length * 0.4;

      switch (l.state) {
        case 'deep':
          l.strength = Math.max(0, l.strength - dt * 0.5);
          if (l.timer <= 0 && this.presence > 0.6) {
            this.placeAway(l, target, 80);
            l.state = 'stalk';
          }
          break;
        case 'stalk': {
          l.strength = Math.min(Math.min(1, this.presence * 1.5), l.strength + dt * 0.3);
          const want = Math.atan2(toZ, toX);
          l.heading += THREE.MathUtils.clamp(wrap(want - l.heading), -0.7 * dt, 0.7 * dt);
          const speed = LEVELS.speed[lv] * (dist > 120 ? 1.6 : 1);
          l.pos.x += Math.cos(l.heading) * speed * dt;
          l.pos.z += Math.sin(l.heading) * speed * dt;
          keepInside(l.pos);
          if (dist < strikeRange && l.strength > 0.8) this.beginWindup(l, target);
          if (this.presence < 0.3) {
            l.state = 'retreat';
            l.timer = 6;
          }
          break;
        }
        case 'windup': {
          // eyes flare, bubbles boil; the tentacle will come down where the ship was heading
          l.strength = 1;
          if (Math.random() < dt * 6) this.hooks.splash(_v.copy(l.strikeBase).add(_r.set((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4)), 0.4);
          if (l.timer <= 0) {
            l.state = 'strike';
            l.timer = STRIKE_TIME;
            l.struck = false;
            this.hooks.splash(l.strikeBase, 1.8);
          }
          break;
        }
        case 'strike': {
          const t = STRIKE_TIME - l.timer;
          this.poseStrike(l, t, scale);
          if (!l.struck && t >= 1.5) {
            l.struck = true;
            this.hooks.splash(l.strikeTarget, 2.2);
            const reach = 3.2 + target.length * 0.45;
            _v.copy(target.position).setY(0);
            if (_v.distanceTo(_r.copy(l.strikeTarget).setY(0)) < reach) {
              const shove = _s.copy(l.strikeDir).multiplyScalar(4);
              shove.y = -1.5;
              this.hooks.hitShip(LEVELS.damage[lv], target.position.clone(), shove);
            }
          }
          if (l.timer <= 0) {
            l.tentacle.mesh.visible = false;
            l.state = 'retreat';
            l.timer = 4;
          }
          break;
        }
        case 'retreat':
          l.tentacle.mesh.visible = false;
          l.strength = Math.max(0, l.strength - dt * 0.35);
          l.pos.x += Math.cos(l.heading) * 2.5 * dt;
          l.pos.z += Math.sin(l.heading) * 2.5 * dt;
          keepInside(l.pos);
          if (l.timer <= 0) {
            l.state = 'deep';
            l.timer = 7 + Math.random() * 8 - lv * 2;
          }
          break;
        case 'gone':
          l.tentacle.mesh.visible = false;
          l.strength = Math.max(0, l.strength - dt * 0.4);
          break;
      }

      // blink now and then
      l.nextBlink -= dt;
      if (l.nextBlink <= 0) {
        l.blink = 0;
        l.nextBlink = 2.5 + Math.random() * 4;
      }
      l.blink = Math.min(1, l.blink + dt * 5);
      l.pos.y = this.waves.heightAt(l.pos.x, l.pos.z);

      if (l.strength > 0.01 && shown < MAX_LURKERS) {
        const glow = l.state === 'windup' ? 1.6 + Math.sin(this.time * 18) * 0.4 : 0.8;
        (u.uLurkA.value as THREE.Vector4[])[shown].set(l.pos.x, l.pos.z, Math.cos(l.heading), Math.sin(l.heading));
        (u.uLurkB.value as THREE.Vector4[])[shown].set(l.strength, l.state === 'windup' ? 1 : l.blink, scale, glow);
        shown++;
      }
    }
    u.uLurkCount.value = shown;
  }

  private beginWindup(l: Lurker, target: LurkerTarget): void {
    const lv = this.level - 1;
    l.state = 'windup';
    l.timer = LEVELS.windup[lv];
    // aim where the ship will be when the tentacle lands
    const lead = l.timer + 1.5;
    l.strikeTarget.copy(target.position).addScaledVector(target.velocity, lead * 0.85).setY(0);
    const away = _v.set(l.pos.x - l.strikeTarget.x, 0, l.pos.z - l.strikeTarget.z);
    if (away.lengthSq() < 1) away.set(1, 0, 0);
    away.normalize();
    const reachOut = 6 + target.length * 0.3;
    l.strikeBase.copy(l.strikeTarget).addScaledVector(away, reachOut);
    l.strikeBase.y = this.waves.heightAt(l.strikeBase.x, l.strikeBase.z);
    l.strikeDir.copy(away).negate();
    l.strikeLength = (reachOut + 6) * LEVELS.scale[lv];
  }

  private poseStrike(l: Lurker, t: number, scale: number): void {
    const m = l.tentacle;
    m.mesh.visible = true;
    let emerge = 1;
    let pitch = 0;
    let curl = 0;
    if (t < 0.8) {
      // rise out of the sea, leaning back
      const k = ease(t / 0.8);
      emerge = k;
      pitch = -0.15 - 0.15 * k;
      curl = -0.05 * k;
    } else if (t < 1.25) {
      // rear back
      const k = ease((t - 0.8) / 0.45);
      pitch = -0.3 - 0.25 * k;
      curl = -0.05 - 0.07 * k;
    } else if (t < 1.5) {
      // slam down across the ship
      const k = (t - 1.25) / 0.25;
      const e = k * k;
      pitch = -0.55 + (1.45 + 0.55) * e;
      curl = -0.12 + 0.17 * e;
    } else if (t < 2.05) {
      // lie there, writhing
      pitch = 1.45 + Math.sin((t - 1.5) * 9) * 0.03;
      curl = 0.05;
    } else {
      // drag back under
      const k = ease((t - 2.05) / (STRIKE_TIME - 2.05));
      emerge = 1 - k;
      pitch = 1.45 - 0.9 * k;
      curl = 0.05;
    }
    m.pose(l.strikeBase, l.strikeDir, l.strikeLength, scale, emerge, pitch, curl, this.time);
  }
}

function ease(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const _up = new THREE.Vector3(0, 1, 0);
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _s = new THREE.Vector3();
