import * as THREE from 'three';
import { fitPage } from './fit';
import { PALETTE } from '../render/palette';
import { toonMaterial } from '../render/toon';
import {
  cannonClash,
  CANNON_SPACING,
  CannonFit,
  cannonProblem,
  CANNON_T_RANGE,
  cloneDesign,
  computeStats,
  escortCost,
  DESIGN_LIMITS,
  gunHeight,
  halfBeamAt,
  HullDesign,
  loadDesign,
  lowestGunLevel,
  MAST_SLOTS,
  MAX_GUN_LEVEL,
  PRESETS,
  rigBoost,
  sanitizeDesign,
  saveDesign,
  sheerAt,
  STATIONS,
} from '../ship/HullDesign';
import { buildShipVisual, disposeShipVisual } from '../ship/ShipVisual';
import { buildGunModel } from '../combat/Broadside';
import { RESOURCE_IDS, RESOURCES, Stock } from '../world/Resources';

export interface ShipyardActions {
  launch(design: HullDesign): void;
  useRaft(): void;
  back(): void;
  /** What the player has in the hold, to compare against the cost. */
  stock(): Stock;
  /** What sailing this design as the flagship would cost now (nothing if she is the ship you already sail). */
  refitCost(design: HullDesign): Stock;
  /** Build the design as an escort. Returns why it could not be done, or ''. */
  escort(design: HullDesign): string;
  /** e.g. "2 of 4": escorts afloat out of the most allowed. */
  fleet(): string;
}

type Tool = 'draw' | 'masts' | 'cannons';

const W = 640;
const TOP_H = 230;
const SIDE_H = 200;
const MARGIN = 34;
const WATERLINE = 78;
const MAX_MASTS = 3;

/**
 * The ship designer.
 *
 * Left: two drawing boards. On the top view you drag to draw the hull's
 * outline (one side; it is mirrored). On the side view you drag to draw the
 * keel line under the water. Tools switch the top view to placing masts
 * (click a ring to cycle square sail, triangle sail, none) and cannons (click
 * anywhere along either edge, on the open deck or a gun deck below it).
 * Sliders set the overall size.
 * Right: the design lofted into 3D, live, with its stats and cost.
 */
export class Shipyard {
  private readonly root: HTMLElement;
  private readonly top: HTMLCanvasElement;
  private readonly side: HTMLCanvasElement;
  private readonly statsEl: HTMLElement;
  private readonly nameEl: HTMLInputElement;
  private design: HullDesign;
  private tool: Tool = 'draw';
  /** Cannons tool: which deck new guns go on, and whether each click places a pair. */
  private gunLevel = 0;
  private mirror = true;
  private warning = '';
  /** Cannons tool: what a click under the pointer would do. */
  private hover: { t: number; side: 1 | -1; ok: boolean; remove: number } | null = null;
  /** Owner's colour for the preview's sails. */
  colour: THREE.ColorRepresentation = PALETTE.sail;
  private dirty = true;

  // 3D preview
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  private readonly preview: HTMLCanvasElement;
  private model: THREE.Group | null = null;
  private yaw = 0.9;
  private pitch = 0.42;
  private zoom = 1;
  private spin = true;
  /** The preview sea: flat, or a rolling swell with the ship riding it. */
  private waves = false;
  private readonly water: THREE.Mesh;
  private readonly waterGeo = new THREE.PlaneGeometry(160, 160, 64, 64);
  private time = 0;
  private orbiting = false;
  private raf = 0;
  private lastTime = 0;

