# Plunder — technical pipeline

How the three core systems fit together, and how Step 1 lays the groundwork for each.

```
 Shipyard (2D)                    3D world                         Sim
 ┌──────────────┐  hull spec   ┌──────────────┐   HullSpec    ┌────────────────┐
 │ top + side   │ ───────────▶ │ lofted hull  │ ────────────▶ │ FloatingBody   │
 │ profile draw │  (stations)  │ mesh + snaps │ probes, drag, │ (buoyancy/drag)│
 └──────────────┘              └──────────────┘ mass, inertia └───────┬────────┘
                                                                      │ samples
                         WaveField (Gerstner params)  ◀───────────────┘
                          │ uniforms         │ CPU sample()
                          ▼                  ▼
                     ocean vertex shader   buoyancy, camera, (later) cannon arcs
```

## 1. Drawing → 3D hull

Your two sketches map neatly onto a classic naval-architecture *loft*:

1. **Capture.** The shipyard canvas records strokes as polylines (not pixels). Two views:
   - **Top-down** outline → half-breadth curve `b(z)`: the beam at each point along the length.
   - **Side** profile → sheer (deck) line `s(z)` and keel line `k(z)`; the drawn bow rake/stern transom come from here.
   If the player only draws one view we infer the other (default sheer + keel from length).
2. **Clean up.** Mirror the top view around the centre line (hulls are symmetric), resample both curves to *N* evenly spaced **stations** along the length (≈24–40), smooth with Chaikin or Catmull-Rom so shaky strokes become fair curves, clamp self-intersections.
3. **Sections.** At each station build a cross-section from `b(z)`, `s(z)`, `k(z)`: a parametric "U-to-V" curve (superellipse with a per-hull fullness exponent, which can become an upgrade/slider). Each section is a ring of *M* points.
4. **Skin.** Stitch rings into a triangle strip (port + starboard + deck cap + transom cap). Compute smooth normals, UVs along length/girth for plank textures, and run the same toon + ink-outline material as the raft.
5. **Snap points.** Walk the deck surface: mast sockets along the centre line where the beam is above a minimum; cannon ports along the gunwale every *x* m, each storing position, outward normal and allowed arc. Components snap to the nearest free socket; total weight/arc/reload come from the component data.
6. **Derive the HullSpec** (the same struct the raft uses in `src/physics/FloatingBody.ts`):
   - Displaced volume from integrating section areas below the waterline → mass budget / draft.
   - Buoyancy probes placed on the hull bottom at a few stations × port/centre/starboard.
   - **Drag:** forward drag from frontal area and a *fineness ratio* (length ÷ beam). Wide = more displaced water = higher `dragForward`, lower top speed; sleek = faster but less deck area for snaps. Lateral drag from keel depth × length.
   - Inertia from the bounding box (good enough), roll stability from beam vs. centre-of-mass height (masts/cannons raise it).

Everything after step 1 is pure geometry, so it can run in a Web Worker and preview live while the player draws.

## 2. Ocean (vertex shader + CPU twin)

- **Gerstner waves** (`src/ocean/waves.ts`): a sum of up to 12 directional waves in three systems (long swell, cross swell, wind chop). Each wave's height is modulated by a slow "wave group" envelope travelling at half its speed, so sets of bigger waves roll through and the sea differs from place to place. Foam only breaks on the tallest crests inside a set. Gerstner moves water sideways as well as up, which gives the sharp crests and wide troughs of cartoon seas.
- **One set of parameters, two evaluators.** The shader reads them as uniforms, and `WaveField.sample()` runs identical math in TS. Because Gerstner displaces horizontally, the CPU inverts it with 4 fixed-point iterations to find the true height at a world (x, z).
- **Toon fragment shader** (`src/ocean/oceanMaterial.ts`): hard colour bands by wave height, two-step lighting, crest caps, noise-driven foam "brush strokes", noisy golden sun glints, fresnel to the horizon colour, and fog.
- **Mesh:** one 512² grid whose spacing grows cubically outward (≈0.5 m under the ship, kilometres at the horizon), re-centred on the camera focus and snapped to its vertex spacing so it never swims. Waves fade out with distance to avoid aliasing.
- **Later uses of the CPU sampler:** line of sight (raycast against the swell), cannonball splash/impact, firing-arc ribbon draped on the water (sample heights along the arc and build a strip a few cm above the surface), wake/foam trails.

## 3. Physics

