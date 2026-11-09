import type { IslandType } from './Islands';

export type ResourceId = 'wood' | 'stone' | 'salvage';

export const RESOURCE_IDS: ResourceId[] = ['wood', 'stone', 'salvage'];

export const RESOURCES: Record<ResourceId, { label: string; color: string }> = {
  wood: { label: 'Wood', color: '#c0814a' },
  stone: { label: 'Stone', color: '#b9b2a6' },
  // (the id is still 'salvage' so older saves and code keep working)
  salvage: { label: 'Metals', color: '#8fc7e8' },
};

export type Stock = Record<ResourceId, number>;

export function emptyStock(): Stock {
  return { wood: 0, stone: 0, salvage: 0 };
}

/** What each island type offers, as shares of its total (which grows with island size). */
const YIELD: Record<IslandType, Partial<Stock>> = {
  peak: { stone: 0.6, wood: 0.4 },
  ridge: { stone: 0.7, wood: 0.3 },
  mesa: { stone: 0.65, wood: 0.35 },
  hills: { wood: 0.8, stone: 0.2 },
  cay: { wood: 0.7, salvage: 0.3 },
  stacks: { stone: 1 },
  wreck: { salvage: 0.6, wood: 0.4 },
};

/** Full stock of an island: bigger islands hold more. */
export function islandCapacity(type: IslandType, radius: number): Stock {
  const total = Math.round(12 + radius * 1.1);
  const out = emptyStock();
  for (const id of RESOURCE_IDS) out[id] = Math.round(total * (YIELD[type][id] ?? 0));
  return out;
}

/** The ship's cargo hold. */
export class Hold {
  readonly stock = emptyStock();
  constructor(public capacity = 40) {}

  get used(): number {
    return RESOURCE_IDS.reduce((n, id) => n + this.stock[id], 0);
  }

  get free(): number {
    return Math.max(0, this.capacity - this.used);
  }
}
