import * as THREE from 'three';
import { FOG_N, FogOfWar } from '../world/FogOfWar';
import type { Island } from '../world/Islands';
import { RESOURCE_IDS, RESOURCES } from '../world/Resources';
import { WORLD_RADIUS } from '../world/worldConfig';

export interface MapShip {
  /** 0 is the flagship; escorts and raiders carry their collider ids. */
  id: number;
  position: THREE.Vector3;
  /** Compass heading in radians: 0 = north (-Z), clockwise. */
  heading: number;
  /** Sail colour: the owner's. */
  colour: string;
  name: string;
  hostile: boolean;
  /** False for an ally's ship: it shows on the chart but takes no orders from you. */
  mine?: boolean;
  /** 0..1 hull left. */
  health: number;
  /** Where it has been ordered to sail, if anywhere. */
  course: THREE.Vector3 | null;
  /** Shown in its panel, e.g. "Following the flagship". */
  note: string;
}

export interface MapStronghold {
  site: THREE.Vector3;
  level: number;
  home: boolean;
  /** Faction id of whoever holds it. */
  side: number;
  ruined: boolean;
  island: Island;
}

export interface MapState {
  islands: Island[];
  /** Every ship afloat; the flagship first. */
  ships: MapShip[];
  /** Colour and name of a faction (the owner of an island or stronghold). */
  colourOf(faction: number): string;
  nameOf(faction: number): string;
  strongholds: MapStronghold[];
  fog: FogOfWar;
}

export interface MapActions {
  /** Right click on open water: the selected ship (the flagship if none) sails there. */
  order(shipId: number, x: number, z: number): void;
  /** An escort is told to fall in behind the flagship again. */
  follow(shipId: number): void;
  close(): void;
}

interface View {
  cx: number;
  cz: number;
  zoom: number;
}

const INK = '#4a2f17';
const INK_SOFT = 'rgba(74,47,23,.55)';
const TYPE_LABEL: Record<Island['type'], string> = {
  peak: 'Volcanic peak',
  ridge: 'Rocky ridge',
  mesa: 'Mesa',
  hills: 'Green hills',
  cay: 'Sandy cay',
  stacks: 'Sea stacks',
  wreck: 'Shipwreck island',
};

/** Small deterministic random stream, so the paper looks the same every time. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let paperCache: HTMLCanvasElement | null = null;
/** A tile of old parchment: blotches, foxing and fibres over a warm base. */
function paperTile(): HTMLCanvasElement {
  if (paperCache) return paperCache;
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d')!;
  const rnd = stream(77);
  c.fillStyle = '#e7d2a0';
  c.fillRect(0, 0, size, size);
  // large soft stains, drawn wrapped so the tile repeats without seams
  for (let i = 0; i < 46; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 40 + rnd() * 120;
    const dark = rnd() < 0.55;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, dark ? 'rgba(150,108,58,.13)' : 'rgba(255,244,214,.16)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  for (let i = 0; i < 900; i++) {
    c.fillStyle = `rgba(110,74,36,${0.04 + rnd() * 0.1})`;
    c.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  c.strokeStyle = 'rgba(120,84,44,.07)';
  c.lineWidth = 1;
  for (let i = 0; i < 140; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (rnd() - 0.5) * 70, y + (rnd() - 0.5) * 10);
    c.stroke();
  }
  paperCache = cv;
  return cv;
}

/** Jitter for the torn edge of the sheet, one value per step along the border. */
const EDGE = Array.from({ length: 400 }, ((r) => () => r())(stream(5)));

