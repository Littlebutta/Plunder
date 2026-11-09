import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { toonMaterial } from '../render/toon';
import { mulberry32 } from '../util/random';
import type { AtmosphereState } from '../weather/Atmosphere';

/**
 * Gradient sky dome with a soft sun, a moon and stars, plus puffy cel-shaded
 * cloud clusters drifting on a ring around the player. Everything follows the
 * camera so the sky is always "at infinity". Colours are driven each frame by
 * the day-night cycle and weather through `applyAtmosphere`.
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly clouds = new THREE.Group();
  private readonly cloudMat: THREE.MeshToonMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(sunDir: THREE.Vector3, moonDir: THREE.Vector3 = new THREE.Vector3(0, -1, 0)) {
    this.group.name = 'sky';
    this.uniforms = {
      uTop: { value: new THREE.Color(PALETTE.skyTop) },
      uMid: { value: new THREE.Color(PALETTE.skyMid) },
      uHorizon: { value: new THREE.Color(PALETTE.horizon) },
      uSun: { value: new THREE.Color(PALETTE.sunGlow) },
      uSunDir: { value: sunDir },
      uMoonDir: { value: moonDir },
      uSunVis: { value: 1 },
      uMoonVis: { value: 0 },
      uStars: { value: 0 },
      uFogColor: { value: new THREE.Color(PALETTE.horizon) },
      uFogMix: { value: 0 },
      uFlash: { value: 0 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww; // pin to far plane
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uMid, uHorizon, uSun, uSunDir, uMoonDir, uFogColor;
          uniform float uSunVis, uMoonVis, uStars, uFogMix, uFlash;
          varying vec3 vDir;

          float hash3(vec3 p) {
            p = fract(p * vec3(443.897, 441.423, 437.195));
            p += dot(p, p.yzx + 19.19);
            return fract((p.x + p.y) * p.z);
          }

          void main() {
            vec3 d = normalize(vDir);
            float y = max(d.y, 0.0);
            vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, y));
            col = mix(col, uTop, smoothstep(0.18, 0.75, y));

            // Stars: one candidate per cell of a grid on the sphere, twinkle-free
            // so they read as a printed backdrop. Fade toward the horizon.
            if (uStars > 0.001) {
              vec3 p = d * 160.0;
              vec3 cell = floor(p);
              float h = hash3(cell);
              vec3 c = cell + 0.5 + (vec3(hash3(cell + 1.7), hash3(cell + 3.1), hash3(cell + 5.3)) - 0.5) * 0.6;
              float star = smoothstep(0.16, 0.04, length(p - c)) * step(0.93, h);
              col += vec3(0.95, 0.95, 1.0) * star * uStars * smoothstep(0.02, 0.25, y) * (0.5 + 0.5 * fract(h * 37.0));
            }

            float s = max(dot(d, normalize(uSunDir)), 0.0);
            col = mix(col, uSun, pow(s, 12.0) * 0.55 * max(uSunVis, 0.35));            // warm glow
            col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.9975, 0.998, s) * uSunVis); // disc

            // Moon: pale disc with a soft halo and a couple of darker seas.
            float m = max(dot(d, normalize(uMoonDir)), 0.0);
            col += vec3(0.35, 0.42, 0.6) * pow(m, 60.0) * 0.4 * uMoonVis;
            float disc = smoothstep(0.99935, 0.9995, m);
            vec3 seas = vec3(1.0) - 0.12 * step(0.5, hash3(floor(d * 900.0)));
            col = mix(col, vec3(0.93, 0.95, 1.0) * seas, disc * uMoonVis);

            col = mix(col, uFogColor, uFogMix * (1.0 - smoothstep(0.35, 1.0, y) * 0.25));
            col += vec3(0.75, 0.8, 1.0) * uFlash;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    this.group.add(dome);

    this.cloudMat = toonMaterial(PALETTE.cloud, { emissive: 0x9fc6e6, emissiveIntensity: 0.35, fog: false });
    this.buildClouds();
    this.group.add(this.clouds);
  }

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.group.position.set(cameraPos.x, 0, cameraPos.z);
    this.clouds.rotation.y += dt * 0.004;
  }

  /** Push this frame's day-night + weather colours into the dome and clouds. */
  applyAtmosphere(a: AtmosphereState): void {
    const u = this.uniforms;
    (u.uTop.value as THREE.Color).copy(a.skyTop);
    (u.uMid.value as THREE.Color).copy(a.skyMid);
    (u.uHorizon.value as THREE.Color).copy(a.horizon);
    (u.uSun.value as THREE.Color).copy(a.sunGlow);
    (u.uFogColor.value as THREE.Color).copy(a.fogColor);
    u.uSunVis.value = a.sunVis;
    u.uMoonVis.value = a.moonVis;
    u.uStars.value = a.stars;
    u.uFogMix.value = a.skyFog;
    u.uFlash.value = a.flash;
    // Clouds take the sky's mood and melt into thick fog.
    this.cloudMat.color.copy(a.cloudColor).lerp(a.fogColor, a.skyFog);
    this.cloudMat.emissive.copy(a.cloudGlow).lerp(a.fogColor, a.skyFog);
    this.cloudMat.emissiveIntensity = 0.35 + a.flash * 2;
    this.clouds.visible = a.skyFog < 0.97;
  }

  private buildClouds(): void {
    const mat = this.cloudMat;
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
