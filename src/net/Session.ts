import type { MatchConfig, MatchSlot, NetInfo } from '../world/Match';
import { LocalTransport, Message, Peer, steamTransport, Transport } from './Transport';

/**
 * The online side of the Vs lobby. One copy hosts: it owns the match settings
 * and seats the friends who join. Everyone else sees the host's lobby and
 * waits. When the host starts, every copy gets the same MatchConfig (with its
 * own seat marked) and reloads into the match.
 *
 * Lobby messages: ['hi', name, colour] from anyone, ['lobby', config] and
 * ['start', config] from the host.
 */
export class LobbySession {
  transport: Transport | null = null;
  /** What the players are called, by peer id (from their hello). */
  readonly names = new Map<string, { name: string; colour: string; captain: string }>();
  hosting = false;
  private hostAtJoin = '';
  /** Something for the lobby to redraw. */
  onChange: () => void = () => {};
  /** Client: the host's lobby arrived. */
  onLobby: (m: MatchConfig) => void = () => {};
  /** The host started the match: reload into it. */
  onStart: (m: MatchConfig) => void = () => {};
  /** Steam: an invite was accepted while the game was open. */
  onInvite: (code: string) => void = () => {};
  /** The room is gone (the host left). */
  onClosed: (why: string) => void = () => {};

  constructor(private readonly me: () => { colour: string; captain: string }) {}

  get online(): boolean {
    return !!this.transport?.room;
  }

  get code(): string {
    return this.transport?.room ?? '';
  }

  peers(): Peer[] {
    return (this.transport?.peers() ?? []).map((p) => ({ id: p.id, name: this.names.get(p.id)?.name ?? p.name }));
  }

  /** Make a room over Steam, or between windows on this computer. */
  async host(kind: 'steam' | 'local'): Promise<void> {
    await this.open(kind);
    await this.transport!.create();
    this.hosting = true;
    this.hello();
    this.onChange();
  }

  async join(kind: 'steam' | 'local', code: string): Promise<void> {
    await this.open(kind);
    await this.transport!.join(code);
    this.hosting = false;
    this.hostAtJoin = this.transport!.hostId;
    this.hello();
    this.onChange();
  }

  leave(): void {
    this.transport?.leave();
    this.transport = null;
    this.hosting = false;
    this.names.clear();
    this.onChange();
  }

  /** Host: seat whoever is in the room, and send everyone the lobby as it stands. */
  seat(m: MatchConfig): void {
    const t = this.transport;
    if (!t || !this.hosting) return;
    const here = this.peers().filter((p) => p.id !== t.self.id);
    for (const s of m.slots) {
      // a seat whose player has gone is open again
      if (s.peer && s.peer !== t.self.id && !here.some((p) => p.id === s.peer)) {
        delete s.peer;
        s.kind = 'open';
      }
    }
    m.slots[0].peer = t.self.id;
    for (const p of here) {
      let s = m.slots.find((x) => x.peer === p.id);
      if (!s) {
        s = m.slots.find((x, i) => i > 0 && x.kind === 'open' && !x.peer) ?? m.slots.find((x, i) => i > 0 && x.kind === 'closed') ?? m.slots.find((x, i) => i > 0 && x.kind === 'ai');
        if (!s) continue; // the lobby is full
        s.peer = p.id;
        s.kind = 'open';
        const wants = this.names.get(p.id)?.colour;
        if (wants && !m.slots.some((x) => x !== s && x.kind !== 'closed' && x.colour === wants)) s.colour = wants;
      }
      s.name = p.name;
      // each player sails the captain they picked (the same one as someone else is fine)
      const captain = this.names.get(p.id)?.captain;
      if (captain) s.captain = captain;
    }
    m.slots[0].name = this.names.get(t.self.id)?.name ?? t.self.name;
    m.slots[0].captain = this.me().captain;
    t.send(null, ['lobby', m], true);
  }

  /** Host: start. Open seats nobody took are closed; every copy is told its own seat. */
  start(m: MatchConfig): void {
    const t = this.transport;
    if (!t || !this.hosting) return;
    const slots: MatchSlot[] = m.slots.map((s) => ({ ...s, kind: s.kind === 'open' ? (s.peer ? 'human' : 'closed') : s.kind }));
    const config: MatchConfig = { ...m, slots, autostart: true };
    t.send(null, ['start', config], true);
    this.onStart(seated(config, t, true));
  }

