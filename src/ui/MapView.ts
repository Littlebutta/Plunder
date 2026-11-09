import * as THREE from 'three';
import type { Island } from '../world/Islands';
import { WORLD_RADIUS } from '../world/worldConfig';

export interface MapShip {
  position: THREE.Vector3;
  /** Compass heading in radians: 0 = north (-Z), clockwise. */
  heading: number;
  colour: string;
  name: string;
  hostile: boolean;
}

export interface MapState {
  islands: Island[];
  player: MapShip;
  others: MapShip[];
  /** Where the flagship has been ordered to sail, if anywhere. */
  course: THREE.Vector3 | null;
  playerColour: string;
}

export interface MapActions {
  /** Right click on open water: sail there. */
  sailTo(x: number, z: number): void;
  close(): void;
}

const TYPE_LABEL: Record<Island['type'], string> = {
  peak: 'Volcanic peak',
  ridge: 'Rocky ridge',
  mesa: 'Mesa',
  hills: 'Green hills',
  cay: 'Sandy cay',
  stacks: 'Sea stacks',
  wreck: 'Shipwreck island',
};
const GREEN: Partial<Record<Island['type'], string>> = { peak: '#4ea653', hills: '#5cb85a', mesa: '#b98a62', ridge: '#9a8478', stacks: '#8f7468' };

/**
 * The chart: a top-down map of the whole world, opened over the game (which
 * keeps running). Controls follow an RTS: left click selects, right click
 * orders the flagship to sail there, drag pans, the wheel zooms.
 */
