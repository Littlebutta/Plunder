// Launch-time updater: checks GitHub Releases for a newer Plunder build,
// downloads it with a progress window, then silently installs and relaunches.

const { BrowserWindow } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

const CHECK_TIMEOUT_MS = 10_000; // give up on the check (not the download) after this

/**
 * Resolves with 'installing' when an update was downloaded and the app is
 * restarting into it, or 'continue' when the game should just start.
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

    let done = false;
    const status = (text, progress) => {
      if (!splash.isDestroyed()) splash.webContents.send('updater:status', { text, progress });
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(checkTimer);
      ipcMain.removeAllListeners('updater:skip');
      autoUpdater.removeAllListeners();
      if (!splash.isDestroyed()) splash.destroy();
      resolve(result);
    };

    ipcMain.once('updater:skip', () => finish('continue'));

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // if the player skips mid-download, install next quit
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => status('Checking for updates…'));
    autoUpdater.on('update-not-available', () => {
      status('Up to date');
      finish('continue');
    });
    autoUpdater.on('update-available', (info) => {
      clearTimeout(checkTimer); // a download is coming; don't time it out
      status(`Downloading v${info.version}…`, 0);
    });
    autoUpdater.on('download-progress', (p) => {
      status(`Downloading update… ${Math.round(p.percent)}%`, p.percent / 100);
    });
    autoUpdater.on('update-downloaded', (info) => {
      status(`Installing v${info.version}…`, 1);
      done = true;
      setTimeout(() => {
        // isSilent = true (no installer UI), isForceRunAfter = true (relaunch the game)
        autoUpdater.quitAndInstall(true, true);
      }, 600);
      resolve('installing');
    });
    autoUpdater.on('error', (err) => {
      console.warn('[updater]', err && err.message);
      finish('continue'); // offline, rate-limited, etc: just play the installed version
    });

    const checkTimer = setTimeout(() => finish('continue'), CHECK_TIMEOUT_MS);

    autoUpdater.checkForUpdates().catch(() => finish('continue'));
  });
}

module.exports = { runUpdateCheck };