  private async open(kind: 'steam' | 'local'): Promise<void> {
    this.transport?.leave();
    let t: Transport;
    if (kind === 'steam') {
      const steam = await steamTransport();
      if (typeof steam === 'string') throw new Error(steam);
      t = steam;
    } else t = new LocalTransport();
    this.transport = t;
    this.names.clear();
    t.onPeers = () => {
      // the host going ends the lobby (Steam would hand it to someone else; we do not carry on without them)
      if (!this.hosting && t.room && this.hostAtJoin && (t.hostId !== this.hostAtJoin || !t.peers().some((p) => p.id === this.hostAtJoin))) {
        this.leave();
        this.onClosed('The host has left the lobby.');
        return;
      }
      this.hello();
      this.onChange();
    };
    t.onInvite = (code) => this.onInvite(code);
    t.onMessage = (from, msg) => this.take(from, msg);
  }

  private hello(): void {
    const t = this.transport;
    if (!t) return;
    const mine = { name: t.self.name, colour: this.me().colour, captain: this.me().captain };
    this.names.set(t.self.id, mine);
    t.send(null, ['hi', mine.name, mine.colour, mine.captain], true);
  }

  private take(from: string, msg: Message): void {
    const t = this.transport;
    if (!t) return;
    if (msg[0] === 'hi') {
      this.names.set(from, { name: String(msg[1]).slice(0, 24), colour: String(msg[2]), captain: String(msg[3] ?? '').slice(0, 24) });
      this.onChange();
    } else if (from === t.hostId && msg[0] === 'lobby') {
      this.onLobby(msg[1] as MatchConfig);
    } else if (from === t.hostId && msg[0] === 'start') {
      const config = msg[1] as MatchConfig;
      if (config.slots.some((s) => s.peer === t.self.id)) this.onStart(seated(config, t, false));
    }
  }
}

/** The match as one copy sees it: the shared config plus that copy's own seat. */
function seated(config: MatchConfig, t: Transport, host: boolean): MatchConfig {
  const captains = config.slots.filter((s) => s.kind !== 'closed');
  const net: NetInfo = { transport: t.kind, room: t.room, host, me: captains.findIndex((s) => s.peer === t.self.id) };
  return { ...config, net };
}

/**
 * The link during a match. Faction ids are the same on every copy, so messages
 * name factions; this maps them to and from the transport's peers.
 */
export class MatchLink {
  readonly host: boolean;
  /** Messages by their first element. `from` is the sender's faction. */
  readonly handlers = new Map<string, (from: number, msg: Message) => void>();
  /** A player has gone (their faction id). On a client, the host going ends the match. */
  onLeft: (faction: number) => void = () => {};
  private transport: Transport | null = null;
  private readonly peerOf = new Map<number, string>();
  private readonly factionOf = new Map<string, number>();
  private readonly here = new Set<number>();
  /** The host always sits in the first seat. */
  private readonly hostFaction = 0;
  private readonly queue: { to: number | null; msg: Message; reliable: boolean }[] = [];

  constructor(match: MatchConfig) {
    const info = match.net!;
    this.host = info.host;
    match.slots
      .filter((s) => s.kind !== 'closed')
      .forEach((s, f) => {
        if (!s.peer || s.kind !== 'human') return;
        this.peerOf.set(f, s.peer);
        this.factionOf.set(s.peer, f);
        if (f !== info.me) this.here.add(f);
      });
    void this.open(info);
  }

  /** `to` null: every other player. */
  send(msg: Message, reliable = true, to: number | null = null): void {
    const t = this.transport;
    if (!t) {
      if (reliable) this.queue.push({ to, msg, reliable });
      return;
    }
    if (to === null) t.send(null, msg, reliable);
    else {
      const peer = this.peerOf.get(to);
      if (peer) t.send(peer, msg, reliable);
    }
  }

  toHost(msg: Message, reliable = true): void {
    this.send(msg, reliable, this.hostFaction);
  }

  leave(): void {
    this.transport?.leave();
    this.transport = null;
  }

  private async open(info: NetInfo): Promise<void> {
    let t: Transport;
    if (info.transport === 'steam') {
      const steam = await steamTransport();
      if (typeof steam === 'string') return;
      t = steam;
    } else t = new LocalTransport();
    t.onMessage = (from, msg) => {
      const f = this.factionOf.get(from);
      if (f !== undefined && typeof msg[0] === 'string') this.handlers.get(msg[0])?.(f, msg);
    };
    let settled = false;
    t.onPeers = () => {
      if (!settled) return;
      const ids = new Set(t.peers().map((p) => p.id));
      for (const f of [...this.here]) {
        if (ids.has(this.peerOf.get(f)!)) continue;
        this.here.delete(f);
        this.onLeft(f);
      }
    };
    await t.resume(info.room, info.host);
    this.transport = t;
    for (const q of this.queue.splice(0)) this.send(q.msg, q.reliable, q.to);
    // everyone reloads into the match at their own pace: give them a while to turn up before calling them gone
    setTimeout(() => {
      settled = true;
      t.onPeers();
    }, 20000);
  }
}
