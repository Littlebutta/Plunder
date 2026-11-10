/**
 * How two copies of the game talk to each other. The game only ever sees this
 * interface; underneath it is either Steam (lobbies and peer-to-peer packets,
 * through the desktop shell) or a link between windows on the same computer,
 * which is there so an online match can be tried without a second machine.
 */

export interface Peer {
  id: string;
  name: string;
}

export type Message = unknown[];

export interface Transport {
  readonly kind: 'steam' | 'local';
  readonly self: Peer;
  /** The room's invite code; '' when not in one. */
  readonly room: string;
  /** Peer id of whoever made the room. */
  readonly hostId: string;
  /** Everyone in the room, this copy included. */
  peers(): Peer[];
  /** Make a room and return its invite code. */
  create(): Promise<string>;
  join(code: string): Promise<void>;
  /** Pick the room up again after the page reloaded into the match. */
  resume(code: string, asHost: boolean): Promise<void>;
  leave(): void;
  /** `to` null: everyone else in the room. Unreliable messages may be dropped or arrive out of order. */
  send(to: string | null, msg: Message, reliable: boolean): void;
  onMessage: (from: string, msg: Message) => void;
  /** Someone joined or left. */
  onPeers: () => void;
  /** Steam: the player accepted a friend's invite to this room code. */
  onInvite: (code: string) => void;
  /** Steam: open the invite-a-friend dialog, if the overlay is there. */
  invite?(): void;
}

/** What the desktop shell's preload script exposes (electron/preload.cjs). */
export interface DesktopBridge {
  steam: {
    info(): Promise<{ ok: boolean; id: string; name: string; error: string }>;
    create(max: number): Promise<{ ok: boolean; code: string; error: string }>;
    join(code: string): Promise<{ ok: boolean; error: string }>;
    leave(): Promise<void>;
    state(): Promise<SteamLobbyState | null>;
    send(to: string | null, reliable: boolean, data: string): void;
    invite(): void;
    on(handler: (event: SteamEvent) => void): void;
  };
  newWindow(): void;
}
export interface SteamLobbyState {
  code: string;
  host: string;
  members: string[];
}
export type SteamEvent = { type: 'msg'; from: string; data: string } | { type: 'lobby'; state: SteamLobbyState | null } | { type: 'invite'; code: string };

export const desktop = (): DesktopBridge | null => (window as unknown as { plunderDesktop?: DesktopBridge }).plunderDesktop ?? null;

const noop = () => {};

