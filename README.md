# Plunder — 3D sailing prototype

Stylized toon ocean with rolling Gerstner waves, a buoyant log raft that sails by the wind, a bow-mounted swivel gun, and multithreaded projectiles. Built with Three.js + TypeScript + Vite.

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
| Mouse | Aim at the sea |
| Right mouse button | Fire the swivel gun (dotted arc + impact ring). Hold to keep firing. |
| Space | Fire the main guns: the broadside when it is run out, otherwise the swivel. |
| E / click island | Gather from the island in range (a marker floats over it). E again to stop. |
| Esc | Main menu / resume |
| C | Fit / remove the broadside battery (the raft gets a test battery; a designed ship uses its own cannons) |
| F | Also fires the broadside on the side you're aiming at (outlined ribbon) |
| Left mouse drag | Orbit the camera (it stays where you leave it) |
| Mouse wheel | Zoom |
| B | Barrage stress test: hundreds of shells land around you |
| M | Mute (also in Settings: the gear button top right, or the main menu) |
| G | Tuning panel: sea, waves, wind, combat, ocean colours, raft physics |
| P | Show buoyancy probes (red = underwater) |
| H | Hide the help panel |

Shoot the floating flagged barrels for points; they respawn after a while.

## Sailing

Arcade rules: the sail always drives the raft, in any direction. The wind (white arrow on the compass, pennant, wind streaks) is a **boost**: with it behind you the raft is about 60% faster, on the beam you get a little, and into it you only lose a touch of speed. The HUD shows the current wind boost.

## Guns

- **Swivel gun:** free aim with the mouse, dotted trajectory. The ring lands on the water under the cursor. Max range 90 m.
- **Broadside:** the cannons barely traverse (about 12° either way). You aim by turning the ship; the distance to your aim point sets the elevation. A white 3D ribbon follows the shells' arc through the air to the impact zone. Max range 120 m. The cursor only gives a general direction: the aim is held as a compass bearing and a range, small cursor movements are ignored, larger ones are eased in, and the guns traverse against the hull's yaw, so the swell does not swing the ribbon.
- Past max range the ring or ribbon turns red and stops at the limit. Ranges are set in `SWIVEL.maxRange` / `BROADSIDE.maxRange` so upgrades can extend them later.
- Shots do not inherit the ship's own motion, and shells that hit an island stop there.

## Islands

Generated from a seed: peaks (some with craters), ridges, terraced mesas, rolling hills, flat sandy cays, sea stacks and shipwreck islands, dressed with palms, ferns and boulders. Each island sits on a sandy shelf: the water turns turquoise, the waves calm down and foam laps at the beach. This all comes from one terrain height map (`src/ocean/shore.ts`) shared by the wave model, the ocean shader and the projectile simulation.

## Gathering and ports

Each island holds resources that depend on its type and size (wood, stone, salvage) and regrow slowly. Sail within range of an island's shore and a marker appears over it: press E or click the island to select it, and the crew hauls resources into the hold (40 units) while you stay in range. Islands with a **port** (a pier and hut; the green-hill and mesa islands have one for now) must be worked from the pier head instead, and load twice as fast. Rules and numbers are in `src/world/Gathering.ts` and `src/world/Resources.ts`.

## Shipyard

Open it from the main menu. On the **top view** drag to draw the hull's outline (one side, it is mirrored); on the **side view** drag to draw the keel line under the water. Switch tools to place masts (up to three) and pairs of cannons on snap points, set length, beam, keel depth and freeboard with the sliders, or start from a preset (Dinghy, Sloop, Brig, Barge). The design is lofted into 3D live on the right, with its weight, draft, speed, handling, hold and cost. **Launch** swaps your vessel for the design where you are; the cannons you placed become the broadside. The last design is remembered.

A design is plain data (`src/ship/HullDesign.ts`): two curves, four sizes, mast and cannon slots. The model (`ShipVisual.ts`), the buoyancy probes and drag (`designToHullSpec`), and the sail and rudder forces (`designToDrive`) are all derived from it. Building is free for now; costs are shown for balancing.

## Weather and day-night

`src/weather/`. A day lasts about 10 minutes (nights run faster and are moonlit, with stars). Weather
events roll in after a calm spell of a couple of minutes (meant to move to "between rounds" once the
round loop exists), each at level I, II or III:

