/** Lightweight DOM HUD: controls help, speed, sail and compass. */
export class Hud {
  private readonly speedEl: HTMLElement;
  private readonly sailFill: HTMLElement;
  private readonly sailText: HTMLElement;
  private readonly needle: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly help: HTMLElement;
  private readonly windEl: HTMLElement;
  private readonly effEl: HTMLElement;
  private readonly trimEl: HTMLElement;
  private readonly reloadEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly shotsEl: HTMLElement;
  private readonly threadEl: HTMLElement;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="hud-title">Plunder</div>
      <div class="hud-panel hud-help">
        <div><kbd>W</kbd><kbd>S</kbd> raise / lower sail (hold S at zero to back-paddle)</div>
        <div><kbd>A</kbd><kbd>D</kbd> steer · <kbd>Q</kbd><kbd>E</kbd> trim sail · <kbd>T</kbd> auto-trim</div>
        <div><kbd>Mouse</kbd> aim swivel gun · <kbd>Click</kbd>/<kbd>Space</kbd> fire</div>
        <div><kbd>Drag</kbd> orbit camera · <kbd>Wheel</kbd> zoom</div>
        <div><kbd>B</kbd> barrage test · <kbd>M</kbd> mute · <kbd>G</kbd> tuning · <kbd>P</kbd> probes · <kbd>H</kbd> hide help</div>
      </div>
      <div class="hud-panel hud-stats">
        <div class="stat"><b data-speed>0.0</b><span>knots</span></div>
        <div class="sail-bar"><i data-sail></i></div>
        <div class="stat"><b data-sailtext>0%</b><span>sail</span></div>
        <div class="compass"><div class="n">N</div><div class="wind" data-wind></div><div class="needle" data-needle></div></div>
        <div class="stat"><b data-eff>–</b><span data-trim>trim</span></div>
        <div class="stat"><div class="reload"><i data-reload></i></div><span>gun</span></div>
        <div class="stat"><b data-fps>–</b><span>fps</span></div>
      </div>
      <div class="hud-panel hud-score"><b data-score>0</b> barrels · <span data-shots>0</span> shells in flight<span data-thread></span></div>`;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;
    this.speedEl = q('[data-speed]');
    this.sailFill = q('[data-sail]');
    this.sailText = q('[data-sailtext]');
    this.needle = q('[data-needle]');
    this.fpsEl = q('[data-fps]');
    this.help = q('.hud-help');
    this.windEl = q('[data-wind]');
    this.effEl = q('[data-eff]');
    this.trimEl = q('[data-trim]');
    this.reloadEl = q('[data-reload]');
    this.scoreEl = q('[data-score]');
    this.shotsEl = q('[data-shots]');
    this.threadEl = q('[data-thread]');
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  /**
   * @param windHeading radians, direction the wind blows TOWARD (0 = north, clockwise)
   * @param efficiency 0..1 sail drive
   */
  updateSailing(windHeading: number, efficiency: number, trimDeg: number, autoTrim: boolean, sail: number): void {
    this.windEl.style.transform = `rotate(${windHeading}rad)`;
    this.effEl.textContent = sail > 0.05 ? `${Math.round(efficiency * 100)}%` : '–';
    this.effEl.style.color = efficiency > 0.6 ? '#9be37a' : efficiency > 0.25 ? '#ffd27a' : '#ff9a7a';
    this.trimEl.textContent = autoTrim ? 'auto trim' : `trim ${trimDeg > 0 ? '+' : ''}${Math.round(trimDeg)}°`;
  }

  updateCombat(reload: number, score: number, shells: number, threaded: boolean, workerMs: number): void {
    this.reloadEl.style.width = `${Math.round(reload * 100)}%`;
    this.reloadEl.classList.toggle('ready', reload >= 1);
    this.scoreEl.textContent = String(score);
    this.shotsEl.textContent = String(shells);
    this.threadEl.textContent = threaded ? ` · worker ${workerMs.toFixed(2)} ms` : ' · main thread';
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
