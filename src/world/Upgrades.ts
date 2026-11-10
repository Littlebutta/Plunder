import { Stock } from './Resources';

/**
 * Upgrades for a captain's flagship and holdings: won by sinking a ghost ship,
 * or bought at the HQ (from the home island's panel on the chart) for a price
 * that climbs with each one. Every one is small on its own; a captain gets
 * strong by stacking many, not from one lucky roll.
 */
export interface Mods {
  /** How far the flagship sees (fog of war and hidden ships). */
  sight: number;
  /** Broadside muzzle speed (range grows with its square). */
  range: number;
  /** Time for a gun deck to reload. */
  reload: number;
  /** Time for the swivel gun to reload. */
  swivelReload: number;
  /** The flagship's hull points. */
  hull: number;
  /** How fast the hull patches itself. */
  repair: number;
  /** Wood used per point of repair. */
  repairWood: number;
  /** Thrust from the sails. */
  speed: number;
  /** Extra push from a fair wind. */
  windBoost: number;
  /** Rudder bite. */
  turn: number;
  /** What the islands bring in. */
  income: number;
  /** Salvage hauled from wreckage, and bounties. */
  salvage: number;
  /** Share of broadside shots that cost no metal. */
  freeShot: number;
  /** Trade ships' takings. */
  trade: number;
}

export const baseMods = (): Mods => ({ sight: 1, range: 1, reload: 1, swivelReload: 1, hull: 1, repair: 1, repairWood: 1, speed: 1, windBoost: 1, turn: 1, income: 1, salvage: 1, freeShot: 0, trade: 1 });

export interface Upgrade {
  id: string;
  name: string;
  /** What it does, short enough for a one-line notice. */
  text: string;
  /** How many times it can be taken. */
  max: number;
  apply(m: Mods): void;
}

export const UPGRADES: Upgrade[] = [
  { id: 'nest', name: "Crow's Nest", text: '+15% sight range', max: 3, apply: (m) => (m.sight += 0.15) },
  { id: 'barrels', name: 'Long Barrels', text: '+10% cannon range', max: 3, apply: (m) => (m.range += 0.05) },
  { id: 'drill', name: 'Gun Drill', text: 'Gun decks reload 8% faster', max: 3, apply: (m) => (m.reload *= 0.92) },
  { id: 'swivel', name: 'Swivel Drill', text: 'Swivel gun reloads 15% faster', max: 3, apply: (m) => (m.swivelReload *= 0.85) },
  { id: 'oak', name: 'Oak Planking', text: '+10% hull', max: 3, apply: (m) => (m.hull += 0.1) },
  { id: 'carpenter', name: "Ship's Carpenter", text: 'Hull mends 25% faster', max: 3, apply: (m) => (m.repair += 0.25) },
  { id: 'shipwright', name: 'Thrifty Shipwright', text: 'Repairs use 20% less wood', max: 2, apply: (m) => (m.repairWood *= 0.8) },
  { id: 'copper', name: 'Coppered Hull', text: '+5% speed', max: 3, apply: (m) => (m.speed += 0.05) },
  { id: 'canvas', name: 'Fine Canvas', text: '+12% from a fair wind', max: 3, apply: (m) => (m.windBoost += 0.12) },
  { id: 'rudder', name: 'Balanced Rudder', text: '+10% turning', max: 3, apply: (m) => (m.turn += 0.1) },
  { id: 'tax', name: 'Tax Collector', text: '+8% island income', max: 4, apply: (m) => (m.income += 0.08) },
  { id: 'scavenger', name: 'Scavengers', text: '+20% salvage and bounties', max: 3, apply: (m) => (m.salvage += 0.2) },
  { id: 'monkeys', name: 'Powder Monkeys', text: '1 shot in 6 costs no metal', max: 2, apply: (m) => (m.freeShot = Math.min(0.4, m.freeShot + 0.16)) },
  { id: 'charter', name: 'Merchant Charter', text: '+15% from trade ships', max: 3, apply: (m) => (m.trade += 0.15) },
];

export const upgradeById = (id: string) => UPGRADES.find((u) => u.id === id);

/** One captain's upgrades. */
export class UpgradeSet {
  readonly mods = baseMods();
  readonly taken = new Map<string, number>();
  bought = 0;

  get count(): number {
    let n = 0;
    for (const v of this.taken.values()) n += v;
    return n;
  }

  /** A random upgrade this captain can still take, or null when every one is maxed. */
  roll(rand = Math.random): Upgrade | null {
    const open = UPGRADES.filter((u) => (this.taken.get(u.id) ?? 0) < u.max);
    return open.length ? open[Math.floor(rand() * open.length)] : null;
  }

  take(u: Upgrade): void {
    this.taken.set(u.id, (this.taken.get(u.id) ?? 0) + 1);
    u.apply(this.mods);
  }

  /** What the next upgrade from the HQ costs: it climbs by half again each time. */
  price(): Stock {
    const k = Math.pow(1.5, this.bought);
    return { wood: Math.round(20 * k), stone: Math.round(12 * k), salvage: Math.round(20 * k) };
  }

  /** For the HQ panel: "Crow's Nest ×2, Gun Drill". */
  summary(): string {
    return [...this.taken].map(([id, n]) => `${upgradeById(id)?.name ?? id}${n > 1 ? ` ×${n}` : ''}`).join(', ');
  }
}
