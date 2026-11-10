import type { Stock } from './Resources';

/**
 * The captains a player (or an AI seat) can sail as. Each has a pixel-art
 * portrait (`src/ui/Portrait.ts`) whose hat takes the team colour, so two
 * players can pick the same captain, and a couple of small upgrades to start
 * the match with. Nothing here is strong on its own: a captain leans a game
 * one way, they do not decide it.
 */
export type HatStyle = 'tricorn' | 'bicorne' | 'bandana' | 'cap' | 'plumed' | 'beret';
export type Beard = 'none' | 'stubble' | 'full' | 'goatee' | 'mutton' | 'braided';

export interface PortraitLook {
  skin: string;
  hair: string;
  beard: Beard;
  moustache: boolean;
  hat: HatStyle;
  coat: string;
  eyepatch?: boolean;
  scar?: boolean;
  earring?: boolean;
  pipe?: boolean;
  goldTooth?: boolean;
  /** Long hair down past the hat. */
  longHair?: boolean;
  eyes?: string;
}

export interface Captain {
  id: string;
  name: string;
  /** What they are known for, in two or three words. */
  title: string;
  /** Starting upgrades (ids from `UPGRADES`). */
  upgrades: string[];
  /** Extra stores at the start. */
  stock?: Partial<Stock>;
  /** One line on the buff, for the picker. */
  perk: string;
  look: PortraitLook;
  /** Things they say. */
  lines: { hello: string[]; attack: string[]; sunk: string[]; lost: string[]; win: string[] };
}

