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
import { ProjectileSystem, ImpactEvent } from './combat/ProjectileSystem';
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
import { Warship, WarshipHooks, ENEMY_ID, FLEET_ID_BASE, FLEET_ID_END } from './world/Warship';
import { FogOfWar, Lookout } from './world/FogOfWar';
import { computeStats, FREE_CANNONS, METALS_PER_CANNON } from './ship/HullDesign';
import { TargetUi } from './ui/TargetUi';
import { Territory, STRONGHOLD, canAfford, pay, Side } from './world/Strongholds';
import { TerritoryUi } from './ui/TerritoryUi';
import { ballisticVelocity } from './combat/ballistics';
import { MapView, MiniMap, MapState, MapShip } from './ui/MapView';
import { WorldEdge } from './world/WorldEdge';
import { edgeCurrent, steerToward } from './world/navigation';
import { rollWorldSeed, worldSeed } from './world/worldConfig';
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
const world = createIslands(worldSeed());
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
  broadside = new Broadside(ship.group, ship.gunMounts, waves);
  broadside.fireMode = settings.settings.fireMode;
  // a designed ship shows the cannons it was built with; the raft's test battery stays off until C
  broadside.setVisible(ship instanceof DesignedShip && ship.gunMounts.length > 0);
  scene.add(broadside.ribbon);
  hold.capacity = ship.holdCapacity;
  follow.setDistance(Math.max(14, ship.length * 1.9));
  const reach = Math.max(12, ship.length);
  sc.left = sc.bottom = -reach;
  sc.right = sc.top = reach;
  sc.updateProjectionMatrix();
  rebuildProbeMarkers();
  ship.syncVisuals(0);
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
hull.onBattered = () => {
  ship.sail = 0;
  weatherUi.announce('Battered!', 'Your ship limps on with a patched hull', 'danger');
};
const shipState = (): ShipState => ({ position: ship.body.position, velocity: ship.body.velocity, length: ship.length });

// --- Gathering --------------------------------------------------------------
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
    if (w === enemy) endRaid();
    else weatherUi.announce(`${w.name} is lost`, 'One of your escorts has gone down', 'danger');
  },
};
const enemy = new Warship(waves, wind, world.islands, warshipHooks, { id: ENEMY_ID, name: 'Marauder', side: 'npc', colour: NPC_COLOUR, respawn: true });
/** The player's escorts: built at home, ordered about from the chart. */
const fleet: Warship[] = [];
let fleetBuilt = 0;
const FLEET_NAMES = ['Swift', 'Gannet', 'Petrel', 'Osprey', 'Heron', 'Kestrel', 'Curlew', 'Tern'];
scene.add(enemy.group);
const targetUi = new TargetUi(hudRoot);
/** The ship the player has marked (click it; click it again or press T to let go). */
let targeted: Warship | null = null;
const targetAt = new THREE.Vector3();
const screenPt = { x: 0, y: 0, onScreen: false, behind: false };

