# Plunder: notes for Claude

## Dev tracker

Devin keeps features, bugs, the roadmap, playtest notes and assets in one tracker so work isn't
scattered across threads. Check it before gameplay work to see what's planned and what's done.

- **Data:** `tracker.json` on the **`tracker-data`** branch (not on `main`, so edits never trigger a
  desktop release or conflict with feature branches).
- **Devin's UI:** `tracker/index.html` (open the file in Edge/Chrome). It commits to `tracker-data`
  through the GitHub API.
- **Command line:** `tracker/cli.mjs` (plain Node, no install):

```bash
node tracker/cli.mjs                       # summary of everything open, by category and status
node tracker/cli.mjs list --cat bug        # open bugs   (--all for closed too, --status fixed …)
node tracker/cli.mjs show F-13 B-2         # full item JSON incl. notes and links
node tracker/cli.mjs add bug "Raft clips through islands" --priority high --milestone M-6 --notes "…"
node tracker/cli.mjs set F-13 --status in-progress --link https://github.com/Littlebutta/Plunder/pull/3
node tracker/cli.mjs set B-2 --status fixed --append-note "Fixed in PR #4"
```

Reading is always safe. Write commands commit and push to `tracker-data` from a git worktree at
`.tracker-data/` (gitignored) and retry if the web page saved at the same moment; `--no-push` commits
locally only. Whether a session may push there follows the user's instructions for that session.

### Categories and statuses

| Category | Prefix | Statuses (closed ones in italics) |
| --- | --- | --- |
| Features | F | idea, in-progress, *good-enough*, *complete*, *dropped* |
| Bugs & fixes | B | unresolved, *fixed* |
| Roadmap | M | planned, active, *done* (features/bugs point at a step via `milestone`) |
| Playtest notes | P | new, *actioned*, *archived* |
| Assets | A | needed, have, *in-game* |

Item fields: `id, cat, title, status, priority (high|medium|low), milestone (M-n), tags[], notes, links[], created, updated, by`.
Deleted ids are tombstoned in `deleted` and never reused. Only Devin marks things dropped or deletes them.
