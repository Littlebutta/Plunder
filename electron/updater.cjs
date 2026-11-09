// Launch-time updater for the portable Plunder folder (no installer).
//
// Each push to main publishes a GitHub Release with:
//   latest.json              { version, shellId, game, full }
//   game-<version>.zip       just the built game (dist/), ~1-2 MB
//   Plunder-win-x64.zip      the whole portable folder
//
// On launch we read latest.json. If only the game changed (same shellId) we
// download the small game zip into <folder>/game/ and play it straight away.
// If the Electron shell itself changed, we download the full folder zip and a
// tiny script swaps the files in place after the game quits, then relaunches.
// Offline / slow / any error: we just play what's already in the folder.

const { BrowserWindow, app, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { unzipSync } = require('fflate');

const RELEASES = process.env.PLUNDER_UPDATE_URL || 'https://github.com/Littlebutta/Plunder/releases';
const CHECK_TIMEOUT_MS = 10_000; // give up on the version check (not a running download) after this
const SHELL_ID = readJson(path.join(__dirname, 'shell.json'))?.id || 'dev';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Folder that holds Plunder.exe; everything (game updates, saves) lives inside it. */
function portableDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

/** Version of the game files currently played (downloaded game/ or the one bundled with the shell). */
function installedGame() {
  const gameDir = path.join(portableDir(), 'game');
  const v = readJson(path.join(gameDir, 'version.json'))?.version;
  if (v && !newer(app.getVersion(), v) && fs.existsSync(path.join(gameDir, 'index.html'))) {
    return { version: v, dir: gameDir };
  }
  return { version: app.getVersion(), dir: null };
}

function isWritable(dir) {
  try {
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function download(url, onProgress, signal) {
  const res = await net.fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return Buffer.concat(chunks);
}

/** Write a zip's files into dir (created fresh). */
function extractTo(zipBuf, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const files = unzipSync(new Uint8Array(zipBuf));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const out = path.normalize(path.join(dir, name));
    if (!out.startsWith(dir + path.sep)) continue; // ignore path traversal
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

/** Small game-only update: unpack into game.new/ then swap it in for game/. */
function installGame(zipBuf, version) {
  const base = portableDir();
  const staging = path.join(base, 'game.new');
  extractTo(zipBuf, staging);
  fs.writeFileSync(path.join(staging, 'version.json'), JSON.stringify({ version }));
  const live = path.join(base, 'game');
  fs.rmSync(live, { recursive: true, force: true });
  fs.renameSync(staging, live);
}

/**
 * Full update (Windows): unpack the new folder to %TEMP%, then a cmd script waits
 * for this process to exit, copies the files over the portable folder (data/ is
 * untouched), drops the old game/ override and relaunches Plunder.exe.
 */
function stageFullUpdate(zipBuf, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plunder-update-'));
  const newDir = path.join(tmp, 'Plunder');
  extractTo(zipBuf, newDir);
  const appDir = portableDir();
  const exe = path.join(appDir, path.basename(app.getPath('exe')));
  const script = path.join(tmp, 'apply-update.cmd');
  fs.writeFileSync(
    script,
    [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      'timeout /t 1 /nobreak >nul',
      `robocopy "${newDir}" "${appDir}" /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul`,
      `if exist "${path.join(appDir, 'game')}" rmdir /s /q "${path.join(appDir, 'game')}"`,
      `start "" "${exe}"`,
      `(goto) 2>nul & rmdir /s /q "${tmp}"`,
      '',
    ].join('\r\n'),
  );
  console.log(`[updater] staged full update to v${version}`);
  return () => {
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  };
}

/**
 * Shows the splash, updates if needed. Resolves with
 *   { action: 'continue', gameDir }  start the game (gameDir = downloaded game/, or null for bundled)
 *   { action: 'restart' }            a full update is applying; the app will relaunch
 */
function runUpdateCheck(ipcMain) {
  return new Promise((resolve) => {
    const splash = new BrowserWindow({
      width: 420,
      height: 220,
      frame: false,
      resizable: false,
      center: true,
      show: false,
      backgroundColor: '#13324a',
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    splash.once('ready-to-show', () => splash.show());
    splash.loadFile(path.join(__dirname, 'splash.html'));

    const abort = new AbortController();
    let done = false;
    const status = (text, progress) => {
      if (!splash.isDestroyed()) splash.webContents.send('updater:status', { text, progress });
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(checkTimer);
      abort.abort();
      ipcMain.removeAllListeners('updater:skip');
      if (!splash.isDestroyed()) splash.destroy();
      resolve(result);
    };
    const play = () => finish({ action: 'continue', gameDir: installedGame().dir });

    ipcMain.once('updater:skip', play);
    const checkTimer = setTimeout(play, CHECK_TIMEOUT_MS);

    (async () => {
      if (!isWritable(portableDir())) {
        console.warn('[updater] folder is read-only; skipping updates');
        return play();
      }
      status('Checking for updates…');
      const latest = await (await net.fetch(`${RELEASES}/latest/download/latest.json`, { signal: abort.signal, cache: 'no-store' })).json();
      const current = installedGame().version;
      if (!latest?.version || !newer(latest.version, current)) return play();
      clearTimeout(checkTimer); // an update is coming; don't time out the download

      const assetBase = `${RELEASES}/download/v${latest.version}`;
      const shellChanged = latest.shellId && latest.shellId !== SHELL_ID && SHELL_ID !== 'dev';

      if (shellChanged && process.platform === 'win32') {
        status(`Downloading Plunder v${latest.version}…`, 0);
        const zip = await download(`${assetBase}/${latest.full}`, (p) => status(`Downloading Plunder v${latest.version}… ${Math.round(p * 100)}%`, p), abort.signal);
        status(`Installing v${latest.version}…`, 1);
        const apply = stageFullUpdate(zip, latest.version);
        if (done) return; // player hit "Play now" meanwhile
        done = true;
        if (!splash.isDestroyed()) splash.destroy();
        apply();
        resolve({ action: 'restart' });
        return;
      }

      status(`Downloading v${latest.version}…`, 0);
      const zip = await download(`${assetBase}/${latest.game}`, (p) => status(`Downloading v${latest.version}… ${Math.round(p * 100)}%`, p), abort.signal);
      if (done) return;
      status(`Installing v${latest.version}…`, 1);
      installGame(zip, latest.version);
      play();
    })().catch((err) => {
      if (!done) console.warn('[updater]', err && err.message);
      play(); // offline, rate-limited, etc: just play what we have
    });
  });
}

module.exports = { runUpdateCheck, installedGame, portableDir, SHELL_ID };
