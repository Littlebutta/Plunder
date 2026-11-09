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
- **Propulsion:** for now the sail is a throttle (W/S) and the rudder a yaw torque that scales with speed. Next: a wind vector + sail trim (points of sail), which is what makes broadside positioning interesting.

## Roadmap after Step 1

1. Wind + sail trim; wake/foam trail behind hulls.
2. Shipyard scene: 2D draw canvas → lofted hull preview → HullSpec → test sail.
3. Snap points + mast/cannon components with weight affecting draft and stability.
4. Broadside aiming: water-draped ribbon arc, ballistic shots using the CPU wave sampler.
5. Procedural islands + resource pickups; round/shipyard loop.
