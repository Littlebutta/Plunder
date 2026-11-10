import GUI from 'lil-gui';
import './weather.css';
import { Weather, WEATHER_KINDS, WEATHER_INFO, WeatherKind, ShipState } from './Weather';
import type { PlayerHull } from './PlayerHull';

/**
 * Weather HUD: a banner when an event rolls in, a small chip at the top with
 * the clock and current weather, and a hull bar that shows while the ship is
 * damaged.
 */
export class WeatherUi {
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly hullBox: HTMLElement;
  private readonly hullFill: HTMLElement;
  private bannerTimer = 0;
  private hitFlash = 0;

  constructor(root: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'weather-hud';
    wrap.innerHTML = `
      <div class="weather-chip" data-chip></div>
      <div class="weather-banner" data-banner><b data-title></b><span data-sub></span></div>
      <div class="hud-panel weather-hull" data-hull hidden><span>hull</span><div class="weather-hull-bar"><i data-hullfill></i></div></div>`;
    root.appendChild(wrap);
    const q = (s: string) => wrap.querySelector(s) as HTMLElement;
    this.banner = q('[data-banner]');
    this.bannerTitle = q('[data-title]');
    this.bannerSub = q('[data-sub]');
    this.chip = q('[data-chip]');
    this.hullBox = q('[data-hull]');
    this.hullFill = q('[data-hullfill]');
  }

  announce(title: string, subtitle: string, tone: 'calm' | 'danger' | 'good'): void {
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = subtitle;
    this.banner.dataset.tone = tone;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth; // restart the animation
    this.banner.classList.add('show');
    this.bannerTimer = 3.5;
  }

  hit(): void {
    this.hitFlash = 0.6;
  }

  update(dt: number, weather: Weather, hull: PlayerHull, visible: boolean): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
    this.chip.hidden = !visible;
    const ev = weather.event;
    const left = weather.timeLeft;
    const timer = ev && !ev.ending ? ` · ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : '';
    const level = ev ? ` <i>${'I'.repeat(ev.level)}</i>` : '';
    const icon = weather.dayNight.daylight > 0.5 ? '☀' : '☾';
    this.chip.innerHTML = `${icon} ${weather.dayNight.clock} · ${weather.label}${level}${timer}`;
    this.chip.dataset.kind = ev?.kind ?? 'clear';

    this.hullBox.hidden = !visible || hull.hp >= hull.max - 0.01;
    this.hullFill.style.width = `${Math.round(hull.fraction * 100)}%`;
    this.hullFill.classList.toggle('low', hull.fraction < 0.35);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.hullBox.classList.toggle('hit', this.hitFlash > 0);
  }
}

/** Weather + clock controls in the tuning panel (G). */
export function addWeatherControls(gui: GUI, weather: Weather, ship: () => ShipState): void {
  const f = gui.addFolder('Weather & time');
  const dn = weather.dayNight;
  f.add(dn, 'time', 0, 1, 0.001).name('time of day').listen();
  f.add(dn, 'dayLength', 60, 1800, 10).name('day length (s)');
  f.add(dn, 'paused').name('pause clock');
  f.add(weather, 'auto').name('random events');
  const ctl = { event: 'storm' as WeatherKind, level: 2 };
  const names = Object.fromEntries(WEATHER_KINDS.map((k) => [WEATHER_INFO[k].names[1], k]));
  f.add(ctl, 'event', names).name('event');
  f.add(ctl, 'level', 1, 3, 1).name('level');
  f.add({ start: () => weather.start(ctl.event, ctl.level, ship()) }, 'start').name('start event');
  f.add({ stop: () => weather.stop() }, 'stop').name('clear weather');
  f.add({ next: () => weather.nextEvent(ship()) }, 'next').name('random event');
}
