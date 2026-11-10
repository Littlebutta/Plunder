import { loadMatch } from './Match';
import { emptyStock, Stock } from './Resources';

/** Nobody: the owner of an unclaimed island. */
export const NONE = -1;
/**
 * The local player's faction. Faction ids are the same on every copy of an
 * online match (a captain's place in the lobby), so this is 0 only when
 * playing alone or hosting. Fixed for the life of the page: a match starts with a reload.
 */
export const ME = loadMatch().net?.me ?? 0;

export type FactionKind = 'human' | 'ai' | 'raiders';

/** One side in a game: a player (human or AI) or the neutral raiders. */
export interface Faction {
  id: number;
  name: string;
  colour: string;
  /** Factions on the same team do not fight each other. Raiders are on a team of their own. */
  team: number;
  kind: FactionKind;
  /** One pool of resources for everything the faction gathers, earns and spends. */
  stores: Stock;
  /** False once its home island has been taken. */
  alive: boolean;
}

export class Factions {
  readonly list: Faction[] = [];

  add(name: string, colour: string, team: number, kind: FactionKind, stores: Stock = emptyStock()): Faction {
    const f: Faction = { id: this.list.length, name, colour, team, kind, stores, alive: true };
    this.list.push(f);
    return f;
  }

  get me(): Faction {
    return this.list[ME];
  }

  get(id: number): Faction | null {
    return this.list[id] ?? null;
  }

  colour(id: number): string {
    return this.list[id]?.colour ?? '#ffffff';
  }

  name(id: number): string {
    return this.list[id]?.name ?? 'Nobody';
  }

  /** Do these two fight? Unknown shooters (null: weather, stray shot) are no one's friend. */
  hostile(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return true;
    if (a === b) return false;
    const fa = this.list[a];
    const fb = this.list[b];
    return !fa || !fb || fa.team !== fb.team;
  }

  allied(a: number, b: number): boolean {
    return !this.hostile(a, b);
  }

  /** The player factions still in the game (not the raiders). */
  get contenders(): Faction[] {
    return this.list.filter((f) => f.alive && f.kind !== 'raiders');
  }
}
