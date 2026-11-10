import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';

/**
 * Where a crew lives: a ship's deck or the ground around a stronghold, in
 * the local space of whatever the crew's group is parented to.
 */
export interface CrewSurface {
  /**
   * Places worth walking to (guns, the wheel, the masts, cargo, a hut door).
   * On a deck the crew take turns at the guns and the helm (`kind`), facing
   * the way the job needs (`face`, a heading in the crew's space).
   */
  stations: { at: THREE.Vector3; work: boolean; kind?: 'gun' | 'helm'; face?: number }[];
  /** Height of the floor under a point. */
  height(x: number, z: number): number;
  /** Pull a point back inside the walkable area. */
  clamp(p: THREE.Vector3): void;
  /** Walk only to stations close by (ashore, so nobody strolls through the hut). */
  nearby?: boolean;
  /** Local height below which someone thrown clear has hit the water (or the ground). */
  floor: number;
}

export const CREW = {
  walkSpeed: 1.25,
  /** Seconds a casualty lies on deck, and until a replacement turns up. */
  bodyTime: 22,
  replaceTime: 14,
  /** Reach of a shell's blast among the crew (m). */
  blastRadius: 2.6,
};

const SKIN = [0xf0c39a, 0xd69b6c, 0x9c6b46, 0x6e4a32];
const TROUSERS = [0x2f3b52, 0x4a3524, 0x3c4a3a, 0x5a5148];
const HAIR = [0x2a1708, 0x5a3a1c, 0xb8862f, 0x8a8a8a];

