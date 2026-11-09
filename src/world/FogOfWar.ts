import type { Island } from './Islands';
import { WORLD_RADIUS } from './worldConfig';

/** Cells along each side of the fog grid, which covers the whole world disc. */
export const FOG_N = 128;
const SPAN = WORLD_RADIUS * 2 * 1.06;
const CELL = SPAN / FOG_N;

export interface Lookout {
  x: number;
  z: number;
  /** How far it can see (m). */
  range: number;
}

/**
 * Fog of war, as in an RTS: the map starts unknown, is uncovered for good
 * wherever one of your ships or strongholds has looked, and enemy ships only
 * show while something of yours can see them right now.
 */
export class FogOfWar {
  /** 1 where the player has ever looked. */
  readonly explored = new Uint8Array(FOG_N * FOG_N);
  /** 1 where the player can see right now. */
  readonly visible = new Uint8Array(FOG_N * FOG_N);
  /** Islands the player has found. */
  readonly found = new Set<Island>();
  /** Bumped whenever either grid changes, so the chart knows to repaint its fog. */
  version = 0;
  private timer = 0;
  private lookouts: Lookout[] = [];

  /** Grid cell holding a world point, or -1 off the grid. */
  private cell(x: number, z: number): number {
    const i = Math.floor((x + SPAN / 2) / CELL);
    const j = Math.floor((z + SPAN / 2) / CELL);
    return i < 0 || j < 0 || i >= FOG_N || j >= FOG_N ? -1 : j * FOG_N + i;
  }

  isExplored(x: number, z: number): boolean {
    const c = this.cell(x, z);
    return c >= 0 && this.explored[c] === 1;
  }

  /** True if one of the player's lookouts can see this point right now. */
  canSee(x: number, z: number): boolean {
    return this.lookouts.some((l) => Math.hypot(x - l.x, z - l.z) < l.range);
  }

  /** World-space rectangle the grid covers: [min, size]. */
  static readonly bounds = [-SPAN / 2, SPAN] as const;

  /** Refresh a few times a second from everything of the player's that can see. */
  update(dt: number, lookouts: Lookout[], islands: Island[]): void {
    this.lookouts = lookouts;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.3;
    const before = this.visible.slice();
    this.visible.fill(0);
    let changed = false;
    for (const l of lookouts) {
      const r = Math.ceil(l.range / CELL);
      const ci = Math.floor((l.x + SPAN / 2) / CELL);
      const cj = Math.floor((l.z + SPAN / 2) / CELL);
      for (let j = Math.max(0, cj - r); j <= Math.min(FOG_N - 1, cj + r); j++) {
        for (let i = Math.max(0, ci - r); i <= Math.min(FOG_N - 1, ci + r); i++) {
          const x = (i + 0.5) * CELL - SPAN / 2;
          const z = (j + 0.5) * CELL - SPAN / 2;
          if (Math.hypot(x - l.x, z - l.z) > l.range) continue;
          const c = j * FOG_N + i;
          this.visible[c] = 1;
          if (!this.explored[c]) {
            this.explored[c] = 1;
            changed = true;
          }
        }
      }
      for (const island of islands) {
        if (!this.found.has(island) && Math.hypot(island.center.x - l.x, island.center.z - l.z) < l.range + island.radius * 0.6) {
          this.found.add(island);
          changed = true;
        }
      }
    }
    if (!changed) {
      for (let c = 0; c < before.length; c++) {
        if (before[c] !== this.visible[c]) {
          changed = true;
          break;
        }
      }
    }
    if (changed) this.version++;
  }
}
