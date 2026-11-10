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
| S held with the sail struck | Back her with the sweeps, only for as long as it is held |
| Mouse | Aim at the sea |
| Right mouse button | Fire the swivel gun (dotted arc + impact ring). Hold to keep firing. |
| Space | Fire the main guns: one gun deck per press (hold it and the decks follow one another), or the swivel when no broadside is run out. Each shell costs 1 metal. |
| Esc | Main menu / resume |
| C | Fit / remove the broadside battery (the raft gets a test battery; a designed ship uses its own cannons) |
| F | Also fires the broadside on the side you're aiming at (outlined ribbon) |
| Middle mouse drag | Orbit the camera (it stays where you leave it) |
| Mouse wheel | Zoom |
| B | Barrage stress test: hundreds of shells land around you |
| Click a ship / T | Mark the enemy ship as your target (again to let go). Red brackets show it on screen; a red arrow on the screen edge points to it when it is out of view. |
| U | Alongside an island: found an outpost on an unclaimed island, or upgrade your stronghold there. |
| Y | At your home dock: open the shipyard. |
| T | Mark the nearest hostile ship, or let go of the one you have marked. |
| M / Tab | Chart: an old paper map of what you have explored. Left click selects an island or one of your ships (Shift click adds more), right click sends the selection there (the flagship if none; touch the helm to cancel). Shift right click adds a waypoint, Ctrl right click is an attack move (they fight whatever comes in range on the way), right click on your flagship makes them follow it, and holding right and dragging draws a patrol zone. Selected ships can be made into a fleet, picked again from the bar at the top. Drag pans, wheel zooms. The small map in the corner of the HUD opens it too. |
| V | Broadside fire mode: in sequence (bow to stern) or all at once, each with a little random delay per gun. Also in Settings. |
| P | Mute (also in Settings: the gear button top right, or the main menu) |
| G | Tuning panel: sea, waves, wind, combat, ocean colours, raft physics |
| O | Show buoyancy probes (red = underwater) |
| H / ? | Show or hide the controls (also the question mark button, top left; hidden by default) |

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

Each island holds resources that depend on its type and size (wood, stone, metals) and regrow. There is nothing to press: lie off an island's shore and a marker appears over it while the crew haul what it has into your stores. There is one pool of resources for everything (gathered, sent in by islands, spent on building, shot and repairs); it is not kept aboard a ship, and the cargo on your flagship's deck shows how full the pool is. Islands with a **port** (a pier and hut) must be worked from the pier head instead, and load faster. Rules and numbers are in `src/world/Gathering.ts` and `src/world/Resources.ts`.

## Economy

Everything is paid for from the one pool (`ECONOMY` in `src/world/Resources.ts`):

- **Metals** are shot: every cannon shell fired by a ship or a fort costs its owner 1 metal (the swivel gun is free). A ship or fort with no metal holds its fire.
- **Wood** builds, and mends ships: hull repairs take 1 wood per 8 points, a new mast 3.
- **Stone** builds, and mends walls: strongholds repair slowly (1.2 points a second) at 1 stone per 12 points, and not at all without stone.
- Every 10 s each stronghold you hold sends in 2 units of what its island yields, 2 more per level, and 1 metal.
- The raiders pay for nothing. AI captains get a stipend in place of gathering by hand.

## The world

The map is a disc of sea 760 m in radius (`src/world/worldConfig.ts`). At its rim the sea pours off the edge of the world in a waterfall that fades into nothing (`src/world/WorldEdge.ts`; the ocean shader stops drawing at the rim). A current inside the last 70 m turns every ship back, so nothing sails over.

Islands are generated from a seed. The same map loads every time until you press **New map** in the main menu, which rolls a new seed and reloads.

The **chart** (Tab, `src/ui/MapView.ts`) is drawn as an old paper map: torn parchment, inked coasts, a compass rose, the rim of the world, and ships as little top-down hulls whose sails are their owner's colour. It only shows what you have explored. **Fog of war** (`src/world/FogOfWar.ts`) works as in an RTS: the map starts unknown, is uncovered for good wherever your flagship (210 m), escorts (170 m) or strongholds (150 m and up) have looked, and raider ships are drawn only while one of those can see them. Flags over each stronghold show who holds the island. The same painter draws the **exploration window**, a minimap in the corner of the HUD. The game keeps running while the chart is open. Course-keeping and island avoidance are in `src/world/navigation.ts`.

## Salvage, trade, ghosts and upgrades