- **Fixed step** (`src/physics/Simulation.ts`): 120 Hz. Waves and bodies advance in lockstep so buoyancy always sees the water at the right moment, independent of frame rate.
- **Buoyancy** (`FloatingBody`): each probe samples water height; submerged depth → upward spring force applied *at the probe*, so pitch and roll emerge naturally. Stiffness is derived from mass and the desired rest draft. Heave damping acts on velocity *relative to the water*, so the hull rides the swell instead of being buried by crests.
- **Drag in body space:** low along the keel, high sideways (gives that boat-like carve), each with linear + quadratic terms. These are exactly the knobs the hull generator will set.
- **Propulsion (arcade):** the sail always gives a base thrust along the keel, so ships can go anywhere. The wind adds a boost that scales with how far it is behind the ship (full downwind, a little on the beam, none upwind, plus a small headwind penalty). The yard swings to the wind for looks only. The rudder is a yaw torque that scales with speed.

## 4. Multithreading

Combat is where the frame budget goes (barrages, splashes, hit tests), so it is built to run off the main thread from the start.

- **Projectiles run in a Web Worker** (`src/combat/projectile.worker.ts`). The worker owns every shell in one packed `Float32Array`: semi-implicit Euler with gravity and quadratic air drag, swept segment-vs-sphere hit tests against ship colliders, and water impact against its own copy of the `WaveField`, kept in sync by sending the sea state when it changes and the wave clock every frame.
- **One message per frame, pipelined.** The main thread sends spawns + colliders and receives the previous step's snapshot and impact events as transferable buffers (no copying). The worker and the renderer overlap instead of waiting on each other. Positions are extrapolated by velocity to the current frame to hide the one-frame delay.
- **Everything visual is instanced:** shells, splash columns, foam rings, droplets, smoke and splinters each draw in a single call, whatever the count.
- **Numbers:** 2,000 shells in flight step in about 1.6 ms per frame on the worker (measured headless in Node). The barrage test (B) fires 400 by default and can go up to 4,000 from the tuning panel.
- **Fallback:** if a worker can't start, the same `ProjectileSim` runs on the main thread with identical results.
- **Next:** the desktop build is cross-origin isolated, so `SharedArrayBuffer` is available there. Later we can move to a shared ring buffer with no messages at all, and split buoyancy for many AI ships across a small worker pool.

## Roadmap

Done so far: ocean + raft (Step 1); swivel gun, worker projectiles, wind, wake, sounds, palms (Step 2); arcade sailing, wave groups, broadside ribbon, island types and wrecks (Step 3).

**Next, in order**

1. **Shipyard:** 2D draw canvas → lofted hull preview → HullSpec → test sail.
2. **Snap points + components:** masts and cannon types (weight, arc, reload) placed on the drawn hull; weight affects draft and stability. The broadside battery and ribbon from Step 3 plug into these mounts.
3. **Island collision + resources:** hulls ground on the coastline (`Island.coastAt`), shells hit terrain, resource pickups per island type, wrecks as salvage sites.
4. **Round loop + title menu:** title screen, expedition round, shipyard phase, next round.

**Planned features (from Devin, 2026-11-09)**

- **Bigger, scaling maps + overworld map.** Larger default world; size scales with player count. Fog-of-war overworld map that fills in as players explore. *Design note: `createIslands(seed, count, worldRadius)` already takes these as parameters.*
- **Persistent map.** The world stays the same between rounds and regenerates only on a new game. *The world is fully determined by its seed, so persistence is "keep the seed + a list of changes" (ports built, forts captured, wrecks salvaged).*
- **Ports.** Build a port on an island for a steady stream of resources that depends on island type and size.
- **Capture, destroy, fortify.** Islands can hold NPC bases or enemy player bases; players can capture or destroy them and fortify their own.
- **NPC fortress bonuses.** A captured fortress gives its holder a small bonus, which transfers to whoever captures it next.
- **Ship and cannon modifiers** applied between rounds.
- **Defence fleets.** Spawnable ships (perk, upgrade or port building, to be decided) that can be ordered to defend or patrol areas from the minimap.
- **Multiplayer.** *Design note: gameplay state is already kept apart from rendering (FloatingBody, ProjectileSim, WaveField are plain data + pure stepping, and waves are a function of a shared clock), which is what a server-authoritative or lockstep model needs. Decide the netcode model before building ports/capture so ownership is networked from the start.*
- **Title menu.**
