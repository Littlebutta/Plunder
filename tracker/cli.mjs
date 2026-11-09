#!/usr/bin/env node
// Plunder dev tracker CLI — how Claude sessions (and anyone with a terminal) read and update
// the tracker that Devin edits in tracker/index.html.
//
// The data lives in ONE place: `tracker.json` on the `tracker-data` branch of this repo.
// Keeping it off `main` means tracker edits never trigger a desktop release and never
// conflict with feature branches.
//
//   node tracker/cli.mjs                      summary of everything open
//   node tracker/cli.mjs list [--cat feature] [--status idea] [--all]
//   node tracker/cli.mjs show F-12
//   node tracker/cli.mjs add feature "Title" [--status idea] [--priority high] [--milestone M-4]
//                                            [--tags a,b] [--notes "..."] [--link URL]
//   node tracker/cli.mjs set F-12 [--status complete] [--title ...] [--priority ...] [--milestone ...]
//                                 [--tags a,b] [--notes "..."] [--append-note "..."] [--link URL]
//   node tracker/cli.mjs json                 print the raw file
//
// Write commands commit and push to `tracker-data` (retrying on a race with the web page).
// Options: --file <path> works on a local file instead of the branch (no git), --no-push, --by <name>.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANCH = 'tracker-data';
const FILE = 'tracker.json';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = join(REPO_ROOT, '.tracker-data');

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (k === 'all' || k === 'no-push') flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const cmd = pos.shift() || 'summary';
const BY = flags.by || 'Claude';

