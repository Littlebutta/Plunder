import * as THREE from 'three';
import type { HullSpec } from '../physics/FloatingBody';
import type { DriveSpec } from './Vessel';

/**
 * A ship as the player draws it in the shipyard.
 *
 * The hull is described by two curves sampled at STATIONS points from bow
 * (index 0) to stern: the half-breadth seen from above (`plan`) and the keel
 * depth seen from the side (`keel`). Everything else (3D mesh, physics,
 * handling, cost) is derived from this plain data, so a design can be saved,
 * sent over the network, or generated for NPC ships.
 */
export interface HullDesign {
  name: string;
  /** Overall length (m). */
  length: number;
  /** Widest beam (m). */
  beam: number;
  /** Deepest point of the keel below the waterline (m). */
  depth: number;
  /** Deck height above the waterline amidships (m). */
  freeboard: number;
  /** Half-breadth at each station, 0..1 of beam / 2. */
  plan: number[];
  /** Keel depth at each station, 0..1 of depth. */
  keel: number[];
  /** Mast positions along the length, 0 (bow) .. 1 (stern). */
  masts: number[];
  /** Cannon positions along the length; each is a pair, one gun per side. */
  cannons: number[];
}

export const STATIONS = 25;
/** Places along the hull where masts and cannon pairs can go. */
export const MAST_SLOTS = [0.22, 0.34, 0.46, 0.58, 0.7, 0.82];
export const CANNON_SLOTS = [0.2, 0.28, 0.36, 0.44, 0.52, 0.6, 0.68, 0.76, 0.84];
/** A cannon needs at least this much half-breadth under it (m). */
export const CANNON_MIN_HALF_BEAM = 0.95;

export const DESIGN_LIMITS = {
  length: [6, 26],
  beam: [2, 8],
  depth: [0.5, 3],
  freeboard: [0.5, 2.2],
} as const;

function curve(fn: (t: number) => number): number[] {
  return Array.from({ length: STATIONS }, (_, i) => THREE.MathUtils.clamp(fn(i / (STATIONS - 1)), 0.02, 1));
}

/** Pointed bow, widest a little aft of the middle, with a transom `stern` wide. */
function planShape(fullness: number, stern: number): number[] {
  return curve((t) => {
    const bow = Math.pow(Math.sin((Math.PI / 2) * Math.min(1, t / 0.55)), fullness);
    const aft = t < 0.55 ? 1 : 1 - (1 - stern) * Math.pow((t - 0.55) / 0.45, 2);
    return bow * aft;
  });
}

function keelShape(rise: number): number[] {
  return curve((t) => Math.pow(Math.sin(Math.PI * (0.06 + 0.86 * t)), rise));
}

export const PRESETS: HullDesign[] = [
  { name: 'Dinghy', length: 7, beam: 2.6, depth: 0.7, freeboard: 0.7, plan: planShape(0.75, 0.6), keel: keelShape(0.6), masts: [0.46], cannons: [] },
  { name: 'Sloop', length: 11, beam: 3.6, depth: 1.1, freeboard: 1.0, plan: planShape(0.7, 0.5), keel: keelShape(0.5), masts: [0.46], cannons: [0.44, 0.6] },
  { name: 'Brig', length: 18, beam: 5.4, depth: 1.8, freeboard: 1.5, plan: planShape(0.6, 0.55), keel: keelShape(0.45), masts: [0.34, 0.7], cannons: [0.28, 0.44, 0.6, 0.76] },
  { name: 'Barge', length: 14, beam: 6, depth: 1.0, freeboard: 1.1, plan: planShape(0.35, 0.85), keel: keelShape(0.3), masts: [0.46], cannons: [0.36, 0.68] },
];

export function cloneDesign(d: HullDesign): HullDesign {
  return { ...d, plan: [...d.plan], keel: [...d.keel], masts: [...d.masts], cannons: [...d.cannons] };
}