function stored(key: string, make: () => string): string {
  try {
    const had = sessionStorage.getItem(key);
    if (had) return had;
    const made = make();
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return make();
  }
}
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomCode = (n: number) => Array.from({ length: n }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

/**
 * Windows (or browser tabs) of the same copy of the game, linked with a
 * BroadcastChannel. Each keeps saying it is there; one that goes quiet has left.
 */
export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly self: Peer;
  room = '';
  hostId = '';
  onMessage: Transport['onMessage'] = noop;
  onPeers: () => void = noop;
  onInvite: (code: string) => void = noop;
  private channel: BroadcastChannel | null = null;
  private readonly seen = new Map<string, { name: string; at: number; host: boolean }>();
  private beat = 0;
  private hosting = false;

  constructor() {
    const id = stored('plunder.peer', () => randomCode(8));
    this.self = { id, name: `Captain ${id.slice(0, 3)}` };
  }

  peers(): Peer[] {
    return [this.self, ...[...this.seen].map(([id, p]) => ({ id, name: p.name }))].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async create(): Promise<string> {
    this.open(randomCode(4), true);
    return this.room;
  }

  async join(code: string): Promise<void> {
    this.open(code.trim().toUpperCase(), false);
    // wait for the host to answer
    await new Promise<void>((resolve, reject) => {
      const began = Date.now();
      const look = () => {
        if (this.hostId) resolve();
        else if (Date.now() - began > 3000) {
          this.leave();
          reject(new Error('Nobody is hosting a match with that code on this computer.'));
        } else setTimeout(look, 100);
      };
      look();
    });
  }

  async resume(code: string, asHost: boolean): Promise<void> {
    this.open(code, asHost);
  }

  leave(): void {
    if (!this.channel) return;
    this.channel.postMessage({ t: 'bye', from: this.self.id });
    this.channel.close();
    this.channel = null;
    clearInterval(this.beat);
    this.seen.clear();
    this.room = '';
    this.hostId = '';
  }

  send(to: string | null, msg: Message): void {
    this.channel?.postMessage({ t: 'm', from: this.self.id, to, d: msg });
  }

  private open(code: string, asHost: boolean): void {
    this.leave();
    this.room = code;
    this.hosting = asHost;
    this.hostId = asHost ? this.self.id : '';
    const channel = new BroadcastChannel(`plunder.room.${code}`);
    this.channel = channel;
    channel.onmessage = (e) => {
      const m = e.data as { t: string; from: string; to?: string | null; d?: Message; name?: string; host?: boolean };
      if (!m || m.from === this.self.id) return;
      if (m.t === 'hi') {
        const fresh = !this.seen.has(m.from);
        this.seen.set(m.from, { name: m.name ?? 'Captain', at: Date.now(), host: !!m.host });
        if (m.host) this.hostId = m.from;
        if (fresh) {
          this.hello(); // so the newcomer hears of us at once
          this.onPeers();
        }
      } else if (m.t === 'bye') {
        if (this.seen.delete(m.from)) this.onPeers();
      } else if (m.t === 'm' && m.d && (m.to == null || m.to === this.self.id)) {
        this.onMessage(m.from, m.d);
      }
    };
    this.hello();
    let lastBeat = Date.now();
    this.beat = window.setInterval(() => {
      this.hello();
      const now = Date.now();
      // if this window was the one that stalled (loading, a long frame, minimised), the others
      // only look quiet because their messages are still queued: give them the benefit of the doubt
      if (now - lastBeat > 2500) for (const p of this.seen.values()) p.at = now;
      lastBeat = now;
      let gone = false;
      for (const [id, p] of this.seen) {
        if (now - p.at > 10000) {
          this.seen.delete(id);
          gone = true;
        }
      }
      if (gone) this.onPeers();
    }, 700);
    window.addEventListener('pagehide', () => this.channel?.postMessage({ t: 'bye', from: this.self.id }));
  }

  private hello(): void {
    this.channel?.postMessage({ t: 'hi', from: this.self.id, name: this.self.name, host: this.hosting });
  }
}

/** Steam lobbies and peer-to-peer packets, by way of the desktop shell. */
export class SteamTransport implements Transport {
  readonly kind = 'steam' as const;
  readonly self: Peer;
  room = '';
  hostId = '';
  onMessage: Transport['onMessage'] = noop;
  onPeers: () => void = noop;
  onInvite: (code: string) => void = noop;
  private members: string[] = [];

  constructor(
    private readonly bridge: DesktopBridge['steam'],
    me: Peer,
  ) {
    this.self = me;
    bridge.on((e) => {
      if (e.type === 'msg') {
        try {
          const msg = JSON.parse(e.data) as Message;
          if (Array.isArray(msg)) this.onMessage(e.from, msg);
        } catch {
          // not ours
        }
      } else if (e.type === 'lobby') this.take(e.state);
      else if (e.type === 'invite') this.onInvite(e.code);
    });
  }

  /** Names travel in the game's own hello messages; until one arrives a peer is just "Captain". */
  peers(): Peer[] {
    return this.members.map((id) => (id === this.self.id ? this.self : { id, name: 'Captain' }));
  }

  async create(): Promise<string> {
    const r = await this.bridge.create(8);
    if (!r.ok) throw new Error(r.error || 'Steam could not make a lobby.');
    this.take(await this.bridge.state());
    return this.room;
  }

  async join(code: string): Promise<void> {
    const r = await this.bridge.join(code.trim());
    if (!r.ok) throw new Error(r.error || 'Could not join that lobby.');
    this.take(await this.bridge.state());
  }

  async resume(): Promise<void> {
    this.take(await this.bridge.state());
  }

  leave(): void {
    void this.bridge.leave();
    this.take(null);
  }

  send(to: string | null, msg: Message, reliable: boolean): void {
    const data = JSON.stringify(msg);
    // Steam drops unreliable packets over 1200 bytes, so big ones go the reliable way
    this.bridge.send(to, reliable || data.length > 1100, data);
  }

  invite(): void {
    this.bridge.invite();
  }

  private take(state: SteamLobbyState | null): void {
    this.room = state?.code ?? '';
    this.hostId = state?.host ?? '';
    this.members = state?.members ?? [];
    this.onPeers();
  }
}

/** Is Steam there to play over? Resolves to the transport, or the reason it is not. */
export async function steamTransport(): Promise<SteamTransport | string> {
  const bridge = desktop();
  if (!bridge) return 'Steam play needs the desktop version of Plunder.';
  try {
    const info = await bridge.steam.info();
    if (!info.ok) return info.error || 'Steam is not running. Start Steam, then restart Plunder.';
    return new SteamTransport(bridge.steam, { id: info.id, name: info.name });
  } catch {
    return 'Steam is not available in this copy of Plunder.';
  }
}