- **Fog**: sea mist to blinding fog; the horizon and islands vanish.
- **Storm**: squall, storm, tempest. Rain, lightning and thunder, rougher seas and stronger wind.
- **Eyes in the deep**: one to three sea creatures, glowing eyes under the surface, follow your ship.
  Get close and one rears a tentacle and smashes it down where you were heading; steer away during the
  wind-up to dodge. Shoot the eyes or tentacle to make it dive, enough hits drive it off.
- **Armageddon**: the sky and sea turn blood red and a cursed fleet rises out of the sea, circles you
  and fires volleys. Sink them all to end it early.

Hull damage shows in a bar above the stats; it repairs slowly once you're out of trouble. Tuning panel
(G) → *Weather & time*: time of day, day length, start/stop any event at any level.

## Main menu

The game opens on a title menu: options on the left, the raft sailing by itself on the right. Drag to look around. Esc in play returns to it.

## Sound

Recorded sounds live in `public/sounds/` (`cannon-fire.mp3`, `sail-full.mp3`). Splashes, wood hits, the ocean bed and the wind bed are synthesized in `src/audio/AudioManager.ts` until recordings exist for them. To add a recording, drop the file in `public/sounds/` and add it to `SAMPLES` in that file.

Volumes (master, sound effects, sea and wind, music) and mute are set in the Settings window (`src/ui/Settings.ts`) and remembered between sessions. Each has its own bus in `AudioManager`; the music bus is ready but nothing plays on it yet.

The sea never shows inside a hull: each vessel carries an invisible lid (`src/render/waterMask.ts`) drawn after the boat and before the ocean.

In the browser console, `plunder` exposes the scene, waves, raft and camera for tinkering.

## Layout

```
src/
  main.ts                    bootstrap + game loop
  ocean/waves.ts             Gerstner WaveField: shared GPU uniforms + CPU sampler
  ocean/shore.ts             terrain height map: calm shallows, shoreline, shells hitting land
  ocean/oceanMaterial.ts     toon ocean shader (bands, foam, shoreline, fresnel, fog)
  ocean/Ocean.ts             camera-following variable-density ocean grid
  physics/FloatingBody.ts    buoyancy probes, body-space drag, rigid-body integration
  physics/Simulation.ts      fixed 120 Hz step (waves + bodies in lockstep)
  raft/Raft.ts               starter raft model + its HullSpec
  ship/Vessel.ts             base for anything you sail: arcade sail drive + wind boost
  ship/HullDesign.ts         shipyard design data, presets, stats, design -> physics
  ship/ShipVisual.ts         lofts a design into a ship model with mount points
  ship/DesignedShip.ts       a Vessel built from a design
  combat/ProjectileSim.ts    projectile integrator, water + collider hits (pure, no DOM)
  combat/projectile.worker.ts  runs ProjectileSim on a worker thread
  combat/ProjectileSystem.ts main-thread side: batching, instanced rendering, impact events
  combat/SwivelGun.ts        bow swivel gun: model, ballistic aiming, aim preview
  combat/Broadside.ts        broadside battery: side/elevation aiming, ripple fire, water ribbon
  fx/Effects.ts              instanced splashes, smoke, splinters, muzzle flashes
  fx/Wake.ts                 foam wake ribbon that rides the waves
  fx/WindStreaks.ts          curly wind lines
  audio/AudioManager.ts      Web Audio: samples, 3D panning, synth splashes + ambience
  world/Wind.ts              wandering wind with gusts
  world/Targets.ts           floating target barrels
  world/Resources.ts         resource types, island yields, the ship's hold
  world/Gathering.ts         in-range / port rule, hauling, regrowth
  camera/FollowCamera.ts     smoothed orbit/follow camera that stays above the swell
  sky/Sky.ts                 gradient sky dome, sun, toon clouds
  world/Islands.ts           procedural islands (7 types), palms, boulders, sea stacks
  world/Wreck.ts             beached shipwreck model
  util/noise.ts              seeded value noise for terrain
  render/                    palette, toon materials, ink outlines
  input/Input.ts             keyboard/mouse state
  ui/                        HUD, main menu, gathering panel, lil-gui tuning panel
electron/                 desktop shell: main process, launch-time updater, splash
scripts/                  shell fingerprint + zip helpers used by the release workflow
.github/workflows/        portable Windows build + GitHub Release on every push to main
docs/PIPELINE.md          technical plan: drawing → hull, waves, physics
tracker/                  dev tracker: open tracker/index.html (data on the tracker-data branch, see CLAUDE.md)
```
