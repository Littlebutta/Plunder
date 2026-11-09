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
  /** Masts, main mast first. */
  masts: MastFit[];
  /** A triangular headsail from the foremast to the bowsprit. */
  jib: boolean;
  /** Broadside guns, each placed on its own. */
  cannons: CannonFit[];
  /** Where the swivel gun stands. */
  swivel: 'bow' | 'stern';
}

/** Square: best with the wind astern. Lateen (triangle): best with the wind on the beam or a little ahead. */
export type SailType = 'square' | 'lateen';

export interface MastFit {
  /** Position along the length, 0 (bow) .. 1 (stern). */
  t: number;
  sail: SailType;
}

export interface CannonFit {
  /** Position along the length, 0 (bow) .. 1 (stern). */
  t: number;
  /** 1 = starboard, -1 = port. */
  side: 1 | -1;
  /** 0 = on the open deck; 1, 2, 3 = gun decks below it, firing through ports in the hull side. */
  level: number;
}

export const STATIONS = 25;
/** Places along the hull where masts and cannon pairs can go. */
export const MAST_SLOTS = [0.22, 0.34, 0.46, 0.58, 0.7, 0.82];
/** A cannon needs at least this much half-breadth under it (m). */
export const CANNON_MIN_HALF_BEAM = 0.95;
/** Cannons can stand anywhere along this stretch of the hull. */
export const CANNON_T_RANGE = [0.1, 0.92] as const;
/** Least distance between two guns on the same side and deck (m). */
export const CANNON_SPACING = 0.9;
/** A ship's first few cannons come with the hull; each one beyond that costs metals. */
export const FREE_CANNONS = 4;
export const METALS_PER_CANNON = 4;
/** Lowest gun deck number. */
export const MAX_GUN_LEVEL = 3;
/** Height between gun decks (m). */
const GUN_DECK_STEP = 0.78;
/** A gun port's sill must clear the waterline by this much (m). */
const PORT_CLEARANCE = 0.2;

export const DESIGN_LIMITS = {
  length: [6, 26],
  beam: [2, 8],
  depth: [0.5, 3],
  freeboard: [0.5, 3.2],
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

/** Guns in mirrored pairs at the given positions and deck level. */
function pairs(level: number, ...ts: number[]): CannonFit[] {
  return ts.flatMap((t) => [
    { t, side: 1 as const, level },
    { t, side: -1 as const, level },
  ]);
}
const sq = (t: number): MastFit => ({ t, sail: 'square' });
const lat = (t: number): MastFit => ({ t, sail: 'lateen' });

export const PRESETS: HullDesign[] = [
  { name: 'Dinghy', length: 7, beam: 2.6, depth: 0.7, freeboard: 0.7, plan: planShape(0.75, 0.6), keel: keelShape(0.6), masts: [lat(0.46)], jib: false, cannons: [], swivel: 'bow' },
  { name: 'Sloop', length: 11, beam: 3.6, depth: 1.1, freeboard: 1.0, plan: planShape(0.7, 0.5), keel: keelShape(0.5), masts: [sq(0.46)], jib: true, cannons: pairs(0, 0.44, 0.6), swivel: 'bow' },
  {
    name: 'Brig',
    length: 18,
    beam: 5.4,
    depth: 1.8,
    freeboard: 1.6,
    plan: planShape(0.6, 0.55),
    keel: keelShape(0.45),
    masts: [sq(0.34), lat(0.7)],
    jib: true,
    cannons: [...pairs(0, 0.3, 0.52), ...pairs(1, 0.36, 0.46, 0.56, 0.66)],
    swivel: 'bow',
  },
  { name: 'Barge', length: 14, beam: 6, depth: 1.0, freeboard: 1.1, plan: planShape(0.35, 0.85), keel: keelShape(0.3), masts: [sq(0.46)], jib: false, cannons: pairs(0, 0.36, 0.52, 0.68), swivel: 'stern' },
  {
    name: 'Galleon',
    length: 24,
    beam: 7.2,
    depth: 2.4,
    freeboard: 2.6,
    plan: planShape(0.5, 0.6),
    keel: keelShape(0.4),
    masts: [sq(0.46), sq(0.22), lat(0.82)],
    jib: true,
    cannons: [...pairs(0, 0.3, 0.42, 0.54, 0.66), ...pairs(1, 0.28, 0.37, 0.46, 0.55, 0.64, 0.73), ...pairs(2, 0.33, 0.42, 0.51, 0.6, 0.69)],
    swivel: 'bow',
  },
];

export function cloneDesign(d: HullDesign): HullDesign {
  return { ...d, plan: [...d.plan], keel: [...d.keel], masts: d.masts.map((m) => ({ ...m })), cannons: d.cannons.map((c) => ({ ...c })) };
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
    masts: [],
    jib: d.jib === true,
    cannons: [],
    swivel: d.swivel === 'stern' ? 'stern' : 'bow',
  };
  // Masts and cannons: accept the old format too (plain positions; cannons as mirrored deck pairs).
  for (const m of (Array.isArray(d.masts) ? d.masts : []) as unknown[]) {
    const fit = typeof m === 'number' ? { t: m, sail: 'square' } : (m as Partial<MastFit> | null);
    if (!fit || typeof fit.t !== 'number' || !MAST_SLOTS.includes(fit.t) || out.masts.some((o) => o.t === fit.t)) continue;
    out.masts.push({ t: fit.t, sail: fit.sail === 'lateen' ? 'lateen' : 'square' });
  }
  if (out.masts.length === 0) out.jib = false;
  for (const c of (Array.isArray(d.cannons) ? d.cannons : []) as unknown[]) {
    const fits = typeof c === 'number' ? pairs(0, c) : [c as Partial<CannonFit> | null];
    for (const f of fits) {
      if (!f || typeof f.t !== 'number' || !isFinite(f.t)) continue;
      const fit: CannonFit = { t: f.t, side: f.side === -1 ? -1 : 1, level: Math.round(Number(f.level) || 0) };
      if (cannonAllowed(out, fit)) out.cannons.push(fit);
    }
  }
  return out;
}