/** A ship seen from above: wooden hull, two yards of sail in the owner's colour. */
function drawShipIcon(c: CanvasRenderingContext2D, x: number, y: number, heading: number, s: number, sail: string, hostile: boolean): void {
  c.save();
  c.translate(x, y);
  c.rotate(heading);
  c.lineJoin = 'round';
  // bowsprit
  c.strokeStyle = INK;
  c.lineWidth = Math.max(1, s * 0.09);
  c.beginPath();
  c.moveTo(0, -s * 0.8);
  c.lineTo(0, -s * 1.22);
  c.stroke();
  // hull: sharp bow, full waist, squared-off stern
  c.beginPath();
  c.moveTo(0, -s);
  c.bezierCurveTo(s * 0.46, -s * 0.62, s * 0.5, -s * 0.05, s * 0.44, s * 0.62);
  c.quadraticCurveTo(s * 0.42, s * 0.9, s * 0.3, s * 0.92);
  c.lineTo(-s * 0.3, s * 0.92);
  c.quadraticCurveTo(-s * 0.42, s * 0.9, -s * 0.44, s * 0.62);
  c.bezierCurveTo(-s * 0.5, -s * 0.05, -s * 0.46, -s * 0.62, 0, -s);
  c.closePath();
  c.fillStyle = '#a8713c';
  c.fill();
  c.lineWidth = Math.max(1.2, s * 0.11);
  c.strokeStyle = hostile ? '#8f1d1d' : INK;
  c.stroke();
  // deck
  c.beginPath();
  c.moveTo(0, -s * 0.72);
  c.bezierCurveTo(s * 0.3, -s * 0.45, s * 0.33, 0, s * 0.28, s * 0.6);
  c.lineTo(-s * 0.28, s * 0.6);
  c.bezierCurveTo(-s * 0.33, 0, -s * 0.3, -s * 0.45, 0, -s * 0.72);
  c.fillStyle = '#d6a868';
  c.fill();
  // stern rail
  c.strokeStyle = INK_SOFT;
  c.lineWidth = Math.max(0.8, s * 0.06);
  c.beginPath();
  c.moveTo(-s * 0.26, s * 0.72);
  c.lineTo(s * 0.26, s * 0.72);
  c.stroke();
  // two sails, bellied toward the bow, on their yards
  for (const [yy, half] of [[-s * 0.22, s * 0.78], [s * 0.34, s * 0.66]] as const) {
    c.beginPath();
    c.moveTo(-half, yy);
    c.quadraticCurveTo(0, yy - s * 0.46, half, yy);
    c.quadraticCurveTo(0, yy - s * 0.12, -half, yy);
    c.closePath();
    c.fillStyle = sail;
    c.fill();
    c.lineWidth = Math.max(0.8, s * 0.07);
    c.strokeStyle = INK;
    c.stroke();
    c.lineWidth = Math.max(1, s * 0.1);
    c.beginPath();
    c.moveTo(-half * 1.06, yy);
    c.lineTo(half * 1.06, yy);
    c.stroke();
    c.beginPath();
    c.arc(0, yy + s * 0.04, s * 0.09, 0, Math.PI * 2);
    c.fillStyle = '#6e4a26';
    c.fill();
  }
  c.restore();
}

/** Draws the world as an old paper chart into any canvas: the full chart and the minimap share it. */
export class MapPainter {
  private readonly fogCanvas = document.createElement('canvas');
  private readonly fogImage: ImageData;
  private fogVersion = -1;
  private readonly fogA = new Float32Array(FOG_N * FOG_N);
  private readonly fogB = new Float32Array(FOG_N * FOG_N);
  private readonly sheet = document.createElement('canvas');
  private sheetKey = '';

  constructor() {
    this.fogCanvas.width = this.fogCanvas.height = FOG_N;
    this.fogImage = new ImageData(FOG_N, FOG_N);
  }