function updateTargeting(playing: boolean): void {
  targetAt.copy(enemy.position).setY(enemy.position.y + 2.5);
  if (playing && input.clicked && enemy.alive) {
    // a click near the ship on screen marks it: generous, so it works at range and in a swell
    TargetUi.project(targetAt, camera, screenPt);
    const px = (input.pointer.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-input.pointer.y * 0.5 + 0.5) * window.innerHeight;
    const dist = enemy.position.distanceTo(camera.position);
    const reach = THREE.MathUtils.clamp(1900 / Math.max(dist, 10), 30, 110);
    if (!screenPt.behind && Math.hypot(px - screenPt.x, py - screenPt.y) < reach) targeted = targeted ? null : enemy;
  }
  if (playing && input.wasPressed('KeyT')) targeted = targeted ? null : enemy.state !== 'gone' ? enemy : null;
  if (targeted && targeted.state === 'gone') targeted = null;
  if (!playing || !targeted) {
    targetUi.update(null, camera);
    return;
  }
  targetUi.update(
    {
      name: targeted.name,
      position: targetAt,
      health: targeted.hp / targeted.maxHp,
      distance: Math.hypot(targeted.position.x - ship.body.position.x, targeted.position.z - ship.body.position.z),
      note: targeted.state === 'sinking' ? 'Sinking!' : targeted.state === 'fight' ? 'Engaging you' : targeted.state === 'raid' ? 'Raiding your home' : 'On patrol',
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
    if (s.side === 'player') weatherUi.announce(s.home ? 'Your home is in ruins!' : `${s.island.name} is in ruins!`, 'Drive the raiders off before they take it', 'danger');
    else weatherUi.announce('Their walls are down!', 'Hold your ship close to take the island', 'good');
  },
  captured: (s, by) => {
    if (by === 'npc' && s.home) {
      if (mode !== 'over') endGame(false);
    } else if (by === 'player' && s === territory.enemyHome) {
      endGame(true);
    } else if (by === 'player') weatherUi.announce(`${s.island.name} is yours`, 'Your colours fly over it', 'good');
    else weatherUi.announce(`${s.island.name} is lost`, 'The raiders burned your outpost', 'danger');
  },
  changed: () => islandMarkers.refresh(),
});
scene.add(territory.group);
islandMarkers.refresh();
const territoryUi = new TerritoryUi(hudRoot, document.body, {
  retry: () => location.reload(),
  newMap: () => {
    rollWorldSeed();
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
  if (!territory.build(island, island === buildIsland ? hold : null)) return;
  audio.woodHit(ship.body.position);
  const s = territory.at(island)!;
  weatherUi.announce(s.levelName, s.home ? `Your home at ${island.name} grows stronger` : `${island.name} flies your colours`, 'good');
}
chart.islandActions = (island) => territoryUi.chartRows(territory, island, buildIsland, hold, fleet.length);
chart.onIslandAction = (island, act) => (act === 'ship' ? buildEscort() : tryBuild(island));

/** Lay down an escort at the home island, paid from the stores (and the hold, if the flagship is alongside). */
function buildEscort(): void {
  const home = territory.home;
  const alongside = buildIsland === home.island ? hold : null;
  if (home.side !== 'player' || fleet.length >= STRONGHOLD.fleetMax || !canAfford(STRONGHOLD.shipCost, territory.stores, alongside)) return;
  pay(STRONGHOLD.shipCost, territory.stores, alongside);
  const n = fleetBuilt++;
  const w = new Warship(waves, wind, world.islands, warshipHooks, {
    id: FLEET_ID_BASE + (n % (FLEET_ID_END - FLEET_ID_BASE)),
    name: FLEET_NAMES[n % FLEET_NAMES.length],
    side: 'player',
    colour: settings.settings.colour,
    respawn: false,
  });
  const c = home.island.center;
  const a = Math.atan2(home.site.z - c.z, home.site.x - c.x) + (n % 2 ? 0.5 : -0.5);
  const r = home.island.shoreAt(a) + 55;
  w.placeAt(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, a + Math.PI / 2);
  fleet.push(w);
  scene.add(w.group);
  audio.woodHit(w.position);
  weatherUi.announce(`${w.name} launched`, 'She follows your flagship. Give her orders on the chart (Tab).', 'good');
}

// --- Fog of war and the charts that show it ----------------------------------------
const fog = new FogOfWar();
const lookouts: Lookout[] = [];
function updateFog(dt: number): void {
  lookouts.length = 0;
  lookouts.push({ x: ship.body.position.x, z: ship.body.position.z, range: 210 });
  for (const w of fleet) if (w.alive) lookouts.push({ x: w.position.x, z: w.position.z, range: 170 });
  for (const s of territory.strongholds) if (s.side === 'player') lookouts.push({ x: s.site.x, z: s.site.z, range: 150 + s.level * 25 });
  fog.update(dt, lookouts, world.islands);
}
const _hd = new THREE.Vector3();
function mapState(): MapState {
  const colour = settings.settings.colour;
  const ships: MapShip[] = [
    { id: 0, position: ship.body.position, heading: compass(ship.body.forward(_hd)), colour, name: ship.displayName, hostile: false, health: hull.fraction, course, note: course ? 'Under orders' : 'At your command' },
  ];
  for (const w of fleet) {
    if (!w.alive) continue;
    const note = w.state === 'fight' ? 'Engaging the enemy' : w.state === 'raid' ? 'Shelling a stronghold' : w.order ? 'Under orders' : 'Following the flagship';
    ships.push({ id: w.id, position: w.position, heading: compass(w.ship.body.forward(_hd)), colour, name: w.name, hostile: false, health: w.hp / w.maxHp, course: w.order, note });
  }
  if (enemy.alive) ships.push({ id: enemy.id, position: enemy.position, heading: compass(enemy.ship.body.forward(_hd)), colour: NPC_COLOUR, name: enemy.name, hostile: true, health: enemy.hp / enemy.maxHp, course: null, note: '' });
  return { islands: world.islands, ships, playerColour: colour, npcColour: NPC_COLOUR, strongholds: territory.strongholds, fog };
}
const miniMap = new MiniMap(hudRoot, () => {
  if (mode === 'play') chart.open();
});

/** Which side fired a shot, from its owner id. */
function sideOfOwner(owner: number): Side | null {
  if (owner === RAFT_ID || (owner >= FLEET_ID_BASE && owner < FLEET_ID_END)) return 'player';
  if (owner === ENEMY_ID) return 'npc';
  return territory.sideOf(owner);
}
const nearestTo = (at: THREE.Vector3, list: { position: THREE.Vector3; alive: boolean }[]): THREE.Vector3 | null => {
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const o of list) {
    if (!o.alive) continue;
    const d = Math.hypot(o.position.x - at.x, o.position.z - at.z);
    if (d < bestD) {
      bestD = d;
      best = o.position;
    }
  }
  return best;
};

/** Raids: every so often the Marauder sails for the player's home and shells it. */
const RAID = { first: 240, every: 200 };
let raidIn = RAID.first;
function endRaid(): void {
  enemy.raidTarget = null;
  raidIn = RAID.every;
}
function updateRaids(dt: number): void {
  if (enemy.raidTarget) {
    // called off once the home has been rebuilt behind them, or lost
    if (territory.home.side !== 'player') endRaid();
    return;
  }
  raidIn -= dt;
  if (raidIn > 0 || !enemy.alive) return;
  enemy.raidTarget = territory.home.site;
  weatherUi.announce('Raiders!', `The Marauder is making for your home at ${territory.home.island.name}`, 'danger');
}

function endGame(won: boolean): void {
  mode = 'over';
  enemy.raidTarget = null;
  raidIn = RAID.every;
  chart.close();
  settings.showGear(false);
  hudRoot.classList.add('in-menu');
  gun.preview.visible = false;
  broadside.ribbon.visible = false;
  marker.visible = false;
  if (won) territoryUi.showVictory(territory.enemyHome!);
  else territoryUi.showDefeat(territory.home);
}

/** Push the player's settings (colour, fire mode) into the game. */
function applySettings(): void {
  const s = settings.settings;
  ship.setColour(s.colour);
  broadside.fireMode = s.fireMode;
  islandMarkers.setPlayerColour(s.colour);
  territory.setPlayerColour(s.colour);
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
  gatherUi.update(gathering);

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
  shipyard: () => {
    mode = 'yard';
    settings.showGear(false);
    menu.hide();
    yard.open();
  },
  settings: () => settings.open(),
  newMap: () => {
    rollWorldSeed();
    location.reload();
  },
});

