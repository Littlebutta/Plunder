// Launch-time updater for the portable Plunder folder (no installer).
//
// Each push to main publishes a GitHub Release with:
//   latest.json              { version, shell, game, full }
//   game-<version>.zip       just the built game (dist/), a few MB
//   Plunder-win-x64.zip      the whole portable folder
//
// On launch we read latest.json and, if the game is newer, download the small
// game zip into <folder>/game/ and play it straight away. That always works,
// whatever shell (Electron, main process) is installed.
//
// If the shell itself changed, the full folder is fetched in the background
// while you play, unpacked into <folder>/update/, and copied over the folder
// by a small script after the game quits. The download is kept, so a swap
// that fails is retried on the next quit without downloading again, and it
// gives up on a version after a few tries. Everything is logged to
// <folder>/data/updater.log.
//
// latest.json used to call the shell fingerprint "shellId". Shells from before
// this file was rewritten took any shellId change as a reason to download the
// whole folder on the splash screen, and on some PCs the swap never completed,
// so they downloaded it again on every launch. The key is now "shell": those
// older shells see no fingerprint and take the game-only path, which works.
//
// Offline / slow / any error: we just play what's already in the folder.

const { BrowserWindow, app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { unzip, unzipSync } = require('fflate');

const RELEASES = process.env.PLUNDER_UPDATE_URL || 'https://github.com/Littlebutta/Plunder/releases';
const CHECK_TIMEOUT_MS = 10_000; // give up on the version check (not a running download) after this
const SHELL_ID = readJson(path.join(__dirname, 'shell.json'))?.id || 'dev';
/** Swap attempts per shell version before we stop trying (the game still updates). */
const MAX_SWAPS = 3;

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

const updateDir = () => path.join(portableDir(), 'update');
const logFile = () => path.join(portableDir(), 'data', 'updater.log');

/** Append a line to data/updater.log (kept short: the last ~200 lines). */
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(`[updater] ${msg}`);
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let old = '';
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {
      // first line
    }
    const lines = (old + line + '\r\n').split(/\r?\n/).filter(Boolean).slice(-200);
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
  } catch {
    // logging must never stop the game
  }
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
  if (total && got !== total) throw new Error(`download cut short (${got} of ${total} bytes)`);
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

// --- Shell (full folder) updates ----------------------------------------------------

/** Like extractTo, but off the main thread and with async writes, so a game in progress never stalls. */
async function extractToAsync(zipBuf, dir) {
  await fs.promises.rm(dir, { recursive: true, force: true });
  const files = await new Promise((resolve, reject) => unzip(new Uint8Array(zipBuf), (err, out) => (err ? reject(err) : resolve(out))));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const out = path.normalize(path.join(dir, name));
    if (!out.startsWith(dir + path.sep)) continue; // ignore path traversal
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.writeFile(out, data);
  }
}

/** A finished or abandoned swap leaves update/ behind: clear it once it is no use. */
function tidyUpdates() {
  const state = readJson(stateFile());
  if (fs.existsSync(updateDir()) && (!state || state.shell === SHELL_ID)) {
    fs.rmSync(updateDir(), { recursive: true, force: true });
    if (state) log(`shell ${SHELL_ID} is installed; cleared the staged update`);
  }
}

/** What is staged in update/: { version, shell, attempts } once a full folder is unpacked there. */
const stateFile = () => path.join(updateDir(), 'state.json');
const stagedFolder = (version) => path.join(updateDir(), `v${version}`);

/**
 * Fetch and unpack the full folder for `latest` into update/v<version>/, in the
 * background while the game runs. Does nothing if it is already there.
 */
async function stageShell(latest, shell) {
  const state = readJson(stateFile());
  if (state && state.shell === shell && fs.existsSync(path.join(stagedFolder(state.version), 'Plunder.exe'))) {
    if ((state.attempts || 0) >= MAX_SWAPS) log(`shell ${shell} failed to install ${state.attempts} times; not trying again`);
    return;
  }
  log(`shell changed (${SHELL_ID} -> ${shell}): downloading the full folder for v${latest.version} in the background`);
  fs.rmSync(updateDir(), { recursive: true, force: true });
  const zip = await download(`${RELEASES}/download/v${latest.version}/${latest.full}`, () => {});
  await extractToAsync(zip, stagedFolder(latest.version));
  if (!fs.existsSync(path.join(stagedFolder(latest.version), 'Plunder.exe'))) throw new Error('the full folder has no Plunder.exe');
  fs.writeFileSync(stateFile(), JSON.stringify({ version: latest.version, shell, attempts: 0 }));
  log(`staged v${latest.version}; it is copied in when the game quits`);
}

