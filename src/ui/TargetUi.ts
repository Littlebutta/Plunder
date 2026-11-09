import * as THREE from 'three';

export interface TargetInfo {
  name: string;
  /** World position to mark (a point on the ship, a little above the deck). */
  position: THREE.Vector3;
  /** 0..1 hull left. */
  health: number;
  /** Metres from the player. */
  distance: number;
  /** Shown under the name, e.g. "sinking". */
  note: string;
}

/**
 * Target marker: red brackets round the targeted ship while it is on screen,
 * a red arrow on the edge of the screen pointing toward it when it is not,
 * and a small panel with its name, hull and range.
 */
export class TargetUi {
  private readonly brackets: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly arrowLabel: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly rangeEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.brackets = document.createElement('div');
    this.brackets.className = 'target-brackets';
    this.brackets.innerHTML = '<i></i><i></i><i></i><i></i>';
    this.arrow = document.createElement('div');
    this.arrow.className = 'target-arrow';
    this.arrow.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M20 3 L35 33 L20 26 L5 33 Z" fill="#e23b3b" stroke="#3a0d0d" stroke-width="2.5" stroke-linejoin="round"/></svg><span></span>';
    this.arrowLabel = this.arrow.querySelector('span') as HTMLElement;
    this.panel = document.createElement('div');
    this.panel.className = 'hud-panel target-panel';
    this.panel.innerHTML = `
      <div class="target-name"><b data-name></b><span data-range></span></div>
      <div class="target-bar"><i data-bar></i></div>
      <div class="target-note" data-note></div>`;
    root.append(this.brackets, this.arrow, this.panel);
    this.nameEl = this.panel.querySelector('[data-name]') as HTMLElement;
    this.rangeEl = this.panel.querySelector('[data-range]') as HTMLElement;
    this.bar = this.panel.querySelector('[data-bar]') as HTMLElement;
    this.noteEl = this.panel.querySelector('[data-note]') as HTMLElement;
    this.hide();
  }

  hide(): void {
    this.brackets.hidden = this.arrow.hidden = this.panel.hidden = true;
  }

  /**
   * Where a world point falls on screen, in pixels, and whether it is in view.
   * Shared with click-to-target, so what you can click is what is marked.
   */
  static project(position: THREE.Vector3, camera: THREE.Camera, out: { x: number; y: number; onScreen: boolean; behind: boolean }): void {
    _p.copy(position).project(camera);
    // behind the camera the projection flips: detect it in view space
    _v.copy(position).applyMatrix4(camera.matrixWorldInverse);
    out.behind = _v.z > 0;
    out.x = (_p.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-_p.y * 0.5 + 0.5) * window.innerHeight;
    out.onScreen = !out.behind && Math.abs(_p.x) < 0.96 && Math.abs(_p.y) < 0.94;
  }

  update(target: TargetInfo | null, camera: THREE.Camera): void {
    if (!target) {
      this.hide();
      return;
    }
    this.panel.hidden = false;
    this.nameEl.textContent = target.name;
    this.rangeEl.textContent = `${Math.round(target.distance)} m`;
    this.bar.style.width = `${Math.round(target.health * 100)}%`;
    this.noteEl.textContent = target.note;
    this.noteEl.hidden = !target.note;

    TargetUi.project(target.position, camera, _s);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (_s.onScreen) {
      this.arrow.hidden = true;
      this.brackets.hidden = false;
      // brackets shrink with distance but stay readable
      const size = THREE.MathUtils.clamp(2600 / Math.max(target.distance, 12), 34, 150);
      this.brackets.style.width = this.brackets.style.height = `${size}px`;
      this.brackets.style.transform = `translate(${_s.x - size / 2}px, ${_s.y - size / 2}px)`;
      return;
    }
    // Off screen: an arrow on the screen edge, along the line from the centre toward the target.
    this.brackets.hidden = true;
    this.arrow.hidden = false;
    let dx = _s.x - w / 2;
    let dy = _s.y - h / 2;
    if (_s.behind) {
      dx = -dx;
      dy = -dy;
      // straight behind: point down the screen rather than nowhere
      if (Math.hypot(dx, dy) < 1) dy = 1;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const mx = w / 2 - 56;
    const my = h / 2 - 56;
    const k = Math.min(mx / Math.abs(dx || 1e-6), my / Math.abs(dy || 1e-6));
    const x = w / 2 + dx * k;
    const y = h / 2 + dy * k;
    this.arrow.style.transform = `translate(${x - 20}px, ${y - 20}px)`;
    (this.arrow.firstElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(dx, -dy)}rad)`;
    this.arrowLabel.textContent = `${Math.round(target.distance)} m`;
  }
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = { x: 0, y: 0, onScreen: false, behind: false };
