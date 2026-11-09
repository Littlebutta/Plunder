/** Small seeded 2D value noise + fbm/ridged helpers for terrain generation. */
export class Noise2D {
  private readonly perm: Uint8Array;

  constructor(rand: () => number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private hash(x: number, y: number): number {
    return this.perm[(this.perm[x & 255] + y) & 511] / 255;
  }

  /** 0..1 */
  value(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = this.hash(xi, yi);
    const b = this.hash(xi + 1, yi);
    const c = this.hash(xi, yi + 1);
    const d = this.hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** 0..~1 fractal noise */
  fbm(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value(x, y);
      norm += amp;
      x = x * 2.03 + 17.3;
      y = y * 2.03 + 9.1;
      amp *= 0.5;
    }
    return sum / norm;
  }

  /** 0..1 ridged noise: sharp crests, good for mountain ridges. */
  ridged(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.value(x, y) * 2 - 1);
      sum += amp * n * n;
      norm += amp;
      x = x * 2.1 + 3.7;
      y = y * 2.1 + 11.9;
      amp *= 0.5;
    }
    return sum / norm;
  }
}
