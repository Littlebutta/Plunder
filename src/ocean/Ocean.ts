import * as THREE from 'three';
import { WaveField } from './waves';
import { createOceanMaterial } from './oceanMaterial';
import { ShoreField } from './shore';
import { OCEAN_ORDER } from '../render/waterMask';

/** Fraction of linear spacing in the grid mapping; lower = denser centre. */
const LINEAR = 0.04;

/**
 * Large ocean surface that follows the camera focus.
 *
 * The grid is denser near its centre (vertex spacing grows cubically
 * outwards), giving fine wave detail around the ship and cheap distant water
 * out to the horizon in a single draw call.
 */
export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  /** Snap step for re-centering; keeps vertices from "swimming". */
  private readonly snap: number;

  constructor(
    readonly waves: WaveField,
    sunDir: THREE.Vector3,
    shore: ShoreField | null = null,
    { radius = 2400, segments = 512 } = {},
  ) {
    this.material = createOceanMaterial(waves, sunDir, shore);
    const geometry = Ocean.buildGrid(radius, segments);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false; // vertices move in the shader
    this.mesh.name = 'ocean';
    this.mesh.renderOrder = OCEAN_ORDER; // after the hull lids (see waterMask.ts)
    this.snap = (LINEAR * radius * 2) / segments; // = centre vertex spacing
    this.refreshAmplitude();
  }

  /** Call after wave parameters change so the colour ramp stays calibrated. */
  refreshAmplitude(): void {
    let amp = 0;
    const a = this.waves.uniforms.uWaveA.value;
    for (let i = 0; i < this.waves.uniforms.uWaveCount.value; i++) amp += a[i].w;
    this.material.uniforms.uMaxAmp.value = Math.max(amp * 0.75, 0.05);
  }

  /** Re-centre under `focus` (usually the camera target). */
  update(focus: THREE.Vector3): void {
    const s = this.snap;
    this.mesh.position.set(Math.round(focus.x / s) * s, 0, Math.round(focus.z / s) * s);
    this.material.uniforms.uCenter.value.set(focus.x, focus.z);
  }

  private static buildGrid(radius: number, segments: number): THREE.BufferGeometry {
    const verts = segments + 1;
    const positions = new Float32Array(verts * verts * 3);
    const map = (u: number) => {
      // u in [-1, 1] -> world, spacing grows with |u|
      const a = Math.abs(u);
      return Math.sign(u) * (LINEAR * a + (1 - LINEAR) * a * a * a) * radius;
    };
    let p = 0;
    for (let j = 0; j < verts; j++) {
      const z = map((j / segments) * 2 - 1);
      for (let i = 0; i < verts; i++) {
        const x = map((i / segments) * 2 - 1);
        positions[p++] = x;
        positions[p++] = 0;
        positions[p++] = z;
      }
    }
    const indices = new Uint32Array(segments * segments * 6);
    let k = 0;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices[k++] = a;
        indices[k++] = c;
        indices[k++] = b;
        indices[k++] = b;
        indices[k++] = c;
        indices[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
  }
}
