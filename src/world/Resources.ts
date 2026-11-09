import type { IslandType } from './Islands';

export type ResourceId = 'wood' | 'stone' | 'food' | 'salvage';

export const RESOURCE_IDS: ResourceId[] = ['wood', 'stone', 'food', 'salvage'];

export const RESOURCES: Record<ResourceId, { label: string; color: string }> = {
  wood: { label: 'Wood', color: '#c0814a' },
  stone: { label: 'Stone', color: '#b9b2a6' },
  food: { label: 'Food', color: '#9be37a' },
  salvage: { label: 'Salvage', color: '#8fc7e8' },
};

export type Stock = Record<ResourceId, number>;

export function emptyStock(): Stock {
  return { wood: 0, stone: 0, food: 0, salvage: 0 };
}

/** What each island type offers, as shares of its total (which grows with island size). */
const YIELD: Record<IslandType, Partial<Stock>> = {
  peak: { stone: 0.55, wood: 0.3, food: 0.15 },
  ridge: { stone: 0.7, wood: 0.3 },
  mesa: { stone: 0.6, wood: 0.25, food: 0.15 },
  hills: { wood: 0.55, food: 0.45 },
  cay: { food: 0.8, wood: 0.2 },
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
