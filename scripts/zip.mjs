// node scripts/zip.mjs <folder> <out.zip>: zip a folder's contents (paths relative to it).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const [src, out] = process.argv.slice(2);
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(src, p).split('\\').join('/')] = [readFileSync(p), { level: 6 }];
  }
})(src);
writeFileSync(out, zipSync(files));
console.log(`${out}: ${Object.keys(files).length} files`);
