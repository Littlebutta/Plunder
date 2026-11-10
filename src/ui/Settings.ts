import type { AudioBus, AudioManager } from '../audio/AudioManager';

/** Player settings, kept between sessions. */
export interface GameSettings {
  muted: boolean;
  master: number;
  effects: number;
  ambience: number;
  music: number;
  /** Broadside: guns fire one after another, or all at once. */
  fireMode: 'ripple' | 'volley';
  /** The player's colour: sails, pennant and island markers. */
  colour: string;
}

/** Colours a player can fly. White is kept for NPCs. */
export const PLAYER_COLOURS: { name: string; hex: string }[] = [
  { name: 'Crimson', hex: '#d8343a' },
  { name: 'Orange', hex: '#f08a2c' },
  { name: 'Gold', hex: '#f2c230' },
  { name: 'Green', hex: '#4caf50' },
  { name: 'Teal', hex: '#22b3a6' },
  { name: 'Blue', hex: '#3d7be0' },
  { name: 'Purple', hex: '#9457d6' },
  { name: 'Pink', hex: '#ee6fa8' },
  { name: 'Black', hex: '#3a3438' },
];
export const NPC_COLOUR = '#ffffff';

const KEY = 'plunder.settings.v1';
const DEFAULTS: GameSettings = { muted: false, master: 0.8, effects: 1, ambience: 0.7, music: 0.7, fireMode: 'ripple', colour: PLAYER_COLOURS[0].hex };

export function loadSettings(): GameSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<GameSettings>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
    return {
      muted: raw.muted === true,
      master: num(raw.master, DEFAULTS.master),
      effects: num(raw.effects, DEFAULTS.effects),
      ambience: num(raw.ambience, DEFAULTS.ambience),
      music: num(raw.music, DEFAULTS.music),
      fireMode: raw.fireMode === 'volley' ? 'volley' : 'ripple',
      colour: PLAYER_COLOURS.some((c) => c.hex === raw.colour) ? (raw.colour as string) : DEFAULTS.colour,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage unavailable: settings last for this session only
  }
}

const BUSES: { id: AudioBus; label: string; note?: string }[] = [
  { id: 'master', label: 'Master volume' },
  { id: 'effects', label: 'Sound effects', note: 'guns, splashes, hits' },
  { id: 'ambience', label: 'Sea and wind' },
  { id: 'music', label: 'Music' },
];

/**
 * Settings window (your colour, gunnery, sound), opened from the main menu and from the
 * gear button during play. Changes apply at once and are remembered.
 */
export class SettingsPanel {
  readonly settings: GameSettings;
  private readonly root: HTMLElement;
  private readonly gear: HTMLButtonElement;
  onClose: (() => void) | null = null;
  /** Called when a gameplay setting (colour, fire mode) changes. */
  onChange: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly audio: AudioManager,
  ) {
    this.settings = loadSettings();
    this.apply();

    this.root = document.createElement('div');
    this.root.className = 'settings';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="settings-card">
        <div class="settings-title">Settings</div>
        <div class="settings-section">Your colour</div>
        <div class="settings-swatches">
          ${PLAYER_COLOURS.map((c) => `<button data-colour="${c.hex}" title="${c.name}" aria-label="${c.name}" style="background:${c.hex}"></button>`).join('')}
        </div>
        <div class="settings-note">Your sails and the markers on islands you hold. White belongs to NPCs.</div>
        <div class="settings-section">Broadside</div>
        <div class="settings-select">
          <button data-fire="ripple">Sequential (bow to stern)</button>
          <button data-fire="volley">All at once</button>
        </div>
        <div class="settings-section">Sound</div>
        <label class="settings-check"><input type="checkbox" data-mute /> Mute all sound</label>
        ${BUSES.map(
          (b) => `
        <label class="settings-row">
          <span>${b.label}${b.note ? `<small>${b.note}</small>` : ''}</span>
          <input type="range" min="0" max="100" step="1" data-bus="${b.id}" />
          <b data-val="${b.id}"></b>
        </label>`,
        ).join('')}
        <div class="settings-actions">
          <button data-act="reset">Reset</button>
          <button data-act="close">Done</button>
        </div>
      </div>`;
    parent.append(this.root);

    this.gear = document.createElement('button');
    this.gear.className = 'settings-gear';
    this.gear.title = 'Settings';
    this.gear.setAttribute('aria-label', 'Settings');
    this.gear.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>';
    this.gear.hidden = true;
    this.gear.addEventListener('click', () => {
      this.gear.blur();
      this.visible ? this.close() : this.open();
    });
    parent.append(this.gear);

    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.bus) this.settings[el.dataset.bus as AudioBus] = Number(el.value) / 100;
      else if ('mute' in el.dataset) this.settings.muted = el.checked;
      this.commit();
    });
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      const act = btn?.dataset.act;
      if (btn?.dataset.colour) {
        this.settings.colour = btn.dataset.colour;
        this.commit();
      } else if (btn?.dataset.fire) {
        this.settings.fireMode = btn.dataset.fire === 'volley' ? 'volley' : 'ripple';
        this.commit();
      } else if (act === 'reset') {
        Object.assign(this.settings, DEFAULTS, { colour: this.settings.colour });
        this.commit();
      } else if (act === 'close' || e.target === this.root) this.close();
    });
    // keep sailing keys from reaching the game while a slider has focus
    this.root.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') e.stopPropagation();
    });
    this.refresh();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.refresh();
    this.root.hidden = false;
  }

  close(): void {
    if (!this.visible) return;
    this.root.hidden = true;
    this.onClose?.();
  }

  /** Show or hide the in-game gear button. */
  showGear(v: boolean): void {
    this.gear.hidden = !v;
  }

  /** Flip mute (the P key) and remember it. */
  toggleMute(): boolean {
    this.settings.muted = !this.settings.muted;
    this.commit();
    return this.settings.muted;
  }

  private commit(): void {
    this.apply();
    saveSettings(this.settings);
    this.refresh();
    this.onChange?.();
  }

  /** Flip the broadside fire mode (the V key) and remember it. */
  toggleFireMode(): 'ripple' | 'volley' {
    this.settings.fireMode = this.settings.fireMode === 'ripple' ? 'volley' : 'ripple';
    this.commit();
    return this.settings.fireMode;
  }

  private apply(): void {
    const s = this.settings;
    this.audio.setVolume('master', s.master);
    this.audio.setVolume('effects', s.effects);
    this.audio.setVolume('ambience', s.ambience);
    this.audio.setVolume('music', s.music);
    this.audio.setMuted(s.muted);
  }

  private refresh(): void {
    const s = this.settings;
    (this.root.querySelector('[data-mute]') as HTMLInputElement).checked = s.muted;
    this.root.querySelectorAll<HTMLElement>('[data-colour]').forEach((b) => b.classList.toggle('on', b.dataset.colour === s.colour));
    this.root.querySelectorAll<HTMLElement>('[data-fire]').forEach((b) => b.classList.toggle('on', b.dataset.fire === s.fireMode));
    for (const b of BUSES) {
      const slider = this.root.querySelector(`[data-bus="${b.id}"]`) as HTMLInputElement;
      slider.value = String(Math.round(s[b.id] * 100));
      slider.disabled = s.muted;
      (this.root.querySelector(`[data-val="${b.id}"]`) as HTMLElement).textContent = s.muted ? 'off' : `${Math.round(s[b.id] * 100)}%`;
    }
  }
}
