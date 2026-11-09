import * as THREE from 'three';
import { WORLD_RADIUS } from './worldConfig';

/**
 * The end of the world: the sea pours over the rim of the map in a waterfall
 * that falls away into nothing.
 *
 * The ocean shader stops drawing at WORLD_RADIUS (see oceanMaterial.ts); this
 * adds the sheet of falling water below the rim and a band of spray above it.
 * Colours are passed in as the ocean's own uniforms so the fall darkens with
 * the night and the weather like the sea does.
 */
export class WorldEdge {
  readonly group = new THREE.Group();
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(ocean: { uMid: THREE.IUniform; uFoam: THREE.IUniform; uHorizon: THREE.IUniform; uLight: THREE.IUniform }) {
    this.group.name = 'world-edge';
    this.uniforms = {
      uTime: { value: 0 },
      uWater: ocean.uMid,
      uFoam: ocean.uFoam,
      uVoid: ocean.uHorizon,
      uLight: ocean.uLight,
    };
    const DEPTH = 420;
    const fall = new THREE.Mesh(
      new THREE.CylinderGeometry(WORLD_RADIUS, WORLD_RADIUS, DEPTH, 256, 1, true),
      new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uWater, uFoam, uVoid, uLight;
          varying vec2 vUv;
          float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
          void main() {
            float depth = 1.0 - vUv.y;                 // 0 at the rim, 1 at the bottom
            // ropes of white water, each column falling at its own speed
            float col = floor(vUv.x * 3600.0);
            float speed = 0.5 + hash(col) * 0.7;
            float streak = fract(depth * (3.0 + hash(col + 7.0) * 3.0) - uTime * speed + hash(col + 3.0));
            float rope = smoothstep(0.55, 1.0, streak) * step(0.35, hash(col + 11.0));
            // broad slow bands so it does not read as a barcode from far off
            float band = 0.5 + 0.5 * sin(vUv.x * 700.0 + sin(depth * 9.0 - uTime * 0.8) * 1.5);
            vec3 c = mix(uWater, uFoam, clamp(rope * 0.8 + band * 0.18 + (1.0 - smoothstep(0.0, 0.03, depth)) * 0.9, 0.0, 1.0));
            c *= uLight;
            // the fall thins out and is swallowed by the void
            c = mix(c, uVoid * uLight, smoothstep(0.15, 0.85, depth));
            float a = 1.0 - smoothstep(0.35, 1.0, depth);
            gl_FragColor = vec4(c, a);
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    fall.position.y = -DEPTH / 2 + 0.6;
    fall.renderOrder = 3;
    fall.frustumCulled = false;
    this.group.add(fall);

    // Spray hanging over the rim.
    const MIST = 26;
    const mist = new THREE.Mesh(
      new THREE.CylinderGeometry(WORLD_RADIUS + 6, WORLD_RADIUS + 1, MIST, 256, 1, true),
      new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uFoam, uLight;
          varying vec2 vUv;
          void main() {
            float puff = 0.6 + 0.4 * sin(vUv.x * 700.0 + uTime * 0.7) * sin(vUv.x * 263.0 - uTime * 0.4);
            float a = (1.0 - vUv.y) * (1.0 - vUv.y) * 0.5 * puff;
            gl_FragColor = vec4(uFoam * uLight, a);
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    mist.position.y = MIST / 2 - 1;
    mist.renderOrder = 4;
    mist.frustumCulled = false;
    this.group.add(mist);
  }

  update(dt: number): void {
    this.uniforms.uTime.value += dt;
  }
}