/** Clamp numbers and curves to legal values (used on anything loaded or drawn). */
export function sanitizeDesign(d: HullDesign): HullDesign {
  const lim = DESIGN_LIMITS;
  const fix = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => (typeof v === 'number' && isFinite(v) ? THREE.MathUtils.clamp(v, lo, hi) : fallback);
  const arr = (a: unknown, fallback: number[]) =>
    Array.isArray(a) && a.length === STATIONS && a.every((v) => typeof v === 'number' && isFinite(v)) ? a.map((v) => THREE.MathUtils.clamp(v, 0.02, 1)) : [...fallback];
  const base = PRESETS[1];
  const out: HullDesign = {
    name: typeof d.name === 'string' ? d.name.slice(0, 24) : 'Ship',
    length: fix(d.length, lim.length, base.length),
    beam: fix(d.beam, lim.beam, base.beam),
    depth: fix(d.depth, lim.depth, base.depth),
    freeboard: fix(d.freeboard, lim.freeboard, base.freeboard),
    plan: arr(d.plan, base.plan),
    keel: arr(d.keel, base.keel),
    masts: (Array.isArray(d.masts) ? d.masts : []).filter((m) => MAST_SLOTS.includes(m)),
    cannons: (Array.isArray(d.cannons) ? d.cannons : []).filter((c) => CANNON_SLOTS.includes(c)),
  };
  out.cannons = out.cannons.filter((c) => halfBeamAt(out, c) >= CANNON_MIN_HALF_BEAM);
  return out;
}

function sampleCurve(a: number[], t: number): number {
  const f = THREE.MathUtils.clamp(t, 0, 1) * (STATIONS - 1);
  const i = Math.min(STATIONS - 2, Math.floor(f));
  return a[i] + (a[i + 1] - a[i]) * (f - i);
}

/** Half-breadth (m) at position t along the hull. */
export function halfBeamAt(d: HullDesign, t: number): number {
  return (sampleCurve(d.plan, t) * d.beam) / 2;
}

/** Keel depth below the waterline (m) at t. */
export function keelAt(d: HullDesign, t: number): number {
  return sampleCurve(d.keel, t) * d.depth;
}

/** Height of the rail above the waterline at t: the sheer line sweeps up toward bow and stern. */
export function sheerAt(d: HullDesign, t: number): number {
  const s = 2 * t - 1;
  return d.freeboard * (1 + 0.38 * s * s * (s < 0 ? 1.5 : 0.9));
}

/** Height of the deck planking at t (a bulwark's height below the rail). */
export function deckAt(d: HullDesign, t: number): number {
  return sheerAt(d, t) - 0.32;
}

/** Ship-space z of position t (bow at -length / 2). */
export function zAt(d: HullDesign, t: number): number {
  return (t - 0.5) * d.length;
}

export interface ShipStats {
  mass: number;
  draft: number;
  /** Mean of the plan curve: how boxy the hull is seen from above. */
  fullness: number;
  sailArea: number;
  /** m/s at full sail without wind help. */
  speed: number;
  /** 0..1, higher turns quicker. */
  agility: number;
  gunsPerSide: number;
  hold: number;
  cost: { wood: number; stone: number; salvage: number };
}

/** Sail carried by the mast at slot index i of a design (m^2), plus its dimensions. */
export function mastSize(d: HullDesign, index: number): { height: number; yard: number; sailW: number; sailH: number } {
  // the first mast is the main mast; others are a little shorter
  const scale = index === 0 ? 1 : 0.82;
  const height = THREE.MathUtils.clamp(d.length * 0.72, 3.8, 17) * scale;
  const yard = Math.max(2.2, d.beam * 1.45) * scale;
  return { height, yard, sailW: yard * 0.9, sailH: height * 0.6 };
}

