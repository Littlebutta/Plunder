# Plunder — 3D sailing prototype

Stylized toon ocean with rolling Gerstner waves, a buoyant log raft that sails by the wind, a bow-mounted swivel gun, and multithreaded projectiles. Built with Three.js + TypeScript + Vite.

## Run it

Requires Node 20+.

```bash
npm install
npm run dev        # opens http://localhost:5173
```

`npm run build` type-checks and produces a static build in `dist/` (`npm run preview` serves it).

## Controls

| Key | Action |
| --- | --- |
| W / S (or ↑ / ↓) | Raise / lower the sail. Hold S at 0% to back-paddle. |
| A / D (or ← / →) | Steer (stronger at speed, reverses when going backwards) |
| Q / E | Trim the sail by hand (turns auto-trim off) |
| T | Toggle auto-trim |
| Mouse | Aim the swivel gun at the sea (dotted arc + impact ring) |
| Click / Space | Fire the swivel gun |
| Mouse drag | Orbit the camera (it eases back behind the raft after ~2.5 s) |
| Mouse wheel | Zoom |
| B | Barrage stress test: hundreds of shells land around you |
| M | Mute |
| G | Tuning panel: sea, waves, wind, combat, ocean colours, raft physics |
| P | Show buoyancy probes (red = underwater) |
| H | Hide the help panel |

Shoot the floating flagged barrels for points; they respawn after a while.

## Sailing

The wind (white arrow on the compass, pennant at the masthead, curly wind streaks) drifts slowly. A square sail only pushes along its own face and only when the wind hits the back of it, so the raft is fast downwind, workable on a reach, and cannot sail into the wind. The **drive %** on the HUD shows how well the sail is working. Auto-trim keeps the yard at its best angle; trim by hand with Q/E.

## Sound

Recorded sounds live in `public/sounds/` (`cannon-fire.mp3`, `sail-full.mp3`). Splashes, wood hits, the ocean bed and the wind bed are synthesized in `src/audio/AudioManager.ts` until recordings exist for them. To add a recording, drop the file in `public/sounds/` and add it to `SAMPLES` in that file.

In the browser console, `plunder` exposes the scene, waves, raft and camera for tinkering.

## Layout

```
src/
  main.ts                    bootstrap + game loop
  ocean/waves.ts             Gerstner WaveField: shared GPU uniforms + CPU sampler
  ocean/oceanMaterial.ts     toon ocean shader (bands, foam, glints, fresnel, fog)
  ocean/Ocean.ts             camera-following variable-density ocean grid
  physics/FloatingBody.ts    buoyancy probes, body-space drag, rigid-body integration
  physics/Simulation.ts      fixed 120 Hz step (waves + bodies in lockstep)
  raft/Raft.ts               raft model, HullSpec, square-sail + trim model
  combat/ProjectileSim.ts    projectile integrator, water + collider hits (pure, no DOM)
  combat/projectile.worker.ts  runs ProjectileSim on a worker thread
  combat/ProjectileSystem.ts main-thread side: batching, instanced rendering, impact events
  combat/SwivelGun.ts        bow swivel gun: model, ballistic aiming, aim preview
  fx/Effects.ts              instanced splashes, smoke, splinters, muzzle flashes
  fx/Wake.ts                 foam wake ribbon that rides the waves
  fx/WindStreaks.ts          curly wind lines
  audio/AudioManager.ts      Web Audio: samples, 3D panning, synth splashes + ambience
  world/Wind.ts              wandering wind with gusts
  world/Targets.ts           floating target barrels
  camera/FollowCamera.ts     smoothed orbit/follow camera that stays above the swell
  sky/Sky.ts                 gradient sky dome, sun, toon clouds
  world/Islands.ts           placeholder islands with detailed palms
  render/                    palette, toon materials, ink outlines
  input/Input.ts             keyboard/mouse state
  ui/                        HUD + lil-gui tuning panel
docs/PIPELINE.md          technical plan: drawing → hull, waves, physics
```
