import { LobbySession } from '../net/Session';
import { desktop, steamTransport } from '../net/Transport';
import { defaultVsMatch, loadLobby, MatchConfig, MatchSlot, saveLobby, TEAM_NAMES } from '../world/Match';
import { PLAYER_COLOURS } from './Settings';
import { CAPTAINS, captainById } from '../world/Captains';
import { portraitUrl } from './Portrait';

export interface LobbyActions {
  /** Start the match that was set up. */
  start(match: MatchConfig): void;
  back(): void;
  /** The local player's colour (from Settings). */
  colour(): string;
  /** The local player's captain (from Settings), and changing it. */
  captain(): string;
  setCaptain(id: string): void;
  /** A Steam invite was accepted: bring the lobby up (false if a match is under way and it cannot). */
  summon(): boolean;
}

const ISLAND_CHOICES = [8, 12, 16, 20];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The Vs lobby: four captain slots with teams and colours on the left, the
 * map settings on the right. Played alone the other captains are AI. Hosted
 * online, friends who join with the invite code (or a Steam invite) take the
 * open slots; they see the host's lobby and wait for the start. Start hands
 * the finished MatchConfig back; the game reloads into it.
 */
export class Lobby {
  private readonly root: HTMLElement;
  private match: MatchConfig;
  private readonly session: LobbySession;
  /** Which link an online match uses: Steam, or windows on this computer (for trying it out alone). */
  private link: 'steam' | 'local' = 'local';
  /** Why Steam cannot be used, or '' when it can. */
  private steamWhy = 'Checking for Steam...';
  private busy = false;
  private notice = '';
  private joinCode = '';

