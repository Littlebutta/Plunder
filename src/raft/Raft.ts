import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { addOutline, toonMaterial } from '../render/toon';
import { FloatingBody, HullSpec } from '../physics/FloatingBody';
import { WaveField } from '../ocean/waves';

/** Raft footprint (body space): x = beam, z = length, forward = -Z. */
const BEAM = 2.6;
const LENGTH = 3.6;
const LOG_R = 0.26;

export const RAFT_HULL: HullSpec = {
  mass: 420,
  size: new THREE.Vector3(BEAM, 0.8, LENGTH),
  probes: (() => {
    const pts: THREE.Vector3[] = [];
    for (const x of [-1.05, 0, 1.05]) for (const z of [-1.6, -0.8, 0, 0.8, 1.6]) pts.push(new THREE.Vector3(x, -LOG_R, z));
    return pts;
  })(),
  probeMaxDepth: 0.8,
  restDraft: 0.22,
  heaveDamping: 260,
  dragForward: { linear: 60, quadratic: 34 },
  dragLateral: { linear: 600, quadratic: 420 },
  yawDamping: 4000,
  tiltDamping: 180,
};

/** Tunables for the "sail" (really a simple throttle until wind arrives). */
export const RAFT_DRIVE = {
  maxThrust: 1500, // N at full sail -> ~6 m/s top speed with the drag above
  reverseThrust: 350, // N when paddling backwards
  steerTorque: 1000, // N·m at full rudder
  steerSpeedGain: 0.25, // extra steering per m/s of forward speed
  sailRate: 0.6, // sail fraction per second when raising/lowering
};

/**
 * The player's starting craft: a lashed-log raft with a single square sail.
 * Visual group is driven by a `FloatingBody` for physics.
 */
export class Raft {
  readonly group = new THREE.Group();
  readonly body: FloatingBody;

  /** 0 = furled, 1 = full sail. Negative = paddling backwards. */
  sail = 0;
  rudder = 0;

  private readonly sailMesh: THREE.Mesh;
  private readonly sailPivot = new THREE.Group();
  private readonly flag: THREE.Mesh;
  private readonly tiller: THREE.Group;
  private time = 0;

