import * as THREE from 'three';
import { WaveField } from '../ocean/waves';

interface WakePoint {
  x: number;
  z: number;
  /** unit side vector at emission */
  sx: number;
  sz: number;
  age: number;
  width: number;
  strength: number;
}

/**
 * Foam wake: a ribbon laid on the water behind a hull, drawn as two white
 * diverging lines with broken foam between them (the classic cartoon wake).
 * The ribbon's vertices re-sample the wave height every frame, so it rides
 * the swell instead of floating through it.
 */
export class Wake {
  readonly mesh: THREE.Mesh;
  private readonly points: WakePoint[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly fade: Float32Array;
  private emitTimer = 0;

  constructor(
    private readonly waves: WaveField,
    private readonly maxPoints = 64,
    private readonly life = 7,
    private readonly baseWidth = 1.6,
  ) {
    const verts = maxPoints * 2;
    this.positions = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    this.fade = new Float32Array(verts);
    const idx: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('fade', new THREE.BufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(idx);
    this.geometry.setDrawRange(0, 0);

    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        uniforms: { uTime: { value: 0 } },
        vertexShader: /* glsl */ `
          attribute float fade;
          varying vec2 vUv;
          varying float vFade;
          varying vec2 vWorld;
          void main() {
            vUv = uv;
            vFade = fade;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          varying float vFade;
          varying vec2 vWorld;
          float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
          float noise(vec2 p) {
            vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
          }
          void main() {
            float edge = min(vUv.x, 1.0 - vUv.x);           // 0 at the rims, 0.5 in the middle
            float rim = 1.0 - smoothstep(0.03, 0.07, edge);  // two crisp outer lines
            float n = noise(vWorld * 1.6 + uTime * 0.2);
            float inner = step(0.62 + vUv.y * 0.3, n) * (1.0 - smoothstep(0.2, 0.5, edge) * 0.4);
            float foam = max(rim, inner);
            // dissolve with age: noise eats the foam away
            float alive = step(n * 0.6 + 0.2, vFade);
            float a = foam * alive;
            if (a < 0.5) discard;
            gl_FragColor = vec4(vec3(0.96, 0.99, 1.0), 0.92);
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.name = 'wake';
  }

  /**
   * @param stern world position of the stern at the waterline
   * @param side world unit vector pointing to starboard
   * @param speed forward speed (m/s); wake only forms above a crawl
   */
  update(dt: number, stern: THREE.Vector3, side: THREE.Vector3, speed: number): void {
    for (const p of this.points) p.age += dt;
    while (this.points.length && this.points[0].age > this.life) this.points.shift();

    this.emitTimer -= dt;
    const strength = THREE.MathUtils.clamp((Math.abs(speed) - 0.5) / 3, 0, 1);
    if (this.emitTimer <= 0) {
      this.emitTimer = 0.11;
      if (strength > 0 || this.points.length) {
        if (this.points.length >= this.maxPoints) this.points.shift();
        this.points.push({ x: stern.x, z: stern.z, sx: side.x, sz: side.z, age: 0, width: this.baseWidth * 0.5, strength });
      }
    } else if (this.points.length) {
      // keep the newest point glued to the stern so the wake starts at the hull
      const last = this.points[this.points.length - 1];
      last.x = stern.x;
      last.z = stern.z;
      last.sx = side.x;
      last.sz = side.z;
      last.strength = strength;
    }

    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const t = p.age / this.life;
      const half = p.width + t * this.baseWidth * 2.2; // spreads as it ages
      const fade = p.strength * (1 - t);
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const x = p.x + p.sx * half * sign;
        const z = p.z + p.sz * half * sign;
        const v = i * 2 + s;
        this.positions[v * 3] = x;
        this.positions[v * 3 + 1] = this.waves.heightAt(x, z) + 0.06;
        this.positions[v * 3 + 2] = z;
        this.uvs[v * 2] = s;
        this.uvs[v * 2 + 1] = t;
        this.fade[v] = fade;
      }
    }
    this.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    (this.geometry.attributes.fade as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value += dt;
  }
}