export const CAPTAINS: Captain[] = [
  {
    id: 'ironjaw',
    name: 'Ironjaw Marrow',
    title: 'The Brawler',
    upgrades: ['oak', 'drill'],
    perk: '+10% hull, gun decks reload 8% faster',
    look: { skin: '#e0a37a', hair: '#3a2416', beard: 'full', moustache: true, hat: 'tricorn', coat: '#5a2a22', scar: true },
    lines: {
      hello: ['Run out the guns, lads. Today we eat well.', 'I have broken better ships than these.'],
      attack: ['Your walls look thin from here.', 'Strike your colours or I strike them for you!'],
      sunk: ['Ha! Another hull for the deep.', 'That is how a broadside is done.'],
      lost: ['You will pay for every plank!'],
      win: ['These waters answer to me now.'],
    },
  },
  {
    id: 'pell',
    name: 'Old Salt Pell',
    title: 'The Windcatcher',
    upgrades: ['canvas', 'copper'],
    perk: '+12% from a fair wind, +5% speed',
    look: { skin: '#c98a62', hair: '#d8d4cc', beard: 'mutton', moustache: true, hat: 'cap', coat: '#2a3d5c', pipe: true },
    lines: {
      hello: ['Smell that? A fair wind and a fat prize.', 'Sixty years at sea and I still beat the young ones home.'],
      attack: ['You will never see me coming.', 'Catch me if your sails can.'],
      sunk: ['Should have trimmed your sails, sonny.'],
      lost: ['Blast it! The wind turned on me.'],
      win: ['The sea always remembers the patient.'],
    },
  },
  {
    id: 'coral',
    name: 'Madame Coral',
    title: 'The Banker',
    upgrades: ['tax', 'tax'],
    stock: { salvage: 15 },
    perk: '+16% island income, 15 extra metals',
    look: { skin: '#f0c4a0', hair: '#b8322a', beard: 'none', moustache: false, hat: 'plumed', coat: '#3f6b4a', earring: true, longHair: true, eyes: '#2a8a6a' },
    lines: {
      hello: ['Every island has a price, darling.', 'Let us make this profitable.'],
      attack: ['I am calling in your debts.', 'Your islands look undervalued.'],
      sunk: ['Write that one off.'],
      lost: ['This was a poor investment.'],
      win: ['A splendid return, all told.'],
    },
  },
  {
    id: 'vex',
    name: 'One-Eye Vex',
    title: 'The Lookout',
    upgrades: ['nest', 'nest'],
    perk: '+30% sight range',
    look: { skin: '#a8714e', hair: '#1c1c22', beard: 'goatee', moustache: false, hat: 'bandana', coat: '#41314f', eyepatch: true, earring: true },
    lines: {
      hello: ['One eye sees more than your two.', 'I spotted you an hour ago.'],
      attack: ['Saw you from the horizon.', 'Nowhere to hide on my sea.'],
      sunk: ['Watched you go down. Lovely.'],
      lost: ['Did not see that one coming.'],
      win: ['Nothing escapes my eye.'],
    },
  },
  {
    id: 'grubb',
    name: 'Bosun Grubb',
    title: 'The Patcher',
    upgrades: ['carpenter', 'shipwright'],
    perk: 'Hull mends 25% faster on 20% less wood',
    look: { skin: '#e7b48c', hair: '#7a4a24', beard: 'braided', moustache: true, hat: 'beret', coat: '#6b5a2a', goldTooth: true },
    lines: {
      hello: ['A bit of tar and she will float forever.', 'Hammer, nails, and spite. That is all I need.'],
      attack: ['I will patch my ship with yours.', 'Mind your hull, I know where it is weak.'],
      sunk: ['Timber! Mine now.'],
      lost: ['Not even I can fix that.'],
      win: ['Still floating. Always floating.'],
    },
  },
  {
    id: 'sable',
    name: 'Lady Sable',
    title: 'The Marksman',
    upgrades: ['barrels', 'swivel'],
    perk: '+10% cannon range, swivel reloads 15% faster',
    look: { skin: '#7a4a32', hair: '#141016', beard: 'none', moustache: false, hat: 'bicorne', coat: '#1f2e3a', longHair: true, eyes: '#c79a3a' },
    lines: {
      hello: ['Stay at range. It will not save you.', 'I never miss twice.'],
      attack: ['You are already in my sights.', 'Hold still, this will be quick.'],
      sunk: ['Right where I aimed.'],
      lost: ['A lucky shot. Yours, not mine.'],
      win: ['Clean work, from a distance.'],
    },
  },
  {
    id: 'finch',
    name: 'Quartermaster Finch',
    title: 'The Trader',
    upgrades: ['charter', 'charter'],
    stock: { wood: 20 },
    perk: '+30% from trade ships, 20 extra wood',
    look: { skin: '#f2c9a8', hair: '#c8a050', beard: 'stubble', moustache: false, hat: 'tricorn', coat: '#7a3f6a', earring: true },
    lines: {
      hello: ['Buy low, sail fast, sink the competition.', 'My ledgers and my cannons are both full.'],
      attack: ['Hostile takeover, mate.', 'Your trade routes are mine now.'],
      sunk: ['A bargain at any price.'],
      lost: ['I demand a refund!'],
      win: ['The market has spoken.'],
    },
  },
  {
    id: 'jack',
    name: 'Scuttle Jack',
    title: 'The Scavenger',
    upgrades: ['scavenger', 'monkeys'],
    perk: '+20% salvage and bounties, 1 shot in 6 free',
    look: { skin: '#d49a6a', hair: '#5a3a1a', beard: 'stubble', moustache: true, hat: 'bandana', coat: '#3a4a3a', goldTooth: true, scar: true },
    lines: {
      hello: ['One captain\'s wreck is another\'s treasure.', 'Ooh, shiny ships. All of them mine soon.'],
      attack: ['I will pick your bones clean.', 'Leave the barrels, I want those.'],
      sunk: ['Mine, mine, all mine!'],
      lost: ['Not my barrels! Not my lovely barrels!'],
      win: ['Everything floating belongs to Jack.'],
    },
  },
];

export const captainById = (id: string | undefined) => CAPTAINS.find((c) => c.id === id) ?? CAPTAINS[0];
export const pickLine = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
