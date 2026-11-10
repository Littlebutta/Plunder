// Plunder desktop shell (Electron main process).
//
// Plunder is a portable folder: no installer, nothing written outside it.
// Packaged builds show a small "checking for updates" window, pull the newest
// release from GitHub (Littlebutta/Plunder) into the folder, then open the game.
// Offline or on any updater error the game just starts. See updater.cjs.
//
// The game itself is the normal Vite build (dist/, or a newer downloaded copy in
// <folder>/game/), served over a custom
// app:// protocol with cross-origin isolation headers so Web Workers and
// SharedArrayBuffer (multithreaded physics/projectiles) are available.

const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runUpdateCheck, installedGame, portableDir } = require('./updater.cjs');

const BUNDLED_DIST = path.join(__dirname, '..', 'dist');
let gameRoot = BUNDLED_DIST; // swapped for <folder>/game when a newer game build was downloaded

// Keep settings, saves and caches inside the portable folder (data/), not in %APPDATA%.
if (app.isPackaged) app.setPath('userData', path.join(portableDir(), 'data'));
const DEV_URL = process.env.PLUNDER_DEV_URL; // e.g. http://localhost:5173 (see `npm run desktop:dev`)

// Headers that make the page "crossOriginIsolated" (needed for SharedArrayBuffer).
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

// One running copy only (a second launch focuses the first window).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(gameRoot, rel));
    if (!file.startsWith(gameRoot + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
}

function createGameWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    show: false,
    backgroundColor: '#7fc8e8',
    title: `Plunder ${installedGame().version}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'), // Steam and "second window" for online play
    },
  });

  win.once('ready-to-show', () => win.show());
  // Keep the version in the title bar so it's obvious which build is running.
  win.on('page-title-updated', (e) => e.preventDefault());

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I')) {
      win.webContents.toggleDevTools();
    }
  });

  // External links open in the real browser, never inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(DEV_URL || 'app://plunder/index.html');
  return win;
}

async function start() {
  Menu.setApplicationMenu(null);
  registerAppProtocol();

  if (app.isPackaged) {
    if (process.argv.includes('--no-update')) {
      gameRoot = installedGame().dir || BUNDLED_DIST;
    } else {
      const result = await runUpdateCheck(ipcMain);
      if (result.action === 'restart') return app.quit(); // files get swapped, then Plunder relaunches
      gameRoot = result.gameDir || BUNDLED_DIST;
    }
  }

  // Online play: Steam is loaded only when the game asks, and never stops the game from starting.
  try {
    require('./steam.cjs').register(ipcMain);
  } catch (err) {
    console.error('Steam bridge unavailable:', err);
  }
  // A second game window, for trying an online match alone on one computer.
  ipcMain.on('plunder:new-window', () => {
    if (BrowserWindow.getAllWindows().length < 4) createGameWindow();
  });

  gameWindow = createGameWindow();
}

// The splash closes before the game window opens, so only quit once the game has been shown.
let gameWindow = null;
app.on('window-all-closed', () => {
  if (gameWindow) app.quit();
});