  constructor(
    parent: HTMLElement,
    private readonly actions: ShipyardActions,
  ) {
    this.design = loadDesign() ?? cloneDesign(PRESETS[1]);
    this.root = document.createElement('div');
    this.root.className = 'yard';
    this.root.hidden = true;
    const slider = (key: keyof typeof DESIGN_LIMITS, label: string) =>
      `<label>${label} <b data-val="${key}"></b><input type="range" data-dim="${key}" min="${DESIGN_LIMITS[key][0]}" max="${DESIGN_LIMITS[key][1]}" step="0.1"></label>`;
    this.root.innerHTML = `
      <div class="yard-top">
        <div class="yard-title">Shipyard</div>
        <input class="yard-name" data-name maxlength="24" aria-label="Ship name">
        <div class="yard-row" data-presets>
          <span class="yard-label">Start from</span>
          ${PRESETS.map((p, i) => `<button data-preset="${i}">${p.name}</button>`).join('')}
        </div>
        <div class="yard-stock" data-stock></div>
        <button data-act="back" class="yard-back">Back to sea</button>
      </div>
      <div class="yard-left">
        <div class="yard-tabs" data-tools>
          <button data-tool="draw"><i>1</i>Hull</button>
          <button data-tool="masts"><i>2</i>Sails</button>
          <button data-tool="cannons"><i>3</i>Guns</button>
        </div>
        <div class="yard-card">
          <div class="yard-sliders" data-sliders>
            ${slider('length', 'Length')}${slider('beam', 'Beam')}${slider('depth', 'Keel depth')}${slider('freeboard', 'Freeboard')}
          </div>
          <div class="yard-opts" data-opts></div>
          <div class="yard-tip" data-tip></div>
        </div>
        <div class="yard-board"><span>Top view</span><canvas data-top width="${W}" height="${TOP_H}"></canvas></div>
        <div class="yard-board"><span>Side view</span><canvas data-side width="${W}" height="${SIDE_H}"></canvas></div>
      </div>
      <div class="yard-right">
        <div class="yard-view">
          <canvas data-preview></canvas>
          <div class="yard-viewbar">
            <button data-view="quarter">3/4</button><button data-view="side">Side</button><button data-view="top">Top</button><button data-view="stern">Stern</button><button data-view="spin">Spin</button><button data-view="waves" title="Show her riding a swell">Waves</button>
            <span>Drag to turn · wheel to zoom</span>
          </div>
        </div>
        <div class="yard-stats" data-stats></div>
        <div class="yard-actions">
          <button data-act="raft" class="quiet">Use the starter raft</button>
          <button data-act="escort"><b>Build as an escort</b><small data-escortcost></small></button>
          <button data-act="launch" class="primary"><b>Sail her as your flagship</b><small data-launchcost></small></button>
        </div>
      </div>`;
    parent.append(this.root);
    // no scroll bars: the whole yard shrinks to fit when the left column would overflow
    fitPage(this.root, () => [this.root.querySelector('.yard-left') as HTMLElement]);
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.top = q('[data-top]');
    this.side = q('[data-side]');
    this.statsEl = q('[data-stats]');
    this.nameEl = q('[data-name]');
    this.preview = q('[data-preview]');

    // --- preview scene ---
    this.renderer = new THREE.WebGLRenderer({ canvas: this.preview, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(PALETTE.skyMid);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
    sun.position.set(-6, 9, 5);
    this.scene.add(sun, new THREE.HemisphereLight(0xbfe6ff, 0x1d5f99, 1.3));
    this.waterGeo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(this.waterGeo, toonMaterial(PALETTE.oceanMid, { transparent: true, opacity: 0.82 }));
    this.scene.add(this.water);

    // --- events ---
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      this.warning = '';
      if (btn.dataset.preset) {
        this.design = cloneDesign(PRESETS[Number(btn.dataset.preset)]);
        this.changed();
      } else if (btn.dataset.tool) {
        this.tool = btn.dataset.tool as Tool;
        // turn the model side-on for the guns, so they can be seen going in
        if (this.tool === 'cannons') this.setView('side');
        this.changed(false);
      } else if (btn.dataset.view) {
        this.setView(btn.dataset.view);
        this.refreshPanel();
      } else if (btn.dataset.level) {
        this.gunLevel = Number(btn.dataset.level);
        this.changed(false);
      } else if (btn.dataset.swivel) {
        this.design.swivel = btn.dataset.swivel === 'stern' ? 'stern' : 'bow';
        this.changed();
      } else if (btn.dataset.act === 'clear-guns') {
        this.design.cannons = [];
        this.changed();
      } else if (btn.dataset.act === 'launch') {
        saveDesign(this.design);
        actions.launch(cloneDesign(this.design));
      } else if (btn.dataset.act === 'escort') {
        saveDesign(this.design);
        const why = actions.escort(cloneDesign(this.design));
        this.warn(why || `${this.design.name} launched as an escort. She waits for you off the dock.`);
      } else if (btn.dataset.act === 'raft') actions.useRaft();
      else if (btn.dataset.act === 'back') actions.back();
      btn.blur();
    });
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const dim = el.dataset.dim as keyof typeof DESIGN_LIMITS | undefined;
      if (dim) {
        this.design[dim] = Number(el.value);
        this.changed();
      } else if ('mirror' in el.dataset) {
        this.mirror = el.checked;
      } else if ('jib' in el.dataset) {
        this.design.jib = el.checked;
        this.changed();
      } else if (el === this.nameEl) {
        this.design.name = el.value.trim() || 'Ship';
        saveDesign(this.design);
      }
    });
    // keep typing in the name box from steering the ship behind the overlay
    this.nameEl.addEventListener('keydown', (e) => e.stopPropagation());
    this.bindBoard(this.top, true);
    this.bindBoard(this.side, false);

    this.preview.addEventListener('pointerdown', (e) => {
      this.orbiting = true;
      this.preview.setPointerCapture(e.pointerId);
    });
    this.preview.addEventListener('pointerup', (e) => {
      this.orbiting = false;
      this.preview.releasePointerCapture(e.pointerId);
    });
    this.preview.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY < 0 ? 1 / 1.12 : 1.12), 0.35, 1.8);
      },
      { passive: false },
    );
    this.preview.addEventListener('pointermove', (e) => {
      if (!this.orbiting) return;
      this.spin = false;
      this.yaw -= e.movementX * 0.008;
      this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.006, 0.05, 1.3);
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.warning = '';
    this.changed(false);
    this.lastTime = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (this.root.hidden) return;
      this.renderPreview();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
  }

  /** Show a message in the tip line (e.g. why a launch was refused). */
  warn(message: string): void {
    this.warning = message;
    this.refreshPanel();
  }

  private setView(view: string): void {
    if (view === 'spin') {
      this.spin = !this.spin;
      return;
    }
    if (view === 'waves') {
      this.waves = !this.waves;
      if (!this.waves) this.flatten();
      return;
    }
    this.spin = false;
    const v = { quarter: [0.9, 0.42], side: [Math.PI / 2, 0.16], top: [Math.PI / 2, 1.3], stern: [0, 0.3] }[view] ?? [0.9, 0.42];
    this.yaw = v[0];
    this.pitch = v[1];
    this.zoom = 1;
  }

  /** Current design (a copy). */
  get current(): HullDesign {
    return cloneDesign(this.design);
  }

  // --- drawing boards -----------------------------------------------------------

  private xOf(t: number): number {
    return MARGIN + t * (W - MARGIN * 2);
  }

  private tOf(x: number): number {
    return (x - MARGIN) / (W - MARGIN * 2);
  }

  private bindBoard(canvas: HTMLCanvasElement, isTop: boolean): void {
    let drawing = false;
    let last: { f: number; v: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
    };
    const paint = (e: PointerEvent) => {
      const { x, y } = local(e);
      const f = THREE.MathUtils.clamp(this.tOf(x), 0, 1) * (STATIONS - 1);
      const v = isTop
        ? THREE.MathUtils.clamp(Math.abs(y - TOP_H / 2) / (TOP_H / 2 - 18), 0.02, 1)
        : THREE.MathUtils.clamp((y - WATERLINE) / (SIDE_H - WATERLINE - 14), 0.05, 1);
      const arr = isTop ? this.design.plan : this.design.keel;
      // fill every station between the previous pointer sample and this one
      const from = last ?? { f, v };
      const lo = Math.min(from.f, f);
      const hi = Math.max(from.f, f);
      for (let i = Math.ceil(lo - 0.5); i <= Math.floor(hi + 0.5); i++) {
        if (i < 0 || i >= STATIONS) continue;
        const k = hi - lo < 1e-6 ? 1 : (i - from.f) / (f - from.f);
        arr[i] = from.v + (v - from.v) * THREE.MathUtils.clamp(k, 0, 1);
      }
      last = { f, v };
      this.changed(false);
    };
    /** Cannons: a drag keeps doing what its first click did (placing, or taking guns off). */
    let gunDrag: 'place' | 'remove' | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (isTop && this.tool === 'cannons') {
        const at = local(e);
        const spot = this.gunSpot(at.x, at.y);
        gunDrag = spot.remove >= 0 ? 'remove' : 'place';
        canvas.setPointerCapture(e.pointerId);
        this.gunAt(spot, gunDrag);
        return;
      }
      if (isTop && this.tool !== 'draw') {
        const at = local(e);
        this.placeAt(at.x, at.y);
        return;
      }
      if (!isTop && this.tool !== 'draw') return;
      drawing = true;
      last = null;
      canvas.setPointerCapture(e.pointerId);
      paint(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drawing) paint(e);
      if (isTop && this.tool === 'cannons') {
        const at = local(e);
        const spot = this.gunSpot(at.x, at.y);
        if (gunDrag && (gunDrag === 'remove' || spot.ok)) this.gunAt(spot, gunDrag);
        this.hover = spot;
        this.drawTop();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.hover) return;
      this.hover = null;
      this.drawTop();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!gunDrag) return;
      gunDrag = null;
      canvas.releasePointerCapture(e.pointerId);
      this.changed();
    });
    const end = (e: PointerEvent) => {
      if (!drawing) return;
      drawing = false;
      canvas.releasePointerCapture(e.pointerId);
      // take the wobble out of a freehand line, then store
      const arr = isTop ? this.design.plan : this.design.keel;
      for (let pass = 0; pass < 2; pass++) {
        const src = [...arr];
        for (let i = 1; i < STATIONS - 1; i++) arr[i] = src[i - 1] * 0.25 + src[i] * 0.5 + src[i + 1] * 0.25;
      }
      this.changed();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /**
   * Cannons tool: the spot under the pointer. Over a gun, that gun (to take
   * off); otherwise the nearest place within a metre or so where a gun fits on
   * this deck, so a click a little off still lands.
   */
  private gunSpot(x: number, y: number): { t: number; side: 1 | -1; ok: boolean; remove: number } {
    const d = this.design;
    const side: 1 | -1 = y < TOP_H / 2 ? 1 : -1;
    const raw = THREE.MathUtils.clamp(this.tOf(x), CANNON_T_RANGE[0], CANNON_T_RANGE[1]);
    const pxPerT = W - MARGIN * 2;
    // a gun already there (either side when placing pairs)
    let remove = -1;
    let best = Infinity;
    d.cannons.forEach((g, i) => {
      if (g.level !== this.gunLevel || (g.side !== side && !this.mirror)) return;
      const px = Math.abs(g.t - raw) * pxPerT;
      if (px < Math.max(9, (CANNON_SPACING / d.length) * pxPerT * 0.5) && px < best) {
        best = px;
        remove = i;
      }
    });
    if (remove >= 0) return { t: d.cannons[remove].t, side, ok: true, remove };
    const fits = (t: number) => {
      const mine: CannonFit = { t, side, level: this.gunLevel };
      if (cannonProblem(d, mine) || cannonClash(d, mine) >= 0) return false;
      if (!this.mirror) return true;
      const twin: CannonFit = { t, side: -side as 1 | -1, level: this.gunLevel };
      return !cannonProblem(d, twin) && cannonClash(d, twin) < 0;
    };
    const step = 0.1 / d.length;
    for (let k = 0; k <= 14; k++) {
      for (const sgn of k ? [1, -1] : [1]) {
        const t = raw + sgn * k * step;
        if (t < CANNON_T_RANGE[0] || t > CANNON_T_RANGE[1]) continue;
        if (fits(t)) return { t, side, ok: true, remove: -1 };
      }
    }
    return { t: raw, side, ok: false, remove: -1 };
  }

  /** Cannons tool: place a gun (and its twin) at a spot, or take one off. */
  private gunAt(spot: { t: number; side: 1 | -1; ok: boolean; remove: number }, mode: 'place' | 'remove'): void {
    const d = this.design;
    this.warning = '';
    if (mode === 'remove') {
      if (spot.remove < 0) return;
      const gone = d.cannons[spot.remove];
      d.cannons = d.cannons.filter((c) => !(c.level === gone.level && Math.abs(c.t - gone.t) < 1e-6 && (c.side === gone.side || this.mirror)));
    } else {
      if (spot.remove >= 0) return;
      if (!spot.ok) {
        this.warning = cannonProblem(d, { t: spot.t, side: spot.side, level: this.gunLevel }) ?? 'No room for a gun there: too close to the next one.';
        this.refreshPanel();
        return;
      }
      d.cannons.push({ t: spot.t, side: spot.side, level: this.gunLevel });
      if (this.mirror) d.cannons.push({ t: spot.t, side: -spot.side as 1 | -1, level: this.gunLevel });
      d.cannons.sort((a, b) => a.level - b.level || a.t - b.t || b.side - a.side);
    }
    this.dirty = true;
    this.hover = null;
    this.drawTop();
    this.drawSide();
    this.refreshPanel();
  }

  /** Masts / cannons tool: a click on the top view. */
  private placeAt(x: number, y: number): void {
    const d = this.design;
    this.warning = '';
    if (this.tool === 'masts') {
      const t = MAST_SLOTS.reduce((best, s) => (Math.abs(this.xOf(s) - x) < Math.abs(this.xOf(best) - x) ? s : best));
      if (Math.abs(this.xOf(t) - x) > 24) return;
      // each click steps the slot on: empty, square sail, triangle sail, empty
      const at = d.masts.findIndex((m) => m.t === t);
      if (at < 0) {
        if (d.masts.length < MAX_MASTS) d.masts.push({ t, sail: 'square' });
        else this.warning = `A ship carries at most ${MAX_MASTS} masts.`;
      } else if (d.masts[at].sail === 'square') d.masts[at].sail = 'lateen';
      else d.masts.splice(at, 1);
      // the main mast (first in the list) is the one nearest the middle
      d.masts.sort((a, b) => Math.abs(a.t - 0.46) - Math.abs(b.t - 0.46));
      this.changed();
      return;
    }
    // Cannons: anywhere along either edge. Above the centre line is starboard (the bow points left).
    const t = THREE.MathUtils.clamp(this.tOf(x), CANNON_T_RANGE[0], CANNON_T_RANGE[1]);
    const side: 1 | -1 = y < TOP_H / 2 ? 1 : -1;
    const fits: CannonFit[] = [{ t, side, level: this.gunLevel }];
    if (this.mirror) fits.push({ t, side: -side as 1 | -1, level: this.gunLevel });
    // clicking a gun that is already there takes it (and its twin) away
    const hit = cannonClash(d, fits[0]);
    if (hit >= 0 && Math.abs(d.cannons[hit].t - t) * (W - MARGIN * 2) < 12) {
      const gone = d.cannons[hit];
      d.cannons = d.cannons.filter((c) => !(c.level === gone.level && Math.abs(c.t - gone.t) < 1e-6 && (c.side === gone.side || this.mirror)));
      this.changed();
      return;
    }
    for (const f of fits) {
      const why = cannonProblem(d, f) ?? (cannonClash(d, f) >= 0 ? 'Too close to another gun on that side.' : null);
      if (why) this.warning = why;
      else d.cannons.push(f);
    }
    d.cannons.sort((a, b) => a.level - b.level || a.t - b.t || b.side - a.side);
    this.changed();
  }

  private changed(store = true): void {
    this.design = sanitizeDesign(this.design);
    if (store) saveDesign(this.design);
    this.dirty = true;
    this.drawTop();
    this.drawSide();
    this.refreshPanel();
  }

  private drawTop(): void {
    const c = this.top.getContext('2d')!;
    const d = this.design;
    const cy = TOP_H / 2;
    const scale = TOP_H / 2 - 18;
    c.clearRect(0, 0, W, TOP_H);
    c.fillStyle = '#1b5f97';
    c.fillRect(0, 0, W, TOP_H);
    // hull
    c.beginPath();
    for (let i = 0; i < STATIONS; i++) c.lineTo(this.xOf(i / (STATIONS - 1)), cy - d.plan[i] * scale);
    for (let i = STATIONS - 1; i >= 0; i--) c.lineTo(this.xOf(i / (STATIONS - 1)), cy + d.plan[i] * scale);
    c.closePath();
    c.fillStyle = '#c0814a';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = '#2a1708';
    c.stroke();
    c.setLineDash([6, 6]);
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(42,23,8,.5)';
    c.beginPath();
    c.moveTo(this.xOf(0), cy);
    c.lineTo(this.xOf(1), cy);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255,248,230,.75)';
    c.font = '700 12px Nunito, sans-serif';
    c.fillText('BOW', 4, cy + 4);
    c.fillText('STERN', W - 44, cy + 4);

    // snap points and what is placed on them
    if (this.tool === 'masts') {
      for (const s of MAST_SLOTS) {
        c.beginPath();
        c.arc(this.xOf(s), cy, 9, 0, Math.PI * 2);
        c.strokeStyle = '#fff8e6';
        c.lineWidth = 2;
        c.stroke();
      }
    }
    for (const m of d.masts) {
      const x = this.xOf(m.t);
      // the sail as seen from above: a bar across for a square sail, a wedge for a triangle
      c.strokeStyle = '#f3e6c8';
      c.fillStyle = 'rgba(243,230,200,.85)';
      c.lineWidth = 5;
      c.beginPath();
      if (m.sail === 'square') {
        c.moveTo(x, cy - 30);
        c.lineTo(x, cy + 30);
        c.stroke();
      } else {
        c.moveTo(x - 12, cy);
        c.lineTo(x + 34, cy - 9);
        c.lineTo(x + 34, cy + 9);
        c.closePath();
        c.fill();
      }
      c.beginPath();
      c.arc(x, cy, 7, 0, Math.PI * 2);
      c.fillStyle = '#6e3b1b';
      c.fill();
      c.strokeStyle = '#f3e6c8';
      c.lineWidth = 2;
      c.stroke();
    }
    if (d.jib && d.masts.length > 0) {
      const fore = Math.min(...d.masts.map((m) => m.t));
      c.fillStyle = 'rgba(243,230,200,.85)';
      c.beginPath();
      c.moveTo(this.xOf(0) - 22, cy);
      c.lineTo(this.xOf(fore) - 10, cy - 6);
      c.lineTo(this.xOf(fore) - 10, cy + 6);
      c.closePath();
      c.fill();
    }
    // swivel gun
    c.fillStyle = '#b7853b';
    c.beginPath();
    c.arc(this.xOf(d.swivel === 'stern' ? 0.94 : 0.09), cy, 5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#2a1708';
    c.lineWidth = 1.5;
    c.stroke();

    // Cannons. Starboard is drawn above the centre line. Deck guns sit inside the
    // rail; guns on the decks below poke out through it, further for each deck down.
    const edge = (t: number) => (halfBeamAt(d, t) / (d.beam / 2)) * scale;
    if (this.tool === 'cannons') {
      // where the deck being placed on has room
      c.strokeStyle = 'rgba(255,248,230,.9)';
      c.lineWidth = 2;
      c.setLineDash([3, 5]);
      for (const side of [-1, 1]) {
        c.beginPath();
        let open = false;
        for (let i = 0; i <= 80; i++) {
          const t = CANNON_T_RANGE[0] + ((CANNON_T_RANGE[1] - CANNON_T_RANGE[0]) * i) / 80;
          const ok = cannonProblem(d, { t, side: 1, level: this.gunLevel }) === null;
          const yy = cy - side * (edge(t) + (this.gunLevel === 0 ? -11 : 4 + this.gunLevel * 5));
          if (ok && open) c.lineTo(this.xOf(t), yy);
          else if (ok) c.moveTo(this.xOf(t), yy);
          open = ok;
        }
        c.stroke();
      }
      c.setLineDash([]);
    }
    // lower decks first, so the open deck's guns draw over them
    const order = [...d.cannons].sort((a, b) => b.level - a.level);
    for (const g of order) {
      const active = this.tool !== 'cannons' || g.level === this.gunLevel;
      const marked = this.hover && this.hover.remove >= 0 && Math.abs(d.cannons[this.hover.remove].t - g.t) < 1e-6 && g.level === d.cannons[this.hover.remove].level && (g.side === this.hover.side || this.mirror);
      drawGun(c, this.xOf(g.t), cy, g.side, edge(g.t), g.level, active ? 1 : 0.4, marked ? 'remove' : 'gun');
    }
    // what a click would do
    const h = this.hover;
    if (this.tool === 'cannons' && h && h.remove < 0) {
      for (const side of this.mirror ? [h.side, -h.side as 1 | -1] : [h.side]) drawGun(c, this.xOf(h.t), cy, side, edge(h.t), this.gunLevel, 0.75, h.ok ? 'ghost' : 'bad');
    }
    c.fillStyle = 'rgba(255,248,230,.75)';
    c.fillText('STARBOARD', W - 82, 14);
    c.fillText('PORT', W - 44, TOP_H - 6);
  }

  private drawSide(): void {
    const c = this.side.getContext('2d')!;
    const d = this.design;
    const depthPx = SIDE_H - WATERLINE - 14;
    const sheerPx = (t: number) => WATERLINE - (sheerAt(d, t) / (DESIGN_LIMITS.freeboard[1] * 1.6)) * (WATERLINE - 30);
    c.clearRect(0, 0, W, SIDE_H);
    c.fillStyle = '#8fd0f2';
    c.fillRect(0, 0, W, WATERLINE);
    c.fillStyle = '#1b5f97';
    c.fillRect(0, WATERLINE, W, SIDE_H - WATERLINE);
    // masts behind the hull
    c.strokeStyle = '#6e3b1b';
    c.lineWidth = 4;
    for (const m of d.masts) {
      c.beginPath();
      c.moveTo(this.xOf(m.t), sheerPx(m.t));
      c.lineTo(this.xOf(m.t), 6);
      c.stroke();
    }
    c.beginPath();
    for (let i = 0; i < STATIONS; i++) c.lineTo(this.xOf(i / (STATIONS - 1)), sheerPx(i / (STATIONS - 1)));
    for (let i = STATIONS - 1; i >= 0; i--) c.lineTo(this.xOf(i / (STATIONS - 1)), WATERLINE + d.keel[i] * depthPx);
    c.closePath();
    c.fillStyle = '#9a5a2c';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = '#2a1708';
    c.stroke();
    // gun ports of the decks below, and the muzzles of the deck guns at the rail
    const hPx = (h: number) => WATERLINE - (h / (DESIGN_LIMITS.freeboard[1] * 1.6)) * (WATERLINE - 30);
    for (const g of d.cannons) {
      if (g.side !== 1 && d.cannons.some((o) => o.side === 1 && o.level === g.level && Math.abs(o.t - g.t) < 1e-6)) continue;
      const y = hPx(gunHeight(d, g.t, g.level));
      const x = this.xOf(g.t);
      if (g.level > 0) {
        // a gun port: dark opening, its lid propped open above
        c.fillStyle = '#5e3518';
        c.fillRect(x - 6, y - 12, 12, 4);
        c.fillStyle = '#1a0f08';
        c.fillRect(x - 5, y - 5, 10, 10);
      }
      // the muzzle looking out at you
      c.beginPath();
      c.arc(x, y, g.level ? 3.6 : 3.2, 0, Math.PI * 2);
      c.fillStyle = '#4a4c52';
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = '#121214';
      c.stroke();
      c.beginPath();
      c.arc(x, y, 1.4, 0, Math.PI * 2);
      c.fillStyle = '#050505';
      c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,.7)';
    c.lineWidth = 1;
    c.setLineDash([6, 6]);
    c.beginPath();
    c.moveTo(0, WATERLINE);
    c.lineTo(W, WATERLINE);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255,248,230,.8)';
    c.font = '700 12px Nunito, sans-serif';
    c.fillText('waterline', 6, WATERLINE - 5);
  }

  private refreshPanel(): void {
    const d = this.design;
    const s = computeStats(d);
    const have = this.actions.stock();
    if (document.activeElement !== this.nameEl) this.nameEl.value = d.name;
    for (const key of Object.keys(DESIGN_LIMITS) as (keyof typeof DESIGN_LIMITS)[]) {
      (this.root.querySelector(`[data-dim="${key}"]`) as HTMLInputElement).value = String(d[key]);
      (this.root.querySelector(`[data-val="${key}"]`) as HTMLElement).textContent = `${d[key].toFixed(1)} m`;
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === this.tool));
    (this.root.querySelector('[data-sliders]') as HTMLElement).hidden = this.tool !== 'draw';
    (this.root.querySelector('[data-view="spin"]') as HTMLElement).classList.toggle('on', this.spin);
    (this.root.querySelector('[data-view="waves"]') as HTMLElement).classList.toggle('on', this.waves);
    const tip = this.root.querySelector('[data-tip]') as HTMLElement;
    tip.textContent =
      this.warning ||
      {
        draw: 'Drag on the top view to draw the outline, and on the side view to draw the keel.',
        masts: `Click a ring on the top view: square sail (best with the wind behind), then triangle sail (best with the wind on the beam or ahead), then none. Up to ${MAX_MASTS} masts.`,
        cannons: `Click along either edge of the top view to place a cannon; click one to remove it. Fit as many as the hull has room for: each one adds 2 metals to what the ship costs to build. Lower decks need a tall enough hull (freeboard).`,
      }[this.tool];
    tip.classList.toggle('warn', !!this.warning);
    // options for the current tool
    const opts = this.root.querySelector('[data-opts]') as HTMLElement;
    const deepest = Math.max(...[0.3, 0.4, 0.5, 0.6, 0.7].map((t) => lowestGunLevel(d, t)));
    if (this.gunLevel > deepest) this.gunLevel = deepest;
    const levelName = (n: number) => (n === 0 ? 'Open deck' : `Gun deck ${n}`);
    const optsHtml =
      this.tool === 'masts'
        ? `<label><input type="checkbox" data-jib ${d.jib ? 'checked' : ''} ${d.masts.length ? '' : 'disabled'}> Jib (headsail: helps when sailing across or into the wind)</label>`
        : this.tool === 'cannons'
          ? `<div class="yard-row"><span>Place on</span>${Array.from({ length: MAX_GUN_LEVEL + 1 }, (_, n) => `<button data-level="${n}" class="${n === this.gunLevel ? 'on' : ''}" ${n > deepest ? 'disabled title="Under the waterline on this hull"' : ''}>${levelName(n)}</button>`).join('')}
             <label><input type="checkbox" data-mirror ${this.mirror ? 'checked' : ''}> Both sides</label></div>
             <div class="yard-row"><span>Swivel gun</span><button data-swivel="bow" class="${d.swivel === 'bow' ? 'on' : ''}">Bow</button><button data-swivel="stern" class="${d.swivel === 'stern' ? 'on' : ''}">Stern</button>
             <button data-act="clear-guns" class="quiet">Clear all guns</button></div>`
          : '';
    if (opts.dataset.html !== optsHtml) {
      opts.dataset.html = optsHtml;
      opts.innerHTML = optsHtml;
    }
    opts.hidden = optsHtml === '';
    const squares = d.masts.filter((m) => m.sail === 'square').length;
    const lateens = d.masts.length - squares;
    const rigText =
      d.masts.length === 0
        ? 'none (oars only, slow)'
        : [squares ? `${squares} square` : '', lateens ? `${lateens} triangle` : '', d.jib ? 'jib' : ''].filter(Boolean).join(' + ');
    const pct = (along: number) => `${Math.round(rigBoost(d, along) * 100)}%`;
    const decks = new Set(d.cannons.map((c) => c.level)).size;
    const deckText = s.guns === 0 ? '' : ` on ${decks} deck${decks > 1 ? 's' : ''}`;
    const turn = s.agility > 0.9 ? 'Nimble' : s.agility > 0.65 ? 'Steady' : 'Heavy';
    const tile = (label: string, value: string, sub = '') => `<div class="tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    this.statsEl.innerHTML =
      tile('Top speed', `${(s.speed * 1.94384).toFixed(1)} kn`) +
      tile('Handling', turn) +
      tile('Cannons', String(s.guns), s.guns ? `${s.gunsPerSide} a side${deckText}` : 'none fitted') +
      tile('Sails', String(d.masts.length), rigText) +
      tile('Size', `${d.length.toFixed(1)} × ${d.beam.toFixed(1)} m`, `${(s.mass / 1000).toFixed(1)} t · draws ${s.draft.toFixed(1)} m`) +
      tile('Wind boost', pct(1), `astern · beam ${pct(0)} · close ${pct(-0.6)}`);
    const short = (ok: boolean, text: string) => `<span class="${ok ? '' : 'short'}">${text}</span>`;
    const ec = escortCost(d);
    const fc = this.actions.refitCost(d);
    (this.root.querySelector('[data-launchcost]') as HTMLElement).innerHTML =
      !fc.wood && !fc.salvage && !fc.stone ? 'already yours' : short(have.wood >= fc.wood, `${fc.wood} wood`) + (fc.salvage ? ' · ' + short(have.salvage >= fc.salvage, `${fc.salvage} metals`) : '');
    (this.root.querySelector('[data-escortcost]') as HTMLElement).innerHTML =
      short(have.wood >= ec.wood, `${ec.wood} wood`) + (ec.salvage ? ' · ' + short(have.salvage >= ec.salvage, `${ec.salvage} metals`) : '') + ` · fleet ${this.actions.fleet()}`;
    (this.root.querySelector('[data-stock]') as HTMLElement).innerHTML =
      `<span>Stores</span>` + RESOURCE_IDS.map((id) => `<span class="res"><i style="background:${RESOURCES[id].color}"></i>${RESOURCES[id].label} <b>${have[id]}</b></span>`).join('');
  }

  // --- 3D preview ---------------------------------------------------------------

  /** Height of the preview swell at a point: a few crossing waves, so it never looks like one pattern. */
  private swell(x: number, z: number): number {
    const t = this.time;
    const L = Math.max(8, this.design.length);
    return (
      Math.sin(x * (2.1 / L) + z * (0.9 / L) - t * 1.3) * 0.34 +
      Math.sin(-x * (1.1 / L) + z * (2.6 / L) - t * 1.7 + 1.3) * 0.22 +
      Math.sin(x * (4.3 / L) - z * (3.1 / L) - t * 2.6 + 4.1) * 0.08
    ) * Math.min(1.6, L / 9);
  }

  /** Move the preview sea and let the ship ride it: heave, pitch and roll from the water under her. */
  private ride(): void {
    const pos = this.waterGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.swell(pos.getX(i), pos.getZ(i)));
    pos.needsUpdate = true;
    this.waterGeo.computeVertexNormals();
    if (!this.model) return;
    const half = this.design.length * 0.4;
    const beam = this.design.beam * 0.45;
    const bow = this.swell(0, -half);
    const stern = this.swell(0, half);
    const port = this.swell(-beam, 0);
    const star = this.swell(beam, 0);
    this.model.position.y = (bow + stern + port + star) / 4;
    this.model.rotation.set(Math.atan2(bow - stern, half * 2) * 0.8, 0, Math.atan2(port - star, beam * 2) * 0.6);
  }

  /** Back to a flat sea, the ship sitting level on it. */
  private flatten(): void {
    const pos = this.waterGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, 0);
    pos.needsUpdate = true;
    this.waterGeo.computeVertexNormals();
    this.model?.position.set(0, 0, 0);
    this.model?.rotation.set(0, 0, 0);
  }

  private renderPreview(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.dirty) {
      this.dirty = false;
      if (this.model) {
        this.scene.remove(this.model);
        disposeShipVisual(this.model);
      }
      const visual = buildShipVisual(this.design, this.colour);
      this.model = visual.group;
      // the guns as they will stand in the game, and a marker for the swivel
      for (const mount of visual.gunMounts) this.model.add(buildGunModel(mount).root);
      const swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.9, 8), toonMaterial(0xb7853b));
      swivel.position.copy(visual.swivelMount).setY(visual.swivelMount.y + 0.45);
      this.model.add(swivel);
      this.scene.add(this.model);
    }
    const w = this.preview.clientWidth;
    const h = this.preview.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.preview.width !== Math.floor(w * this.renderer.getPixelRatio()) || this.preview.height !== Math.floor(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (!this.orbiting && this.spin) this.yaw += dt * 0.25;
    this.time += dt;
    if (this.waves) this.ride();
    const dist = (this.design.length * 1.9 + 6) * this.zoom;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cp * dist, Math.sin(this.pitch) * dist + 1, Math.cos(this.yaw) * cp * dist);
    this.camera.lookAt(0, this.design.length * 0.16, 0);
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * A cannon seen from above. On the open deck: a wooden carriage on four
 * trucks with the barrel run out over the rail. On a gun deck below: just the
 * muzzle poking out of its port in the hull side.
 * @param edge distance from the centre line to the hull side (px)
 */
function drawGun(c: CanvasRenderingContext2D, x: number, cy: number, side: 1 | -1, edge: number, level: number, alpha: number, look: 'gun' | 'ghost' | 'bad' | 'remove'): void {
  c.save();
  c.globalAlpha = alpha;
  // draw in a frame where +y points outboard
  c.translate(x, cy - side * edge);
  if (side > 0) c.scale(1, -1);
  const metal = look === 'bad' ? '#c0392b' : look === 'remove' ? '#e0663a' : look === 'ghost' ? '#7fd67a' : '#43464d';
  const dark = '#141416';
  if (level === 0) {
    // carriage inboard of the rail
    c.fillStyle = look === 'gun' ? '#7a4a24' : 'rgba(255,255,255,.25)';
    c.strokeStyle = dark;
    c.lineWidth = 1.2;
    c.fillRect(-5.5, -17, 11, 12);
    c.strokeRect(-5.5, -17, 11, 12);
    c.fillStyle = dark;
    for (const wx of [-7.5, 5]) for (const wy of [-16, -9]) c.fillRect(wx, wy, 2.5, 4);
    // barrel: breech knob, tapered tube, muzzle ring past the rail
    tube(c, -14, 6, 3.4, 2.4, metal, dark);
  } else {
    // a gun port in the side and the muzzle sticking out of it
    c.fillStyle = dark;
    c.fillRect(-4.5, -2, 9, 3);
    tube(c, -1, 3 + level * 2.5, 3, 2.4, metal, dark);
  }
  c.restore();
}

/** A tapered barrel from y0 to y1 (outboard), with a ring at the muzzle. */
function tube(c: CanvasRenderingContext2D, y0: number, y1: number, r0: number, r1: number, fill: string, ink: string): void {
  c.beginPath();
  c.moveTo(-r0, y0);
  c.lineTo(-r1, y1);
  c.lineTo(r1, y1);
  c.lineTo(r0, y0);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = 1.2;
  c.strokeStyle = ink;
  c.stroke();
  // breech knob
  c.beginPath();
  c.arc(0, y0 - 1, r0 * 0.6, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
  c.stroke();
  // muzzle ring
  c.fillStyle = ink;
  c.fillRect(-r1 - 0.8, y1 - 1.6, r1 * 2 + 1.6, 1.6);
}
