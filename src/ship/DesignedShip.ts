import * as THREE from 'three';
import { WaveField } from '../ocean/waves';
import { PALETTE } from '../render/palette';
import { sailTint, setToonColour } from '../render/toon';
import { Wind } from '../world/Wind';
import { computeStats, designToDrive, designToHullSpec, HullDesign, rigBoost, ShipStats } from './HullDesign';
import { buildShipVisual, ShipVisual } from './ShipVisual';
import { Vessel } from './Vessel';

/** A ship built from a shipyard design: lofted hull, derived physics and handling. */
export class DesignedShip extends Vessel {
  readonly swivelMount: THREE.Vector3;
  override readonly swivelFacing: number;
  readonly gunMounts: THREE.Vector3[];
  readonly length: number;
  readonly holdCapacity: number;
  readonly displayName: string;
  readonly stats: ShipStats;

  private readonly visual: ShipVisual;
  private time = 0;
  /** Which side the fore-and-aft sails are bellied out to (-1 / 1), eased. */
  private lee = 1;

  constructor(
    readonly design: HullDesign,
    waves: WaveField,
    wind: Wind,
    colour: THREE.ColorRepresentation = PALETTE.sail,
  ) {
    const stats = computeStats(design);
    const hull = designToHullSpec(design, stats);
    super(hull, designToDrive(design, hull, stats), waves, wind);
    this.stats = stats;
    this.visual = buildShipVisual(design, colour);
    this.group.add(this.visual.group);
    this.group.name = 'designed-ship';
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

  setColour(colour: THREE.ColorRepresentation): void {
    setToonColour(this.visual.sailMaterial, sailTint(colour));
    setToonColour(this.visual.flagMaterial, colour);
  }

  syncVisuals(dt: number): void {
    this.time += dt;
    const b = this.body;
    this.group.position.copy(b.position);
    this.group.quaternion.copy(b.quaternion);

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
