# Plunder — 3D sailing prototype (Step 1)

Stylized toon ocean with rolling Gerstner waves, a buoyant log raft that rides the swell, and a smooth follow/orbit camera. Built with Three.js + TypeScript + Vite.

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
docs/PIPELINE.md          technical plan: drawing → hull, waves, physics
```
