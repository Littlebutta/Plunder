import { AI_NAMES, defaultVsMatch, loadLobby, MatchConfig, MatchSlot, saveLobby, TEAM_NAMES } from '../world/Match';
import { PLAYER_COLOURS } from './Settings';

export interface LobbyActions {
  /** Start the match that was set up. */
  start(match: MatchConfig): void;
  back(): void;
  /** The local player's colour (from Settings). */
  colour(): string;
}

const ISLAND_CHOICES = [8, 12, 16, 20];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The Vs lobby: four captain slots (you, and AI captains for now) with teams
 * and colours on the left, the map settings on the right. Start hands the
 * finished MatchConfig back; the game reloads into it.
 */
export class Lobby {
  private readonly root: HTMLElement;
  private match: MatchConfig;

  constructor(
    parent: HTMLElement,
    private readonly actions: LobbyActions,
  ) {
    this.match = loadLobby() ?? defaultVsMatch(actions.colour());
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.root.hidden = true;
    parent.append(this.root);

    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.disabled) return;
      const m = this.match;
      const slot = btn.dataset.slot ? m.slots[Number(btn.dataset.slot)] : null;
      if (slot && btn.dataset.kind) slot.kind = btn.dataset.kind as MatchSlot['kind'];
      else if (slot && btn.dataset.team) slot.team = Number(btn.dataset.team);
      else if (slot && 'colour' in btn.dataset) slot.colour = this.nextColour(slot);
      else if (btn.dataset.islands) m.islands = Number(btn.dataset.islands);
      else if (btn.dataset.stock) m.stock = btn.dataset.stock as MatchConfig['stock'];
      else if (btn.dataset.ai) m.ai = btn.dataset.ai as MatchConfig['ai'];
      else if (btn.dataset.fair) m.fair = btn.dataset.fair === '1';
      else if (btn.dataset.forts) m.forts = btn.dataset.forts === '1';
      else if (btn.dataset.act === 'reseed') m.seed = 1 + Math.floor(Math.random() * 999_983);
      else if (btn.dataset.act === 'back') return actions.back();
      else if (btn.dataset.act === 'start') {
        if (this.problem()) return;
        saveLobby(m);
        return actions.start({ ...m, slots: m.slots.map((s) => ({ ...s })), autostart: true });
      }
      this.render();
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.seed !== undefined) {
        const v = Math.floor(Number(el.value));
        if (Number.isFinite(v) && v > 0) this.match.seed = v;
        this.render();
      }
    });
    // typing a seed must not steer the ship behind the lobby
    this.root.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation();
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    // slot 1 is always you, in your own colour
    const me = this.match.slots[0];
    me.kind = 'human';
    me.name = 'You';
    me.colour = this.actions.colour();
    for (const s of this.match.slots.slice(1)) if (s.colour === me.colour) s.colour = this.nextColour(s);
    this.root.hidden = false;
    this.render();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** The next colour nobody else in the lobby is flying. */
  private nextColour(slot: MatchSlot): string {
    const taken = this.match.slots.filter((s) => s !== slot && s.kind !== 'closed').map((s) => s.colour);
    const all = PLAYER_COLOURS.map((c) => c.hex);
    const at = all.indexOf(slot.colour);
    for (let i = 1; i <= all.length; i++) {
      const c = all[(at + i + all.length) % all.length];
      if (!taken.includes(c)) return c;
    }
    return slot.colour;
  }

  /** Why the match cannot start, or ''. */
  private problem(): string {
    const playing = this.match.slots.filter((s) => s.kind !== 'closed');
    if (playing.length < 2) return 'Open at least one more captain slot.';
    if (new Set(playing.map((s) => s.team)).size < 2) return 'Everyone is on the same team. Put someone on another.';
    return '';
  }

  private render(): void {
    const m = this.match;
    const pick = (attr: string, value: string | number, label: string, on: boolean, hint = '') => `<button data-${attr}="${value}" class="${on ? 'on' : ''}" ${hint ? `title="${hint}"` : ''}>${label}</button>`;
    const slots = m.slots
      .map((s, i) => {
        const closed = s.kind === 'closed';
        const kind =
          i === 0
            ? '<span class="lobby-kind">You</span>'
            : `<span class="lobby-seg">${pick(`slot="${i}" data-kind`, 'ai', 'AI', s.kind === 'ai')}${pick(`slot="${i}" data-kind`, 'closed', 'Closed', closed)}</span>`;
        const teams = TEAM_NAMES.map((_, t) => pick(`slot="${i}" data-team`, t, String(t + 1), s.team === t)).join('');
        return `
          <div class="lobby-slot ${closed ? 'closed' : ''}">
            <button class="lobby-colour" data-slot="${i}" data-colour style="background:${s.colour}" ${i === 0 || closed ? 'disabled' : ''} title="${i === 0 ? 'Your colour is set in Settings' : 'Change colour'}"></button>
            <div class="lobby-name">${esc(i === 0 ? 'You' : closed ? 'Empty' : `Captain ${s.name || AI_NAMES[i - 1]}`)}</div>
            ${kind}
            <span class="lobby-seg teams" ${closed ? 'hidden' : ''}><i>Team</i>${teams}</span>
          </div>`;
      })
      .join('');
    const problem = this.problem();
    this.root.innerHTML = `
      <div class="lobby-card">
        <div class="lobby-head">
          <div class="lobby-title">Vs match</div>
          <div class="lobby-sub">Last team with a home island wins. Take a captain's home and they are out.</div>
        </div>
        <div class="lobby-cols">
          <div class="lobby-col">
            <div class="lobby-section">Captains and teams</div>
            ${slots}
            <div class="lobby-note">Friends join these slots over Steam in the next update. For now the other captains are AI.</div>
          </div>
          <div class="lobby-col">
            <div class="lobby-section">Map</div>
            <div class="lobby-row"><span>Islands</span><span class="lobby-seg">${ISLAND_CHOICES.map((n) => pick('islands', n, String(n), m.islands === n)).join('')}</span></div>
            <div class="lobby-row"><span>Placement</span><span class="lobby-seg">${pick('fair', 1, 'Fair', m.fair, 'Every captain gets the same islands at the same distances')}${pick('fair', 0, 'Random', !m.fair, 'Islands fall where they fall; homes are spread as far apart as the map allows')}</span></div>
            <div class="lobby-row"><span>Neutral forts</span><span class="lobby-seg">${pick('forts', 1, 'On', m.forts, 'Raider stockades on the port islands, there for the taking')}${pick('forts', 0, 'Off', !m.forts)}</span></div>
            <div class="lobby-row"><span>Map seed</span><span class="lobby-seed"><input data-seed type="number" min="1" value="${m.seed}"><button data-act="reseed">Roll</button></span></div>
            <div class="lobby-section">Rules</div>
            <div class="lobby-row"><span>Starting stores</span><span class="lobby-seg">${pick('stock', 'lean', 'Lean', m.stock === 'lean')}${pick('stock', 'standard', 'Standard', m.stock === 'standard')}${pick('stock', 'rich', 'Rich', m.stock === 'rich')}</span></div>
            <div class="lobby-row"><span>AI captains</span><span class="lobby-seg">${pick('ai', 'easy', 'Easy', m.ai === 'easy')}${pick('ai', 'normal', 'Normal', m.ai === 'normal')}${pick('ai', 'hard', 'Hard', m.ai === 'hard')}</span></div>
          </div>
        </div>
        <div class="lobby-foot">
          <span class="lobby-problem">${problem}</span>
          <button data-act="back">Back</button>
          <button data-act="start" class="primary" ${problem ? 'disabled' : ''}>Start match</button>
        </div>
      </div>`;
  }
}
