# Plunder — 3D sailing prototype (Step 1)

Stylized toon ocean with rolling Gerstner waves, a buoyant log raft that rides the swell, and a smooth follow/orbit camera. Built with Three.js + TypeScript + Vite.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev        # opens http://localhost:5173
```

`npm run build` type-checks and produces a static build in `dist/` (`npm run preview` serves it).

## Desktop app (Windows)

Plunder ships as a Windows desktop app built with Electron. It **updates itself on launch**: every push to `main` makes GitHub Actions build a new installer and publish it as a [GitHub Release](https://github.com/Littlebutta/Plunder/releases); when the installed game starts it shows a small "Checking for updates" window, downloads anything newer, installs it silently and relaunches. Offline (or if the check takes over 10 s) it just starts the installed version, and "Play now" skips the wait.

**First install:** download `Plunder-Setup-<version>.exe` from the latest release and run it. It installs per user (no admin prompt) and adds desktop and Start menu shortcuts. The build is not code-signed yet, so Windows SmartScreen will warn the first time: click *More info → Run anyway*.

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the game and open it in the desktop shell |
| `npm run desktop:dev` | Desktop shell on the Vite dev server (hot reload) |
| `npm run dist:win` | Build the Windows installer locally into `release/` (no publish) |

In the desktop app, F11 toggles fullscreen and F12 opens dev tools. Launch with `--no-update` to skip the update check.

The game is served over an `app://` protocol with cross-origin isolation headers (the Vite dev server sends the same ones), so `crossOriginIsolated` is true and Web Workers + `SharedArrayBuffer` are available for multithreaded simulation. Static assets such as sounds belong in `public/` (served from `/`) or are imported from `src/`; both end up in `dist/` and inside the app.

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
.github/workflows/        Windows build + GitHub Release on every push to main
docs/PIPELINE.md          technical plan: drawing → hull, waves, physics
```