export class MapView {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly info: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Map centre in world coordinates and pixels per metre. */
  private cx = 0;
  private cz = 0;
  private zoom = 0.4;
  private selected: Island | null = null;
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
      <div class="chart-help"><b>Left click</b> select · <b>Right click</b> sail there · <b>Drag</b> pan · <b>Wheel</b> zoom · <b>Tab</b> close</div>
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
      this.cx -= e.movementX / this.zoom;
      this.cz -= e.movementY / this.zoom;
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
      if (Math.hypot(w.x, w.z) < WORLD_RADIUS - 20) this.actions.sailTo(w.x, w.z);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.clientX, e.clientY);
        this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), this.minZoom(), 4);
        const after = this.toWorld(e.clientX, e.clientY);
        this.cx += before.x - after.x;
        this.cz += before.z - after.z;
        this.clampView();
      },
      { passive: false },
    );
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      if ('close' in btn.dataset) this.actions.close();
      else if (btn.dataset.islandAct && this.selected) this.onIslandAction?.(this.selected, btn.dataset.islandAct);
      btn.blur();
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.zoom = this.minZoom();
    this.cx = this.cz = 0;
    this.infoKey = '';
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Show an island's panel (used when the game wants to point at one). */
  selectIsland(island: Island | null): void {
    this.selected = island;
    this.infoKey = '';
  }

  private minZoom(): number {
    return (Math.min(window.innerWidth, window.innerHeight) * 0.46) / WORLD_RADIUS;
  }

  private clampView(): void {
    const r = Math.hypot(this.cx, this.cz);
    if (r > WORLD_RADIUS) {
      this.cx *= WORLD_RADIUS / r;
      this.cz *= WORLD_RADIUS / r;
    }
  }

  private toWorld(clientX: number, clientY: number): { x: number; z: number } {
    return { x: this.cx + (clientX - window.innerWidth / 2) / this.zoom, z: this.cz + (clientY - window.innerHeight / 2) / this.zoom };
  }

  private toScreen(x: number, z: number): [number, number] {
    return [window.innerWidth / 2 + (x - this.cx) * this.zoom, window.innerHeight / 2 + (z - this.cz) * this.zoom];
  }

  private select(clientX: number, clientY: number): void {
    const w = this.toWorld(clientX, clientY);
    const hit = this.state?.islands.find((i) => Math.hypot(w.x - i.center.x, w.z - i.center.z) < Math.max(i.radius, 14 / this.zoom));
    this.selected = hit ?? null;
    this.infoKey = '';
  }

  /** Redraw. Call every frame while the chart is open. */
  draw(state: MapState): void {
    this.state = state;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the void
    c.fillStyle = '#10161f';
    c.fillRect(0, 0, w, h);
    const [ox, oy] = this.toScreen(0, 0);
    const R = WORLD_RADIUS * this.zoom;
    // the waterfall round the rim, then the sea
    const fall = c.createRadialGradient(ox, oy, R, ox, oy, R * 1.09);
    fall.addColorStop(0, 'rgba(244,251,255,.95)');
    fall.addColorStop(0.25, 'rgba(120,190,230,.55)');
    fall.addColorStop(1, 'rgba(16,22,31,0)');
    c.fillStyle = fall;
    c.beginPath();
    c.arc(ox, oy, R * 1.09, 0, Math.PI * 2);
    c.fill();
    const sea = c.createRadialGradient(ox, oy, R * 0.2, ox, oy, R);
    sea.addColorStop(0, '#1b78c0');
    sea.addColorStop(1, '#135f9f');
    c.fillStyle = sea;
    c.beginPath();
    c.arc(ox, oy, R, 0, Math.PI * 2);
    c.fill();
    // grid, for a sense of distance
    c.save();
    c.beginPath();
    c.arc(ox, oy, R, 0, Math.PI * 2);
    c.clip();
    c.strokeStyle = 'rgba(255,255,255,.07)';
    c.lineWidth = 1;
    for (let g = -WORLD_RADIUS; g <= WORLD_RADIUS; g += 100) {
      const [gx] = this.toScreen(g, 0);
      const [, gy] = this.toScreen(0, g);
      c.beginPath();
      c.moveTo(gx, 0);
      c.lineTo(gx, h);
      c.moveTo(0, gy);
      c.lineTo(w, gy);
      c.stroke();
    }
    c.restore();

    // islands
    c.font = '800 12px Nunito, sans-serif';
    c.textAlign = 'center';
    for (const island of state.islands) {
      const outline = (scale: number, src: (a: number) => number) => {
        c.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          const r = src(a) * scale;
          const [x, y] = this.toScreen(island.center.x + Math.cos(a) * r, island.center.z + Math.sin(a) * r);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.closePath();
      };
      outline(1.18, island.shoreAt);
      c.fillStyle = 'rgba(79,208,207,.55)';
      c.fill();
      outline(1, island.shoreAt);
      c.fillStyle = '#f4dc9a';
      c.fill();
      c.strokeStyle = '#2a1708';
      c.lineWidth = 1.5;
      c.stroke();
      const inner = GREEN[island.type];
      if (inner) {
        outline(0.68, island.shoreAt);
        c.fillStyle = inner;
        c.fill();
      }
      const [sx, sy] = this.toScreen(island.center.x, island.center.z);
      if (island.port) {
        const [px, py] = this.toScreen(island.port.x, island.port.z);
        c.strokeStyle = '#6e3b1b';
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(sx + (px - sx) * 0.75, sy + (py - sy) * 0.75);
        c.lineTo(px, py);
        c.stroke();
      }
      // owner's banner
      if (island.owner !== 'none') {
        const col = island.owner === 'player' ? state.playerColour : '#ffffff';
        c.fillStyle = '#2a1708';
        c.fillRect(sx - 1, sy - 16, 2, 16);
        c.fillStyle = col;
        c.strokeStyle = '#2a1708';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(sx + 1, sy - 16);
        c.lineTo(sx + 13, sy - 12);
        c.lineTo(sx + 1, sy - 8);
        c.closePath();
        c.fill();
        c.stroke();
      }
      if (island === this.selected) {
        c.strokeStyle = '#fff8e6';
        c.lineWidth = 2;
        c.setLineDash([6, 5]);
        c.beginPath();
        c.arc(sx, sy, island.radius * 1.35 * this.zoom + 6, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
      c.fillStyle = '#fff8e6';
      c.strokeStyle = 'rgba(16,22,31,.85)';
      c.lineWidth = 3;
      const ly = sy + island.radius * 1.2 * this.zoom + 14;
      c.strokeText(island.name, sx, ly);
      c.fillText(island.name, sx, ly);
    }

    // course
    if (state.course) {
      const [ax, ay] = this.toScreen(state.player.position.x, state.player.position.z);
      const [bx, by] = this.toScreen(state.course.x, state.course.z);
      c.strokeStyle = '#fff8e6';
      c.lineWidth = 2;
      c.setLineDash([8, 6]);
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.arc(bx, by, 6, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(bx - 9, by);
      c.lineTo(bx + 9, by);
      c.moveTo(bx, by - 9);
      c.lineTo(bx, by + 9);
      c.stroke();
    }

    // ships
    const ship = (s: MapShip, size: number) => {
      const [x, y] = this.toScreen(s.position.x, s.position.z);
      c.save();
      c.translate(x, y);
      c.rotate(s.heading);
      c.beginPath();
      c.moveTo(0, -size);
      c.lineTo(size * 0.62, size * 0.8);
      c.lineTo(0, size * 0.45);
      c.lineTo(-size * 0.62, size * 0.8);
      c.closePath();
      c.fillStyle = s.colour;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = s.hostile ? '#e23b3b' : '#2a1708';
      c.stroke();
      c.restore();
      c.fillStyle = s.hostile ? '#ffd9d9' : '#fff8e6';
      c.strokeStyle = 'rgba(16,22,31,.85)';
      c.lineWidth = 3;
      c.strokeText(s.name, x, y - size - 6);
      c.fillText(s.name, x, y - size - 6);
    };
    for (const o of state.others) ship(o, 9);
    ship(state.player, 11);

    // compass rose
    c.fillStyle = '#ffd27a';
    c.font = '800 14px Nunito, sans-serif';
    c.fillText('N', w - 44, 92);
    c.strokeStyle = '#ffd27a';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(w - 44, 98);
    c.lineTo(w - 44, 130);
    c.moveTo(w - 50, 106);
    c.lineTo(w - 44, 98);
    c.lineTo(w - 38, 106);
    c.stroke();

    this.refreshInfo(state);
  }

  private refreshInfo(state: MapState): void {
    const sel = this.selected;
    const extra = sel && this.islandActions ? this.islandActions(sel) : '';
    const key = sel ? [sel.name, sel.owner, sel.stock.wood, sel.stock.stone, sel.stock.salvage, extra].join('|') : '';
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.info.hidden = !sel;
    if (!sel) return;
    const owner = sel.owner === 'player' ? `<span style="color:${state.playerColour}">Yours</span>` : sel.owner === 'npc' ? 'Held by NPCs' : 'Unclaimed';
    const res = (['wood', 'stone', 'salvage'] as const)
      .filter((id) => sel.capacity[id] > 0)
      .map((id) => `<div class="row"><span>${id[0].toUpperCase() + id.slice(1)}</span><b>${sel.stock[id]} / ${sel.capacity[id]}</b></div>`)
      .join('');
    this.info.innerHTML = `
      <div class="island-name">${sel.name}</div>
      <div class="island-type">${TYPE_LABEL[sel.type]}${sel.port ? ' · port' : ''} · ${owner}</div>
      ${res}
      ${extra}`;
  }
}