/** Extra cannons (beyond the free ones) the player has already paid for. */
let cannonsPaid = 0;
const yard = new Shipyard(document.body, {
  launch: (design) => {
    // cannons beyond the first few are paid for in metals, once each
    const extra = Math.max(0, computeStats(design).guns - FREE_CANNONS);
    const due = { wood: 0, stone: 0, salvage: Math.max(0, extra - cannonsPaid) * METALS_PER_CANNON };
    if (!canAfford(due, territory.stores, hold)) {
      yard.warn(`The extra cannons need ${due.salvage} metals and you have ${territory.stores.salvage + hold.stock.salvage}. Gather more, or take some guns off.`);
      return;
    }
    pay(due, territory.stores, hold);
    cannonsPaid = Math.max(cannonsPaid, extra);
    setShip(new DesignedShip(design, waves, wind, settings.settings.colour));
    yard.close();
    startPlay();
  },
  useRaft: () => {
    if (!(ship instanceof Raft)) setShip(new Raft(waves, wind));
    yard.close();
    startPlay();
  },
  back: () => {
    yard.close();
    openMenu();
  },
  stock: () => ({ wood: hold.stock.wood + territory.stores.wood, stone: hold.stock.stone + territory.stores.stone, salvage: hold.stock.salvage + territory.stores.salvage }),
  cannonsPaid: () => cannonsPaid,
});

/** In the menu the scene is shifted right, clear of the options column. */
function applyViewOffset(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (mode === 'menu') camera.setViewOffset(w, h, -w * 0.15, 0, w, h);
  else camera.clearViewOffset();
}

function startPlay(): void {
  mode = 'play';
  audio.setPlaylist(['calm', 'log']);
  if (!voyageStarted) ship.sail = 0;
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
  menu.show(voyageStarted);
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
    enemy,
    territory,
    fleet,
    fog,
    buildEscort,
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
  if (e.colliderId >= FLEET_ID_BASE && e.colliderId < FLEET_ID_END) {
    effects.splinters(e.position, e.kind === 1 ? 14 : 7);
    audio.woodHit(e.position);
    if (by !== 'player') fleet.find((w) => w.id === e.colliderId)?.hit(e.kind);
    return;
  }
  if (e.colliderId === ENEMY_ID) {
    effects.splinters(e.position, e.kind === 1 ? 14 : 7);
    audio.woodHit(e.position);
    if (by !== 'npc' && enemy.hit(e.kind) && e.owner === RAFT_ID) targets.score += 10;
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
    if (by !== 'player') hull.damage(e.kind === 1 ? 9 : 3); // weather: enemy fire
  }
};

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

