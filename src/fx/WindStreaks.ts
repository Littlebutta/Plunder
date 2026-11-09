import * as THREE from 'three';
import { Wind } from '../world/Wind';

const SEGMENTS = 18;

interface Streak {
  origin: THREE.Vector3;
  age: number;
  life: number;
  length: number;
  curl: number;
  phase: number;
}

/**
 * Curly white wind lines drifting past the camera: the storybook way to show
 * which way the wind blows. Each streak is a thin ribbon that "draws itself"
 * in and out along a looping path that travels downwind.
 */
export class WindStreaks {
  readonly mesh: THREE.Mesh;
  private readonly streaks: Streak[] = [];
  private readonly positions: Float32Array;
  private readonly alpha: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();

  constructor(
    private readonly wind: Wind,
    count = 14,
  ) {
    const vertsPer = (SEGMENTS + 1) * 2;
    this.positions = new Float32Array(count * vertsPer * 3);
    this.alpha = new Float32Array(count * vertsPer);
    const idx: number[] = [];
    for (let s = 0; s < count; s++) {
      const base = s * vertsPer;
      for (let i = 0; i < SEGMENTS; i++) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      this.streaks.push({ origin: new THREE.Vector3(), age: 0, life: 1, length: 1, curl: 0, phase: 0 });
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(idx);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          attribute float alpha;
          varying float vAlpha;
          void main() { vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          varying float vAlpha;
          void main() { if (vAlpha < 0.02) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha * 0.7); }
        `,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.name = 'wind-streaks';
    this.streaks.forEach((s) => (s.age = Math.random() * 3)); // stagger
  }

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    const dir = this.wind.direction;
    const side = _side.set(-dir.z, 0, dir.x);
    const camRight = _right.setFromMatrixColumn(camera.matrixWorld, 0);
    const vertsPer = (SEGMENTS + 1) * 2;
    const speed = 4 + this.wind.strength * 8;

    this.streaks.forEach((s, si) => {
      s.age += dt;
      if (s.age >= s.life) this.respawn(s, focus);
      const t = s.age / s.life;
      // head moves along; the visible window [tail, head] grows then shrinks
      const head = Math.min(1, t * 1.6);
      const tail = Math.max(0, t * 1.6 - 0.6);
      const strengthFade = THREE.MathUtils.clamp(this.wind.strength * 1.4, 0, 1);
      const base = si * vertsPer;
      for (let i = 0; i <= SEGMENTS; i++) {
        const u = tail + (head - tail) * (i / SEGMENTS);
        const along = u * s.length;
        // a single loop-the-loop in the middle of the path
        const loop = Math.exp(-Math.pow((u - 0.55) * 5, 2));
        const ang = s.phase + u * Math.PI * 2 * s.curl;
        const p = _p
          .copy(s.origin)
          .addScaledVector(dir, along + Math.sin(ang) * loop * 0.6 + s.age * speed * 0.3)
          .addScaledVector(side, Math.sin(u * 7 + s.phase) * 0.3)
          .add(_up.set(0, (Math.cos(ang) - 1) * loop * 0.6, 0));
        const w = 0.03 * Math.sin(Math.PI * (i / SEGMENTS));
        const a = Math.sin(Math.PI * (i / SEGMENTS)) * Math.sin(Math.PI * t) * strengthFade;
        for (let k = 0; k < 2; k++) {
          const v = base + i * 2 + k;
          const sign = k === 0 ? -1 : 1;
          this.positions[v * 3] = p.x + camRight.x * w * sign;
          this.positions[v * 3 + 1] = p.y + w * sign * 0.5;
          this.positions[v * 3 + 2] = p.z + camRight.z * w * sign;
          this.alpha[v] = a;
        }
      }
    });
    this.geometry.attributes.position.needsUpdate = true;
    (this.geometry.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }

  private respawn(s: Streak, focus: THREE.Vector3): void {
    const dir = this.wind.direction;
    const r = 10 + Math.random() * 30;
    const a = Math.random() * Math.PI * 2;
    s.origin.set(focus.x + Math.cos(a) * r, focus.y + 1.5 + Math.random() * 7, focus.z + Math.sin(a) * r);
    s.origin.addScaledVector(dir, -6); // start upwind so it drifts through view
    s.age = 0;
    s.life = 2.2 + Math.random() * 1.8;
    s.length = 3 + Math.random() * 4;
    s.curl = Math.random() < 0.5 ? 1 : 0;
    s.phase = Math.random() * Math.PI * 2;
  }
}

const _side = new THREE.Vector3();
const _right = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