/** Height of a gun's barrel above the waterline at t, for a gun on the given deck. */
export function gunHeight(d: HullDesign, t: number, level: number): number {
  return deckAt(d, t) + 0.3 - GUN_DECK_STEP * level;
}

/** Lowest gun deck this hull has room for at t (0 = open deck only). */
export function lowestGunLevel(d: HullDesign, t: number): number {
  let level = 0;
  while (level < MAX_GUN_LEVEL && gunHeight(d, t, level + 1) - 0.22 >= PORT_CLEARANCE) level++;
  return level;
}

/** Half-width of the hull's skin at height y (above the waterline) at t. */
export function hullHalfWidthAt(d: HullDesign, t: number, y: number): number {
  const kd = keelAt(d, t);
  const top = sheerAt(d, t);
  const w = Math.pow(THREE.MathUtils.clamp((y + kd) / (top + kd), 0, 1), 1 / 1.25);
  const c = 1 - w;
  return Math.max(0.03, halfBeamAt(d, t)) * Math.pow(Math.sqrt(Math.max(0, 1 - c * c)), 0.7);
}

/** Point on the hull's skin: u runs 0 (keel) .. 1 (rail). Same curve the 3D model is lofted from. */
export function hullPoint(d: HullDesign, t: number, u: number, side: number, out: THREE.Vector3): THREE.Vector3 {
  const hb = Math.max(0.03, halfBeamAt(d, t));
  const kd = keelAt(d, t);
  const top = sheerAt(d, t);
  // round bilge: the side goes out quickly, then turns up to the rail
  const x = hb * Math.pow(Math.sin((u * Math.PI) / 2), 0.7);
  const y = -kd + (top + kd) * Math.pow(1 - Math.cos((u * Math.PI) / 2), 1.25);
  return out.set(side * x, y, zAt(d, t));
}

/** Why a cannon can't go here, or null if it can (ignores other guns; see `cannonClash`). */
export function cannonProblem(d: HullDesign, c: CannonFit): string | null {
  if (c.t < CANNON_T_RANGE[0] || c.t > CANNON_T_RANGE[1]) return 'Too close to the end of the hull.';
  if (c.level < 0 || c.level > MAX_GUN_LEVEL) return 'No such deck.';
  if (c.level > lowestGunLevel(d, c.t)) return 'That deck would be under the waterline here. Raise the freeboard.';
  const width = c.level === 0 ? halfBeamAt(d, c.t) : hullHalfWidthAt(d, c.t, gunHeight(d, c.t, c.level));
  if (width < CANNON_MIN_HALF_BEAM) return 'The hull is too narrow here.';
  return null;
}

/** Index of a gun already standing too close to where `c` would go, or -1. */
export function cannonClash(d: HullDesign, c: CannonFit): number {
  return d.cannons.findIndex((o) => o.side === c.side && o.level === c.level && Math.abs(o.t - c.t) * d.length < CANNON_SPACING);
}

