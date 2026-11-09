# Plunder tracker data

This branch holds only `tracker.json`, the data behind the dev tracker.

- Devin edits it with `tracker/index.html` (on `main`), which commits here through the GitHub API.
- Claude reads and updates it with `node tracker/cli.mjs` (see `CLAUDE.md` on `main`).

It lives on its own branch so tracker edits never trigger a desktop release or conflict with feature branches.
