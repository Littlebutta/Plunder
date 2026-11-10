// Steam bridge for online play (main process).
//
// The game (renderer) asks for Steam through electron/preload.cjs; this file
// answers with steamworks.js: one lobby at a time, and peer-to-peer packets
// between its members. Until Plunder has its own Steamworks app id it runs on
// Valve's public test app, 480 ("Spacewar"), which any Steam account can use.
//
// Steam is only loaded when the game first asks for it, and every failure is
// reported back as text, so a missing or broken Steam can never stop Plunder
// (or its updater) from starting.

const { BrowserWindow } = require('electron');

const APP_ID = 480;
// steamworks.js enums (they are compile-time only in its typings)
const LOBBY_FRIENDS_ONLY = 1;
const SEND_UNRELIABLE = 0;
const SEND_RELIABLE = 2;
const CB_LOBBY_CHAT_UPDATE = 5;
const CB_P2P_SESSION_REQUEST = 6;
const CB_GAME_LOBBY_JOIN_REQUESTED = 8;

let client = null;
let tried = false;
let failure = '';
let lobby = null;

function tell(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('steam:event', event);
  }
}

function lobbyState() {
  if (!lobby) return null;
  try {
    return {
      code: String(lobby.id),
      host: String(lobby.getOwner().steamId64),
      members: lobby.getMembers().map((m) => String(m.steamId64)),
    };
  } catch {
    return null;
  }
}

function ensure() {
  if (tried) return client;
  tried = true;
  try {
    const steamworks = require('steamworks.js');
    client = steamworks.init(APP_ID);
    const cb = steamworks.SteamCallback || {};
    client.callback.register(cb.LobbyChatUpdate ?? CB_LOBBY_CHAT_UPDATE, () => tell({ type: 'lobby', state: lobbyState() }));
    client.callback.register(cb.P2PSessionRequest ?? CB_P2P_SESSION_REQUEST, ({ remote }) => {
      // only talk to people in our lobby
      const state = lobbyState();
      if (state && state.members.includes(String(remote))) client.networking.acceptP2PSession(remote);
    });
    client.callback.register(cb.GameLobbyJoinRequested ?? CB_GAME_LOBBY_JOIN_REQUESTED, (e) => tell({ type: 'invite', code: String(e.lobby_steam_id) }));
    // hand incoming packets to the game
    setInterval(() => {
      try {
        let size;
        let budget = 256;
        while (budget-- > 0 && (size = client.networking.isP2PPacketAvailable()) > 0) {
          const packet = client.networking.readP2PPacket(size);
          tell({ type: 'msg', from: String(packet.steamId.steamId64), data: packet.data.toString('utf8') });
        }
      } catch {
        // a bad packet is dropped
      }
    }, 8);
  } catch (err) {
    client = null;
    failure = /steam/i.test(String(err && err.message)) ? 'Steam is not running. Start Steam, then restart Plunder.' : `Steam could not be loaded (${String((err && err.message) || err).slice(0, 120)}).`;
  }
  return client;
}

const text = (err) => String((err && err.message) || err || 'Steam said no.').slice(0, 160);

function register(ipcMain) {
  ipcMain.handle('steam:info', () => {
    const c = ensure();
    if (!c) return { ok: false, id: '', name: '', error: failure };
    try {
      return { ok: true, id: String(c.localplayer.getSteamId().steamId64), name: c.localplayer.getName(), error: '' };
    } catch (err) {
      return { ok: false, id: '', name: '', error: text(err) };
    }
  });
  ipcMain.handle('steam:create', async (_e, max) => {
    const c = ensure();
    if (!c) return { ok: false, code: '', error: failure };
    try {
      if (lobby) lobby.leave();
      lobby = await c.matchmaking.createLobby(LOBBY_FRIENDS_ONLY, Math.min(4, Math.max(2, Number(max) || 4)));
      lobby.setData('game', 'plunder');
      return { ok: true, code: String(lobby.id), error: '' };
    } catch (err) {
      lobby = null;
      return { ok: false, code: '', error: text(err) };
    }
  });
  ipcMain.handle('steam:join', async (_e, code) => {
    const c = ensure();
    if (!c) return { ok: false, error: failure };
    if (!/^\d{5,20}$/.test(String(code))) return { ok: false, error: 'That is not a Steam invite code.' };
    try {
      if (lobby) lobby.leave();
      lobby = await c.matchmaking.joinLobby(BigInt(code));
      return { ok: true, error: '' };
    } catch (err) {
      lobby = null;
      return { ok: false, error: `Could not join. Check the code, and that the host is your Steam friend. (${text(err)})` };
    }
  });
  ipcMain.handle('steam:leave', () => {
    try {
      if (lobby) lobby.leave();
    } catch {
      // already gone
    }
    lobby = null;
  });
  ipcMain.handle('steam:state', () => lobbyState());
  ipcMain.on('steam:send', (_e, to, reliable, data) => {
    if (!client || !lobby || typeof data !== 'string') return;
    try {
      const me = String(client.localplayer.getSteamId().steamId64);
      const state = lobbyState();
      if (!state) return;
      const buffer = Buffer.from(data, 'utf8');
      const type = reliable ? SEND_RELIABLE : SEND_UNRELIABLE;
      for (const id of state.members) {
        if (id === me || (to && to !== id)) continue;
        client.networking.sendP2PPacket(BigInt(id), type, buffer);
      }
    } catch {
      // not sent
    }
  });
  ipcMain.on('steam:invite', () => {
    try {
      if (lobby) lobby.openInviteDialog();
    } catch {
      // no overlay
    }
  });
}

module.exports = { register };
