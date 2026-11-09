import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { toonMaterial } from '../render/toon';
import { mulberry32 } from '../util/random';

/**
 * Gradient sky dome with a soft sun, plus puffy cel-shaded cloud clusters
 * drifting on a ring around the player. Everything follows the camera so the
 * sky is always "at infinity".
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly clouds = new THREE.Group();

  constructor(sunDir: THREE.Vector3) {
    this.group.name = 'sky';
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(PALETTE.skyTop) },
          uMid: { value: new THREE.Color(PALETTE.skyMid) },
          uHorizon: { value: new THREE.Color(PALETTE.horizon) },
          uSun: { value: new THREE.Color(PALETTE.sunGlow) },
          uSunDir: { value: sunDir },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww; // pin to far plane
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uMid, uHorizon, uSun, uSunDir;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float y = max(d.y, 0.0);
            vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, y));
            col = mix(col, uTop, smoothstep(0.18, 0.75, y));
            float s = max(dot(d, normalize(uSunDir)), 0.0);
            col = mix(col, uSun, pow(s, 12.0) * 0.55);       // warm glow
            col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.9975, 0.998, s)); // disc
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    this.group.add(dome);

    this.buildClouds();
    this.group.add(this.clouds);
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.group.position.set(cameraPos.x, 0, cameraPos.z);
    this.clouds.rotation.y += dt * 0.004;
  }

  private buildClouds(): void {
    const mat = toonMaterial(PALETTE.cloud, { emissive: 0x9fc6e6, emissiveIntensity: 0.35, fog: false });
    const puff = new THREE.IcosahedronGeometry(1, 3);
    const rand = mulberry32(7);
    const count = 22;
    for (let i = 0; i < count; i++) {
      const cluster = new THREE.Group();
      const angle = (i / count) * Math.PI * 2 + rand() * 0.2;
      const dist = 1100 + rand() * 700;
      cluster.position.set(Math.cos(angle) * dist, 70 + rand() * 160, Math.sin(angle) * dist);
      const puffs = 5 + Math.floor(rand() * 5);
      const width = 50 + rand() * 70;
      for (let p = 0; p < puffs; p++) {
        const m = new THREE.Mesh(puff, mat);
        const t = p / (puffs - 1) - 0.5;
        const r = (1 - Math.abs(t) * 1.2) * (18 + rand() * 16) + 8;
        m.scale.set(r, r * 0.8, r);
        m.position.set(t * width * 2, r * 0.3 + rand() * 6, (rand() - 0.5) * 20);
        cluster.add(m);
      }
      cluster.lookAt(0, cluster.position.y, 0);
      this.clouds.add(cluster);
    }
  }
}

