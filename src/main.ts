import * as THREE from 'three';
import { WaveField } from './ocean/waves';
import { Ocean } from './ocean/Ocean';
import { Sky } from './sky/Sky';
import { Raft } from './raft/Raft';
import { Input } from './input/Input';
import { FollowCamera } from './camera/FollowCamera';
import { createIslands } from './world/Islands';
import { Hud } from './ui/Hud';
import { createDebugPanel } from './ui/DebugPanel';
import { PALETTE } from './render/palette';
import { Simulation } from './physics/Simulation';
import { Wind } from './world/Wind';
import { Targets, TARGET_ID_BASE } from './world/Targets';
import { ProjectileSystem, ImpactEvent, Collider } from './combat/ProjectileSystem';
import { SwivelGun, SWIVEL } from './combat/SwivelGun';
import { Broadside, BROADSIDE, BroadsideShot } from './combat/Broadside';
import { Effects } from './fx/Effects';
import { Wake } from './fx/Wake';
import { WindStreaks } from './fx/WindStreaks';
import { AudioManager } from './audio/AudioManager';
import { Gathering } from './world/Gathering';
import { Hold } from './world/Resources';
import { GatherUi } from './ui/GatherUi';
import { IslandMarkers } from './world/IslandMarkers';
import { Warship, WarshipHooks, warshipId, WARSHIP_ID_BASE, WARSHIP_ID_END } from './world/Warship';
import { Factions, ME } from './world/Factions';
import { loadMatch, saveMatch, START_STOCK } from './world/Match';
import { AiCaptain } from './world/AiCaptain';
import { Lobby } from './ui/Lobby';
import { FogOfWar, Lookout } from './world/FogOfWar';
import { computeStats, escortCost, FREE_CANNONS, HullDesign, loadDesign, METALS_PER_CANNON, PRESETS } from './ship/HullDesign';
import { MAST, mastOwner } from './ship/Masts';
import { TargetUi } from './ui/TargetUi';
import { Territory, STRONGHOLD, canAfford, costLabel, pay, ShipSight, Side } from './world/Strongholds';
import { TerritoryUi } from './ui/TerritoryUi';
import { ballisticVelocity } from './combat/ballistics';
import { MapView, MiniMap, MapState, MapShip } from './ui/MapView';
import { WorldEdge } from './world/WorldEdge';
import { edgeCurrent, steerToward } from './world/navigation';
import { rollWorldSeed } from './world/worldConfig';
import { NPC_COLOUR } from './ui/Settings';
import { MainMenu } from './ui/MainMenu';
import { SettingsPanel } from './ui/Settings';
import { Shipyard } from './ui/Shipyard';
import { DesignedShip } from './ship/DesignedShip';
import type { Vessel } from './ship/Vessel';
import type { Island } from './world/Islands';
// Weather events + day-night cycle
import { DayNight } from './weather/DayNight';
import { Weather, ShipState } from './weather/Weather';
import { PlayerHull } from './weather/PlayerHull';
import { WeatherUi, addWeatherControls } from './weather/WeatherUi';

// --- Renderer ---------------------------------------------------------------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PALETTE.horizon, 300, 1600);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 6000);

// --- Lighting (warm sun + sky/sea bounce) ---------------------------------
// The day-night cycle moves the key light (sun by day, moon by night); the
// weather sets its colour and strength each frame (src/weather).
const dayNight = new DayNight();
const sunDir = dayNight.lightDir;
const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -12;
sc.right = sc.top = 12;
sc.near = 1;
sc.far = 80;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x1d5f99, 1.3);
scene.add(hemi);

// --- World ----------------------------------------------------------------
/** What this page load is: the classic voyage against the raiders, or a Vs match from the lobby. */
const match = loadMatch();
const vs = match.mode === 'vs';
const captainSlots = match.slots.filter((s) => s.kind !== 'closed');
const world = createIslands(match.seed, match.islands, 640, vs && match.fair ? captainSlots.length : 0);
const waves = new WaveField();
waves.shore = world.shore; // calm shallows around the islands
const ocean = new Ocean(waves, sunDir, world.shore);
const sky = new Sky(dayNight.sunDir, dayNight.moonDir);
scene.add(sky.group, ocean.mesh, world.group);

const wind = new Wind();
let ship: Vessel = new Raft(waves, wind);
ship.body.placeOnWater(0, 0, 0);
scene.add(ship.group);

// Swivel gun on the bow
const RAFT_ID = 0;
const gun = new SwivelGun(waves);
function mountSwivel(): void {
  gun.mount.position.copy(ship.swivelMount);
  gun.mount.rotation.y = ship.swivelFacing; // a stern gun faces aft
  ship.group.add(gun.mount);
}
mountSwivel();
scene.add(gun.preview);

// Broadside battery: the raft carries a test battery (C to fit / remove);
// a shipyard design carries the cannons it was drawn with.
let broadside = new Broadside(ship.group, ship.gunMounts, waves);
broadside.setVisible(false);
scene.add(broadside.ribbon);
const broadsideShots: BroadsideShot[] = [];

const targets = new Targets(waves);
scene.add(targets.group);

const projectiles = new ProjectileSystem(waves);
scene.add(projectiles.mesh);
const effects = new Effects(waves);
scene.add(effects.group);
const wake = new Wake(waves);
scene.add(wake.mesh);
const streaks = new WindStreaks(wind);
scene.add(streaks.mesh);

const audio = new AudioManager();
const settings = new SettingsPanel(document.body, audio);
settings.onClose = () => canvas.focus();
settings.onChange = () => applySettings();
ship.setColour(settings.settings.colour);
broadside.fireMode = settings.settings.fireMode;
const onSailFilled = () => audio.play('sailFull', { volume: 0.8, rateJitter: 0.04 });
ship.onSailFilled = onSailFilled;

// Debug: buoyancy probe markers (P)
const probeMarkers = new THREE.Group();
probeMarkers.visible = false;
const probeGeo = new THREE.SphereGeometry(0.08, 8, 6);
const wetMat = new THREE.MeshBasicMaterial({ color: 0xff3355, depthTest: false });
const dryMat = new THREE.MeshBasicMaterial({ color: 0xffee55, depthTest: false });
function rebuildProbeMarkers(): void {
  probeMarkers.clear();
  for (let i = 0; i < ship.body.probeWorld.length; i++) {
    const m = new THREE.Mesh(probeGeo, dryMat);
    m.renderOrder = 10;
    probeMarkers.add(m);
  }
}
rebuildProbeMarkers();
scene.add(probeMarkers);