  paint(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    view: View,
    state: MapState,
    opts: { mini: boolean; selectedIsland: Island | null; selectedShip: number | null },
  ): void {
    const S = (x: number, z: number): [number, number] => [w / 2 + (x - view.cx) * view.zoom, h / 2 + (z - view.cz) * view.zoom];
    const mini = opts.mini;

    // --- the table and the sheet (painted once per size, then reused) ----------------
    const scale = c.getTransform().a;
    const key = `${w}x${h}@${scale}:${mini}`;
    if (key !== this.sheetKey) {
      this.sheetKey = key;
      this.sheet.width = Math.round(w * scale);
      this.sheet.height = Math.round(h * scale);
      const sc = this.sheet.getContext('2d')!;
      sc.setTransform(scale, 0, 0, scale, 0, 0);
      sc.fillStyle = '#24170d';
      sc.fillRect(0, 0, w, h);
      this.sheetPath(sc, w, h, mini);
      if (!mini) {
        sc.shadowColor = 'rgba(0,0,0,.6)';
        sc.shadowBlur = 22;
        sc.shadowOffsetY = 6;
      }
      sc.fillStyle = sc.createPattern(paperTile(), 'repeat') ?? '#e7d2a0';
      sc.fill();
      sc.shadowColor = 'transparent';
      if (!mini) {
        // scorched, handled edges (clipped, so only the inner half of each stroke shows)
        sc.save();
        sc.clip();
        sc.strokeStyle = 'rgba(94,58,24,.028)';
        for (let lw = 150; lw >= 10; lw -= 10) {
          sc.lineWidth = lw;
          sc.stroke();
        }
        sc.strokeStyle = 'rgba(74,47,23,.6)';
        sc.lineWidth = 3;
        sc.stroke();
        sc.restore();
      }
    }
    c.drawImage(this.sheet, 0, 0, w, h);
    c.save();
    this.sheetPath(c, w, h, mini);
    c.clip();

    const [ox, oy] = S(0, 0);
    const R = WORLD_RADIUS * view.zoom;

    // --- the sea: a faint wash inside the rim, rhumb lines, the edge of the world ---
    c.save();
    c.beginPath();
    c.arc(ox, oy, R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(120,160,170,.10)';
    c.fill();
    c.clip();
    if (!mini) {
      const [rx, ry] = S(-WORLD_RADIUS * 0.56, WORLD_RADIUS * 0.52);
      c.strokeStyle = 'rgba(74,47,23,.13)';
      c.lineWidth = 1;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        c.beginPath();
        c.moveTo(rx, ry);
        c.lineTo(rx + Math.cos(a) * R * 2.4, ry + Math.sin(a) * R * 2.4);
        c.stroke();
      }
    }
    c.restore();
    // the rim: an inked double line, and water falling away outside it
    c.strokeStyle = INK;
    c.lineWidth = mini ? 1.5 : 2.5;
    c.beginPath();
    c.arc(ox, oy, R, 0, Math.PI * 2);
    c.stroke();
    if (!mini) {
      c.lineWidth = 1;
      c.beginPath();
      c.arc(ox, oy, R + 5, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = INK_SOFT;
      const ticks = 180;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2;
        const len = 8 + EDGE[i % EDGE.length] * 14;
        c.beginPath();
        c.moveTo(ox + Math.cos(a) * (R + 9), oy + Math.sin(a) * (R + 9));
        c.lineTo(ox + Math.cos(a) * (R + 9 + len), oy + Math.sin(a) * (R + 9 + len));
        c.stroke();
      }
    }

    // --- islands the player has found ------------------------------------------------
    for (const island of state.islands) {
      if (!state.fog.found.has(island)) continue;
      const outline = (scale: number) => {
        c.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          const r = island.shoreAt(a) * scale;
          const [x, y] = S(island.center.x + Math.cos(a) * r, island.center.z + Math.sin(a) * r);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.closePath();
      };
      const [sx, sy] = S(island.center.x, island.center.z);
      if (!mini) {
        // shoal water: a dotted line off the coast
        outline(1.22);
        c.setLineDash([2, 4]);
        c.strokeStyle = INK_SOFT;
        c.lineWidth = 1;
        c.stroke();
        c.setLineDash([]);
      }
      outline(1);
      c.fillStyle = '#d2b077';
      c.fill();
      c.strokeStyle = INK;
      c.lineWidth = mini ? 1 : 1.8;
      c.stroke();
      if (mini) {
        if (island.owner >= 0) {
          c.fillStyle = state.colourOf(island.owner);
          c.strokeStyle = INK;
          c.lineWidth = 1;
          c.beginPath();
          c.arc(sx, sy, 3.4, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
        continue;
      }
      // what the land is like: hill strokes for high ground, palms for low
      const rz = island.radius * view.zoom;
      c.strokeStyle = INK_SOFT;
      c.lineWidth = 1.2;
      if (island.type === 'peak' || island.type === 'ridge' || island.type === 'mesa' || island.type === 'stacks') {
        const n = island.type === 'peak' ? 1 : 3;
        for (let i = 0; i < n; i++) {
          const px = sx + (i - (n - 1) / 2) * rz * 0.36;
          const py = sy + (i % 2 ? rz * 0.12 : -rz * 0.05);
          const k = rz * (n === 1 ? 0.34 : 0.2);
          c.beginPath();
          c.moveTo(px - k, py + k * 0.6);
          c.lineTo(px, py - k * 0.7);
          c.lineTo(px + k, py + k * 0.6);
          c.moveTo(px - k * 0.2, py - k * 0.1);
          c.lineTo(px + k * 0.15, py + k * 0.35);
          c.stroke();
        }
      } else {
        for (let i = 0; i < 3; i++) {
          const a = i * 2.1 + 0.4;
          const px = sx + Math.cos(a) * rz * 0.32;
          const py = sy + Math.sin(a) * rz * 0.3;
          const k = Math.max(3, rz * 0.12);
          c.beginPath();
          c.moveTo(px, py + k);
          c.lineTo(px, py - k * 0.3);
          c.moveTo(px - k, py);
          c.quadraticCurveTo(px, py - k * 1.2, px + k, py);
          c.stroke();
        }
      }
      if (island.port) {
        const [px, py] = S(island.port.x, island.port.z);
        c.strokeStyle = INK;
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(sx + (px - sx) * 0.75, sy + (py - sy) * 0.75);
        c.lineTo(px, py);
        c.stroke();
      }
      if (island === opts.selectedIsland) {
        c.strokeStyle = '#8f1d1d';
        c.lineWidth = 2;
        c.setLineDash([6, 5]);
        c.beginPath();
        c.arc(sx, sy, island.radius * 1.35 * view.zoom + 6, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
    }

    // --- fog of war -----------------------------------------------------------------
    this.refreshFog(state.fog);
    c.save();
    c.beginPath();
    c.arc(ox, oy, R + (mini ? 0 : 2), 0, Math.PI * 2);
    c.clip();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    const [fx, fy] = S(FogOfWar.bounds[0], FogOfWar.bounds[0]);
    c.drawImage(this.fogCanvas, fx, fy, FogOfWar.bounds[1] * view.zoom, FogOfWar.bounds[1] * view.zoom);
    c.restore();

    // --- strongholds and the flags over them, on top of the fog so control always reads ---
    if (!mini) {
      for (const s of state.strongholds) {
        if (!state.fog.found.has(s.island)) continue;
        const [x, y] = S(s.site.x, s.site.z);
        const k = 5 + s.level * 1.5;
        c.fillStyle = s.ruined ? '#8d7a5e' : '#f0e2bd';
        c.strokeStyle = INK;
        c.lineWidth = 1.5;
        c.beginPath();
        if (s.level < 2) {
          c.moveTo(x - k, y + k * 0.7);
          c.lineTo(x - k, y - k * 0.2);
          c.lineTo(x, y - k);
          c.lineTo(x + k, y - k * 0.2);
          c.lineTo(x + k, y + k * 0.7);
        } else {
          c.moveTo(x - k, y + k * 0.7);
          c.lineTo(x - k, y - k);
          c.lineTo(x - k * 0.45, y - k);
          c.lineTo(x - k * 0.45, y - k * 0.45);
          c.lineTo(x + k * 0.45, y - k * 0.45);
          c.lineTo(x + k * 0.45, y - k);
          c.lineTo(x + k, y - k);
          c.lineTo(x + k, y + k * 0.7);
        }
        c.closePath();
        c.fill();
        c.stroke();
        // the owner's flag
        const top = y - k - 14;
        c.beginPath();
        c.moveTo(x, y - k * 0.6);
        c.lineTo(x, top);
        c.stroke();
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x + 13, top + 4.5);
        c.lineTo(x, top + 9);
        c.closePath();
        c.fillStyle = state.colourOf(s.side);
        c.fill();
        c.stroke();
        if (s.home) {
          c.setLineDash([3, 3]);
          c.beginPath();
          c.arc(x, y, k + 7, 0, Math.PI * 2);
          c.stroke();
          c.setLineDash([]);
        }
      }

      // names
      c.textAlign = 'center';
      c.font = `400 ${THREE.MathUtils.clamp(11 + view.zoom * 8, 15, 22)}px 'Pirata One', serif`;
      for (const island of state.islands) {
        if (!state.fog.found.has(island)) continue;
        const [sx, sy] = S(island.center.x, island.center.z);
        const ly = sy + island.radius * 1.22 * view.zoom + 16;
        c.strokeStyle = 'rgba(231,210,160,.85)';
        c.lineWidth = 4;
        c.strokeText(island.name, sx, ly);
        c.fillStyle = INK;
        c.fillText(island.name, sx, ly);
      }
      c.fillStyle = INK_SOFT;
      c.font = `italic 600 ${Math.max(11, Math.min(15, R * 0.04))}px Nunito, serif`;
      c.fillText('beyond this line the sea falls off the world', ox, oy + R - 12);
      const [rx, ry] = S(-WORLD_RADIUS * 0.56, WORLD_RADIUS * 0.52);
      this.rose(c, rx, ry, Math.max(26, R * 0.085));
    }

    // --- courses: a dashed line to a red cross, as on any good treasure map -------------
    for (const ship of state.ships) {
      if (ship.hostile || !ship.course) continue;
      const [ax, ay] = S(ship.position.x, ship.position.z);
      const [bx, by] = S(ship.course.x, ship.course.z);
      c.strokeStyle = '#8f1d1d';
      c.lineWidth = mini ? 1 : 2;
      c.setLineDash(mini ? [3, 3] : [9, 7]);
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
      c.setLineDash([]);
      const k = mini ? 3 : 8;
      c.lineWidth = mini ? 1.5 : 3.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(bx - k, by - k);
      c.lineTo(bx + k, by + k);
      c.moveTo(bx + k, by - k);
      c.lineTo(bx - k, by + k);
      c.stroke();
      c.lineCap = 'butt';
    }

    // --- ships: raiders only while something of yours can see them ----------------------
    for (let i = state.ships.length - 1; i >= 0; i--) {
      const ship = state.ships[i];
      if (ship.hostile && !state.fog.canSee(ship.position.x, ship.position.z)) continue;
      const [x, y] = S(ship.position.x, ship.position.z);
      const size = mini ? (ship.id === 0 ? 6.5 : 5) : ship.id === 0 ? 15 : 12;
      if (ship.id === opts.selectedShip && !mini) {
        c.strokeStyle = '#8f1d1d';
        c.lineWidth = 2;
        c.setLineDash([5, 4]);
        c.beginPath();
        c.arc(x, y, size * 1.7, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
      drawShipIcon(c, x, y, ship.heading, size, ship.colour, ship.hostile);
      if (!mini) {
        c.font = '800 12px Nunito, sans-serif';
        c.textAlign = 'center';
        c.strokeStyle = 'rgba(231,210,160,.85)';
        c.lineWidth = 3.5;
        c.strokeText(ship.name, x, y + size * 1.5 + 12);
        c.fillStyle = ship.hostile ? '#8f1d1d' : INK;
        c.fillText(ship.name, x, y + size * 1.5 + 12);
      }
    }
    c.restore();
  }

  /** Outline of the sheet of paper: a torn edge all the way round (a plain square for the minimap). */
  private sheetPath(c: CanvasRenderingContext2D, w: number, h: number, mini: boolean): void {
    c.beginPath();
    if (mini) {
      c.rect(0, 0, w, h);
      return;
    }
    const m = 16;
    const step = 26;
    let n = 0;
    const jag = () => EDGE[n++ % EDGE.length] * 12;
    for (let x = m; x < w - m; x += step) c.lineTo(x, m + jag());
    for (let y = m; y < h - m; y += step) c.lineTo(w - m - jag(), y);
    for (let x = w - m; x > m; x -= step) c.lineTo(x, h - m - jag());
    for (let y = h - m; y > m; y -= step) c.lineTo(m + jag(), y);
    c.closePath();
  }

  /** Compass rose: an eight-point star with north marked. */
  private rose(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    c.save();
    c.translate(x, y);
    c.strokeStyle = INK;
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const len = i % 2 ? r * 0.62 : r;
      c.save();
      c.rotate(a);
      c.beginPath();
      c.moveTo(0, -len);
      c.lineTo(r * 0.13, 0);
      c.lineTo(0, r * 0.1);
      c.closePath();
      c.fillStyle = INK;
      c.fill();
      c.beginPath();
      c.moveTo(0, -len);
      c.lineTo(-r * 0.13, 0);
      c.lineTo(0, r * 0.1);
      c.closePath();
      c.fillStyle = '#ead7a8';
      c.fill();
      c.stroke();
      c.restore();
    }
    c.fillStyle = INK;
    c.font = `400 ${Math.round(r * 0.5)}px 'Pirata One', serif`;
    c.textAlign = 'center';
    c.fillText('N', 0, -r * 1.12);
    c.restore();
  }

  /** Repaint the little fog image when the fog has changed. */
  private refreshFog(fog: FogOfWar): void {
    if (fog.version === this.fogVersion) return;
    this.fogVersion = fog.version;
    const px = this.fogImage.data;
    // alpha per cell, then blurred so the fog has a soft edge rather than steps
    let a = this.fogA;
    let b = this.fogB;
    for (let i = 0; i < FOG_N * FOG_N; i++) a[i] = fog.visible[i] ? 0 : fog.explored[i] ? 46 : 168;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < FOG_N; j++) {
        for (let i = 0; i < FOG_N; i++) {
          let sum = 0;
          let n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const x = i + di;
              const y = j + dj;
              if (x < 0 || y < 0 || x >= FOG_N || y >= FOG_N) continue;
              sum += a[y * FOG_N + x];
              n++;
            }
          }
          b[j * FOG_N + i] = sum / n;
        }
      }
      [a, b] = [b, a];
    }
    for (let i = 0; i < FOG_N * FOG_N; i++) {
      const o = i * 4;
      px[o] = 66;
      px[o + 1] = 46;
      px[o + 2] = 26;
      px[o + 3] = a[i];
    }
    this.fogCanvas.getContext('2d')!.putImageData(this.fogImage, 0, 0);
  }
}

