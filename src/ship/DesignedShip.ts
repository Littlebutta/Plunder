import * as THREE from 'three';
import { WaveField } from '../ocean/waves';
import { PALETTE } from '../render/palette';
import { sailTint, setToonColour } from '../render/toon';
import { Wind } from '../world/Wind';
import { computeStats, deckAt, designToDrive, designToHullSpec, halfBeamAt, HullDesign, mastSize, rigBoost, ShipStats, zAt } from './HullDesign';
import { Crew, CrewSurface } from '../crew/Crew';
import { MastRig } from './Masts';
import { buildShipVisual, ShipVisual } from './ShipVisual';
import { Vessel } from './Vessel';
import { CargoPile } from './Cargo';
import type { Stock } from '../world/Resources';

/** The deck of a design as somewhere for a crew to walk: guns, wheel, masts and cargo to visit. */
function deckSurface(d: HullDesign, visual: ShipVisual): CrewSurface {
  const tOf = (z: number) => THREE.MathUtils.clamp(z / d.length + 0.5, 0, 1);
  const stations: CrewSurface['stations'] = [];
  d.cannons.forEach((c, i) => {
    if (c.level !== 0) return;
    const m = visual.gunMounts[i];
    stations.push({ at: new THREE.Vector3(m.x - Math.sign(m.x) * 0.6, 0, m.z + 0.1), work: true });
  });
  if (d.length >= 9) stations.push({ at: new THREE.Vector3(0, 0, zAt(d, 0.87) + 0.45), work: true }); // the helm
  for (const m of visual.masts) stations.push({ at: new THREE.Vector3(0.4, 0, m.foot.z + 0.2), work: true });
  visual.cargoPlaces.slice(0, 4).forEach((c) => stations.push({ at: new THREE.Vector3(c.x + 0.45, 0, c.z), work: false }));
  stations.push({ at: new THREE.Vector3(0, 0, zAt(d, 0.16)), work: false }, { at: new THREE.Vector3(0.3, 0, zAt(d, 0.9)), work: false });
  return {
    stations,
    height: (_x, z) => deckAt(d, tOf(z)) + 0.02,
    clamp: (p) => {
      const t = THREE.MathUtils.clamp(tOf(p.z), 0.11, 0.92);
      const half = Math.max(0.05, halfBeamAt(d, t) * 0.92 - 0.32);
      p.z = zAt(d, t);
      p.x = THREE.MathUtils.clamp(p.x, -half, half);
    },
    floor: -0.5,
  };
}

/** A ship built from a shipyard design: lofted hull, derived physics and handling. */
export class DesignedShip extends Vessel {
  readonly swivelMount: THREE.Vector3;
  override readonly swivelFacing: number;
  readonly gunMounts: THREE.Vector3[];
  readonly length: number;
  readonly holdCapacity: number;
  readonly displayName: string;
  readonly stats: ShipStats;

  /** Her masts: they can be shot away and are stepped again by the crew. */
  readonly rig: MastRig;
  /** Pays for a replacement mast (the player's stores); null = free (NPC ships). */
  spendWood: ((wood: number) => boolean) | null = null;

  readonly visual: ShipVisual;
  /** The hands on deck. */
  readonly crew: Crew;
  /** Someone was thrown overboard and has hit the water (world position). */
  static onOverboard: ((at: THREE.Vector3) => void) | null = null;
  private readonly cargo: CargoPile;
  private time = 0;
  /** Which side the fore-and-aft sails are bellied out to (-1 / 1), eased. */
  private lee = 1;