/** Swap the player's vessel (starter raft <-> a shipyard design), keeping place and heading. */
function setShip(next: Vessel): void {
  const old = ship;
  const heading = Math.atan2(-old.body.forward(fwd).x, -fwd.z);
  scene.remove(old.group, broadside.ribbon);
  old.onSailFilled = null;
  ship = next;
  ship.body.placeOnWater(old.body.position.x, old.body.position.z, heading);
  ship.onSailFilled = onSailFilled;
  scene.add(ship.group);
  mountSwivel();
  ship.setColour(settings.settings.colour);
  fitFlagship();
  broadside = new Broadside(ship.group, ship.gunMounts, waves);
  broadside.fireMode = settings.settings.fireMode;
  // a designed ship shows the cannons it was built with; the raft's test battery stays off until C
  broadside.setVisible(ship instanceof DesignedShip && ship.gunMounts.length > 0);
  scene.add(broadside.ribbon);
  follow.setDistance(Math.max(14, ship.length * 1.9));
  const reach = Math.max(12, ship.length);
  sc.left = sc.bottom = -reach;
  sc.right = sc.top = reach;
  sc.updateProjectionMatrix();
  rebuildProbeMarkers();
  ship.syncVisuals(0);
}

/** The flagship's masts: replacements are paid for in wood, and the player hears about it. */
function fitFlagship(): void {
  if (!(ship instanceof DesignedShip)) return;
  ship.spendWood = (wood) => {
    if (hold.stock.wood < wood) return false;
    hold.stock.wood -= wood;
    return true;
  };
  ship.rig.onFall = (_i, top) => {
    effects.splinters(top, 26);
    audio.woodHit(top);
    weatherUi.announce('Mast down!', 'She sails slower until the crew step a new one', 'danger');
  };
  ship.rig.onRaised = () => weatherUi.announce('Mast repaired', `A new mast is up (${MAST.woodCost} wood)`, 'good');
}

const sim = new Simulation();

// --- Controls / UI --------------------------------------------------------
const input = new Input(canvas);
const follow = new FollowCamera(camera, input, waves);
const hudRoot = document.getElementById('hud')!;
const hud = new Hud(hudRoot);

// --- Weather events + day-night cycle (src/weather) -------------------------
const hull = new PlayerHull();
const weatherUi = new WeatherUi(hudRoot);
const weather = new Weather({
  dayNight,
  waves,
  wind,
  ocean,
  sky,
  scene,
  sun,
  hemi,
  refreshSea: () => {
    waves.syncUniforms();
    ocean.refreshAmplitude();
    projectiles.markSeaDirty();
  },
  splash: (at, size) => {
    effects.splash(at, size);
    audio.splash(at, size);
  },
  splinters: (at, count) => {
    effects.splinters(at, count);
    audio.woodHit(at);
  },
  hitShip: (damage, at, shove) => {
    hull.damage(damage);
    ship.body.velocity.add(shove);
    effects.splinters(at, 14);
    audio.woodHit(at);
  },
  fire: (from, vel, owner, dir) => {
    projectiles.spawn(from, vel, 1, owner);
    effects.muzzle(from, dir, _zero, 1.3);
    audio.play('cannon', { volume: 0.8, rate: 0.8, rateJitter: 0.06, position: from });
  },
  announce: (title, sub, tone) => weatherUi.announce(title, sub, tone),
  thunder: (distance, strength) => audio.thunder(distance, strength),
  rainSound: (amount) => audio.setRain(amount),
});
scene.add(weather.group);
const _zero = new THREE.Vector3();
hull.onDamage = () => weatherUi.hit();
hull.onBattered = () => sinkPlayer();
const shipState = (): ShipState => ({ position: ship.body.position, velocity: ship.body.velocity, length: ship.length });

// --- Gathering --------------------------------------------------------------
/** The player's one pool of resources: gathering, income and plunder all land here. */
const hold = new Hold();
const gathering = new Gathering(world.islands, hold);
const gatherUi = new GatherUi(hudRoot);
// --- Enemy ship + targeting ---------------------------------------------------
const warshipHooks: WarshipHooks = {
  fire: (w, from, dir) => {
    shotVel.copy(dir).multiplyScalar(BROADSIDE.muzzleSpeed);
    projectiles.spawn(from, shotVel, BROADSIDE.kind, w.id);
    effects.muzzle(from, dir, w.ship.body.velocity, 1.5);
    audio.play('cannon', { volume: 0.9, rate: 0.95, rateJitter: 0.06, position: from });
  },
  sunk: (w) => {
    effects.splinters(w.position, 40);
    effects.splash(w.position, 2.2);
    audio.woodHit(w.position);
    audio.splash(w.position, 1.6);
    if (w === marauder) endRaid();
    else if (w.faction === ME) weatherUi.announce(`${w.name} is lost`, 'One of your escorts has gone down', 'danger');
    else if (w.flagship && fog.canSee(w.position.x, w.position.z)) weatherUi.announce(`${w.name} is sunk`, `${factions.name(w.faction)} will be back with a new ship`, factions.hostile(ME, w.faction) ? 'good' : 'danger');
  },
};

// --- Sides ---------------------------------------------------------------------------
const factions = new Factions();
if (vs) {
  captainSlots.forEach((slot, n) => {
    const f = factions.add(n === 0 ? 'You' : slot.name, n === 0 ? settings.settings.colour : slot.colour, slot.team, n === 0 ? 'human' : 'ai', n === 0 ? hold.stock : undefined);
    Object.assign(f.stores, START_STOCK[match.stock]);
  });
  if (match.forts) factions.add('Raiders', NPC_COLOUR, 99, 'raiders');
} else {
  factions.add('You', settings.settings.colour, 0, 'human', hold.stock);
  factions.add('Raiders', NPC_COLOUR, 99, 'raiders');
}
const RAIDERS = factions.list.find((f) => f.kind === 'raiders')?.id ?? -1;

/** Every ship that sails itself: the raiders' Marauder, AI captains' flagships, and everyone's escorts. */
const ships: Warship[] = [];
/** Whose each warship is, by collider id (kept after she sinks, for shots still in the air). */
const shipFaction = new Map<number, number>();
function addShip(w: Warship): Warship {
  ships.push(w);
  shipFaction.set(w.id, w.faction);
  scene.add(w.group);
  return w;
}
/** Classic voyage: the raiders' ship, which patrols the middle of the map and raids the player's home. */
const marauder = vs ? null : addShip(new Warship(waves, wind, world.islands, warshipHooks, { id: warshipId(), name: 'Marauder', faction: RAIDERS, colour: NPC_COLOUR, respawn: true }));
/** The player's escorts: built at home, ordered about from the chart. */
const fleet: Warship[] = [];
const fleetBuilt = new Map<number, number>();
const FLEET_NAMES = ['Swift', 'Gannet', 'Petrel', 'Osprey', 'Heron', 'Kestrel', 'Curlew', 'Tern'];
const escortsOf = (faction: number) => ships.filter((w) => w.faction === faction && !w.flagship && w.state !== 'gone');
const hostileShips = () => ships.filter((w) => w.alive && factions.hostile(ME, w.faction));
const targetUi = new TargetUi(hudRoot);
/** The ship the player has marked (click it; click it again or press T to let go). */
let targeted: Warship | null = null;
const targetAt = new THREE.Vector3();
const screenPt = { x: 0, y: 0, onScreen: false, behind: false };

