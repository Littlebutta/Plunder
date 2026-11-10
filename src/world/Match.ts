import { Stock } from './Resources';
import { worldSeed } from './worldConfig';

/** 'open' only exists in the online lobby: a slot waiting for a friend to join. */
export type SlotKind = 'human' | 'ai' | 'closed' | 'open';

export interface MatchSlot {
  kind: SlotKind;
  /** 0-based team number. */
  team: number;
  colour: string;
  name: string;
  /** Online: which copy of the game sails this slot (a transport peer id). */
  peer?: string;
}

/** An online match: how this copy is linked to the others. */
export interface NetInfo {
  transport: 'steam' | 'local';
  /** The room's invite code. */
  room: string;
  /** Is this copy the host, which runs the world for everyone? */
  host: boolean;
  /** This copy's faction: its place among the captains. */
  me: number;
}

/**
 * What kind of game the world is built for. 'classic' is the solo voyage
 * against the raiders; 'vs' is a match set up in the lobby: several captains
 * (you and AI for now) in teams, each with a home island.
 */
export interface MatchConfig {
  mode: 'classic' | 'vs';
  seed: number;
  /** How many islands to scatter. */
  islands: number;
  /** Deal every captain the same islands at the same distances. */
  fair: boolean;
  /** Neutral forts on the port islands, there for the taking. */
  forts: boolean;
  /** What every captain starts with. */
  stock: 'lean' | 'standard' | 'rich';
  /** How well supplied the AI captains are. */
  ai: 'easy' | 'normal' | 'hard';
  slots: MatchSlot[];
  /** Go straight to sea when the page loads (set by the lobby's Start). */
  autostart?: boolean;
  /** Set when the match is played online. */
  net?: NetInfo;
}

export const TEAM_NAMES = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
export const SLOT_COLOURS = ['#d8343a', '#2f7fd6', '#3aa655', '#e0a020', '#8a4fc7', '#e06a9a', '#20a5a5', '#3a3a44'];
export const AI_NAMES = ['Blackwood', 'Redmayne', 'Calloway', 'Vane', 'Marlowe', 'Drummond', 'Ashby'];
export const START_STOCK: Record<MatchConfig['stock'], Stock> = {
  lean: { wood: 30, stone: 10, salvage: 25 },
  standard: { wood: 60, stone: 25, salvage: 60 },
  rich: { wood: 160, stone: 70, salvage: 160 },
};

const KEY = 'plunder.match';

export function classicMatch(): MatchConfig {
  return { mode: 'classic', seed: worldSeed(), islands: 11, fair: false, forts: true, stock: 'lean', ai: 'normal', slots: [] };
}

/** A two-captain match to start the lobby from. */
export function defaultVsMatch(colour: string): MatchConfig {
  return {
    mode: 'vs',
    seed: 1 + Math.floor(Math.random() * 999_983),
    islands: 12,
    fair: true,
    forts: true,
    stock: 'standard',
    ai: 'normal',
    slots: [
      { kind: 'human', team: 0, colour, name: 'You' },
      { kind: 'ai', team: 1, colour: SLOT_COLOURS.find((c) => c !== colour) ?? SLOT_COLOURS[1], name: AI_NAMES[0] },
      { kind: 'closed', team: 2, colour: SLOT_COLOURS[2], name: AI_NAMES[1] },
      { kind: 'closed', team: 3, colour: SLOT_COLOURS[3], name: AI_NAMES[2] },
    ],
  };
}

/** The match this page load is for: the lobby's, if one was just started, else the classic voyage. */
export function loadMatch(): MatchConfig {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const m = JSON.parse(raw) as MatchConfig;
      if (m && m.mode === 'vs' && Array.isArray(m.slots) && m.slots.filter((s) => s.kind === 'human' || s.kind === 'ai').length >= 2) return m;
    }
  } catch {
    // no storage: classic
  }
  return classicMatch();
}

export function saveMatch(m: MatchConfig | null): void {
  try {
    if (m) sessionStorage.setItem(KEY, JSON.stringify(m));
    else sessionStorage.removeItem(KEY);
  } catch {
    // no storage: the match cannot be carried over a reload
  }
}

/** The lobby's last settings, kept between games. */
export function loadLobby(): MatchConfig | null {
  try {
    const raw = localStorage.getItem(KEY + '.lobby');
    const m = raw ? (JSON.parse(raw) as MatchConfig) : null;
    if (!m || !Array.isArray(m.slots) || m.slots.length !== 4) return null;
    // an online lobby's seats are not remembered: next time they start empty
    delete m.net;
    for (const s of m.slots.slice(1)) {
      if (s.kind === 'open' || s.kind === 'human') s.kind = 'closed';
      delete s.peer;
    }
    return m;
  } catch {
    return null;
  }
}

export function saveLobby(m: MatchConfig): void {
  try {
    localStorage.setItem(KEY + '.lobby', JSON.stringify(m));
  } catch {
    // not remembered
  }
}