const _playerSight = { position: ship.body.position, velocity: ship.body.velocity, alive: true };
const _enemySight = { position: enemy.position, velocity: enemy.ship.body.velocity, alive: true };
const friends = [_playerSight];
const raiders = [_enemySight];
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
  if (input.wasPressed('Escape')) {
    if (settings.visible) settings.close();
    else if (chart.visible) chart.close();
    else if (playing) openMenu();
    else if (mode === 'yard') {
      yard.close();
      openMenu();
    } else if (mode === 'menu' && voyageStarted) startPlay();
  }
  if (playing) {
    if (input.wasPressed('KeyG')) gui._hidden ? gui.show() : gui.hide();
    if (input.wasPressed('KeyH')) hud.toggleHelp();
    if (input.wasPressed('KeyV')) settings.toggleFireMode();
    if (input.wasPressed('Tab')) chart.visible ? chart.close() : chart.open();
    if (input.wasPressed('KeyP')) probeMarkers.visible = !probeMarkers.visible;
    if (input.wasPressed('KeyM')) settings.toggleMute();
    if (input.wasPressed('KeyB')) fireBarrage(barrage.size);
  }

  wind.update(dt);
  if (playing) {
    if (!followCourse(dt)) ship.control(dt, input.throttle, input.steer);
  }
  else autopilot(dt);
  sim.advance(dt, (h) => {
    waves.update(h);
    ship.physicsStep(h);
    enemy.physicsStep(h);
    for (const w of fleet) w.physicsStep(h);
  });
  ship.syncVisuals(dt);

  // --- Gun ---
  if (playing) {
    updateAimPoint(dt);
    gun.aimAt(aimPoint);
  }
  gun.update(dt);
  // Right mouse fires the swivel. Space fires the main guns: the broadside when
  // one is run out, otherwise the swivel.
  const batteryOut = broadside.visible && broadside.guns.length > 0;
  if (playing && (input.fireSwivel || (input.fire && !batteryOut)) && gun.tryFire()) {
    gun.muzzle(muzzlePos, muzzleDir);
    shotVel.copy(muzzleDir).multiplyScalar(SWIVEL.muzzleSpeed);
    projectiles.spawn(muzzlePos, shotVel, SWIVEL.kind, RAFT_ID);
    effects.muzzle(muzzlePos, muzzleDir, ship.body.velocity, 0.8);
    audio.play('cannon', { volume: 0.55, rate: 1.4, rateJitter: 0.05, position: muzzlePos });
  }
  // --- Broadside ---
  if (playing && input.wasPressed('KeyC')) broadside.setVisible(!broadside.visible);
  if (playing && broadside.visible) {
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
  _playerSight.alive = playing;
  _playerSight.position = ship.body.position;
  _playerSight.velocity = ship.body.velocity;
  _enemySight.alive = enemy.alive;
  friends.length = 1;
  for (const w of fleet) if (w.alive) friends.push({ position: w.position, velocity: w.ship.body.velocity, alive: true });
  enemy.update(dt, nearestTo(enemy.position, friends), playing);
  for (let i = fleet.length - 1; i >= 0; i--) {
    const w = fleet[i];
    if (w.state === 'gone') {
      scene.remove(w.group);
      fleet.splice(i, 1);
      continue;
    }
    w.escort = ship.body.position;
    // an escort shells any raider stronghold it finds itself near
    const mark = territory.strongholds.find((s) => s.side === 'npc' && !s.ruined && Math.hypot(s.site.x - w.position.x, s.site.z - w.position.z) < 150);
    w.raidTarget = mark ? mark.site : null;
    w.update(dt, enemy.alive ? enemy.position : null, playing);
    if (w.alive) edgeCurrent(w.position, w.ship.body.velocity, dt);
  }
  ship.setCargo(hold.stock, hold.capacity);
  // the current at the rim turns every ship back
  const atEdge = edgeCurrent(ship.body.position, ship.body.velocity, dt);
  if (enemy.alive) edgeCurrent(enemy.position, enemy.ship.body.velocity, dt);
  edgeWarning.hidden = !playing || atEdge < 0.15;
  worldEdge.update(dt);
  if (playing) updateFog(dt);
  if (chart.visible) {
    if (!playing) chart.close();
    else chart.draw(mapState());
  } else if (playing) miniMap.update(dt, mapState());
  if (playing) updateGathering(dt);
  // territory
  buildIsland = playing ? territory.islandInReach(ship.body.position) : null;
  if (playing && buildIsland && input.wasPressed('KeyU')) tryBuild(buildIsland);
  if (playing) updateRaids(dt);
  territory.update(dt, friends, raiders, playing);
  territoryUi.update(territory, buildIsland, hold, fleet.length);
  islandMarkers.update(dt, wind.angle);

  targets.update(dt, waves.currentTime);
  projectiles.setColliders([{ id: RAFT_ID, position: ship.body.position, radius: Math.max(1.7, ship.length * 0.36) }, ...targets.colliders(), ...enemy.colliders(), ...territory.colliders(), ...weather.colliders()]);
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
