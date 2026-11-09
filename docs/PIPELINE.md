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

- **Gerstner waves** (`src/ocean/waves.ts`): a sum of up to 6 directional waves. Gerstner moves water sideways as well as up, which gives the sharp crests and wide troughs of cartoon seas.
- **One set of parameters, two evaluators.** The shader reads them as uniforms, and `WaveField.sample()` runs identical math in TS. Because Gerstner displaces horizontally, the CPU inverts it with 4 fixed-point iterations to find the true height at a world (x, z).
- **Toon fragment shader** (`src/ocean/oceanMaterial.ts`): hard colour bands by wave height, two-step lighting, crest caps, noise-driven foam "brush strokes", noisy golden sun glints, fresnel to the horizon colour, and fog.
- **Mesh:** one 512² grid whose spacing grows cubically outward (≈0.5 m under the ship, kilometres at the horizon), re-centred on the camera focus and snapped to its vertex spacing so it never swims. Waves fade out with distance to avoid aliasing.
- **Later uses of the CPU sampler:** line of sight (raycast against the swell), cannonball splash/impact, firing-arc ribbon draped on the water (sample heights along the arc and build a strip a few cm above the surface), wake/foam trails.

## 3. Physics

- **Fixed step** (`src/physics/Simulation.ts`): 120 Hz. Waves and bodies advance in lockstep so buoyancy always sees the water at the right moment, independent of frame rate.
- **Buoyancy** (`FloatingBody`): each probe samples water height; submerged depth → upward spring force applied *at the probe*, so pitch and roll emerge naturally. Stiffness is derived from mass and the desired rest draft. Heave damping acts on velocity *relative to the water*, so the hull rides the swell instead of being buried by crests.
- **Drag in body space:** low along the keel, high sideways (gives that boat-like carve), each with linear + quadratic terms. These are exactly the knobs the hull generator will set.
- **Propulsion:** a square-sail model. The apparent wind (true wind minus the hull's velocity) pushes along the sail's normal, and only when it hits the back face. Force ∝ apparent speed² × cos²(angle). The forward part drives the hull, and part of the sideways part becomes leeway that the high lateral drag resists. Auto-trim searches yard angles for the most forward drive. The rudder is a yaw torque that scales with speed.

## 4. Multithreading

Combat is where the frame budget goes (barrages, splashes, hit tests), so it is built to run off the main thread from the start.

- **Projectiles run in a Web Worker** (`src/combat/projectile.worker.ts`). The worker owns every shell in one packed `Float32Array`: semi-implicit Euler with gravity and quadratic air drag, swept segment-vs-sphere hit tests against ship colliders, and water impact against its own copy of the `WaveField`, kept in sync by sending the sea state when it changes and the wave clock every frame.
- **One message per frame, pipelined.** The main thread sends spawns + colliders and receives the previous step's snapshot and impact events as transferable buffers (no copying). The worker and the renderer overlap instead of waiting on each other. Positions are extrapolated by velocity to the current frame to hide the one-frame delay.
- **Everything visual is instanced:** shells, splash columns, foam rings, droplets, smoke and splinters each draw in a single call, whatever the count.
- **Numbers:** 2,000 shells in flight step in about 1.6 ms per frame on the worker (measured headless in Node). The barrage test (B) fires 400 by default and can go up to 4,000 from the tuning panel.
- **Fallback:** if a worker can't start, the same `ProjectileSim` runs on the main thread with identical results.
- **Next:** the desktop build is cross-origin isolated, so `SharedArrayBuffer` is available there. Later we can move to a shared ring buffer with no messages at all, and split buoyancy for many AI ships across a small worker pool.

## Roadmap

1. ~~Wind + sail trim; wake/foam trail behind hulls.~~ Done in Step 2, together with the swivel gun, worker projectiles, sounds and detailed palms.
2. **Shipyard scene:** 2D draw canvas → lofted hull preview → HullSpec → test sail. *(next)*
3. Snap points + mast/cannon components with weight affecting draft and stability.
4. Broadside aiming: water-draped ribbon arc (the swivel gun's dotted arc + impact ring is the first version), cannon types with arcs and reloads.
5. Procedural islands + resource pickups; round/shipyard loop; enemy ships.