/**
 * Called as the app quits: if a new shell is staged, start the script that
 * copies it over the folder once this process (and its helpers) have exited.
 */
function applyStagedShell() {
  if (process.platform !== 'win32') return;
  const state = readJson(stateFile());
  if (!state || state.shell === SHELL_ID || (state.attempts || 0) >= MAX_SWAPS) return;
  const from = stagedFolder(state.version);
  if (!fs.existsSync(path.join(from, 'Plunder.exe'))) return;
  fs.writeFileSync(stateFile(), JSON.stringify({ ...state, attempts: (state.attempts || 0) + 1 }));
  const appDir = portableDir();
  const exeName = path.basename(app.getPath('exe'));
  const logPath = logFile();
  const script = path.join(updateDir(), 'apply-update.cmd');
  // No `timeout` here: it fails at once without a console. `ping` waits a second either way.
  fs.writeFileSync(
    script,
    [
      '@echo off',
      'setlocal',
      `set "LOG=${logPath}"`,
      `echo %date% %time% swap: waiting for Plunder (pid ${process.pid}) to exit>>"%LOG%"`,
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      `tasklist /FI "PID eq ${process.pid}" /NH 2>nul | find " ${process.pid} " >nul`,
      'if errorlevel 1 goto gone',
      'if %tries% geq 60 goto gone',
      'ping -n 2 127.0.0.1 >nul',
      'goto wait',
      ':gone',
      // Chromium's crash reporter and GPU helpers can hold the exe for a moment after the main process
      'ping -n 3 127.0.0.1 >nul',
      `robocopy "${from}" "${appDir}" /E /IS /IT /R:20 /W:1 /NFL /NDL /NJH /NP >>"%LOG%"`,
      'set rc=%errorlevel%',
      // (labels, not a bracketed block: a folder name with brackets in it would break one)
      'if %rc% geq 8 goto failed',
      `echo %date% %time% swap: done, robocopy code %rc%>>"%LOG%"`,
      `rmdir /s /q "${from}"`,
      `del "${stateFile()}"`,
      '(goto) 2>nul & del "%~f0"',
      ':failed',
      `echo %date% %time% swap: robocopy failed with code %rc%, will retry on the next quit>>"%LOG%"`,
      'exit /b 1',
      '',
    ].join('\r\n'),
  );
  log(`quitting: copying in the staged v${state.version} (try ${(state.attempts || 0) + 1} of ${MAX_SWAPS}) for ${exeName}`);
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Shows the splash, updates the game if needed. Resolves with
 *   { action: 'continue', gameDir, shell }  start the game (gameDir = downloaded game/, or null for bundled);
 *                                            `shell` is set when a newer shell should be fetched in the background
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
    let shellUpdate = null;
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
    const play = () => finish({ action: 'continue', gameDir: installedGame().dir, shell: shellUpdate });

    ipcMain.once('updater:skip', play);
    const checkTimer = setTimeout(play, CHECK_TIMEOUT_MS);

    (async () => {
      if (!isWritable(portableDir())) {
        log('folder is read-only; skipping updates');
        return play();
      }
      try {
        tidyUpdates();
      } catch (err) {
        log(`could not clear old update files: ${err && err.message}`);
      }
      status('Checking for updates…');
      const latest = await (await net.fetch(`${RELEASES}/latest/download/latest.json`, { signal: abort.signal, cache: 'no-store' })).json();
      const shell = latest?.shell || latest?.shellId;
      if (shell && shell !== SHELL_ID && SHELL_ID !== 'dev' && latest.full && process.platform === 'win32') shellUpdate = { latest, shell };
      const current = installedGame().version;
      if (!latest?.version || !newer(latest.version, current)) return play();
      clearTimeout(checkTimer); // an update is coming; don't time out the download

      status(`Downloading v${latest.version}…`, 0);
      const zip = await download(`${RELEASES}/download/v${latest.version}/${latest.game}`, (p) => status(`Downloading v${latest.version}… ${Math.round(p * 100)}%`, p), abort.signal);
      if (done) return;
      status(`Installing v${latest.version}…`, 1);
      installGame(zip, latest.version);
      log(`game updated ${current} -> ${latest.version}`);
      play();
    })().catch((err) => {
      if (!done) log(`update check failed: ${err && err.message}`);
      play(); // offline, rate-limited, etc: just play what we have
    });
  });
}

/** Fetch a newer shell in the background (after the game has opened). Never throws. */
function fetchShellInBackground(info) {
  if (!info) return;
  stageShell(info.latest, info.shell).catch((err) => log(`background shell download failed: ${err && err.message}`));
}

module.exports = { runUpdateCheck, fetchShellInBackground, applyStagedShell, installedGame, portableDir, SHELL_ID };
