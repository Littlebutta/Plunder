# Plunder — 3D sailing prototype (Step 1)

Stylized toon ocean with rolling Gerstner waves, a buoyant log raft that rides the swell, and a smooth follow/orbit camera. Built with Three.js + TypeScript + Vite.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev        # opens http://localhost:5173
```

`npm run build` type-checks and produces a static build in `dist/` (`npm run preview` serves it).

## Desktop app (Windows, portable)

Plunder ships as a **portable folder**: no installer, nothing written outside the folder. Unzip it anywhere (Desktop, a USB stick) and run `Plunder.exe`. Settings and saves live in `data/` inside the folder, so copying the folder copies everything.

**First time:** download `Plunder-win-x64.zip` from the [latest release](https://github.com/Littlebutta/Plunder/releases/latest), unzip, run `Plunder.exe`. The exe isn't code-signed yet, so Windows SmartScreen may warn: click *More info → Run anyway*.

**Updates happen on launch.** Every push to `main` makes GitHub Actions publish a release. When Plunder starts it shows a small "Checking for updates" window and reads that release's `latest.json`:

- **Game-only change** (the usual case): downloads `game-<version>.zip` (a couple of MB) into `game/` inside the folder and starts it.
- **Desktop shell changed** (Electron or anything in `electron/`, detected by a fingerprint from `scripts/shell-id.mjs`): downloads the full folder zip, quits, swaps the files in place (keeping `data/`) and relaunches.
- Offline, slow (>10 s to check) or any error: plays what's already in the folder. "Play now" skips the wait, and `--no-update` skips the check entirely. A read-only folder never updates.

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the game and open it in the desktop shell |
| `npm run desktop:dev` | Desktop shell on the Vite dev server (hot reload) |
| `npm run package:win` | Build the portable folder locally into `release/win-unpacked/` |

In the desktop app, F11 toggles fullscreen and F12 opens dev tools.

The game is served over an `app://` protocol with cross-origin isolation headers (the Vite dev server sends the same ones), so `crossOriginIsolated` is true and Web Workers + `SharedArrayBuffer` are available for multithreaded simulation. Static assets such as sounds belong in `public/` (served from `/`) or are imported from `src/`; both end up in `dist/`, which is what game updates ship.

## Controls

| Key | Action |
| --- | --- |
| W / S (or ↑ / ↓) | Raise / lower the sail. Hold S at 0% to back-paddle. |
| A / D (or ← / →) | Steer (stronger at speed, reverses when going backwards) |
| Mouse drag | Orbit the camera (it eases back behind the raft after ~2.5 s) |
| Mouse wheel | Zoom |
| G | Tuning panel: sea roughness, each wave, ocean colours, raft physics |
| P | Show buoyancy probes (red = underwater) |
| H | Hide the help panel |

In the browser console, `plunder` exposes the scene, waves, raft and camera for tinkering.

## Layout

```
src/
  main.ts                 bootstrap + game loop
  ocean/waves.ts          Gerstner WaveField: shared GPU uniforms + CPU sampler
  ocean/oceanMaterial.ts  toon ocean shader (bands, foam, glints, fresnel, fog)
  ocean/Ocean.ts          camera-following variable-density ocean grid
  physics/FloatingBody.ts buoyancy probes, body-space drag, rigid-body integration
  physics/Simulation.ts   fixed 120 Hz step (waves + bodies in lockstep)
  raft/Raft.ts            raft model, HullSpec, sail/rudder control
  camera/FollowCamera.ts  smoothed orbit/follow camera that stays above the swell
  sky/Sky.ts              gradient sky dome, sun, toon clouds
  world/Islands.ts        placeholder islands (procedural ones come later)
  render/                 palette, toon materials, ink outlines
  input/Input.ts          keyboard/mouse state
  ui/                     HUD + lil-gui tuning panel
electron/                 desktop shell: main process, launch-time updater, splash
scripts/                  shell fingerprint + zip helpers used by the release workflow
.github/workflows/        portable Windows build + GitHub Release on every push to main
docs/PIPELINE.md          technical plan: drawing → hull, waves, physics
```