function updateTargeting(playing: boolean): void {
  if (playing && input.clicked) {
    // a click near a hostile ship on screen marks it: generous, so it works at range and in a swell
    const px = (input.pointer.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-input.pointer.y * 0.5 + 0.5) * window.innerHeight;
    let best: Warship | null = null;
    let bestD = Infinity;
    for (const w of hostileShips()) {
      TargetUi.project(targetAt.copy(w.position).setY(w.position.y + 2.5), camera, screenPt);
      const reach = THREE.MathUtils.clamp(1900 / Math.max(w.position.distanceTo(camera.position), 10), 30, 110);
      const d = Math.hypot(px - screenPt.x, py - screenPt.y);
      if (!screenPt.behind && d < reach && d < bestD) {
        best = w;
        bestD = d;
      }
    }
    if (best) targeted = targeted === best ? null : best;
  }
  if (playing && input.wasPressed('KeyT')) {
    // T lets go, or marks the nearest hostile ship
    const near = hostileShips().sort((a, b) => a.position.distanceTo(ship.body.position) - b.position.distanceTo(ship.body.position))[0];
    targeted = targeted ? null : (near ?? null);
  }
  if (targeted && targeted.state === 'gone') targeted = null;
  if (!playing || !targeted) {
    targetUi.update(null, camera);
    return;
  }
  targetAt.copy(targeted.position).setY(targeted.position.y + 2.5);
  targetUi.update(
    {
      name: targeted.flagship ? `${targeted.name} (${factions.name(targeted.faction)})` : targeted.name,
      position: targetAt,
      health: targeted.hp / targeted.maxHp,
      distance: Math.hypot(targeted.position.x - ship.body.position.x, targeted.position.z - ship.body.position.z),
      note: targeted.state === 'sinking' ? 'Sinking!' : targeted.state === 'fight' ? 'In a fight' : targeted.state === 'raid' ? 'Shelling a stronghold' : 'Under sail',
    },
    camera,
  );
}

// --- World's edge + chart -------------------------------------------------------
const worldEdge = new WorldEdge(ocean.material.uniforms as never);
scene.add(worldEdge.group);
const edgeWarning = document.createElement('div');
edgeWarning.className = 'hud-edge';
edgeWarning.textContent = "The world's edge! The current is turning you back.";
edgeWarning.hidden = true;
hudRoot.append(edgeWarning);

/** Where the flagship has been told to sail from the chart; any touch of the helm cancels it. */
let course: THREE.Vector3 | null = null;
const chart = new MapView(document.body, {
  order: (id, x, z) => {
    if (id === 0) course = new THREE.Vector3(x, 0, z);
    else {
      const w = fleet.find((f) => f.id === id);
      if (w) w.order = new THREE.Vector3(x, 0, z);
    }
  },
  follow: (id) => {
    const w = fleet.find((f) => f.id === id);
    if (w) w.order = null;
  },
  close: () => {
    chart.close();
    canvas.focus();
  },
});
const compass = (v: THREE.Vector3) => Math.atan2(v.x, -v.z);

/** Sail the flagship along its ordered course. Returns false when there is none. */
function followCourse(dt: number): boolean {
  if (!course) return false;
  if (input.throttle !== 0 || input.steer !== 0) {
    course = null; // the player took the helm
    return false;
  }
  const p = ship.body.position;
  const left = Math.hypot(course.x - p.x, course.z - p.z);
  if (left < Math.max(18, ship.length * 1.5)) {
    course = null;
    return false;
  }
  ship.body.forward(fwd).setY(0).normalize();
  // ease the sail off on the approach so she does not overshoot
  const want = left < 70 ? 0.35 : 1;
  ship.control(dt, ship.sail < want - 0.03 ? 1 : ship.sail > want + 0.05 ? -1 : 0, steerToward(p, fwd, course, world.islands));
  return true;
}

const islandMarkers = new IslandMarkers(world.islands);
scene.add(islandMarkers.group);
gathering.onHaul = () => audio.woodHit(ship.body.position);

// --- Territory: home island, strongholds, raids, winning and losing -------------
const territory = new Territory(world.islands, {
  fire: (from, vel, owner) => {
    projectiles.spawn(from, vel, BROADSIDE.kind, owner);
    muzzleDir.copy(vel).normalize();
    effects.muzzle(from, muzzleDir, _zero, 1.5);
    audio.play('cannon', { volume: 0.9, rate: 0.85, rateJitter: 0.06, position: from });
  },
  ruined: (s) => {
    effects.splinters(s.collider.position, 40);
    audio.woodHit(s.site);
    if (s.side === ME) weatherUi.announce(s === territory.home ? 'Your home is in ruins!' : `${s.island.name} is in ruins!`, 'Drive them off before they take it', 'danger');
    else if (factions.hostile(ME, s.side) && fog.canSee(s.site.x, s.site.z)) weatherUi.announce('Their walls are down!', 'Hold a ship close to take the island', 'good');
  },
  captured: (s, by, from, wasHome, burned) => {
    if (wasHome) {
      // a captain is out: their ships go down with their flag
      for (const w of ships) if (w.faction === from) w.scuttle();
    }
    if (from === ME && wasHome) {
      if (mode !== 'over') endGame(false);
    } else if (by === ME && s === territory.enemyHome) {
      endGame(true);
    } else if (wasHome) {
      weatherUi.announce(`${factions.name(from)} is out`, `${factions.name(by)} took their home at ${s.island.name}`, factions.hostile(ME, from) ? 'good' : 'danger');
      // Vs: the last team afloat wins
      if (vs && mode !== 'over' && !factions.contenders.some((f) => factions.hostile(ME, f.id))) endGame(true);
    } else if (by === ME) weatherUi.announce(`${s.island.name} is yours`, 'Your colours fly over it', 'good');
    else if (from === ME) weatherUi.announce(`${s.island.name} is lost`, burned ? 'The raiders burned your outpost' : `${factions.name(by)} took it`, 'danger');
  },
  changed: () => islandMarkers.refresh(),
}, factions, { mode: match.mode, forts: match.forts });
islandMarkers.colourOf = (f) => factions.colour(f);
scene.add(territory.group);
islandMarkers.refresh();
const territoryUi = new TerritoryUi(hudRoot, document.body, {
  retry: () => {
    if (vs) saveMatch({ ...match, autostart: true });
    location.reload();
  },
  newMap: () => {
    if (vs) saveMatch({ ...match, seed: 1 + Math.floor(Math.random() * 999_983), autostart: true });
    else rollWorldSeed();
    location.reload();
  },
  carryOn: () => {
    territoryUi.hideEnd();
    startPlay();
  },
});
/** The island the flagship is alongside, close enough to build on. */
let buildIsland: Island | null = null;
function tryBuild(island: Island): void {
  if (!territory.build(island, island === buildIsland)) return;
  audio.woodHit(ship.body.position);
  const s = territory.at(island)!;
  weatherUi.announce(s.levelName, s.home ? `Your home at ${island.name} grows stronger` : `${island.name} flies your colours`, 'good');
}
chart.islandActions = (island) => territoryUi.chartRows(territory, island, buildIsland, hold, fleet.length, escortDesigns());
chart.onIslandAction = (island, act) => {
  if (!act.startsWith('ship:')) return tryBuild(island);
  const why = buildEscort(escortDesigns()[Number(act.slice(5))]);
  if (why) weatherUi.announce('Cannot build her yet', why, 'danger');
};