/**
 * The chart: an old paper map of the world, opened over the game (which keeps
 * running). Controls follow an RTS: left click selects an island or one of
 * your ships, right click orders the selected ship (the flagship if none) to
 * sail there, drag pans, the wheel zooms. Only what you have explored is
 * drawn, and raiders show only while you can see them.
 */
export class MapView {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly info: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly painter = new MapPainter();
  private readonly view: View = { cx: 0, cz: 0, zoom: 0.4 };
  private selected: Island | null = null;
  private selectedShip: number | null = null;
  private state: MapState | null = null;
  private infoKey = '';
  /** Extra HTML for the selected island's panel (territory actions), set by the game. */
  islandActions: ((island: Island) => string) | null = null;
  /** Called when a button with data-island-act inside the panel is pressed. */
  onIslandAction: ((island: Island, act: string) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly actions: MapActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'chart';
    this.root.hidden = true;
    this.root.innerHTML = `
      <canvas></canvas>
      <div class="chart-title">Chart</div>
      <div class="chart-help"><b>Left click</b> select an island or ship · <b>Right click</b> send the selected ship there · <b>Drag</b> pan · <b>Wheel</b> zoom · <b>Tab</b> close</div>
      <div class="chart-info hud-panel" data-info hidden></div>
      <button class="chart-close" data-close>Close</button>`;
    parent.append(this.root);
    this.canvas = this.root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.info = this.root.querySelector('[data-info]') as HTMLElement;

    let dragging = false;
    let moved = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = 0;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (moved < 5) return;
      this.view.cx -= e.movementX / this.view.zoom;
      this.view.cz -= e.movementY / this.view.zoom;
      this.clampView();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      dragging = false;
      this.canvas.releasePointerCapture(e.pointerId);
      if (moved < 5) this.select(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY);
      if (Math.hypot(w.x, w.z) < WORLD_RADIUS - 20) this.actions.order(this.selectedShip ?? 0, w.x, w.z);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.clientX, e.clientY);
        this.view.zoom = THREE.MathUtils.clamp(this.view.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), this.minZoom(), 4);
        const after = this.toWorld(e.clientX, e.clientY);
        this.view.cx += before.x - after.x;
        this.view.cz += before.z - after.z;
        this.clampView();
      },
      { passive: false },
    );
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      if ('close' in btn.dataset) this.actions.close();
      else if (btn.dataset.islandAct && this.selected) this.onIslandAction?.(this.selected, btn.dataset.islandAct);
      else if (btn.dataset.shipAct === 'follow' && this.selectedShip !== null) this.actions.follow(this.selectedShip);
      btn.blur();
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.view.zoom = this.minZoom();
    this.view.cx = this.view.cz = 0;
    this.infoKey = '';
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Show an island's panel (used when the game wants to point at one). */
  selectIsland(island: Island | null): void {
    this.selected = island;
    this.selectedShip = null;
    this.infoKey = '';
  }

  private minZoom(): number {
    return (Math.min(window.innerWidth, window.innerHeight) * 0.41) / WORLD_RADIUS;
  }

  private clampView(): void {
    const r = Math.hypot(this.view.cx, this.view.cz);
    if (r > WORLD_RADIUS) {
      this.view.cx *= WORLD_RADIUS / r;
      this.view.cz *= WORLD_RADIUS / r;
    }
  }

  private toWorld(clientX: number, clientY: number): { x: number; z: number } {
    return { x: this.view.cx + (clientX - window.innerWidth / 2) / this.view.zoom, z: this.view.cz + (clientY - window.innerHeight / 2) / this.view.zoom };
  }

  private select(clientX: number, clientY: number): void {
    const w = this.toWorld(clientX, clientY);
    const state = this.state;
    this.infoKey = '';
    // one of your own ships first, then an island you have found
    const ship = state?.ships.find((s) => s.mine !== false && !s.hostile && Math.hypot(w.x - s.position.x, w.z - s.position.z) * this.view.zoom < 20);
    if (ship) {
      this.selectedShip = ship.id;
      this.selected = null;
      return;
    }
    this.selectedShip = null;
    this.selected = state?.islands.find((i) => state.fog.found.has(i) && Math.hypot(w.x - i.center.x, w.z - i.center.z) < Math.max(i.radius, 14 / this.view.zoom)) ?? null;
  }

  /** Redraw. Call every frame while the chart is open. */
  draw(state: MapState): void {
    this.state = state;
    if (this.selectedShip !== null && !state.ships.some((s) => s.id === this.selectedShip)) this.selectedShip = null;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.painter.paint(this.ctx, w, h, this.view, state, { mini: false, selectedIsland: this.selected, selectedShip: this.selectedShip });
    this.refreshInfo(state);
  }

  private refreshInfo(state: MapState): void {
    const sel = this.selected;
    const ship = this.selectedShip === null ? null : (state.ships.find((s) => s.id === this.selectedShip) ?? null);
    const extra = sel && this.islandActions ? this.islandActions(sel) : '';
    const key = sel
      ? [sel.name, sel.owner, ...RESOURCE_IDS.map((id) => sel.stock[id]), extra].join('|')
      : ship
        ? [ship.id, Math.round(ship.health * 100), ship.note, !!ship.course].join('|')
        : '';
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.info.hidden = !sel && !ship;
    if (ship) {
      this.info.innerHTML = `
        <div class="island-name">${ship.name}</div>
        <div class="island-type">${ship.id === 0 ? 'Your flagship' : 'Escort'} · ${ship.note}</div>
        <div class="row"><span>Hull</span><b>${Math.round(ship.health * 100)}%</b></div>
        <div class="chart-hint">Right click the chart to send her there.</div>
        ${ship.id !== 0 ? '<button data-ship-act="follow">Follow the flagship</button>' : ''}`;
      return;
    }
    if (!sel) return;
    const owner = sel.owner === 0 ? `<span style="color:${state.colourOf(0)}">Yours</span>` : sel.owner > 0 ? `Held by ${state.nameOf(sel.owner)}` : 'Unclaimed';
    const res = RESOURCE_IDS.filter((id) => sel.capacity[id] > 0)
      .map((id) => `<div class="row"><span>${RESOURCES[id].label}</span><b>${sel.stock[id]} / ${sel.capacity[id]}</b></div>`)
      .join('');
    this.info.innerHTML = `
      <div class="island-name">${sel.name}</div>
      <div class="island-type">${TYPE_LABEL[sel.type]}${sel.port ? ' · port' : ''} · ${owner}</div>
      ${res}
      ${extra}`;
  }
}

/** The exploration window: a small chart in the corner of the HUD, as in an RTS. Click it to open the chart. */
export class MiniMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly painter = new MapPainter();
  private timer = 0;
  static readonly SIZE = 196;

  constructor(root: HTMLElement, onOpen: () => void) {
    const frame = document.createElement('div');
    frame.className = 'minimap';
    frame.title = 'Open the chart (Tab)';
    this.canvas = document.createElement('canvas');
    frame.append(this.canvas);
    root.append(frame);
    this.ctx = this.canvas.getContext('2d')!;
    frame.addEventListener('click', onOpen);
  }

  /** Repaints a few times a second: plenty for a map this small. */
  update(dt: number, state: MapState): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const size = MiniMap.SIZE;
    if (this.canvas.width !== size * dpr) this.canvas.width = this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.painter.paint(this.ctx, size, size, { cx: 0, cz: 0, zoom: (size * 0.47) / WORLD_RADIUS }, state, { mini: true, selectedIsland: null, selectedShip: null });
  }
}
