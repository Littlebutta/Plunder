// Fingerprint of everything in the desktop shell that the small game-only update
// can't replace: the Electron main-process files, Electron itself and the packaging
// config. Written to electron/shell.json (bundled with the app) and printed for
// latest.json. When it changes, installed copies download the full folder instead.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hash = createHash('sha256');
const shellFiles = readdirSync('electron')
  .filter((f) => f !== 'shell.json' && f !== 'dev.mjs')
  .sort()
  .map((f) => `electron/${f}`);
for (const f of [...shellFiles, 'electron-builder.yml']) {
  hash.update(f).update(readFileSync(f));
}
hash.update(require('electron/package.json').version);
hash.update(require('fflate/package.json').version);

const id = hash.digest('hex').slice(0, 16);
writeFileSync('electron/shell.json', JSON.stringify({ id }) + '\n');
console.log(id);