/** Designs an escort can be built from: the stock ones, and the player's own from the shipyard. */
function escortDesigns(): HullDesign[] {
  const own = loadDesign();
  return own && !PRESETS.some((p) => p.name === own.name) ? [...PRESETS.slice(0, 5), own] : PRESETS.slice(0, 5);
}

/** A berth off a captain's home island: n picks one of a row of them. Null once the home is lost. */
function homeBerth(n: number, faction = ME): { x: number; z: number; heading: number } | null {
  const home = territory.homes.get(faction);
  if (!home) return null;
  const c = home.island.center;
  const a = Math.atan2(home.site.z - c.z, home.site.x - c.x) + ((n % 2 ? 1 : -1) * Math.ceil(n / 2) * 30) / Math.max(60, home.island.radius);
  const r = home.island.shoreAt(a) + 50;
  return { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r, heading: a + Math.PI / 2 };
}

/** True while the flagship lies off the player's home island, where ships are built and refitted. */
function atHomeDock(): boolean {
  return territory.home.side === ME && sunkFor < 0 && territory.islandInReach(ship.body.position) === territory.home.island;
}

/** Lay down an escort at a captain's home island from a design, paid from their stores. Returns why not, or ''. */
function buildEscort(design: HullDesign = PRESETS[1], faction = ME): string {
  const owner = factions.get(faction)!;
  const cost = escortCost(design);
  const n = fleetBuilt.get(faction) ?? 0;
  const berth = homeBerth(1 + (n % 4), faction);
  if (!berth) return 'Your home island is lost.';
  if (escortsOf(faction).length >= STRONGHOLD.fleetMax) return `Your fleet is full (${STRONGHOLD.fleetMax} escorts).`;
  if (!canAfford(cost, owner.stores, null)) return `An escort ${design.name} needs ${costLabel(cost)}.`;
  pay(cost, owner.stores, null);
  fleetBuilt.set(faction, n + 1);
  const w = addShip(
    new Warship(waves, wind, world.islands, warshipHooks, {
      id: warshipId(),
      name: FLEET_NAMES[(n + faction * 3) % FLEET_NAMES.length],
      faction,
      colour: owner.colour,
      respawn: false,
      design,
    }),
  );
  w.placeAt(berth.x, berth.z, berth.heading);
  if (faction === ME) {
    fleet.push(w);
    audio.woodHit(w.position);
    weatherUi.announce(`${w.name} launched`, `A ${design.name} to follow your flagship. Give her orders on the chart (M).`, 'good');
  }
  return '';
}

// --- AI captains (Vs) -----------------------------------------------------------------
const captains: AiCaptain[] = [];
for (const f of factions.list) {
  if (f.kind !== 'ai') continue;
  const flagship = addShip(
    new Warship(waves, wind, world.islands, warshipHooks, {
      id: warshipId(),
      name: f.name,
      faction: f.id,
      colour: f.colour,
      respawn: true,
      berth: () => homeBerth(0, f.id),
      flagship: true,
      preset: match.ai === 'hard' ? 2 : 1,
    }),
  );
  const berth = homeBerth(0, f.id);
  if (berth) flagship.placeAt(berth.x, berth.z, berth.heading);
  captains.push(
    new AiCaptain(
      f,
      flagship,
      {
        territory,
        factions,
        islands: world.islands,
        escortsOf,
        launchEscort: (id) => buildEscort(PRESETS[1], id) === '',
        threatNear: (id, at, range) =>
          (factions.hostile(id, ME) && sunkFor < 0 && mode === 'play' && ship.body.position.distanceTo(at) < range) ||
          ships.some((w) => w.alive && factions.hostile(id, w.faction) && w.position.distanceTo(at) < range),
      },
      match.ai,
    ),
  );
}

// --- Sinking and coming back ---------------------------------------------------------
/** Seconds since the flagship went down; below zero while she is afloat. */
let sunkFor = -1;
const RESPAWN_TIME = 7;
function sinkPlayer(): void {
  if (sunkFor >= 0) return;
  sunkFor = 0;
  course = null;
  ship.sail = 0;
  gathering.select(null);
  effects.splinters(ship.body.position, 40);
  effects.splash(ship.body.position, 2.2);
  audio.woodHit(ship.body.position);
  audio.splash(ship.body.position, 1.6);
  weatherUi.announce('Sunk!', `A new ship will be ready at ${territory.home.island.name} in a few seconds`, 'danger');
}
/** Put the flagship in her berth at home, whole again. */
function berthFlagship(): void {
  const berth = homeBerth(0) ?? { x: 0, z: 0, heading: 0 };
  ship.body.placeOnWater(berth.x, berth.z, berth.heading);
  ship.body.velocity.set(0, 0, 0);
  ship.sail = 0;
  ship.group.rotation.set(0, 0, 0);
  if (ship instanceof DesignedShip) {
    ship.rig.restore();
    ship.crew.reset();
  }
  hull.hp = hull.max;
  sunkFor = -1;
  ship.syncVisuals(0);
}

// --- Fog of war and the charts that show it ----------------------------------------
const fog = new FogOfWar();
const lookouts: Lookout[] = [];
function updateFog(dt: number): void {
  lookouts.length = 0;
  lookouts.push({ x: ship.body.position.x, z: ship.body.position.z, range: 210 });
  // allies share what they see
  for (const w of ships) if (w.alive && factions.allied(ME, w.faction)) lookouts.push({ x: w.position.x, z: w.position.z, range: 170 });
  for (const s of territory.strongholds) if (factions.allied(ME, s.side)) lookouts.push({ x: s.site.x, z: s.site.z, range: 150 + s.level * 25 });
  fog.update(dt, lookouts, world.islands);
}
const _hd = new THREE.Vector3();
function mapState(): MapState {
  const colour = settings.settings.colour;
  const ships_: MapShip[] = [
    { id: 0, position: ship.body.position, heading: compass(ship.body.forward(_hd)), colour, name: ship.displayName, hostile: false, health: hull.fraction, course, note: course ? 'Under orders' : 'At your command' },
  ];
  for (const w of ships) {
    if (!w.alive) continue;
    const mine = w.faction === ME;
    const hostile = factions.hostile(ME, w.faction);
    const note = hostile ? '' : w.state === 'fight' ? 'Engaging the enemy' : w.state === 'raid' ? 'Shelling a stronghold' : !mine ? `${factions.name(w.faction)}, your ally` : w.order ? 'Under orders' : 'Following the flagship';
    ships_.push({ id: w.id, position: w.position, heading: compass(w.ship.body.forward(_hd)), colour: factions.colour(w.faction), name: w.name, hostile, mine, health: w.hp / w.maxHp, course: mine ? w.order : null, note });
  }
  return { islands: world.islands, ships: ships_, colourOf: (f) => factions.colour(f), nameOf: (f) => factions.name(f), strongholds: territory.strongholds, fog };
}
const miniMap = new MiniMap(hudRoot, () => {
  if (mode === 'play') chart.open();
});

