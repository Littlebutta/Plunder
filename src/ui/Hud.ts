/** Lightweight DOM HUD: controls help, speed, sail and compass. */
export class Hud {
  private readonly speedEl: HTMLElement;
  private readonly sailFill: HTMLElement;
  private readonly sailText: HTMLElement;
  private readonly needle: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly help: HTMLElement;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-title">Plunder</div>
      <div class="hud-panel hud-help">
        <div><kbd>W</kbd><kbd>S</kbd> raise / lower sail (hold S at zero to back-paddle)</div>
        <div><kbd>A</kbd><kbd>D</kbd> steer</div>
        <div><kbd>Drag</kbd> orbit camera · <kbd>Wheel</kbd> zoom</div>
        <div><kbd>G</kbd> wave &amp; physics tuning · <kbd>P</kbd> buoyancy probes · <kbd>H</kbd> hide help</div>
      </div>
      <div class="hud-panel hud-stats">
        <div class="stat"><b data-speed>0.0</b><span>knots</span></div>
        <div class="sail-bar"><i data-sail></i></div>
        <div class="stat"><b data-sailtext>0%</b><span>sail</span></div>
        <div class="compass"><div class="n">N</div><div class="needle" data-needle></div></div>
        <div class="stat"><b data-fps>–</b><span>fps</span></div>
      </div>`;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;
    this.speedEl = q('[data-speed]');
    this.sailFill = q('[data-sail]');
    this.sailText = q('[data-sailtext]');
    this.needle = q('[data-needle]');
    this.fpsEl = q('[data-fps]');
    this.help = q('.hud-help');
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  /** @param heading radians, 0 = facing north (-Z), clockwise positive */
  update(dt: number, speedMs: number, sail: number, heading: number): void {
    this.speedEl.textContent = (Math.abs(speedMs) * 1.94384).toFixed(1);
    const pct = Math.round(Math.abs(sail) * 100);
    this.sailText.textContent = sail < 0 ? `-${Math.round((pct / 40) * 100)}%` : `${pct}%`;
    this.sailFill.style.height = `${sail < 0 ? (-sail / 0.4) * 100 : sail * 100}%`;
    this.sailFill.classList.toggle('rev', sail < 0);
    this.needle.style.transform = `rotate(${heading}rad)`;

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fpsEl.textContent = String(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }
}
