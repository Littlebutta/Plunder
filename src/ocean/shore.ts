/**
 * World-space terrain height map shared by everything that needs to know
 * where the land is: the wave model calms the sea in shallow water (CPU and
 * GPU), the ocean shader draws the shoreline from it, and the projectile
 * simulation uses it for shells that hit land.
 *
 * Plain data, no DOM and no Three.js, so it can be posted to a worker.
 */
export interface ShoreData {
  /** Samples per side. */
  size: number;
  /** World metres covered per side, centred on the origin. */
  extent: number;
  /** Terrain height in metres (negative = under water), row-major, z then x. */
  heights: Float32Array;
}

/** Height stored where there is no land at all. */
export const SHORE_DEEP = -30;
/** Waves reach full height where the water is at least this deep (m). */
export const SHORE_FULL_DEPTH = 7;
/** Fraction of wave height left at the waterline. */
export const SHORE_MIN_WAVE = 0.1;
/** Range of heights packed into the 8-bit GPU texture. */
export const SHORE_TEX_MIN = -8;
export const SHORE_TEX_RANGE = 10;

export class ShoreField implements ShoreData {
  readonly heights: Float32Array;

  constructor(
    readonly size = 1024,
    readonly extent = 1536,
    heights?: Float32Array,
  ) {
    this.heights = heights ?? new Float32Array(size * size).fill(SHORE_DEEP);
  }

  static from(data: ShoreData): ShoreField {
    return new ShoreField(data.size, data.extent, data.heights);
  }

  /** Metres per sample. */
  get cell(): number {
    return this.extent / this.size;
  }

  /**
   * Stamp a piece of terrain into the map. `height(x, z)` is in the terrain's
   * own space, centred on (cx, cz); only samples within `radius` are visited.
   */
  stamp(cx: number, cz: number, radius: number, height: (x: number, z: number) => number): void {
    const { size, extent, heights } = this;
    const cell = this.cell;
    const toIndex = (w: number) => (w + extent / 2) / cell - 0.5;
    const i0 = Math.max(0, Math.floor(toIndex(cx - radius)));
    const i1 = Math.min(size - 1, Math.ceil(toIndex(cx + radius)));
    const j0 = Math.max(0, Math.floor(toIndex(cz - radius)));
    const j1 = Math.min(size - 1, Math.ceil(toIndex(cz + radius)));
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * cell - extent / 2 - cz;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell - extent / 2 - cx;
        if (x * x + z * z > radius * radius) continue;
        const h = height(x, z);
        const o = j * size + i;
        if (h > heights[o]) heights[o] = h;
      }
    }
  }

  /** Terrain height at world (x, z), bilinear; deep water outside the map. */
  heightAt(x: number, z: number): number {
    const { size, extent, heights } = this;
    const fx = ((x + extent / 2) / extent) * size - 0.5;
    const fz = ((z + extent / 2) / extent) * size - 0.5;
    if (fx < 0 || fz < 0 || fx > size - 1 || fz > size - 1) return SHORE_DEEP;
    const i = Math.min(size - 2, Math.floor(fx));
    const j = Math.min(size - 2, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const o = j * size + i;
    const a = heights[o];
    const b = heights[o + 1];
    const c = heights[o + size];
    const d = heights[o + size + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Wave height multiplier at world (x, z): 1 in open water, small at the beach. */
  waveScale(x: number, z: number): number {
    return shoreWaveScale(this.heightAt(x, z));
  }

  /** 8-bit copy for the GPU (see SHORE_TEX_MIN / SHORE_TEX_RANGE). */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.heights.length);
    for (let i = 0; i < out.length; i++) {
      const t = (this.heights[i] - SHORE_TEX_MIN) / SHORE_TEX_RANGE;
      out[i] = Math.round(Math.min(1, Math.max(0, t)) * 255);
    }
    return out;
  }
}

/** Same curve as `shoreScale()` in the ocean shader. */
export function shoreWaveScale(terrainHeight: number): number {
  const t = Math.min(1, Math.max(0, -terrainHeight / SHORE_FULL_DEPTH));
  return SHORE_MIN_WAVE + (1 - SHORE_MIN_WAVE) * t * t * (3 - 2 * t);
}