/** Which faction fired a shot, from its owner id. Null: nobody's (weather, the barrage test). */
function sideOfOwner(owner: number): Side | null {
  if (owner === RAFT_ID) return ME;
  if (owner >= WARSHIP_ID_BASE && owner < WARSHIP_ID_END) return shipFaction.get(owner) ?? null;
  return territory.sideOf(owner);
}
/** Deck cargo shows the whole pool: this many units fills every place on deck. */
const CARGO_FULL = 140;

/** Raids: every so often the Marauder sails for the player's home and shells it. */
const RAID = { first: 240, every: 200 };
let raidIn = RAID.first;
function endRaid(): void {
  if (marauder) marauder.raidTarget = null;
  raidIn = RAID.every;
}
function updateRaids(dt: number): void {
  if (!marauder) return;
  if (marauder.raidTarget) {
    // called off once the home has been rebuilt behind them, or lost
    if (territory.home.side !== ME) endRaid();
    return;
  }
  raidIn -= dt;
  if (raidIn > 0 || !marauder.alive) return;
  marauder.raidTarget = territory.home.site;
  weatherUi.announce('Raiders!', `The Marauder is making for your home at ${territory.home.island.name}`, 'danger');
}

function endGame(won: boolean): void {
  mode = 'over';
  endRaid();
  chart.close();
  settings.showGear(false);
  hudRoot.classList.add('in-menu');
  gun.preview.visible = false;
  broadside.ribbon.visible = false;
  marker.visible = false;
  if (won) territoryUi.showVictory(vs ? null : territory.enemyHome);
  else territoryUi.showDefeat(territory.home);
}

/** Push the player's settings (colour, fire mode) into the game. */
function applySettings(): void {
  const s = settings.settings;
  ship.setColour(s.colour);
  broadside.fireMode = s.fireMode;
  factions.me.colour = s.colour;
  territory.refreshColours();
  islandMarkers.refresh();
  for (const w of fleet) w.ship.setColour(s.colour);
  yard.colour = s.colour;
  hud.setFireMode(s.fireMode);
}
// Marker that floats over the island (or its port) you can gather from.
const marker = new THREE.Group();
const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), markerMat);
gem.scale.y = 1.5;
const halo = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 6, 32), markerMat);
halo.rotation.x = Math.PI / 2;
halo.position.y = -1.9;
marker.add(gem, halo);
marker.visible = false;
scene.add(marker);
const islandMeshes = new Map<THREE.Object3D, Island>();
for (const island of world.islands) islandMeshes.set(island.group, island);

function islandUnderPointer(): Island | null {
  raycaster.setFromCamera(new THREE.Vector2(input.pointer.x, input.pointer.y), camera);
  const hits = raycaster.intersectObject(world.group, true);
  for (const hit of hits) {
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      const island = islandMeshes.get(o);
      if (island) return island;
    }
  }
  return null;
}

function updateGathering(dt: number): void {
  const at = ship.body.position;
  gathering.update(dt, at);
  if (input.wasPressed('KeyE')) gathering.toggle();
  if (input.clicked && gathering.inRange && !gathering.selected && islandUnderPointer() === gathering.inRange) gathering.select(gathering.inRange);
  gatherUi.update(gathering, territory.incomePerMinute);

  const target = gathering.selected ?? gathering.inRange;
  marker.visible = !!target;
  if (!target) return;
  const bob = Math.sin(performance.now() * 0.003) * 0.4;
  if (target.port) {
    marker.position.set(target.port.x, target.port.y + 7 + bob, target.port.z);
  } else {
    // over the stretch of shore nearest the ship
    const a = Math.atan2(at.z - target.center.z, at.x - target.center.x);
    const r = target.shoreAt(a) * 0.85;
    const lx = Math.cos(a) * r;
    const lz = Math.sin(a) * r;
    marker.position.set(target.center.x + lx, Math.max(0, target.heightAt(lx, lz)) + 7 + bob, target.center.z + lz);
  }
  marker.rotation.y += dt * 1.5;
  markerMat.color.set(!gathering.selected ? 0xffffff : gathering.working ? 0x9be37a : 0xffb27a);
}

// --- Main menu ------------------------------------------------------------
let mode: 'menu' | 'play' | 'yard' | 'over' = 'menu';
let voyageStarted = false;
const menu = new MainMenu(document.body, {
  play: () => startPlay(),
  shipyard: () => openYard(),
  settings: () => settings.open(),
  newMap: () => {
    rollWorldSeed();
    location.reload();
  },
});

/** The shipyard works only at the home dock (or before the voyage has begun, when the ship is still there). */
function openYard(): void {
  if (voyageStarted && !atHomeDock()) {
    weatherUi.announce('No shipyard here', `Bring your ship alongside your home at ${territory.home.island.name}`, 'danger');
    return;
  }
  mode = 'yard';
  chart.close();
  settings.showGear(false);
  menu.hide();
  hudRoot.classList.add('in-menu');
  gun.preview.visible = false;
  broadside.ribbon.visible = false;
  marker.visible = false;
  yard.open();
}
/** Leave the shipyard: back to the sea if a voyage is under way, else to the menu. */
function leaveYard(): void {
  yard.close();
  if (voyageStarted) startPlay();
  else openMenu();
}

/** Extra cannons (beyond the free ones) the player has already paid for. */
let cannonsPaid = 0;
const yard = new Shipyard(document.body, {
  launch: (design) => {
    // cannons beyond the first few are paid for in metals, once each
    const extra = Math.max(0, computeStats(design).guns - FREE_CANNONS);
    const due = { wood: 0, stone: 0, salvage: Math.max(0, extra - cannonsPaid) * METALS_PER_CANNON };
    if (!canAfford(due, territory.stores, hold)) {
      yard.warn(`The extra cannons need ${due.salvage} metals and you have ${hold.stock.salvage}. Gather more, or take some guns off.`);
      return;
    }
    pay(due, territory.stores, hold);
    cannonsPaid = Math.max(cannonsPaid, extra);
    setShip(new DesignedShip(design, waves, wind, settings.settings.colour, RAFT_ID));
    yard.close();
    startPlay();
  },
  useRaft: () => {
    if (!(ship instanceof Raft)) setShip(new Raft(waves, wind));
    yard.close();
    startPlay();
  },
  back: () => leaveYard(),
  escort: (design) => buildEscort(design),
  fleet: () => `${fleet.length} of ${STRONGHOLD.fleetMax}`,
  stock: () => hold.stock,
  cannonsPaid: () => cannonsPaid,
});

/** In the menu the scene is shifted right, clear of the options column. */
function applyViewOffset(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (mode === 'menu') camera.setViewOffset(w, h, -w * 0.15, 0, w, h);
  else camera.clearViewOffset();
}

/** Sea music: "Sailing into the Fog" while a fog event is in, else the normal sea playlist (weather). */
let fogMusic = false;
function seaPlaylist(): ('fog' | 'calm' | 'log')[] {
  fogMusic = weather.event?.kind === 'fog' && !weather.event.ending;
  return fogMusic ? ['fog'] : ['calm', 'log'];
}

function startPlay(): void {
  mode = 'play';
  audio.setPlaylist(seaPlaylist());
  if (!voyageStarted) berthFlagship(); // the voyage begins at the home dock
  voyageStarted = true;
  menu.hide();
  hudRoot.classList.remove('in-menu');
  settings.showGear(true);
  gun.preview.visible = true;
  broadside.ribbon.visible = broadside.visible;
  applyViewOffset();
  canvas.focus();
}

