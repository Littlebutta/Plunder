import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { toonMaterial } from '../render/toon';
import {
  CANNON_MIN_HALF_BEAM,
  CANNON_SLOTS,
  cloneDesign,
  computeStats,
  DESIGN_LIMITS,
  halfBeamAt,
  HullDesign,
  loadDesign,
  MAST_SLOTS,
  PRESETS,
  sanitizeDesign,
  saveDesign,
  sheerAt,
  STATIONS,
} from '../ship/HullDesign';
import { buildShipVisual, disposeShipVisual } from '../ship/ShipVisual';
import type { Stock } from '../world/Resources';

export interface ShipyardActions {
  launch(design: HullDesign): void;
  useRaft(): void;
  back(): void;
  /** What the player has in the hold, to compare against the cost. */
  stock(): Stock;
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
 * keel line under the water. Tools switch the top view to placing masts and
 * cannon pairs on snap points. Sliders set the overall size.
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
  private dirty = true;

  // 3D preview
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  private readonly preview: HTMLCanvasElement;
  private model: THREE.Group | null = null;
  private yaw = 0.9;
  private pitch = 0.42;
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
      <div class="yard-left">
        <div class="yard-head">
          <div class="yard-title">Shipyard</div>
          <input class="yard-name" data-name maxlength="24" aria-label="Ship name">
        </div>
        <div class="yard-row" data-presets>
          <span>Start from</span>
          ${PRESETS.map((p, i) => `<button data-preset="${i}">${p.name}</button>`).join('')}
        </div>
        <div class="yard-row" data-tools>
          <button data-tool="draw">Draw hull</button>
          <button data-tool="masts">Place masts</button>
          <button data-tool="cannons">Place cannons</button>
          <span class="yard-tip" data-tip></span>
        </div>
        <div class="yard-board"><span>Top view</span><canvas data-top width="${W}" height="${TOP_H}"></canvas></div>
        <div class="yard-board"><span>Side view</span><canvas data-side width="${W}" height="${SIDE_H}"></canvas></div>
        <div class="yard-sliders">
          ${slider('length', 'Length')}${slider('beam', 'Beam')}${slider('depth', 'Keel depth')}${slider('freeboard', 'Freeboard')}
        </div>
      </div>
      <div class="yard-right">
        <canvas data-preview></canvas>
        <div class="yard-stats" data-stats></div>
        <div class="yard-actions">
          <button data-act="launch" class="primary">Launch this ship</button>
          <button data-act="raft">Use the starter raft</button>
          <button data-act="back">Back</button>
        </div>
      </div>`;
    parent.append(this.root);
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
    const water = new THREE.Mesh(new THREE.CircleGeometry(120, 48), toonMaterial(PALETTE.oceanMid, { transparent: true, opacity: 0.82 }));
    water.rotation.x = -Math.PI / 2;
    this.scene.add(water);

    // --- events ---
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      if (btn.dataset.preset) {
        this.design = cloneDesign(PRESETS[Number(btn.dataset.preset)]);
        this.changed();
      } else if (btn.dataset.tool) {
        this.tool = btn.dataset.tool as Tool;
        this.changed(false);
      } else if (btn.dataset.act === 'launch') {
        saveDesign(this.design);
        actions.launch(cloneDesign(this.design));
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
    this.preview.addEventListener('pointermove', (e) => {
      if (!this.orbiting) return;
      this.yaw -= e.movementX * 0.008;
      this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.006, 0.05, 1.3);
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
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
    canvas.addEventListener('pointerdown', (e) => {
      if (isTop && this.tool !== 'draw') {
        this.placeAt(local(e).x);
        return;
      }
      drawing = true;
      last = null;
      canvas.setPointerCapture(e.pointerId);
      paint(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drawing) paint(e);
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

  /** Masts / cannons tool: toggle the snap point nearest to the click. */
  private placeAt(x: number): void {
    const d = this.design;
    const slots = this.tool === 'masts' ? MAST_SLOTS : CANNON_SLOTS;
    const t = slots.reduce((best, s) => (Math.abs(this.xOf(s) - x) < Math.abs(this.xOf(best) - x) ? s : best));
    if (Math.abs(this.xOf(t) - x) > 24) return;
    const list = this.tool === 'masts' ? d.masts : d.cannons;
    const at = list.indexOf(t);
    if (at >= 0) list.splice(at, 1);
    else if (this.tool === 'masts' && list.length < MAX_MASTS) list.push(t);
    else if (this.tool === 'cannons' && halfBeamAt(d, t) >= CANNON_MIN_HALF_BEAM) list.push(t);
    list.sort((a, b) => a - b);
    // the main mast (first in the list) is the one nearest the middle
    if (this.tool === 'masts') d.masts.sort((a, b) => Math.abs(a - 0.46) - Math.abs(b - 0.46));
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
      c.beginPath();
      c.arc(this.xOf(m), cy, 7, 0, Math.PI * 2);
      c.fillStyle = '#6e3b1b';
      c.fill();
      c.strokeStyle = '#f3e6c8';
      c.lineWidth = 2;
      c.stroke();
    }
    const gunY = (t: number) => Math.max(10, (halfBeamAt(d, t) / (d.beam / 2)) * scale - 12);
    if (this.tool === 'cannons') {
      for (const s of CANNON_SLOTS) {
        const ok = halfBeamAt(d, s) >= CANNON_MIN_HALF_BEAM;
        c.strokeStyle = ok ? '#fff8e6' : 'rgba(255,248,230,.25)';
        c.lineWidth = 2;
        for (const side of [-1, 1]) c.strokeRect(this.xOf(s) - 7, cy + side * gunY(s) - 7, 14, 14);
      }
    }
    c.fillStyle = '#2f2c2a';
    for (const g of d.cannons) for (const side of [-1, 1]) c.fillRect(this.xOf(g) - 5, cy + side * gunY(g) - 8, 10, 16);
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
      c.moveTo(this.xOf(m), sheerPx(m));
      c.lineTo(this.xOf(m), 6);
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
    (this.root.querySelector('[data-tip]') as HTMLElement).textContent = {
      draw: 'Drag on the top view to draw the outline, and on the side view to draw the keel.',
      masts: `Click a ring on the top view to add or remove a mast (up to ${MAX_MASTS}).`,
      cannons: 'Click a square on the top view to add or remove a pair of cannons. The hull must be wide enough there.',
    }[this.tool];
    const turn = s.agility > 0.9 ? 'Nimble' : s.agility > 0.65 ? 'Steady' : 'Heavy';
    const cost = (label: string, need: number, got: number) => `<span class="${got >= need ? '' : 'short'}">${label} ${need}</span>`;
    this.statsEl.innerHTML = `
      <div><span>Length × beam</span><b>${d.length.toFixed(1)} × ${d.beam.toFixed(1)} m</b></div>
      <div><span>Draft</span><b>${s.draft.toFixed(1)} m</b></div>
      <div><span>Weight</span><b>${(s.mass / 1000).toFixed(1)} t</b></div>
      <div><span>Top speed</span><b>${(s.speed * 1.94384).toFixed(1)} kn</b></div>
      <div><span>Handling</span><b>${turn}</b></div>
      <div><span>Masts</span><b>${d.masts.length}${d.masts.length === 0 ? ' (oars only, slow)' : ''}</b></div>
      <div><span>Cannons</span><b>${s.gunsPerSide} per side</b></div>
      <div><span>Hold</span><b>${s.hold}</b></div>
      <div class="cost"><span>Cost</span><b>${cost('Wood', s.cost.wood, have.wood)} · ${cost('Stone', s.cost.stone, have.stone)} · ${cost('Salvage', s.cost.salvage, have.salvage)}</b></div>
      <div class="note">Building is free while the shipyard is being tested. Costs are shown so we can balance them.</div>`;
  }

  // --- 3D preview ---------------------------------------------------------------

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
      this.model = buildShipVisual(this.design).group;
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
    if (!this.orbiting) this.yaw += dt * 0.25;
    const dist = this.design.length * 1.9 + 6;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cp * dist, Math.sin(this.pitch) * dist + 1, Math.cos(this.yaw) * cp * dist);
    this.camera.lookAt(0, this.design.length * 0.16, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