// Geometry is shared by every sailor in the game.
let geo: Record<string, THREE.BufferGeometry> | null = null;
const mats = new Map<number, THREE.MeshToonMaterial>();
const flat = (c: number) => {
  let m = mats.get(c);
  if (!m) mats.set(c, (m = toonMaterial(c)));
  return m;
};
function geometries(): Record<string, THREE.BufferGeometry> {
  if (geo) return geo;
  const limb = (r: number, len: number) => {
    // a rounded limb hanging down from its pivot
    const g = new THREE.CapsuleGeometry(r, len, 3, 8);
    g.translate(0, -len / 2 - r * 0.4, 0);
    return g;
  };
  const torso = new THREE.CapsuleGeometry(0.15, 0.2, 4, 12);
  torso.scale(1.05, 1, 0.82);
  const brim = new THREE.CylinderGeometry(0.25, 0.27, 0.025, 14);
  const crown = new THREE.CylinderGeometry(0.11, 0.14, 0.12, 12);
  crown.translate(0, 0.07, 0);
  const bandana = new THREE.SphereGeometry(0.158, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
  const tricorn = new THREE.CylinderGeometry(0.05, 0.27, 0.13, 3);
  tricorn.rotateY(Math.PI);
  geo = {
    torso,
    head: new THREE.SphereGeometry(0.15, 14, 12),
    leg: limb(0.068, 0.2),
    arm: limb(0.05, 0.2),
    hand: new THREE.SphereGeometry(0.058, 8, 6),
    foot: new THREE.BoxGeometry(0.11, 0.07, 0.19),
    eye: new THREE.SphereGeometry(0.022, 6, 5),
    nose: new THREE.SphereGeometry(0.035, 6, 5),
    beard: new THREE.SphereGeometry(0.11, 10, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55),
    hair: new THREE.SphereGeometry(0.156, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    belt: new THREE.CylinderGeometry(0.162, 0.162, 0.05, 12),
    brim,
    crown,
    bandana,
    knot: new THREE.SphereGeometry(0.045, 6, 5),
    tricorn,
  };
  geo.belt.scale(1.05, 1, 0.82);
  return geo;
}

type State = 'walk' | 'idle' | 'fly' | 'dead' | 'away';

/** One sailor: a small rounded figure with a shirt in the team's colour. */
class Sailor {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  state: State = 'idle';
  timer = 0;
  phase = Math.random() * 6;
  readonly target = new THREE.Vector3();
  working = false;
  /** The station they are at or making for (index), or -1. */
  station = -1;
  /** Heading to turn to while working a station. */
  facing: number | null = null;
  readonly vel = new THREE.Vector3();
  readonly spin = new THREE.Vector3();

  constructor(shirt: THREE.Material, n: number) {
    const g = geometries();
    const skin = flat(SKIN[n % SKIN.length]);
    const trousers = flat(TROUSERS[(n * 3 + 1) % TROUSERS.length]);
    const hair = flat(HAIR[(n * 5 + 2) % HAIR.length]);
    const dark = flat(0x2a1708);
    const mesh = (geometry: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geometry, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    this.root.add(this.body);
    // legs swing from the hips
    for (const [leg, x] of [
      [this.legL, -0.075],
      [this.legR, 0.075],
    ] as const) {
      leg.position.set(x, 0.34, 0);
      mesh(g.leg, trousers, leg);
      mesh(g.foot, dark, leg, 0, -0.3, 0.035);
      this.body.add(leg);
    }
    addOutline(mesh(g.torso, shirt, this.body, 0, 0.5, 0), 0.016, PALETTE.outline);
    mesh(g.belt, dark, this.body, 0, 0.375, 0);
    for (const [arm, x] of [
      [this.armL, -0.2],
      [this.armR, 0.2],
    ] as const) {
      arm.position.set(x, 0.63, 0);
      arm.rotation.z = x < 0 ? -0.12 : 0.12;
      mesh(g.arm, n % 3 === 1 ? skin : shirt, arm); // some have their sleeves rolled
      mesh(g.hand, skin, arm, 0, -0.27, 0);
      this.body.add(arm);
    }
    const head = mesh(g.head, skin, this.body, 0, 0.84, 0);
    addOutline(head, 0.016, PALETTE.outline);
    for (const x of [-0.055, 0.055]) mesh(g.eye, dark, head, x, 0.02, 0.135).castShadow = false;
    mesh(g.nose, skin, head, 0, -0.02, 0.15).castShadow = false;
    // headgear and whiskers vary from sailor to sailor
    const kind = n % 4;
    if (kind === 0) {
      mesh(g.bandana, shirt, head, 0, 0.012, 0).rotation.x = -0.18;
      mesh(g.knot, shirt, head, 0.09, 0.02, -0.13);
    } else if (kind === 1) {
      const straw = flat(0xe2c877);
      mesh(g.brim, straw, head, 0, 0.1, 0);
      mesh(g.crown, straw, head, 0, 0.1, 0);
    } else if (kind === 2) {
      mesh(g.hair, hair, head, 0, 0.01, -0.012).rotation.x = -0.25;
    } else {
      mesh(g.tricorn, dark, head, 0, 0.15, 0);
    }
    if (n % 3 === 0) mesh(g.beard, hair, head, 0, -0.03, 0.04);
    const s = 0.94 + ((n * 7) % 5) * 0.035;
    this.root.scale.setScalar(s);
  }

  /** Limbs for this moment. */
  pose(dt: number): void {
    const walking = this.state === 'walk';
    this.phase += dt * (walking ? 9 : 1.6);
    const sw = walking ? Math.sin(this.phase) : 0;
    const k = 1 - Math.exp(-dt * 12);
    const to = (g: THREE.Group, x: number) => (g.rotation.x += (x - g.rotation.x) * k);
    to(this.legL, sw * 0.75);
    to(this.legR, -sw * 0.75);
    if (this.state === 'idle' && this.working) {
      // hauling on something: both arms forward, pumping
      const pump = Math.sin(this.phase * 2.2) * 0.3;
      to(this.armL, -1.25 + pump);
      to(this.armR, -1.25 - pump);
      this.body.rotation.x += (0.16 - this.body.rotation.x) * k;
    } else {
      to(this.armL, -sw * 0.6);
      to(this.armR, sw * 0.6);
      this.body.rotation.x += ((walking ? 0.08 : 0) - this.body.rotation.x) * k;
    }
    this.body.position.y = walking ? Math.abs(Math.sin(this.phase)) * 0.035 : Math.sin(this.phase) * 0.006;
  }

  /** Limp: flung through the air or lying where they fell. */
  sprawl(): void {
    this.legL.rotation.x = 0.5;
    this.legR.rotation.x = -0.3;
    this.armL.rotation.x = -2.4;
    this.armR.rotation.x = -1.9;
    this.body.rotation.x = 0;
    this.body.position.y = 0;
  }
}

/**
 * A handful of sailors who go about their business on a deck or around a
 * stronghold: walking between the guns, the wheel and the cargo, working for
 * a bit, moving on. A shell landing among them throws some clear and leaves
 * others lying where they fell; replacements turn up after a while.
 */
export class Crew {
  readonly group = new THREE.Group();
  private readonly sailors: Sailor[] = [];
  private readonly shirt: THREE.MeshToonMaterial;
  /** Someone thrown clear has landed (local position): time for a splash. */
  onLanded: ((at: THREE.Vector3) => void) | null = null;

  constructor(
    count: number,
    colour: THREE.ColorRepresentation,
    private readonly surface: CrewSurface,
  ) {
    this.group.name = 'crew';
    this.shirt = toonMaterial(colour);
    for (let n = 0; n < count; n++) {
      const s = new Sailor(this.shirt, n + Math.floor(Math.random() * 12));
      this.sailors.push(s);
      this.group.add(s.root);
    }
    this.reset();
  }

  get count(): number {
    return this.sailors.length;
  }

  /** Sailors on their feet. */
  get standing(): number {
    return this.sailors.filter((s) => s.state === 'walk' || s.state === 'idle').length;
  }

  setColour(colour: THREE.ColorRepresentation): void {
    this.shirt.color.set(colour);
  }

  /** Everyone back on their feet at a station (a new ship, a respawn). */
  reset(): void {
    this.sailors.forEach((s, i) => this.muster(s, i));
  }

  private muster(s: Sailor, i: number): void {
    const st = this.surface.stations;
    const pick = st.length ? st[(i * 7 + 3) % st.length] : null;
    s.root.position.set(pick ? pick.at.x : 0, 0, pick ? pick.at.z : 0);
    s.root.position.x += (Math.random() - 0.5) * 0.5;
    s.root.position.z += (Math.random() - 0.5) * 0.5;
    this.surface.clamp(s.root.position);
    s.root.position.y = this.surface.height(s.root.position.x, s.root.position.z);
    s.root.rotation.set(0, Math.random() * 6.28, 0);
    s.root.visible = true;
    s.state = 'idle';
    s.working = false;
    s.timer = 0.5 + Math.random() * 4;
  }

  /**
   * A shell burst at `at` (local). Sailors close by are thrown clear or
   * killed where they stand. Returns how many were hit.
   */
  blast(at: THREE.Vector3, power = 1): number {
    let n = 0;
    for (const s of this.sailors) {
      if (s.state !== 'walk' && s.state !== 'idle') continue;
      const d = Math.hypot(s.root.position.x - at.x, s.root.position.z - at.z);
      if (d > CREW.blastRadius * power || Math.random() > 0.75 - (d / (CREW.blastRadius * power)) * 0.45) continue;
      n++;
      s.sprawl();
      if (Math.random() < 0.6) {
        // thrown clear, up and away from the burst
        s.state = 'fly';
        const dx = s.root.position.x - at.x || Math.random() - 0.5;
        const dz = s.root.position.z - at.z || Math.random() - 0.5;
        const l = Math.hypot(dx, dz) || 1;
        const out = 2.5 + Math.random() * 4 * power;
        s.vel.set((dx / l) * out, 5.5 + Math.random() * 4 * power, (dz / l) * out);
        s.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 12);
      } else {
        s.state = 'dead';
        s.timer = CREW.bodyTime * (0.7 + Math.random() * 0.6);
        s.root.rotation.set(-Math.PI / 2, 0, Math.random() * 6.28);
        s.root.position.y = this.surface.height(s.root.position.x, s.root.position.z) + 0.14;
      }
    }
    return n;
  }

  /**
   * Where a sailor goes next. On a deck with guns and a helm they swap between
   * the two: whoever leaves the wheel is relieved by someone from the guns, and
   * the empty guns are filled first. Elsewhere, anywhere.
   */
  private pickStation(s: Sailor): number {
    const st = this.surface.stations;
    const taken = (i: number) => this.sailors.some((o) => o !== s && o.station === i && (o.state === 'walk' || o.state === 'idle'));
    const helm = st.findIndex((x) => x.kind === 'helm');
    const guns = st.map((x, i) => (x.kind === 'gun' ? i : -1)).filter((i) => i >= 0);
    if (helm >= 0 || guns.length) {
      const was = st[s.station]?.kind;
      // the wheel is never left empty for long
      if (helm >= 0 && !taken(helm) && was !== 'helm') return helm;
      const free = guns.filter((i) => i !== s.station && !taken(i));
      if (free.length && Math.random() < 0.85) return free[Math.floor(Math.random() * free.length)];
      if (helm >= 0 && was === 'gun' && Math.random() < 0.5) return helm;
      if (guns.length && Math.random() < 0.6) return guns[Math.floor(Math.random() * guns.length)];
    }
    return Math.floor(Math.random() * st.length);
  }

  update(dt: number): void {
    const surf = this.surface;
    this.sailors.forEach((s, i) => {
      const p = s.root.position;
      switch (s.state) {
        case 'idle':
          s.timer -= dt;
          // at a station: turn to face the work (out over the gun, or forward at the wheel)
          if (s.facing !== null) {
            const d = Math.atan2(Math.sin(s.facing - s.root.rotation.y), Math.cos(s.facing - s.root.rotation.y));
            s.root.rotation.y += d * Math.min(1, dt * 6);
          }
          if (s.timer <= 0 && surf.stations.length) {
            const pick = this.pickStation(s);
            let st = surf.stations[pick];
            s.station = pick;
            if (surf.nearby) {
              const near = [...surf.stations].sort((a, b) => a.at.distanceToSquared(p) - b.at.distanceToSquared(p));
              st = near[1 + Math.floor(Math.random() * Math.min(3, near.length - 1))] ?? st;
            }
            s.target.copy(st.at);
            s.target.x += (Math.random() - 0.5) * 0.4;
            s.target.z += (Math.random() - 0.5) * 0.4;
            surf.clamp(s.target);
            s.working = st.work;
            s.facing = null;
            s.state = 'walk';
          }
          s.pose(dt);
          break;
        case 'walk': {
          const dx = s.target.x - p.x;
          const dz = s.target.z - p.z;
          const left = Math.hypot(dx, dz);
          if (left < 0.12) {
            s.state = 'idle';
            const st = surf.stations[s.station];
            // a turn at the guns or the wheel lasts a while; then someone else takes over
            s.timer = st?.kind ? 6 + Math.random() * 8 : 2 + Math.random() * 4;
            s.facing = st?.face ?? null;
          } else {
            const step = Math.min(left, CREW.walkSpeed * dt);
            p.x += (dx / left) * step;
            p.z += (dz / left) * step;
            // turn to face the way they are going
            const want = Math.atan2(dx, dz);
            let d = want - s.root.rotation.y;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            s.root.rotation.y += d * Math.min(1, dt * 10);
          }
          p.y = surf.height(p.x, p.z);
          s.pose(dt);
          break;
        }
        case 'fly':
          s.vel.y -= 14 * dt;
          p.addScaledVector(s.vel, dt);
          s.root.rotation.x += s.spin.x * dt;
          s.root.rotation.y += s.spin.y * dt;
          s.root.rotation.z += s.spin.z * dt;
          if (p.y < surf.floor && s.vel.y < 0) {
            this.onLanded?.(p);
            s.root.visible = false;
            s.state = 'away';
            s.timer = CREW.replaceTime * (0.7 + Math.random() * 0.8);
          }
          break;
        case 'dead':
          s.timer -= dt;
          if (s.timer <= 0) {
            s.root.visible = false;
            s.state = 'away';
            s.timer = CREW.replaceTime * (0.5 + Math.random() * 0.8);
          }
          break;
        case 'away':
          s.timer -= dt;
          if (s.timer <= 0) this.muster(s, i + Math.floor(Math.random() * 9));
          break;
      }
    });
  }
}
