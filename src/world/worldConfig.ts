/** The sea ends in a waterfall this far from the middle of the map (m). */
export const WORLD_RADIUS = 760;
/** Ships are turned back by a current inside this distance of the edge (m). */
export const EDGE_MARGIN = 70;

const SEED_KEY = 'plunder.world.seed';
const DEFAULT_SEED = 3;

/** Seed of the current map: the same islands every launch until a new map is asked for. */
export function worldSeed(): number {
  try {
    const v = Number(localStorage.getItem(SEED_KEY));
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_SEED;
  } catch {
    return DEFAULT_SEED;
  }
}

/** Pick a fresh map. Takes effect when the game is reloaded. */
export function rollWorldSeed(): number {
  const seed = 1 + Math.floor(Math.random() * 999_983);
  try {
    localStorage.setItem(SEED_KEY, String(seed));
  } catch {
    // storage unavailable: the default map stays
  }
  return seed;
}