function openMenu(): void {
  mode = 'menu';
  audio.setPlaylist(['log']);
  menu.show(voyageStarted, !voyageStarted || atHomeDock());
  hudRoot.classList.add('in-menu');
  settings.showGear(false);
  gun.preview.visible = false;
  broadside.ribbon.visible = false;
  marker.visible = false;
  applyViewOffset();
}

/** Menu backdrop: the raft sails a lazy circle around the start on its own. */
function autopilot(dt: number): void {
  const p = ship.body.position;
  ship.body.forward(fwd);
  const r = Math.hypot(p.x, p.z) || 1;
  const k = THREE.MathUtils.clamp((r - 45) / 30, -1, 1);
  const dx = -p.z / r - (p.x / r) * k;
  const dz = p.x / r - (p.z / r) * k;
  const turn = fwd.x * dz - fwd.z * dx;
  ship.control(dt, ship.sail < 0.75 ? 1 : 0, THREE.MathUtils.clamp(turn * 2, -1, 1));
}
// Barrage stress test: shells arc in from a ring of unseen ships and land around the ship.
const barrage = {
  size: 400,
  fire: () => fireBarrage(barrage.size),
};
const gui = createDebugPanel(waves, ocean, wind, () => projectiles.markSeaDirty(), barrage);
addWeatherControls(gui, weather, shipState); // weather

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  applyViewOffset();
});

// Expose a handle for console tinkering / automated checks.
Object.assign(window, {
  plunder: {
    aimPoint: () => aimPoint,
    gathering,
    hold,
    startPlay,
    openMenu,
    setShip,
    scene,
    camera,
    waves,
    ocean,
    follow,
    sim,
    wind,
    gun,
    world,
    projectiles,
    targets,
    marauder,
    enemy: marauder,
    ships,
    factions,
    captains,
    match,
    territory,
    fleet,
    fog,
    buildEscort,
    atHomeDock,
    openYard,
    get sunkFor() {
      return sunkFor;
    },
    chart,
    get course() {
      return course;
    },
    audio,
    barrage,
    weather,
    hull,
    get raft() {
      return ship;
    },
    get ship() {
      return ship;
    },
    get broadside() {
      return broadside;
    },
  },
});

// --- Combat wiring ----------------------------------------------------------
projectiles.onImpact = (e: ImpactEvent) => {
  const size = e.kind === 1 ? 1.5 : 0.55;
  if (e.type === 'splash') {
    effects.splash(e.position, size);
    audio.splash(e.position, size);
    return;
  }
  const by = sideOfOwner(e.owner);
  const mast = e.type === 'land' ? null : mastOwner(e.colliderId);
  if (mast) {
    effects.splinters(e.position, e.kind === 1 ? 12 : 6);
    audio.woodHit(e.position);
    if (mast.ship === RAFT_ID) {
      if (factions.hostile(by, ME) && ship instanceof DesignedShip) ship.rig.hit(mast.mast, e.kind);
    } else {
      const w = ships.find((f) => f.id === mast.ship);
      if (w && factions.hostile(by, w.faction) && w.hitMast(mast.mast, e.kind)) mastFell(w);
    }
    return;
  }
  if (e.type === 'land') {
    effects.splinters(e.position, e.kind === 1 ? 8 : 4);
    audio.woodHit(e.position);
    territory.landed(e.position, e.kind, by);
    return;
  }
  if (territory.owns(e.colliderId)) {
    effects.splinters(e.position, e.kind === 1 ? 14 : 7);
    audio.woodHit(e.position);
    territory.hit(e.colliderId, e.kind, by);
    return;
  }
  // weather: sea creatures and cursed ships
  if (weather.owns(e.colliderId)) {
    const at = weather.hit(e.colliderId, e.kind);
    if (at) audio.woodHit(at);
    return;
  }
  if (e.colliderId >= WARSHIP_ID_BASE && e.colliderId < WARSHIP_ID_END) {
    effects.splinters(e.position, e.kind === 1 ? 14 : 7);
    audio.woodHit(e.position);
    const w = ships.find((f) => f.id === e.colliderId);
    // only a known enemy's shot counts: weather and stray shots pass warships by
    if (w && by !== null && factions.hostile(by, w.faction)) {
      w.ship.crewHit(e.position, e.kind);
      if (w.hit(e.kind) && e.owner === RAFT_ID) targets.score += 10;
    }
    return;
  }
  if (e.colliderId >= TARGET_ID_BASE) {
    const at = targets.hit(e.colliderId);
    if (at) {
      effects.splinters(at, 16);
      effects.splash(at, 0.8);
      audio.woodHit(at);
    }
  } else if (e.colliderId === RAFT_ID) {
    effects.splinters(e.position, 8);
    audio.woodHit(e.position);
    if (factions.hostile(by, ME) && sunkFor < 0) {
      hull.damage(e.kind === 1 ? 9 : 3); // weather: enemy fire
      if (ship instanceof DesignedShip) ship.crewHit(e.position, e.kind);
      // a shell through the hull sometimes carries rigging away with it
      if (e.kind === 1 && ship instanceof DesignedShip && Math.random() < MAST.hullHitChance) {
        const m = ship.rig.nearest((Math.random() - 0.5) * ship.length);
        if (m >= 0) ship.rig.hit(m, 0);
      }
    }
  }
};

DesignedShip.onOverboard = (at) => {
  effects.splash(at, 0.5);
  audio.splash(at, 0.5);
};
function mastFell(w: Warship): void {
  effects.splinters(_mastAt.copy(w.position).setY(w.position.y + 5), 26);
  if (factions.hostile(ME, w.faction) && fog.canSee(w.position.x, w.position.z)) weatherUi.announce(`${w.name} has lost a mast`, 'She is slowed until her crew step a new one', 'good');
}
const _mastAt = new THREE.Vector3();

const queuedShots: { delay: number; pos: THREE.Vector3; vel: THREE.Vector3 }[] = [];
function fireBarrage(n: number): void {
  const centre = ship.body.position;
  const batteries = 8;
  for (let i = 0; i < n; i++) {
    const b = i % batteries;
    const a = (b / batteries) * Math.PI * 2 + 0.3;
    const r = 180 + (b % 3) * 40;
    const from = new THREE.Vector3(centre.x + Math.cos(a) * r, 3, centre.z + Math.sin(a) * r);
    // land in a scattered ring around (not on) the raft
    const ta = Math.random() * Math.PI * 2;
    const tr = 12 + Math.random() * 70;
    const to = new THREE.Vector3(centre.x + Math.cos(ta) * tr, 0, centre.z + Math.sin(ta) * tr);
    const vel = ballisticVelocity(from, to, 70 + Math.random() * 15);
    queuedShots.push({ delay: Math.random() * 3, pos: from, vel });
  }
}

