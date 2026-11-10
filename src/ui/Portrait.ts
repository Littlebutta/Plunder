import type { Captain, PortraitLook } from '../world/Captains';

/**
 * Pixel-art captain portraits, painted pixel by pixel on a 32x32 canvas and
 * shown scaled up with crisp edges. The hat is always the team colour, so two
 * players on the same captain still look like who they fight for. Two frames
 * (mouth shut, mouth open) let a portrait talk.
 */
export const PORTRAIT_SIZE = 32;

const cache = new Map<string, HTMLCanvasElement>();

/** The portrait as a 32x32 canvas (shared: copy it with drawImage, don't add it to the page twice). */
export function portrait(c: Captain, teamColour: string, open = false): HTMLCanvasElement {
  const key = `${c.id}|${teamColour}|${open}`;
  let cv = cache.get(key);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = cv.height = PORTRAIT_SIZE;
    paint(cv.getContext('2d')!, c.look, teamColour, open);
    cache.set(key, cv);
  }
  return cv;
}

/** A canvas element on the page showing a portrait, scaled up `scale` times. */
export function portraitElement(c: Captain, teamColour: string, scale = 3): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.width = el.height = PORTRAIT_SIZE;
  el.className = 'portrait';
  el.style.width = el.style.height = `${PORTRAIT_SIZE * scale}px`;
  el.getContext('2d')!.drawImage(portrait(c, teamColour), 0, 0);
  return el;
}