function cannonAllowed(d: HullDesign, c: CannonFit): boolean {
  return cannonProblem(d, c) === null && cannonClash(d, c) < 0;
}

/** Where a gun's carriage stands in ship space (the barrel is 0.3 m above this). */
export function cannonMount(d: HullDesign, c: CannonFit, out = new THREE.Vector3()): THREE.Vector3 {
  if (c.level === 0) return out.set(c.side * (halfBeamAt(d, c.t) * 0.93 - 0.42), deckAt(d, c.t), zAt(d, c.t));
  const y = gunHeight(d, c.t, c.level);
  return out.set(c.side * (hullHalfWidthAt(d, c.t, y) - 0.5), y - 0.3, zAt(d, c.t));
}

/**
 * How much of the wind's boost a sail takes, 0..1, by point of sail.
 * `along` is the cosine of the angle between the ship's heading and where the
 * wind blows toward: 1 = running dead downwind, 0 = wind on the beam, -1 = head to wind.
 */
export function sailBoost(type: SailType, along: number): number {
  if (type === 'square') return THREE.MathUtils.clamp((along + 0.3) / 1.3, 0, 1);
  // lateen: full pull from a broad reach round to a close reach, less dead downwind
  if (along >= 0.35) return THREE.MathUtils.lerp(1, 0.5, (along - 0.35) / 0.65);
  if (along >= -0.55) return 1;
  return THREE.MathUtils.clamp(1 - (-0.55 - along) / 0.37, 0, 1);
}

/** Extra boost from a jib: helps most on a close reach. */
export function jibBoost(along: number): number {
  return 0.22 * THREE.MathUtils.clamp(1 - Math.abs(along + 0.25) / 0.75, 0, 1);
}

/** Wind boost for a whole rig at a point of sail: sails weighted by area, plus the jib. */
export function rigBoost(d: HullDesign, along: number): number {
  if (d.masts.length === 0) return 0;
  let area = 0;
  let sum = 0;
  d.masts.forEach((m, i) => {
    const s = mastSize(d, i);
    const a = s.sailW * s.sailH * (m.sail === 'lateen' ? 0.75 : 1);
    area += a;
    sum += a * sailBoost(m.sail, along);
  });
  return Math.min(1, sum / area + (d.jib ? jibBoost(along) : 0));
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
  /** Guns on the fuller side, and in all. */
  gunsPerSide: number;
  guns: number;
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
  const mass = hullMass + guns * 120 + d.masts.length * 80;
  const sailArea =
    d.masts.reduce((sum, m, i) => {
      const s = mastSize(d, i);
      return sum + s.sailW * s.sailH * (m.sail === 'lateen' ? 0.75 : 1);
    }, 0) * (d.jib ? 1.12 : 1);

  // Arcade handling: long hulls are fast, fat and heavily armed ones slower,
  // and you need enough canvas for the hull you drew.
  const hullSpeed = 4.3 + 0.3 * d.length;
  const slim = THREE.MathUtils.clamp(1.15 - (d.beam / d.length) * 0.75 - (fullness - 0.6) * 0.5, 0.7, 1.1);
  const canvas = d.masts.length === 0 ? 0.3 : THREE.MathUtils.clamp(0.5 + (0.55 * sailArea) / (d.length * d.beam * 1.1), 0.5, 1.12);
  const load = 1 - Math.min(0.25, guns * 0.008);
  const speed = hullSpeed * slim * canvas * load;
  const agility = THREE.MathUtils.clamp(1.25 - d.length / 34 - (d.depth - 1) * 0.08, 0.45, 1.1);

  return {
    mass,
    draft: d.depth * (0.55 + 0.25 * keelFill),
    fullness,
    sailArea,
    speed,
    agility,
    gunsPerSide: Math.max(d.cannons.filter((c) => c.side === 1).length, guns - d.cannons.filter((c) => c.side === 1).length),
    guns,
    hold: Math.round(16 + d.length * d.beam * fullness * 1.6),
    cost: {
      wood: Math.round(d.length * d.beam * fullness * 2 + d.masts.length * 10),
      stone: Math.round(d.depth * d.length * 0.6),
      salvage: Math.max(0, guns - FREE_CANNONS) * METALS_PER_CANNON,
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

const STORAGE_KEY = 'plunder.design.v1'; // older saves are upgraded by sanitizeDesign

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