  constructor(waves: WaveField) {
    this.group.name = 'raft';
    this.body = new FloatingBody(RAFT_HULL, waves);

    const wood = toonMaterial(PALETTE.wood);
    const woodDark = toonMaterial(PALETTE.woodDark);
    const woodLight = toonMaterial(PALETTE.woodLight);
    const rope = toonMaterial(PALETTE.rope);

    // Logs: slightly uneven lengths/radii for a hand-made look.
    const logCount = 5;
    for (let i = 0; i < logCount; i++) {
      const x = (i / (logCount - 1) - 0.5) * (BEAM - LOG_R * 2);
      const len = LENGTH + (i % 2 === 0 ? 0.15 : -0.1) + (i === 2 ? 0.25 : 0);
      const r = LOG_R * (0.92 + ((i * 37) % 10) / 60);
      const geo = new THREE.CylinderGeometry(r, r, len, 10, 1);
      geo.rotateX(Math.PI / 2);
      const log = this.addPart(new THREE.Mesh(geo, i % 2 ? wood : woodLight), 0.035);
      log.position.set(x, 0, (i % 2 ? 0.05 : -0.05));
      // Rounded log ends
      for (const end of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.7, 10), woodDark);
        cap.position.set(x, 0, log.position.z + end * (len / 2 + 0.001));
        cap.rotation.y = end > 0 ? 0 : Math.PI;
        this.group.add(cap);
      }
    }

    // Cross beams + rope lashings
    for (const z of [-1.2, 0.2, 1.3]) {
      const beam = this.addPart(new THREE.Mesh(new THREE.BoxGeometry(BEAM + 0.2, 0.12, 0.26), woodDark), 0.03);
      beam.position.set(0, LOG_R + 0.04, z);
      for (const x of [-1, 1]) {
        const lash = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 6, 12), rope);
        lash.position.set(x * (BEAM / 2 - 0.15), LOG_R - 0.02, z);
        lash.rotation.y = Math.PI / 2;
        this.group.add(lash);
      }
    }

    // Mast, yard and boom
    const mastH = 3.6;
    const mast = this.addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, mastH, 8), woodDark), 0.03);
    mast.position.set(0, LOG_R + mastH / 2, -0.25);

    this.sailPivot.position.set(0, LOG_R + mastH - 0.25, -0.25 + 0.12);
    this.group.add(this.sailPivot);
    const yard = this.addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), woodDark), 0.025);
    yard.rotation.z = Math.PI / 2;
    this.sailPivot.add(yard);

    // Sail: subdivided plane, billowed forward in the vertex data.
    const sailW = 2.3;
    const sailH = 2.5;
    const sailGeo = new THREE.PlaneGeometry(sailW, sailH, 10, 10);
    const pos = sailGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / (sailW / 2);
      const v = pos.getY(i) / (sailH / 2);
      pos.setZ(i, -0.45 * (1 - u * u) * (1 - v * v * 0.6));
    }
    sailGeo.translate(0, -sailH / 2, 0);
    sailGeo.computeVertexNormals();
    this.sailMesh = new THREE.Mesh(sailGeo, toonMaterial(PALETTE.sail, { side: THREE.DoubleSide }));
    this.sailMesh.castShadow = true;
    this.sailPivot.add(this.sailMesh);

    // Pennant on top of the mast
    const flagGeo = new THREE.PlaneGeometry(0.7, 0.3, 6, 1);
    flagGeo.translate(0.35, 0, 0);
    this.flag = new THREE.Mesh(flagGeo, toonMaterial(PALETTE.flag, { side: THREE.DoubleSide }));
    this.flag.position.set(0, LOG_R + mastH + 0.05, -0.25);
    this.group.add(this.flag);

    // Cargo: a crate and a barrel for scale and charm
    const crate = this.addPart(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), woodLight), 0.03);
    crate.position.set(-0.7, LOG_R + 0.35, 0.95);
    crate.rotation.y = 0.3;
    const barrel = this.addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.6, 12), wood), 0.03);
    barrel.position.set(0.75, LOG_R + 0.4, 0.75);
    for (const y of [-0.18, 0.18]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.255, 0.025, 4, 16), woodDark);
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = y;
      barrel.add(hoop);
    }

    // Steering oar at the stern
    this.tiller = new THREE.Group();
    this.tiller.position.set(0, LOG_R + 0.15, LENGTH / 2 + 0.1);
    this.group.add(this.tiller);
    // Oar shaft runs from a handle over the deck, back and down into the water.
    const oarDir = new THREE.Vector3(0, -0.42, 0.91).normalize();
    const oarTilt = Math.atan2(oarDir.z, oarDir.y); // rotates the cylinder's +Y onto oarDir
    const oar = this.addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6), woodDark), 0.02, this.tiller);
    oar.rotation.x = oarTilt;
    oar.position.copy(oarDir).multiplyScalar(0.6);
    const blade = this.addPart(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.28), woodLight), 0.02, this.tiller);
    blade.rotation.x = oarTilt;
    blade.position.copy(oarDir).multiplyScalar(1.65);

    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.name.endsWith('-outline')) o.castShadow = true;
    });
  }

  private addPart(mesh: THREE.Mesh, outline: number, parent: THREE.Object3D = this.group): THREE.Mesh {
    parent.add(mesh);
    addOutline(mesh, outline, PALETTE.outline);
    return mesh;
  }

  // Input axes: throttle -1..1 (S/W) raises/lowers the sail, steer -1..1 (A/D).
  /** Per-frame: read player input into sail / rudder state. */
  control(dt: number, throttleInput: number, steerInput: number): void {
    this.sail = THREE.MathUtils.clamp(this.sail + throttleInput * RAFT_DRIVE.sailRate * dt, -0.4, 1);
    this.rudder = THREE.MathUtils.damp(this.rudder, steerInput, 6, dt);
  }

  /** Fixed-step: turn sail / rudder into forces and integrate. */
  physicsStep(h: number): void {
    const b = this.body;
    b.thrust = this.sail >= 0 ? this.sail * RAFT_DRIVE.maxThrust : (this.sail / 0.4) * RAFT_DRIVE.reverseThrust;
    const speed = b.forwardSpeed;
    const gain = 1 + RAFT_DRIVE.steerSpeedGain * Math.abs(speed);
    // Steering reverses when moving backwards, like a real rudder.
    b.yawTorque = -this.rudder * RAFT_DRIVE.steerTorque * gain * (speed < -0.2 ? -1 : 1);
    b.step(h);
  }

  /** Per-frame: copy physics state to the visuals and animate rigging. */
  syncVisuals(dt: number): void {
    this.time += dt;
    const b = this.body;
    this.group.position.copy(b.position);
    this.group.quaternion.copy(b.quaternion);

    // Visuals: sail furls upward; flag flutters; oar swings with the rudder.
    const unfurl = Math.max(this.sail, 0);
    this.sailMesh.scale.y = THREE.MathUtils.lerp(0.08, 1, unfurl);
    this.sailMesh.scale.z = THREE.MathUtils.lerp(0.2, 1, unfurl);
    this.sailPivot.rotation.y = this.rudder * 0.25;
    this.tiller.rotation.y = -this.rudder * 0.5; // stern swings opposite to the turn
    this.flag.rotation.y = -Math.PI / 2 + Math.sin(this.time * 6) * 0.25 + this.rudder * 0.3;
    this.flag.scale.y = 1 + Math.sin(this.time * 11) * 0.08;
  }
}