export function computeStats(d: HullDesign): ShipStats {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const fullness = mean(d.plan);
  const keelFill = mean(d.keel);
  const guns = d.cannons.length;
  const hullMass = 60 * d.length * d.beam * (0.4 + d.depth) * fullness * (0.5 + keelFill * 0.5) * 1.25;
  const mass = hullMass + guns * 2 * 120 + d.masts.length * 80;
  const sailArea = d.masts.reduce((sum, _m, i) => {
    const s = mastSize(d, i);
    return sum + s.sailW * s.sailH;
  }, 0);

  // Arcade handling: long hulls are fast, fat and heavily armed ones slower,
  // and you need enough canvas for the hull you drew.
  const hullSpeed = 2.7 + 0.2 * d.length;
  const slim = THREE.MathUtils.clamp(1.15 - (d.beam / d.length) * 0.75 - (fullness - 0.6) * 0.5, 0.7, 1.1);
  const canvas = d.masts.length === 0 ? 0.3 : THREE.MathUtils.clamp(0.5 + (0.55 * sailArea) / (d.length * d.beam * 1.1), 0.5, 1.12);
  const load = 1 - Math.min(0.25, guns * 0.02);
  const speed = hullSpeed * slim * canvas * load;
  const agility = THREE.MathUtils.clamp(1.25 - d.length / 34 - (d.depth - 1) * 0.08, 0.45, 1.1);

  return {
    mass,
    draft: d.depth * (0.55 + 0.25 * keelFill),
    fullness,
    sailArea,
    speed,
    agility,
    gunsPerSide: guns,
    hold: Math.round(16 + d.length * d.beam * fullness * 1.6),
    cost: {
      wood: Math.round(d.length * d.beam * fullness * 2 + d.masts.length * 10),
      stone: Math.round(d.depth * d.length * 0.6),
      salvage: guns * 2 * 5,
    },
  };
}

const GRAVITY = 9.81;

/** Physics description of a drawn hull: buoyancy probes follow its footprint. */
export function designToHullSpec(d: HullDesign, stats = computeStats(d)): HullSpec {
  const probes: THREE.Vector3[] = [];
  let depthSum = 0;
  for (const t of [0.1, 0.26, 0.42, 0.58, 0.74, 0.9]) {
    const hb = halfBeamAt(d, t);
    const kd = keelAt(d, t);
    for (const [fx, fy] of [
      [-0.72, 0.5],
      [0, 0.8],
      [0.72, 0.5],
    ]) {
      const y = -Math.max(0.12, kd * fy);
      probes.push(new THREE.Vector3(hb * fx, y, zAt(d, t)));
      depthSum += -y;
    }
  }
  const restDraft = depthSum / probes.length;
  const m = stats.mass;
  const size = new THREE.Vector3(d.beam, d.depth + d.freeboard, d.length);
  const iy = (m / 12) * (size.x * size.x + size.z * size.z);
  const iz = (m / 12) * (size.x * size.x + size.y * size.y);
  const ix = (m / 12) * (size.y * size.y + size.z * size.z);
  return {
    mass: m,
    size,
    probes,
    probeMaxDepth: restDraft * 3.5,
    restDraft,
    // ~0.7 of critical damping per probe, so the hull settles without wallowing
    heaveDamping: 0.7 * 2 * (m / probes.length) * Math.sqrt(GRAVITY / restDraft),
    dragForward: { linear: 0, quadratic: 0 }, // filled in by designToDrive
    dragLateral: { linear: 1.4 * m * (0.6 + d.depth * 0.5), quadratic: 1.0 * m * (0.6 + d.depth * 0.5) },
    yawDamping: 5.8 * iy,
    tiltDamping: 0.4 * Math.max(ix, iz),
  };
}

/** Sail and rudder forces that give the design its computed speed and agility. */
export function designToDrive(d: HullDesign, hull: HullSpec, stats = computeStats(d)): DriveSpec {
  const thrust = hull.mass * 2.0;
  const v = Math.max(0.8, stats.speed);
  // at top speed: thrust = linear * v + quadratic * v^2, split 28% / 72%
  hull.dragForward = { linear: (0.28 * thrust) / v, quadratic: (0.72 * thrust) / (v * v) };
  const iy = (hull.mass / 12) * (hull.size.x * hull.size.x + hull.size.z * hull.size.z);
  return {
    baseThrust: thrust,
    windBoost: thrust * 1.15,
    headwindPenalty: 0.15,
    reverseThrust: thrust * 0.4,
    steerTorque: 1.9 * iy * stats.agility,
    steerSpeedGain: 0.22,
    sailRate: 0.8,
    maxTrim: THREE.MathUtils.degToRad(75),
  };
}

const STORAGE_KEY = 'plunder.design.v1';

export function saveDesign(d: HullDesign): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // storage unavailable (private window, read-only profile): the design just isn't remembered
  }
}

export function loadDesign(): HullDesign | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeDesign(JSON.parse(raw) as HullDesign) : null;
  } catch {
    return null;
  }
}