- **Islands are solid** (`src/world/Grounding.ts`): a hull is pushed back off the beach and loses the speed it carried in. **Reefs and sea stacks** (each island's `rocks`) hole the hull, harder the faster she hit them; the AI and the chart's autopilot steer round them.
- **Wreckage** (`src/world/Flotsam.ts`): every ship that sinks leaves barrels and planks for 100 s; the first hull to sail over them hauls the wood and metals. Whoever sank her also gets a **bounty** in metals at once.
- **Trade ships** (`src/world/Trade.ts`): built from the home island's chart panel once you hold a second island. They sail from home to each of your islands in turn and bring back a cargo of that island's goods (more from far islands and trading posts). They carry no guns.
- **Ghost ships** drift in every few minutes (more often as the match goes on), fight anyone they meet and fade away after three and a half minutes. Sinking one gives your flagship a random **upgrade** (`src/world/Upgrades.ts`): sight, cannon range, reload, hull, repairs, speed, turning, income, salvage, free shots, trade. Each is small; they stack up to a limit. The HQ (home island's chart panel) sells the same upgrades at random for a price that rises by half each time.
- **Random enemy ships**: the Marauder, AI flagships and AI escorts are rolled by `randomDesign()` in `src/ship/HullDesign.ts`.
- **The volcano** (`src/weather/Volcano.ts`): a mountain island erupts, the sky turns red and ash falls, and fireballs come down all over. A red ring on the water marks where each will land.
- **Match based**: there are no rounds. Weather events roll after calm spells that get shorter, and their level and kind (the volcano and armageddon) get worse the longer the match runs (`Weather.escalation`, full after 30 minutes).

## Territory

You start with a **hut on a home island** (the unsettled island nearest the start; `src/world/Strongholds.ts`). Lose it and the game is over. Upgrade it with **U** when alongside, or from the chart's island panel from anywhere:

| Level | Hull | Guns | Cost to reach it |
| --- | --- | --- | --- |
| Hut | 80 | 0 | (given) |
| Stockade | 150 | 0 | 12 wood, 4 stone |
| Watchtower | 230 | 1 | 14 wood, 12 stone, 4 metals |
| Fort | 340 | 3 | 12 wood, 20 stone, 8 metals |

**Outposts** can be founded on any unclaimed island for 10 wood and 2 stone, which is how you claim it. They climb the same ladder but are smaller: 72% of the size, 60% of the hull, and a fort-level outpost carries two guns. Gathering no longer claims an island.

Strongholds with guns fire on hostile ships within 125 m. Shells that strike the walls (or land right under them) wear a stronghold down; friendly fire does nothing. One left alone for 12 s repairs itself. At zero it is **in ruins**, and if a hostile ship then stays within 110 m for 10 s it is taken: an outpost is burned and the island goes back to unclaimed, the home ends the game.

The raiders have a **home of their own**: a watchtower on the port island furthest from yours. Ruin it and hold your ship close to take it, and you win. About four minutes into a voyage, and every few minutes after, the *Marauder* **raids**: it sails for your home and shells it from offshore until it is sunk or you come within 150 m, when it turns on you instead.

**Stores and income.** Every island you hold sends resources to your stores: 1 + its stronghold's level units every 12 s, in the mix that island yields. Stores are shown at the top right with the income per minute. Upgrades and ships are paid from the stores from anywhere. Founding an outpost needs the flagship alongside.

**Capturing islands.** The raiders also keep a stockade on every other port island. Shoot one to ruins and hold a ship within 110 m for 10 s and the island, its flag and its income are yours. They can take a port back the same way.

**Fleet.** From your home island's panel on the chart, or from the shipyard, build escorts (as many as you can pay for) from any of the stock designs or your own saved design. An escort costs half the design's hull wood plus 2 metals a cannon (`escortCost`), and bigger hulls take more sinking. An escort follows the flagship, fights the raiders' ship when it comes within 150 m, and shells any raider stronghold it is near. Select them on the chart and right click to send them somewhere (plain moves sail past fights, attack moves stop for them); "Follow the flagship" calls them back. The home island's chart panel also opens the shipyard from anywhere: designs can be built as escorts there, but the flagship itself is only refitted alongside home. Escorts and the *Marauder* are the same class (`src/world/Warship.ts`).

Numbers are in `LEVELS` and `STRONGHOLD`; the HUD is `src/ui/TerritoryUi.ts`.

## Vs match

**Vs match** on the main menu opens a lobby (`src/ui/Lobby.ts`): eight captain seats (you, AI captains, and friends when the match is hosted online), each with a captain, a team and a colour, and the map and rules on the right. Start reloads the game into that match (`src/world/Match.ts` keeps the config in session storage; "Leave match" on the menu goes back to the solo voyage).

| Setting | What it does |
| --- | --- |
| Islands | 8, 12, 16 or 20 |
| Placement | **Fair**: the map is one wedge of islands repeated round the centre, so every captain has the same islands at the same distances, with one contested port island in the middle. **Random**: islands fall where they fall and homes are spread as far apart as the map allows. |
| Neutral forts | Raider stockades on the port islands, there for the taking |
| Map seed | Same seed, same map |
| Starting stores | Lean 15/4/0, Standard 40/12/8, Rich 120/50/40 (wood/stone/metals) |
| AI captains | Easy, Normal, Hard: how well supplied and how aggressive they are (`AI` in `src/world/AiCaptain.ts`) |

Every captain starts with a hut on a home island and a flagship in its berth. A captain whose home is taken is **out**: their ships go down and whatever else they held passes to the captor. The last team with a home wins. Teammates share vision, do not hurt each other, and show on the chart in their own colours. A scoreboard under the home chip lists who is still in and how many islands each holds.

Sides are **factions** (`src/world/Factions.ts`): an id, a colour, a team and a pool of stores. Strongholds, islands, warships and shots all carry a faction id, and `factions.hostile(a, b)` decides who may hurt whom, so the solo voyage is simply you against a "Raiders" faction. **AI captains** (`src/world/AiCaptain.ts`) play by the same rules as you: they settle the free islands near home, upgrade the home, build escorts, then take everything they have to the nearest hostile stronghold, and come home if theirs is attacked. Instead of gathering by hand they get a stipend of resources a minute. A sunk AI flagship is replaced at its home berth after 25 s.

## Captains and chatter

Every seat is sailed by one of eight **captains** (`src/world/Captains.ts`), each with a pixel-art portrait and a starting perk: one or two upgrades from the HQ list, and for some a little extra in the stores (Old Salt Pell starts with Canvas and Copper, Madame Coral with double Tax and 15 metals, and so on). Pick yours under **Settings, Your captain**, or click the portrait on your seat in the lobby; when hosting, click an AI seat's portrait to change its captain. Two players may pick the same captain: the hat is always drawn in the seat's team colour, so they stay apart.

Portraits are painted at 32×32 on a canvas (`src/ui/Portrait.ts`) from each captain's look (skin, hair, beard, hat style, coat, extras) and cached per colour. When a captain speaks, a card slides in at the bottom left (`src/ui/Chat.ts`) with the portrait, the name in the team colour and the line typed out letter by letter while the mouth flaps. AI captains greet you at the start, taunt you when they come for your islands and grumble when their home falls; you get a line when you win. Online, **Enter** opens a chat box and your lines go to every player with your portrait.

## Online play

A Vs match can be played with friends. In the lobby, **Host a match** makes a room and shows an invite code; a friend opens their own lobby, pastes the code and presses **Join** (over Steam they can also accept an invite from your friends list while Plunder is open). Friends take the slots set to **Open**; the host sets teams, map and rules and starts the match for everyone.

- **Steam** (desktop version, Steam running): a friends-only Steam lobby and peer-to-peer packets through `steamworks.js` in the Electron shell (`electron/steam.cjs`, exposed to the game by `electron/preload.cjs`). Until Plunder has its own Steamworks app id it runs on Valve's public test app, 480 ("Spacewar"), so Steam shows you as playing Spacewar. Change `APP_ID` in `electron/steam.cjs` when there is a real one.
- **This computer**: a link between windows of the same copy (a `BroadcastChannel`), for trying an online match alone. In the desktop version the lobby has **Open a second window**; in a browser, open a second tab.

How it stays in step (`src/net/`, and the "Online play" section of `src/main.ts`): every copy builds the same world from the same seed and lobby. Each player's copy sails their own flagship and reports her a dozen times a second; the host's copy runs everything else (AI captains, escorts, strongholds, captures) and sends that eight times a second. Every shot is announced and flown on every copy, and only the copy that owns what it hits counts the damage. Guests pay for outposts and escorts from their own stores and ask the host to build them. Weather events are off online for now (they are not shared yet), and if the host leaves the match ends.

## Sinking, masts and crew

**Sinking.** The flagship has 100 hull. Raider shells, stronghold guns and weather hazards wear it down, and it mends itself after 8 s out of trouble. At zero she goes down; seven seconds later a fresh ship is waiting in your berth at the home island (`sinkPlayer` / `berthFlagship` in `src/main.ts`).

**Masts** (`src/ship/Masts.ts`). Every mast of a designed ship has its own hit points (40) and two hitboxes up its height; a shell through the hull also has a 30% chance of damaging the nearest mast. A mast shot away topples over the side with its sail and rigging, and the ship loses that mast's share of her drive (down to 30% with none standing). Ten seconds after the last hit the crew start repairs; stepping a new mast costs 3 wood from the stores (free for NPC ships) and takes about 16 s.

**Crew** (`src/crew/Crew.ts`). Sailors in shirts of their owner's colour walk the deck between the guns, the wheel, the masts and the cargo, and villagers do the same around every stronghold. A shell landing among them throws some clear (with a splash) and leaves others lying where they fell; replacements turn up after a while. They are for show: crew losses do not change how a ship fights.

## Enemy ship

A white-sailed NPC sloop, the *Marauder* (`src/world/Warship.ts`), patrols a circle around the middle of the map. It is built from a shipyard design and sails on the same physics as the player. Come within 150 m and it closes to about 60 m, keeps you on its beam and trades broadsides (its shots scatter a little); its hits take points off your hull. It has 100 hull points (a swivel shot takes 7, a cannon shell 16), sinks when they are gone, and a fresh one sails in 25 s later. Numbers are in `ENEMY`.

## Shipyard

Open it from the main menu. On the **top view** drag to draw the hull's outline (one side, it is mirrored); on the **side view** drag to draw the keel line under the water. Set length, beam, keel depth and freeboard with the sliders, or start from a preset (Dinghy, Sloop, Brig, Barge, Galleon).

- **Masts** (up to three): click a ring to step it through square sail, triangle (lateen) sail, none. A square sail takes the wind's boost best with the wind astern; a triangle takes it best with the wind on the beam or a little ahead and less dead downwind. A **jib** adds boost on a close reach. The stats show the rig's boost astern, on the beam and close-hauled (`sailBoost`, `jibBoost`, `rigBoost`).
- **Cannons**: click anywhere along either edge of the top view (starboard is the upper edge) to place a gun, click a gun to remove it. "Both sides" places mirrored pairs. Guns go on the open deck or on up to three gun decks below it, firing through ports in the hull side; a deck is only offered where its ports clear the waterline, so more decks need more freeboard. A gun whose muzzle is under water when the salvo fires stays silent.
- **Swivel**: stands at the bow or the stern.
 The design is lofted into 3D live on the right, with its weight, draft, speed, handling, hold and cost. The shipyard only works **at your home dock**: press **Y** with the flagship alongside your home island (or use the menu before the voyage starts, when she is still in her berth). **Sail her as your flagship** swaps your vessel for the design; **Build as an escort** adds it to your fleet; the cannons you placed become the broadside. The last design is remembered.

A design is plain data (`src/ship/HullDesign.ts`): two curves, four sizes, masts with their sail type, a jib flag, individually placed cannons (`{t, side, level}`) and the swivel's position. Older saved designs are upgraded when loaded. The model (`ShipVisual.ts`), the buoyancy probes and drag (`designToHullSpec`), and the sail and rudder forces (`designToDrive`) are all derived from it. Hull and sails are free for now (their costs are shown for balancing). **Cannons** have no limit beyond the room on the hull: the first 4 come with the ship and each one more costs 4 metals, paid once at launch from your stores. The 3D preview shows the guns where they will stand, with Side, Top, Stern and 3/4 views, and deck guns fire through gaps cut in the rail. What is in your stores shows as cargo on deck (timber, stone blocks, metal ingots).

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

Settings also holds your **colour** (sails, pennant and the banners on islands you hold; white is for NPCs) and the broadside fire mode. Islands with a port start NPC-held; gathering at an unheld island makes it yours for now, until forts and capture arrive.

Volumes (master, sound effects, sea and wind, music) and mute are set in the Settings window (`src/ui/Settings.ts`) and remembered between sessions. Each has its own bus in `AudioManager`.

Music lives in `public/music/` (`.m4a`). The menu plays *Sailor's Log*; at sea *Sailing the calm seas* and *Sailor's Log* alternate; *Sailing into the Fog* is kept for fog weather. Tracks are listed in `MUSIC` in `AudioManager.ts` and chosen with `audio.setPlaylist([...])`, which crossfades.

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