// Mouse aim: where the ray from the camera through the cursor meets the sea.
// The ray is marched across the band of heights the waves can reach and the
// crossing is refined by bisection, so the point is the water you actually
// see under the cursor and does not hop between crests. A short smoothing
// filter takes out what little frame-to-frame noise is left.
const raycaster = new THREE.Raycaster();
const aimPoint = new THREE.Vector3();
const aimRaw = new THREE.Vector3();
const aimFlat = new THREE.Vector3();
/** Cursor on the flat mean sea level (steadier than `aimPoint`; used by the broadside). */
const aimLevel = new THREE.Vector3();
let aimStarted = false;
const AIM_MAX_RANGE = 260;
const AIM_BAND = 5; // waves stay within +/- this many metres
const AIM_SMOOTHING = 0.06; // seconds

function updateAimPoint(dt: number): void {
  raycaster.setFromCamera(new THREE.Vector2(input.pointer.x, input.pointer.y), camera);
  const { origin, direction } = raycaster.ray;
  const gap = (t: number) => origin.y + direction.y * t - waves.heightAt(origin.x + direction.x * t, origin.z + direction.z * t);
  let hit = -1;
  if (direction.y < -1e-3) {
    const t0 = Math.max(0, (AIM_BAND - origin.y) / direction.y);
    const t1 = Math.min((-AIM_BAND - origin.y) / direction.y, AIM_MAX_RANGE * 2);
    const steps = 48;
    let lo = t0;
    if (gap(t0) <= 0) hit = t0;
    for (let i = 1; i <= steps && hit < 0; i++) {
      let hi = t0 + ((t1 - t0) * i) / steps;
      if (gap(hi) > 0) {
        lo = hi;
        continue;
      }
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) > 0) lo = mid;
        else hi = mid;
      }
      hit = hi;
    }
  }
  if (hit >= 0) {
    raycaster.ray.at(hit, aimRaw);
  } else {
    // looking at/above the horizon: aim at max range along the view
    aimFlat.set(direction.x, 0, direction.z).normalize();
    aimRaw.copy(ship.body.position).addScaledVector(aimFlat, AIM_MAX_RANGE);
  }
  // keep the point within gun range of the raft
  aimFlat.subVectors(aimRaw, ship.body.position).setY(0);
  if (aimFlat.length() > AIM_MAX_RANGE) aimRaw.copy(ship.body.position).addScaledVector(aimFlat.normalize(), AIM_MAX_RANGE);

  if (!aimStarted) aimPoint.copy(aimRaw);
  else aimPoint.lerp(aimRaw, 1 - Math.exp(-dt / AIM_SMOOTHING));
  aimStarted = true;
  aimPoint.y = waves.heightAt(aimPoint.x, aimPoint.z);

  // The broadside takes only a general direction from the cursor: where the
  // ray meets the flat mean sea level, which no passing wave can move.
  if (direction.y < -1e-3) {
    raycaster.ray.at(Math.min(-origin.y / direction.y, AIM_MAX_RANGE * 3), aimLevel);
  } else {
    aimFlat.set(direction.x, 0, direction.z).normalize();
    aimLevel.copy(ship.body.position).addScaledVector(aimFlat, AIM_MAX_RANGE);
  }
  aimLevel.y = 0;
}

const _playerSight: ShipSight = { position: ship.body.position, velocity: ship.body.velocity, alive: true, faction: ME };
/** Every ship afloat this frame, as the territory rules and the AI see them. */
const sights: ShipSight[] = [];
const _sightPool: ShipSight[] = [];
const _colliders: Collider[] = [];
const _playerCollider: Collider = { id: RAFT_ID, position: ship.body.position, radius: 2 };
const muzzlePos = new THREE.Vector3();
const muzzleDir = new THREE.Vector3();
const shotVel = new THREE.Vector3();
const stern = new THREE.Vector3();
const starboard = new THREE.Vector3();

// --- Main loop ------------------------------------------------------------
const timer = new THREE.Timer();
timer.connect(document);
const fwd = new THREE.Vector3();