// ---------- git helpers ----------
const git = (args, cwd = REPO_ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fetchBranch() {
  try {
    git(['fetch', '-q', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  } catch (e) {
    console.error(`warning: could not fetch ${BRANCH} (${String(e.stderr || e.message).trim()}); using last fetched copy`);
  }
}

function readDoc() {
  if (flags.file) return JSON.parse(readFileSync(flags.file, 'utf8'));
  fetchBranch();
  return JSON.parse(git(['show', `origin/${BRANCH}:${FILE}`]));
}

function serialize(doc) {
  return JSON.stringify(doc, null, 2) + '\n';
}

function writeDoc(mutate, message) {
  if (flags.file) {
    const doc = JSON.parse(readFileSync(flags.file, 'utf8'));
    const result = mutate(doc);
    doc.updated = now();
    writeFileSync(flags.file, serialize(doc));
    return result;
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    fetchBranch();
    if (!existsSync(WORKTREE)) git(['worktree', 'add', '-q', '--detach', WORKTREE, `origin/${BRANCH}`]);
    else git(['checkout', '-q', '--detach', '-f', `origin/${BRANCH}`], WORKTREE);
    const path = join(WORKTREE, FILE);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const result = mutate(doc);
    doc.updated = now();
    writeFileSync(path, serialize(doc));
    git(['add', FILE], WORKTREE);
    git(['commit', '-q', '-m', `Tracker: ${message}`], WORKTREE);
    if (flags['no-push']) {
      console.error(`committed in ${WORKTREE} (not pushed)`);
      return result;
    }
    try {
      git(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], WORKTREE);
      return result;
    } catch (e) {
      if (attempt === 4) throw e;
      console.error(`push rejected (attempt ${attempt}), refetching and retrying…`);
    }
  }
}

// ---------- model helpers ----------
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const catOf = (doc, key) => {
  const c = doc.categories.find((c) => c.key === key || c.prefix === key || c.label.toLowerCase() === String(key).toLowerCase());
  if (!c) die(`unknown category "${key}". Known: ${doc.categories.map((c) => c.key).join(', ')}`);
  return c;
};
const statusOf = (cat, key) => {
  const s = cat.statuses.find((s) => s.key === key || s.label.toLowerCase() === String(key).toLowerCase());
  if (!s) die(`unknown status "${key}" for ${cat.key}. Known: ${cat.statuses.map((s) => s.key).join(', ')}`);
  return s.key;
};
const isOpen = (cat, item) => !cat.statuses.find((s) => s.key === item.status)?.closed;
const findItem = (doc, id) => {
  const it = doc.items.find((i) => i.id.toLowerCase() === String(id).toLowerCase());
  if (!it) die(`no item ${id}`);
  return it;
};
const nextId = (doc, cat) => {
  const n = doc.items
    .filter((i) => i.id.startsWith(cat.prefix + '-'))
    .reduce((m, i) => Math.max(m, parseInt(i.id.split('-')[1], 10) || 0), 0);
  return `${cat.prefix}-${n + 1}`;
};
const PRI = { high: 0, medium: 1, low: 2 };
function die(msg) {
  console.error(msg);
  process.exit(1);
}

function line(doc, it) {
  const bits = [`${it.id.padEnd(5)} [${it.status}]`];
  if (it.priority) bits.push(`(${it.priority})`);
  bits.push(it.title);
  if (it.milestone) bits.push(`→ ${it.milestone}`);
  return bits.join(' ');
}

function applyFields(doc, cat, it) {
  if (flags.status) it.status = statusOf(cat, flags.status);
  if (flags.title) it.title = flags.title;
  if (flags.priority) {
    if (!(flags.priority in PRI) && flags.priority !== 'none') die('priority must be high, medium, low or none');
    if (flags.priority === 'none') delete it.priority;
    else it.priority = flags.priority;
  }
  if (flags.milestone) {
    if (flags.milestone === 'none') delete it.milestone;
    else it.milestone = findItem(doc, flags.milestone).id;
  }
  if (flags.tags !== undefined) it.tags = flags.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (flags.notes !== undefined) it.notes = flags.notes;
  if (flags['append-note']) it.notes = (it.notes ? it.notes.trimEnd() + '\n\n' : '') + `${now().slice(0, 10)} (${BY}): ${flags['append-note']}`;
  if (flags.link) it.links = [...new Set([...(it.links || []), flags.link])];
  it.updated = now();
  it.by = BY;
}

// ---------- commands ----------
switch (cmd) {
  case 'summary': {
    const doc = readDoc();
    console.log(`Plunder tracker — updated ${doc.updated}`);
    for (const cat of doc.categories) {
      const items = doc.items.filter((i) => i.cat === cat.key);
      const open = items.filter((i) => isOpen(cat, i));
      console.log(`\n## ${cat.label}: ${open.length} open / ${items.length} total`);
      for (const s of cat.statuses.filter((s) => !s.closed)) {
        const group = open
          .filter((i) => i.status === s.key)
          .sort((a, b) => (PRI[a.priority] ?? 3) - (PRI[b.priority] ?? 3));
        if (group.length) console.log(`  ${s.label}:`);
        for (const it of group) console.log('    ' + line(doc, it));
      }
    }
    console.log('\n(closed items hidden — `list --all` shows everything, `show <ID>` shows notes)');
    break;
  }
  case 'list': {
    const doc = readDoc();
    let items = doc.items;
    if (flags.cat) items = items.filter((i) => i.cat === catOf(doc, flags.cat).key);
    if (flags.status) items = items.filter((i) => i.status === flags.status);
    else if (!flags.all) items = items.filter((i) => isOpen(catOf(doc, i.cat), i));
    for (const it of items) console.log(line(doc, it));
    break;
  }
  case 'show': {
    const doc = readDoc();
    for (const id of pos) console.log(JSON.stringify(findItem(doc, id), null, 2));
    break;
  }
  case 'json': {
    process.stdout.write(serialize(readDoc()));
    break;
  }
  case 'add': {
    const [catKey, title] = pos;
    if (!catKey || !title) die('usage: add <category> "title" [--status …]');
    const id = writeDoc((doc) => {
      const cat = catOf(doc, catKey);
      const it = { id: nextId(doc, cat), cat: cat.key, title, status: cat.statuses[0].key, tags: [], notes: '', links: [], created: now() };
      applyFields(doc, cat, it);
      doc.items.push(it);
      return it.id;
    }, `add ${catKey} "${title}"`);
    console.log(`added ${id}`);
    break;
  }
  case 'set': {
    const [id] = pos;
    if (!id) die('usage: set <ID> [--status …]');
    const desc = Object.entries(flags)
      .filter(([k]) => !['file', 'no-push', 'by'].includes(k))
      .map(([k, v]) => (k === 'status' ? `→ ${v}` : k))
      .join(', ');
    writeDoc((doc) => {
      const it = findItem(doc, id);
      applyFields(doc, catOf(doc, it.cat), it);
    }, `${id.toUpperCase()} ${desc}`);
    console.log(`updated ${id.toUpperCase()}`);
    break;
  }
  default:
    die(`unknown command "${cmd}". Commands: summary, list, show, add, set, json`);
}