  constructor(
    parent: HTMLElement,
    private readonly actions: LobbyActions,
  ) {
    this.match = loadLobby() ?? defaultVsMatch(actions.colour());
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.root.hidden = true;
    parent.append(this.root);

    this.session = new LobbySession(() => ({ colour: actions.colour(), captain: actions.captain() }));
    this.session.onChange = () => this.sync();
    this.session.onLobby = (m) => {
      this.match = m;
      this.render();
    };
    this.session.onStart = (m) => {
      if (this.session.hosting) saveLobby(this.match);
      actions.start(m);
    };
    this.session.onClosed = (why) => {
      this.notice = why;
      this.match = loadLobby() ?? defaultVsMatch(actions.colour());
      if (this.visible) this.open();
    };
    void steamTransport().then((t) => {
      this.steamWhy = typeof t === 'string' ? t : '';
      if (!this.steamWhy && !this.session.online) this.link = 'steam';
      if (this.visible) this.render();
    });
    // a friend's Steam invite, accepted while the game is open
    desktop()?.steam.on((e) => {
      if (e.type !== 'invite' || this.session.online || !actions.summon()) return;
      this.link = 'steam';
      void this.go(() => this.session.join('steam', e.code));
    });

    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn || btn.disabled) return;
      const m = this.match;
      const slot = btn.dataset.slot ? m.slots[Number(btn.dataset.slot)] : null;
      if (slot && btn.dataset.kind) {
        slot.kind = btn.dataset.kind as MatchSlot['kind'];
        delete slot.peer; // an AI or closed seat sends its player back to the next open one
      } else if (slot && btn.dataset.team) slot.team = (slot.team + 1) % TEAM_NAMES.length;
      else if (slot && btn.dataset.captain !== undefined) {
        const next = CAPTAINS[(CAPTAINS.findIndex((c) => c.id === slot.captain) + 1) % CAPTAINS.length];
        slot.captain = next.id;
        if (slot === m.slots[0]) actions.setCaptain(next.id);
        else if (slot.kind === 'ai' || slot.kind === 'closed') slot.name = next.name;
      }
      else if (slot && 'colour' in btn.dataset) slot.colour = this.nextColour(slot);
      else if (btn.dataset.islands) m.islands = Number(btn.dataset.islands);
      else if (btn.dataset.stock) m.stock = btn.dataset.stock as MatchConfig['stock'];
      else if (btn.dataset.ai) m.ai = btn.dataset.ai as MatchConfig['ai'];
      else if (btn.dataset.fair) m.fair = btn.dataset.fair === '1';
      else if (btn.dataset.forts) m.forts = btn.dataset.forts === '1';
      else if (btn.dataset.link) this.link = btn.dataset.link as 'steam' | 'local';
      else if (btn.dataset.act === 'reseed') m.seed = 1 + Math.floor(Math.random() * 999_983);
      else if (btn.dataset.act === 'host') return void this.go(() => this.session.host(this.link));
      else if (btn.dataset.act === 'join') return void this.go(() => this.session.join(this.link, this.joinCode));
      else if (btn.dataset.act === 'leave') {
        this.session.leave();
        this.match = loadLobby() ?? defaultVsMatch(actions.colour());
        return this.open();
      } else if (btn.dataset.act === 'copy') {
        void navigator.clipboard?.writeText(this.session.code);
        this.notice = 'Invite code copied.';
      } else if (btn.dataset.act === 'invite') this.session.transport?.invite?.();
      else if (btn.dataset.act === 'window') desktop()?.newWindow();
      else if (btn.dataset.act === 'back') {
        this.session.leave();
        return actions.back();
      } else if (btn.dataset.act === 'start') {
        if (this.problem()) return;
        if (this.session.hosting) return this.session.start(m);
        saveLobby(m);
        return actions.start({ ...m, slots: m.slots.map((s) => ({ ...s, kind: s.kind === 'open' ? 'closed' : s.kind })), autostart: true });
      }
      this.sync();
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.seed !== undefined) {
        const v = Math.floor(Number(el.value));
        if (Number.isFinite(v) && v > 0) this.match.seed = v;
        this.sync();
      }
    });
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.code !== undefined) this.joinCode = el.value;
    });
    // typing must not steer the ship behind the lobby
    this.root.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation();
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** In an online lobby as a guest: the host's settings are shown, not edited. */
  private get guest(): boolean {
    return this.session.online && !this.session.hosting;
  }

  open(): void {
    if (!this.guest) {
      // slot 1 is always you, in your own colour
      const me = this.match.slots[0];
      me.kind = 'human';
      me.name = 'You';
      me.colour = this.actions.colour();
      me.captain = this.actions.captain();
      for (const s of this.match.slots.slice(1)) {
        if (s.colour === me.colour) s.colour = this.nextColour(s);
        if (!this.session.online && s.kind === 'open') s.kind = 'closed';
      }
    }
    this.root.hidden = false;
    this.sync();
  }

  close(): void {
    this.session.leave();
    this.root.hidden = true;
  }

  /** Run something that talks to the network, showing what went wrong if it does. */
  private async go(what: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.notice = '';
    this.render();
    try {
      await what();
    } catch (err) {
      this.notice = err instanceof Error ? err.message : 'That did not work.';
      this.session.leave();
    }
    this.busy = false;
    this.sync();
  }

  /** Host: seat whoever has joined and tell everyone; then redraw. */
  private sync(): void {
    if (this.session.hosting) this.session.seat(this.match);
    if (this.visible) this.render();
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
    const playing = this.match.slots.filter((s) => s.kind === 'human' || s.kind === 'ai' || (s.kind === 'open' && s.peer));
    if (playing.length < 2) return this.session.hosting ? 'Waiting for a friend to join, or add an AI captain.' : 'Open at least one more captain slot.';
    if (new Set(playing.map((s) => s.team)).size < 2) return 'Everyone is on the same team. Put someone on another.';
    if (!this.match.fair && this.match.islands < playing.length * 2) return `${playing.length} captains need at least ${playing.length * 2} islands on a random map.`;
    return '';
  }

  private onlinePanel(): string {
    const s = this.session;
    const desk = !!desktop();
    if (s.online) {
      const steam = s.transport?.kind === 'steam';
      const how = steam
        ? 'Send a friend this code, or invite them from your Steam friends list. They need Plunder open, and to be your Steam friend.'
        : 'This is the same-computer test link: open Plunder in a second window, choose Vs match, and join with this code.';
      return `
        <div class="lobby-section">Online match</div>
        <div class="lobby-online">
          <span class="lobby-code" title="Invite code">${esc(s.code)}</span>
          <button data-act="copy">Copy code</button>
          ${steam && s.hosting ? '<button data-act="invite">Invite friends</button>' : ''}
          ${!steam && desk && s.hosting ? '<button data-act="window">Open a second window</button>' : ''}
          <button data-act="leave">${s.hosting ? 'Stop hosting' : 'Leave'}</button>
        </div>
        <div class="lobby-note">${s.hosting ? how : 'You have joined. The host sets up the match and starts it.'}</div>`;
    }
    const links = desk
      ? `<span class="lobby-seg">${this.pick('link', 'steam', 'Steam', this.link === 'steam', this.steamWhy || 'Play with Steam friends', !!this.steamWhy)}${this.pick('link', 'local', 'This computer', this.link === 'local', 'Two windows on this computer, for trying it out alone')}</span>`
      : '';
    const note =
      this.link === 'steam'
        ? 'Host a match and send a friend the invite code, or join theirs. Friends take the slots set to Open.'
        : `${desk ? (this.steamWhy ? `${esc(this.steamWhy)} ` : '') : 'In the browser this links two tabs on the same computer; play with friends in the desktop version. '}Host here, then join from a second window with the code.`;
    return `
      <div class="lobby-section">Play online</div>
      <div class="lobby-online">
        ${links}
        <button data-act="host" ${this.busy ? 'disabled' : ''}>Host a match</button>
        <input data-code placeholder="Invite code" value="${esc(this.joinCode)}" ${this.busy ? 'disabled' : ''}>
        <button data-act="join" ${this.busy ? 'disabled' : ''}>Join</button>
      </div>
      <div class="lobby-note">${note}</div>`;
  }

  private pick(attr: string, value: string | number, label: string, on: boolean, hint = '', off = false): string {
    return `<button data-${attr}="${value}" class="${on ? 'on' : ''}" ${hint ? `title="${esc(hint)}"` : ''} ${off || this.guest ? 'disabled' : ''}>${label}</button>`;
  }

  private render(): void {
    const m = this.match;
    const s = this.session;
    const self = s.transport?.self.id;
    const guest = this.guest;
    const pick = this.pick.bind(this);
    const slots = m.slots
      .map((slot, i) => {
        const closed = slot.kind === 'closed';
        const mine = s.online ? slot.peer === self : i === 0;
        const seated = !!slot.peer && (slot.kind === 'human' || slot.kind === 'open');
        const kinds = `${pick(`slot="${i}" data-kind`, 'ai', 'AI', slot.kind === 'ai')}${s.online ? pick(`slot="${i}" data-kind`, 'open', 'Open', slot.kind === 'open', 'A seat for a friend') : ''}${pick(`slot="${i}" data-kind`, 'closed', 'Closed', closed)}`;
        const kind = i === 0 ? `<span class="lobby-kind">${s.online ? 'Host' : 'You'}</span>` : `<span class="lobby-seg">${kinds}</span>`;
        const cap = captainById(slot.captain);
        const team = `<button class="lobby-team" data-slot="${i}" data-team="1" ${guest ? 'disabled' : ''} title="Change team">Team ${slot.team + 1}</button>`;
        const name = mine ? (s.online ? `You (${slot.name})` : 'You') : closed ? 'Empty' : seated ? slot.name : slot.kind === 'open' ? 'Waiting for a friend...' : cap.name;
        // you pick your own captain; the host picks the AI's
        const canPick = mine || (!guest && slot.kind === 'ai');
        return `
          <div class="lobby-slot ${closed ? 'closed' : ''}">
            <button class="lobby-face" data-slot="${i}" data-captain ${canPick ? '' : 'disabled'} title="${esc(`${cap.name}, ${cap.title}: ${cap.perk}`)}"><img src="${portraitUrl(cap, slot.colour)}" alt=""></button>
            <button class="lobby-colour" data-slot="${i}" data-colour style="background:${slot.colour}" ${i === 0 || closed || guest ? 'disabled' : ''} title="${i === 0 ? 'Your colour is set in Settings' : 'Change colour'}"></button>
            <div class="lobby-name">${esc(name)}${closed ? '' : `<small>${esc(cap.title)} · ${esc(cap.perk)}</small>`}</div>
            ${kind}
            <span class="teams" ${closed ? 'hidden' : ''}>${team}</span>
          </div>`;
      })
      .join('');
    const problem = guest ? 'Waiting for the host to start the match.' : this.problem();
    const ro = guest ? 'disabled' : '';
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
            ${this.onlinePanel()}
            ${this.notice ? `<div class="lobby-notice">${esc(this.notice)}</div>` : ''}
          </div>
          <div class="lobby-col">
            <div class="lobby-section">Map</div>
            <div class="lobby-row"><span>Islands</span><span class="lobby-seg">${ISLAND_CHOICES.map((n) => pick('islands', n, String(n), m.islands === n)).join('')}</span></div>
            <div class="lobby-row"><span>Placement</span><span class="lobby-seg">${pick('fair', 1, 'Fair', m.fair, 'Every captain gets the same islands at the same distances')}${pick('fair', 0, 'Random', !m.fair, 'Islands fall where they fall; homes are spread as far apart as the map allows')}</span></div>
            <div class="lobby-row"><span>Neutral forts</span><span class="lobby-seg">${pick('forts', 1, 'On', m.forts, 'Raider stockades on the port islands, there for the taking')}${pick('forts', 0, 'Off', !m.forts)}</span></div>
            <div class="lobby-row"><span>Map seed</span><span class="lobby-seed"><input data-seed type="number" min="1" value="${m.seed}" ${ro}><button data-act="reseed" ${ro}>Roll</button></span></div>
            <div class="lobby-section">Rules</div>
            <div class="lobby-row"><span>Starting stores</span><span class="lobby-seg">${pick('stock', 'lean', 'Lean', m.stock === 'lean')}${pick('stock', 'standard', 'Standard', m.stock === 'standard')}${pick('stock', 'rich', 'Rich', m.stock === 'rich')}</span></div>
            <div class="lobby-row"><span>AI captains</span><span class="lobby-seg">${pick('ai', 'easy', 'Easy', m.ai === 'easy')}${pick('ai', 'normal', 'Normal', m.ai === 'normal')}${pick('ai', 'hard', 'Hard', m.ai === 'hard')}</span></div>
          </div>
        </div>
        <div class="lobby-foot">
          <span class="lobby-problem">${problem}</span>
          <button data-act="back">Back</button>
          ${guest ? '' : `<button data-act="start" class="primary" ${problem ? 'disabled' : ''}>Start match</button>`}
        </div>
      </div>`;
  }
}