function frame(): void {
  timer.update();
  const rawDt = timer.getDelta();
  const dt = Math.min(rawDt, 0.1);

  const playing = mode === 'play';
  /** Playing with the flagship afloat: the helm, guns and crew answer. */
  const active = playing && sunkFor < 0;
  if (input.wasPressed('Escape')) {
    if (settings.visible) settings.close();
    else if (chart.visible) chart.close();
    else if (playing) openMenu();
    else if (mode === 'yard') leaveYard();
    else if (mode === 'menu' && voyageStarted) startPlay();
  }
  if (playing) {
    if (input.wasPressed('KeyG')) gui._hidden ? gui.show() : gui.hide();
    if (input.wasPressed('KeyH')) hud.toggleHelp();
    if (input.wasPressed('KeyV')) settings.toggleFireMode();
    if (input.wasPressed('Tab') || input.wasPressed('KeyM')) chart.visible ? chart.close() : chart.open();
    if (input.wasPressed('KeyO')) probeMarkers.visible = !probeMarkers.visible;
    if (input.wasPressed('KeyP')) settings.toggleMute();
    if (input.wasPressed('Slash')) hud.toggleHelp();
    if (input.wasPressed('KeyY')) openYard();
    if (input.wasPressed('KeyB')) fireBarrage(barrage.size);
  }

  wind.update(dt);
  if (active) {
    if (!followCourse(dt)) ship.control(dt, input.throttle, input.steer);
  } else if (!playing && mode !== 'over' && !voyageStarted) autopilot(dt);
  else ship.control(dt, ship.sail > 0.02 ? -1 : 0, 0); // nobody at the helm: the sail comes in
  sim.advance(dt, (h) => {
    waves.update(h);
    if (sunkFor < 0) ship.physicsStep(h);
    for (const w of ships) w.physicsStep(h);
  });
  ship.syncVisuals(dt);
  if (sunkFor >= 0) {
    // she settles and rolls over, then a new ship is ready at home
    if (mode === 'play' || mode === 'over') sunkFor += dt;
    ship.group.position.y -= sunkFor * (0.3 + sunkFor * 0.12);
    ship.group.rotateZ(Math.min(1.3, sunkFor * 0.2));
    ship.group.rotateX(Math.min(0.5, sunkFor * 0.07));
    if (sunkFor >= RESPAWN_TIME && mode === 'play') {
      berthFlagship();
      follow.update(0, ship.body.position);
      weatherUi.announce('Back at the helm', `A fresh ship at ${territory.home.island.name}`, 'good');
    }
  }

  // --- Gun ---
  if (active) {
    updateAimPoint(dt);
    gun.aimAt(aimPoint);
  }
  gun.update(dt);
  // Right mouse fires the swivel. Space fires the main guns: the broadside when
  // one is run out, otherwise the swivel.
  const batteryOut = broadside.visible && broadside.guns.length > 0;
  if (active && (input.fireSwivel || (input.fire && !batteryOut)) && gun.tryFire()) {
    gun.muzzle(muzzlePos, muzzleDir);
    shotVel.copy(muzzleDir).multiplyScalar(SWIVEL.muzzleSpeed);
    projectiles.spawn(muzzlePos, shotVel, SWIVEL.kind, RAFT_ID);
    effects.muzzle(muzzlePos, muzzleDir, ship.body.velocity, 0.8);
    audio.play('cannon', { volume: 0.55, rate: 1.4, rateJitter: 0.05, position: muzzlePos });
  }
  // --- Broadside ---
  if (active && input.wasPressed('KeyC')) broadside.setVisible(!broadside.visible);
  if (active && broadside.visible) {
    broadside.aimAt(aimLevel, dt);
    if (input.fire || input.wasPressed('KeyF') || input.wasPressed('KeyX')) broadside.tryFire();
  }
  broadsideShots.length = 0;
  broadside.update(dt, broadsideShots);
  for (const shot of broadsideShots) {
    shotVel.copy(shot.direction).multiplyScalar(BROADSIDE.muzzleSpeed);
    projectiles.spawn(shot.position, shotVel, BROADSIDE.kind, RAFT_ID);
    effects.muzzle(shot.position, shot.direction, ship.body.velocity, 1.5);
    audio.play('cannon', { volume: 0.9, rate: 1, rateJitter: 0.06, position: shot.position });
    // recoil shoves the raft the other way
    ship.body.velocity.addScaledVector(shot.direction, -0.25);
  }

  for (let i = queuedShots.length - 1; i >= 0; i--) {
    const q = queuedShots[i];
    q.delay -= dt;
    if (q.delay > 0) continue;
    projectiles.spawn(q.pos, q.vel, 1, -2);
    if (Math.random() < 0.15) audio.play('cannon', { volume: 0.9, rate: 0.85, rateJitter: 0.08, position: q.pos });
    queuedShots.splice(i, 1);
  }

  // warships: each fights the nearest ship of the other side
  _playerSight.alive = active;
  _playerSight.position = ship.body.position;
  _playerSight.velocity = ship.body.velocity;
  sights.length = 0;
  sights.push(_playerSight);
  ships.forEach((w, n) => {
    if (!w.alive) return;
    const sight = (_sightPool[n] ??= { position: w.position, velocity: w.ship.body.velocity, alive: true, faction: w.faction });
    sight.position = w.position;
    sight.velocity = w.ship.body.velocity;
    sight.faction = w.faction;
    sights.push(sight);
  });
  if (playing) for (const c of captains) c.update(dt);
  for (let i = ships.length - 1; i >= 0; i--) {
    const w = ships[i];
    if (w.lost) {
      scene.remove(w.group);
      ships.splice(i, 1);
      const at = fleet.indexOf(w);
      if (at >= 0) fleet.splice(at, 1);
      continue;
    }
    if (w.faction === ME) {
      w.escort = ship.body.position;
      // an escort shells any hostile stronghold it finds itself near
      const mark = territory.strongholds.find((s) => factions.hostile(ME, s.side) && !s.ruined && Math.hypot(s.site.x - w.position.x, s.site.z - w.position.z) < 150);
      w.raidTarget = mark ? mark.site : null;
    }
    // each fights the nearest ship of a hostile side
    let foe: THREE.Vector3 | null = null;
    let foeD = Infinity;
    for (const o of sights) {
      if (!o.alive || !factions.hostile(w.faction, o.faction)) continue;
      const d = Math.hypot(o.position.x - w.position.x, o.position.z - w.position.z);
      if (d < foeD) {
        foeD = d;
        foe = o.position;
      }
    }
    w.update(dt, foe, playing);
    if (w.alive) edgeCurrent(w.position, w.ship.body.velocity, dt);
  }
  ship.setCargo(hold.stock, CARGO_FULL);
  // the current at the rim turns every ship back
  const atEdge = edgeCurrent(ship.body.position, ship.body.velocity, dt);
  edgeWarning.hidden = !playing || atEdge < 0.15;
  worldEdge.update(dt);
  if (playing) updateFog(dt);
  if (chart.visible) {
    if (!playing) chart.close();
    else chart.draw(mapState());
  } else if (playing) miniMap.update(dt, mapState());
  if (active) updateGathering(dt);
  // territory
  buildIsland = active ? territory.islandInReach(ship.body.position) : null;
  if (active && buildIsland && input.wasPressed('KeyU')) tryBuild(buildIsland);
  if (playing) updateRaids(dt);
  territory.update(dt, sights, playing);
  territoryUi.update(territory, buildIsland, hold, fleet.length, active && atHomeDock());
  islandMarkers.update(dt, wind.angle);

  targets.update(dt, waves.currentTime);
  _colliders.length = 0;
  if (sunkFor < 0) {
    _playerCollider.position = ship.body.position;
    _playerCollider.radius = Math.max(1.7, ship.length * 0.36);
    _colliders.push(_playerCollider);
    if (ship instanceof DesignedShip) ship.rig.colliders(_colliders);
  }
  for (const w of ships) _colliders.push(...w.colliders());
  _colliders.push(...targets.colliders(), ...territory.colliders(), ...weather.colliders());
  projectiles.setColliders(_colliders);
  projectiles.update(dt);
  effects.update(dt);

  // --- Wake + wind FX ---
  stern.set(0, 0, ship.length / 2 + 0.1).applyQuaternion(ship.body.quaternion).add(ship.body.position);
  starboard.set(1, 0, 0).applyQuaternion(ship.body.quaternion).setY(0).normalize();
  wake.update(dt, stern, starboard, ship.body.forwardSpeed);

  ship.body.forward(fwd);
  follow.update(dt, ship.body.position);
  updateTargeting(playing);

  // weather + day-night: lights, fog, sky and sea colours, events
  weather.update(dt, shipState(), camera, playing);
  hull.update(dt);
  if (playing && fogMusic !== (weather.event?.kind === 'fog' && !weather.event.ending)) audio.setPlaylist(seaPlaylist());
  weatherUi.update(dt, weather, hull, playing);

  ocean.update(follow.focusPoint);
  sky.update(dt, camera.position);

  // Shadow camera follows the ship.
  sun.position.copy(ship.body.position).addScaledVector(sunDir, 40);
  sun.target.position.copy(ship.body.position);

  if (probeMarkers.visible) {
    probeMarkers.children.forEach((m, i) => {
      m.position.copy(ship.body.probeWorld[i]);
      (m as THREE.Mesh).material = ship.body.probeDepth[i] > 0 ? wetMat : dryMat;
    });
  }

  // Compass heading: 0 = north (-Z), clockwise positive.
  hud.update(rawDt, ship.body.forwardSpeed, ship.sail, Math.atan2(fwd.x, -fwd.z));
  hud.updateSailing(Math.atan2(wind.direction.x, -wind.direction.z), ship.windBoost, ship.sail);
  hud.updateCombat(gun.reloadProgress, broadside.visible ? broadside.reloadProgress : -1, targets.score, projectiles.stats.active, projectiles.stats.threaded, projectiles.stats.workerMs);

  streaks.update(dt, camera, follow.focusPoint);
  audio.updateListener(camera);
  audio.updateAmbience(wind.strength, ship.sail, Math.abs(ship.body.forwardSpeed));

  renderer.render(scene, camera);
  input.endFrame();
  requestAnimationFrame(frame);
}
applySettings();
openMenu();
follow.yaw = 2.3;
follow.pitch = 0.2;
requestAnimationFrame(frame);