  constructor(
    readonly design: HullDesign,
    waves: WaveField,
    wind: Wind,
    colour: THREE.ColorRepresentation = PALETTE.sail,
    /** Collider id of the ship, which numbers her mast hitboxes. */
    shipId = 0,
  ) {
    const stats = computeStats(design);
    const hull = designToHullSpec(design, stats);
    super(hull, designToDrive(design, hull, stats), waves, wind);
    this.stats = stats;
    this.visual = buildShipVisual(design, colour);
    this.group.add(this.visual.group);
    this.cargo = new CargoPile(this.visual.cargoPlaces);
    this.visual.group.add(this.cargo.group);
    this.group.name = 'designed-ship';
    this.crew = new Crew(THREE.MathUtils.clamp(Math.round(design.length / 2.3), 2, 9), colour, deckSurface(design, this.visual));
    this.crew.onLanded = (at) => DesignedShip.onOverboard?.(this.group.localToWorld(_w.copy(at)));
    this.visual.group.add(this.crew.group);
    this.rig = new MastRig(
      this.visual.masts,
      design.masts.map((_, i) => {
        const m = mastSize(design, i);
        return m.sailW * m.sailH;
      }),
      shipId,
    );
    this.swivelMount = this.visual.swivelMount;
    this.swivelFacing = this.visual.swivelFacing;
    this.gunMounts = this.visual.gunMounts;
    this.length = design.length;
    this.holdCapacity = stats.hold;
    this.displayName = design.name;
  }

  protected override rigBoost(along: number): number {
    return rigBoost(this.design, along);
  }

  override setCargo(stock: Stock, capacity: number): void {
    this.cargo.set(stock, capacity);
  }

  setColour(colour: THREE.ColorRepresentation): void {
    setToonColour(this.visual.sailMaterial, sailTint(colour));
    setToonColour(this.visual.flagMaterial, colour);
    this.crew.setColour(colour);
  }

  /** A shell burst aboard at a world position: the hands nearby are thrown about. */
  crewHit(at: THREE.Vector3, kind: number): void {
    this.group.updateMatrixWorld();
    this.crew.blast(this.group.worldToLocal(_w.copy(at)), kind === 1 ? 1 : 0.6);
  }

  syncVisuals(dt: number): void {
    this.time += dt;
    const b = this.body;
    this.group.position.copy(b.position);
    this.group.quaternion.copy(b.quaternion);
    this.rig.update(dt, b.position, b.quaternion, this.spendWood);
    this.driveFactor = this.rig.drive;
    this.crew.update(dt);

    const unfurl = Math.max(this.sail, 0);
    const aw = this.apparentLocal;
    // fore-and-aft sails belly out to leeward and swing that way
    if (Math.abs(aw.x) > 0.4) this.lee = THREE.MathUtils.damp(this.lee, Math.sign(aw.x), 3, dt);
    const swing = THREE.MathUtils.clamp(Math.atan2(aw.x, Math.max(0.5, Math.abs(aw.z))), -0.9, 0.9);
    for (const s of this.visual.sails) {
      if (s.type === 'square') {
        s.mesh.scale.y = THREE.MathUtils.lerp(0.08, 1, unfurl);
        s.mesh.scale.z = THREE.MathUtils.lerp(0.2, 1, unfurl);
        s.pivot.rotation.y = this.trim;
      } else {
        s.mesh.scale.y = THREE.MathUtils.lerp(0.06, 1, unfurl);
        s.mesh.scale.x = this.lee * THREE.MathUtils.lerp(0.15, 1, unfurl);
        s.pivot.rotation.y = THREE.MathUtils.damp(s.pivot.rotation.y, swing * 0.7, 2.5, dt);
      }
    }
    const jib = this.visual.jib;
    if (jib) {
      jib.visible = unfurl > 0.05;
      jib.scale.x = this.lee * unfurl;
    }
    this.visual.rudder.rotation.y = -this.rudder * 0.5;
    const flag = this.visual.flag;
    if (flag) {
      flag.rotation.y = Math.atan2(-aw.z, aw.x) + Math.sin(this.time * (6 + aw.length())) * 0.15;
      flag.scale.y = 1 + Math.sin(this.time * 11) * 0.08;
    }
  }
}

const _w = new THREE.Vector3();
