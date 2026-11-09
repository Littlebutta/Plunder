import * as THREE from 'three';
import { WaveField } from '../ocean/waves';
import { Wind } from '../world/Wind';
import { computeStats, designToDrive, designToHullSpec, HullDesign, ShipStats } from './HullDesign';
import { buildShipVisual, ShipVisual } from './ShipVisual';
import { Vessel } from './Vessel';

/** A ship built from a shipyard design: lofted hull, derived physics and handling. */
export class DesignedShip extends Vessel {
  readonly bowMount: THREE.Vector3;
  readonly gunMounts: THREE.Vector3[];
  readonly length: number;
  readonly holdCapacity: number;
  readonly displayName: string;
  readonly stats: ShipStats;

  private readonly visual: ShipVisual;
  private time = 0;

  constructor(
    readonly design: HullDesign,
    waves: WaveField,
    wind: Wind,
  ) {
    const stats = computeStats(design);
    const hull = designToHullSpec(design, stats);
    super(hull, designToDrive(design, hull, stats), waves, wind);
    this.stats = stats;
    this.visual = buildShipVisual(design);
    this.group.add(this.visual.group);
    this.group.name = 'designed-ship';
    this.bowMount = this.visual.bowMount;
    this.gunMounts = this.visual.gunMounts;
    this.length = design.length;
    this.holdCapacity = stats.hold;
    this.displayName = design.name;
  }

  syncVisuals(dt: number): void {
    this.time += dt;
    const b = this.body;
    this.group.position.copy(b.position);
    this.group.quaternion.copy(b.quaternion);

    const unfurl = Math.max(this.sail, 0);
    for (const s of this.visual.sails) {
      s.mesh.scale.y = THREE.MathUtils.lerp(0.08, 1, unfurl);
      s.mesh.scale.z = THREE.MathUtils.lerp(0.2, 1, unfurl);
      s.pivot.rotation.y = this.trim;
    }
    this.visual.rudder.rotation.y = -this.rudder * 0.5;
    const flag = this.visual.flag;
    if (flag) {
      const aw = this.apparentLocal;
      flag.rotation.y = Math.atan2(-aw.z, aw.x) + Math.sin(this.time * (6 + aw.length())) * 0.15;
      flag.scale.y = 1 + Math.sin(this.time * 11) * 0.08;
    }
  }
}