/** Redraw a portrait element (to move its mouth, or change its captain). */
export function drawPortrait(el: HTMLCanvasElement, c: Captain, teamColour: string, open = false): void {
  const g = el.getContext('2d')!;
  g.clearRect(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
  g.drawImage(portrait(c, teamColour, open), 0, 0);
}

/** A data URL of the portrait, for an <img>. */
export function portraitUrl(c: Captain, teamColour: string): string {
  return portrait(c, teamColour).toDataURL();
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k > 1 ? v + (255 - v) * (k - 1) : v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function paint(g: CanvasRenderingContext2D, L: PortraitLook, team: string, open: boolean): void {
  const px = (x: number, y: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(x, y, 1, 1);
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  };
  const ink = '#1a1012';
  const skin = L.skin;
  const skinD = shade(skin, 0.78);
  const skinL = shade(skin, 1.12);
  const hair = L.hair;
  const hairD = shade(hair, 0.7);
  const H = team;
  const Hd = shade(team, 0.62);
  const Hl = shade(team, 1.3);
  const trim = '#e8c050';

  // backdrop: banded sky-to-sea, the pixel way
  const bands = ['#20324a', '#243a55', '#294260', '#2e4a6a', '#335274'];
  for (let y = 0; y < 32; y++) rect(0, y, 31, y, bands[Math.min(4, Math.floor(y / 7))]);

  // long hair falls behind everything else
  if (L.longHair) {
    rect(8, 12, 10, 27, hair);
    rect(22, 12, 24, 27, hair);
    rect(7, 18, 7, 26, hairD);
    rect(25, 18, 25, 26, hairD);
  }

  // coat and shoulders
  for (let y = 25; y < 32; y++) {
    const w = 8 + (y - 25) * 2;
    rect(16 - w, y, 15 + w, y, L.coat);
  }
  // lapels and shirt
  const coatL = shade(L.coat, 1.25);
  for (let k = 0; k < 6; k++) {
    px(13 - Math.floor(k / 2), 25 + k, coatL);
    px(18 + Math.floor(k / 2), 25 + k, coatL);
  }
  rect(14, 25, 17, 27, '#efe6d2');
  rect(15, 28, 16, 31, '#efe6d2');
  px(15, 29, '#c9bfa8');
  // neck
  rect(13, 22, 18, 25, skinD);

  // face: an oval
  for (let y = 9; y <= 24; y++) {
    for (let x = 9; x <= 23; x++) {
      const dx = (x + 0.5 - 16) / 6.6;
      const dy = (y + 0.5 - 16.8) / 7.6;
      if (dx * dx + dy * dy <= 1) px(x, y, x >= 20 || y >= 23 ? skinD : skin);
    }
  }
  // cheek light and ears
  px(12, 18, skinL);
  px(11, 17, skinL);
  rect(9, 15, 9, 18, skinD);
  rect(23, 15, 23, 18, skinD);
  // short hair at the temples
  if (!L.longHair) {
    rect(10, 11, 11, 15, hair);
    rect(21, 11, 22, 15, hair);
  }
  // mutton chops
  if (L.beard === 'mutton') {
    rect(10, 14, 11, 21, hair);
    rect(21, 14, 22, 21, hair);
    rect(12, 20, 12, 21, hair);
    rect(20, 20, 20, 21, hair);
  }

  // eyes and brows
  const eye = L.eyes ?? '#2a2018';
  rect(11, 13, 14, 13, hairD);
  rect(18, 13, 21, 13, hairD);
  rect(12, 15, 13, 15, '#f4f0e6');
  px(13, 15, eye);
  rect(18, 15, 19, 15, '#f4f0e6');
  px(18, 15, eye);
  px(12, 16, skinD);
  px(19, 16, skinD);
  if (L.eyepatch) {
    rect(11, 14, 14, 16, ink);
    for (let x = 9; x <= 23; x++) px(x, x < 15 ? 12 + Math.round((15 - x) * 0.15) : 12 - Math.round((x - 15) * 0.12), ink);
  }
  if (L.scar) {
    px(19, 12, '#c25a5a');
    px(20, 13, '#c25a5a');
    px(20, 14, '#c25a5a');
    px(21, 15, '#c25a5a');
    px(21, 16, '#c25a5a');
  }
  // nose
  px(16, 17, skinD);
  px(16, 18, skinD);
  px(17, 18, skinD);
  px(15, 18, skinL);

  // beards (before the mouth, so an open mouth shows through)
  if (L.beard === 'full') {
    for (let y = 19; y <= 26; y++) {
      const w = y < 24 ? 6 : 6 - (y - 23) * 1.5;
      rect(Math.round(16 - w), y, Math.round(15 + w), y, y % 2 ? hair : hairD);
    }
    rect(10, 16, 11, 19, hair);
    rect(21, 16, 22, 19, hair);
  } else if (L.beard === 'goatee') {
    rect(14, 22, 18, 24, hair);
    rect(15, 25, 17, 25, hairD);
  } else if (L.beard === 'braided') {
    rect(12, 21, 20, 23, hair);
    for (let y = 24; y <= 29; y++) rect(15, y, 17, y, y % 2 ? hairD : hair);
    px(16, 30, trim);
  } else if (L.beard === 'stubble') {
    for (let y = 19; y <= 24; y++) for (let x = 11; x <= 21; x++) if ((x + y) % 2 === 0 && (x - 16) ** 2 / 36 + (y - 17) ** 2 / 56 < 1) px(x, y, skinD);
  }
  if (L.moustache) {
    rect(13, 19, 19, 19, hair);
    px(12, 20, hair);
    px(20, 20, hair);
  }

  // mouth
  if (open) {
    rect(14, 20, 18, 22, '#2a0a0e');
    rect(15, 20, 17, 20, '#f4f0e6');
    rect(15, 22, 17, 22, '#8a2a2a');
    if (L.goldTooth) px(17, 20, trim);
  } else {
    rect(14, 21, 18, 21, '#6a2a24');
    px(13, 20, skinD);
    if (L.goldTooth) px(17, 21, trim);
  }
  if (L.earring) {
    px(9, 19, trim);
    px(9, 20, shade(trim, 0.7));
  }
  if (L.pipe) {
    rect(19, 22, 22, 22, '#5a3a1a');
    rect(23, 19, 24, 22, '#7a4a24');
    px(23, 19, '#2a1a10');
    px(24, 17, 'rgba(220,220,220,.7)');
    px(25, 15, 'rgba(220,220,220,.5)');
  }

  // the hat, in the team's colour
  switch (L.hat) {
    case 'tricorn': {
      rect(10, 4, 22, 9, H);
      rect(11, 3, 21, 3, H);
      rect(10, 4, 11, 9, Hl);
      // brim turned up into three corners
      for (let x = 5; x <= 27; x++) {
        const lift = Math.round(Math.abs(x - 16) * 0.32);
        rect(x, 10 - lift, x, 11 - Math.max(0, lift - 1), Hd);
        px(x, 10 - lift, trim);
      }
      rect(14, 11, 18, 12, Hd);
      px(16, 12, trim);
      break;
    }
    case 'bicorne': {
      for (let x = 3; x <= 28; x++) {
        const top = 3 + Math.round(((x - 16) / 13) ** 2 * 4);
        rect(x, top, x, 10, x < 16 ? H : Hd);
        px(x, top, trim);
      }
      rect(5, 10, 26, 11, Hd);
      rect(15, 6, 17, 8, '#f4f0e6');
      px(16, 7, H);
      break;
    }
    case 'bandana': {
      for (let y = 7; y <= 12; y++) {
        const w = y === 7 ? 4 : y === 8 ? 6 : 7;
        rect(16 - w, y, 15 + w, y, H);
      }
      rect(9, 12, 23, 12, Hd);
      for (const [x, y] of [[12, 9], [17, 8], [20, 10], [14, 11], [11, 11]]) px(x, y, Hl);
      // knot and tails
      rect(23, 11, 24, 13, Hd);
      rect(25, 12, 26, 15, H);
      rect(24, 14, 25, 17, Hd);
      break;
    }
    case 'cap': {
      rect(9, 5, 23, 9, H);
      rect(10, 4, 22, 4, Hl);
      rect(9, 9, 23, 10, ink);
      rect(10, 11, 22, 12, '#1e1e26');
      rect(11, 12, 21, 12, '#33333d');
      rect(15, 6, 17, 8, trim);
      px(16, 7, Hd);
      break;
    }
    case 'plumed': {
      rect(10, 4, 22, 9, H);
      rect(11, 3, 21, 3, Hl);
      rect(3, 9, 29, 10, Hd);
      rect(5, 11, 27, 11, Hd);
      rect(10, 8, 22, 8, trim);
      // a white feather sweeping back
      const feather: [number, number][] = [[21, 3], [22, 2], [23, 2], [24, 1], [25, 1], [26, 0], [27, 0], [22, 3], [24, 2], [26, 1]];
      for (const [x, y] of feather) px(x, y, '#f4f0e6');
      px(28, 1, '#d8d0c0');
      break;
    }
    case 'beret': {
      for (let y = 5; y <= 10; y++) {
        const w = y === 5 ? 5 : y === 10 ? 7 : 9;
        rect(16 - w + 1, y, 16 + w, y, y < 7 ? Hl : H);
      }
      rect(9, 10, 22, 11, Hd);
      px(17, 4, Hd);
      break;
    }
  }

  // a dark frame
  g.strokeStyle = ink;
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, 31, 31);
}
