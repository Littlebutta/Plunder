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
import { ECONOMY, emptyStock, Hold, ResourceId, Stock } from './world/Resources';
import { GatherUi } from './ui/GatherUi';
import { IslandMarkers } from './world/IslandMarkers';
import { Warship, WarshipHooks, warshipId, HUMAN_ID_BASE, WARSHIP_ID_BASE, WARSHIP_ID_END } from './world/Warship';
import { MatchLink } from './net/Session';
import { Factions, ME } from './world/Factions';
import { loadMatch, saveMatch, START_STOCK } from './world/Match';
import { AiCaptain } from './world/AiCaptain';
import { Lobby } from './ui/Lobby';
import { FogOfWar, Lookout } from './world/FogOfWar';
import { computeStats, escortCost, FREE_CANNONS, HullDesign, loadDesign, METALS_PER_CANNON, PRESETS, sanitizeDesign, randomDesign } from './ship/HullDesign';
import { MAST, mastOwner } from './ship/Masts';
import { TargetUi } from './ui/TargetUi';
import { Territory, canAfford, costLabel, pay, ShipSight, Side } from './world/Strongholds';
import { TerritoryUi } from './ui/TerritoryUi';
import { ballisticVelocity } from './combat/ballistics';
import { MapView, MiniMap, MapState, MapShip } from './ui/MapView';
import { WorldEdge } from './world/WorldEdge';
import { edgeCurrent, steerToward } from './world/navigation';
import { ground, KnockTimer } from './world/Grounding';
import { FlotsamField, FLOTSAM, wreckValue } from './world/Flotsam';
const knocks = new KnockTimer();
import { rollWorldSeed } from './world/worldConfig';
import { NPC_COLOUR } from './ui/Settings';
import { Chat } from './ui/Chat';
import { captainById, pickLine, Captain } from './world/Captains';
import { UpgradeSet, upgradeById, UPGRADES, Upgrade } from './world/Upgrades';
import { WORLD_RADIUS } from './world/worldConfig';
import { TradeRoutes, TRADE, MERCHANT } from './world/Trade';
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
/**
 * Online: the link to the other copies of the match. The host's copy runs the
 * world (AI captains, escorts, strongholds); every copy sails its own flagship
 * and decides what hits her. See the "Online play" section further down.
 */
const link = vs && match.net ? new MatchLink(match) : null;
const online = !!link;
/** This copy decides what the AI, the escorts and the strongholds do: always, unless it is a guest in an online match. */
const authority = !link || link.host;
/** The player's colour: in an online match, the one their seat in the lobby flies. */
const myColour = (): string => (online ? captainSlots[ME].colour : settings.settings.colour);
/** Shots fired by this copy this frame, for the others: eight numbers each. */
const outShots: number[] = [];
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
function tellShot(owner: number, kind: number, from: THREE.Vector3, vel: THREE.Vector3): void {
  if (link) outShots.push(owner === RAFT_ID ? HUMAN_ID_BASE + ME : owner, kind, r2(from.x), r2(from.y), r2(from.z), r2(vel.x), r2(vel.y), r2(vel.z));
}
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
const flotsam = new FlotsamField(waves);
scene.add(flotsam.group);
scene.add(effects.group);
const wake = new Wake(waves);
scene.add(wake.mesh);
const streaks = new WindStreaks(wind);
scene.add(streaks.mesh);

const audio = new AudioManager();
const settings = new SettingsPanel(document.body, audio);
settings.onClose = () => canvas.focus();
settings.onChange = () => applySettings();
ship.setColour(myColour());
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
  ship.setColour(myColour());
  fitFlagship();
  broadside = new Broadside(ship.group, ship.gunMounts, waves);
  broadside.fireMode = settings.settings.fireMode;
  // a designed ship shows the cannons it was built with; the raft's test battery stays off until C
  broadside.setVisible(ship instanceof DesignedShip && ship.gunMounts.length > 0);
  scene.add(broadside.ribbon);
  tellDesign();
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
  islands: world.islands,
  blast: (at, radius, damage) => {
    effects.splinters(at, 10);
    audio.play('cannon', { volume: 1, rate: 0.55, rateJitter: 0.1, position: at });
    if (sunkFor < 0 && Math.hypot(ship.body.position.x - at.x, ship.body.position.z - at.z) < radius + ship.length * 0.3) {
      hull.damage(damage);
      effects.splinters(ship.body.position, 18);
      ship.body.velocity.add(_shove.set(ship.body.position.x - at.x, 0, ship.body.position.z - at.z).setLength(2.5));
    }
    if (!authority) return;
    for (const w of ships) {
      if (!w.alive || w.remote || Math.hypot(w.position.x - at.x, w.position.z - at.z) > radius + w.collider.radius) continue;
      w.ship.crewHit(at, 1);
      w.scrape(damage);
    }
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
    tellShot(w.id, BROADSIDE.kind, from, shotVel);
    effects.muzzle(from, dir, w.ship.body.velocity, 1.5);
    audio.play('cannon', { volume: 0.9, rate: 0.95, rateJitter: 0.06, position: from });
  },
  pay: (w, id, n) => charge(w.faction, id, n),
  sunk: (w) => {
    effects.splinters(w.position, 40);
    effects.splash(w.position, 2.2);
    audio.woodHit(w.position);
    audio.splash(w.position, 1.6);
    leaveWreckage(w.position, w.maxHp);
    if (w === marauder) endRaid();
    else if (w.faction === ME) weatherUi.announce(`${w.name} is lost`, 'One of your escorts has gone down', 'danger');
    else if (w.flagship && fog.canSee(w.position.x, w.position.z)) weatherUi.announce(`${w.name} is sunk`, `${factions.name(w.faction)} will be back with a new ship`, factions.hostile(ME, w.faction) ? 'good' : 'danger');
  },
};

/**
 * Add resources to a faction's stores (salvage, bounties). Online, a guest's
 * stores live on their own copy, so the host sends them the takings ('k').
 */
function credit(faction: number, stock: Stock, kind: 'salvage' | 'trade' = 'salvage'): void {
  const f = factions.get(faction);
  if (!f || f.kind === 'raiders' || f.kind === 'ghosts') return;
  if (link?.host && f.kind === 'human' && faction !== ME) {
    link.send(['k', stock.wood, stock.stone, stock.salvage, kind], true, faction);
    return;
  }
  const k = faction === ME ? upgrades.mods[kind] : 1;
  f.stores.wood += Math.round(stock.wood * k);
  f.stores.stone += Math.round(stock.stone * k);
  f.stores.salvage += Math.round(stock.salvage * k);
}
const stockLabel = (k: Stock) => [k.wood && `${k.wood} wood`, k.stone && `${k.stone} stone`, k.salvage && `${k.salvage} metals`].filter(Boolean).join(', ');

/** A ship went down here: leave her wreckage for whoever gets to it first (the host decides, and tells the guests). */
function leaveWreckage(at: THREE.Vector3, maxHp: number): void {
  if (!authority) return;
  const item = flotsam.spawn(at, wreckValue(maxHp));
  link?.send(['f', item.id, r1(at.x), r1(at.z), item.stock.wood, item.stock.stone, item.stock.salvage]);
}

/**
 * Take resources from a faction's stores (shot, repairs). The raiders pay for
 * nothing. Online, a guest's stores live on their own copy: the host works
 * from the figures they last sent and sends the bill ('c').
 */
const owed = new Map<number, Stock>();
function charge(faction: number, id: ResourceId, n: number): boolean {
  if (n <= 0) return true;
  const f = factions.get(faction);
  if (!f || f.kind === 'raiders' || f.kind === 'ghosts') return true;
  if (f.stores[id] < n) return false;
  f.stores[id] -= n;
  if (link?.host && f.kind === 'human' && faction !== ME) {
    const bill = owed.get(faction) ?? emptyStock();
    bill[id] += n;
    owed.set(faction, bill);
  }
  return true;
}

// --- Sides ---------------------------------------------------------------------------
const factions = new Factions();
if (vs) {
  captainSlots.forEach((slot, n) => {
    const f = factions.add(n === ME ? 'You' : slot.name, n === ME ? myColour() : slot.colour, slot.team, slot.kind === 'human' ? 'human' : 'ai', n === ME ? hold.stock : undefined);
    Object.assign(f.stores, START_STOCK[match.stock]);
  });
  if (match.forts) factions.add('Raiders', NPC_COLOUR, 99, 'raiders');
} else {
  hold.stock.salvage = 30; // shot for the first fights
  factions.add('You', myColour(), 0, 'human', hold.stock);
  factions.add('Raiders', NPC_COLOUR, 99, 'raiders');
}
// ghost ships belong to nobody and fight everybody (added last, so the id is the same on every copy)
const GHOSTS = factions.add('Ghosts', '#bfffe6', 98, 'ghosts').id;
const RAIDERS = factions.list.find((f) => f.kind === 'raiders')?.id ?? -1;

/** Every ship that sails itself: the raiders' Marauder, AI captains' flagships, and everyone's escorts. */
const ships: Warship[] = [];
/** Whose each warship is, by collider id (kept after she sinks, for shots still in the air). */
const shipFaction = new Map<number, number>();
function addShip(w: Warship): Warship {
  if (w.faction === GHOSTS) w.haunt();
  ships.push(w);
  shipFaction.set(w.id, w.faction);
  scene.add(w.group);
  return w;
}
/** Classic voyage: the raiders' ship, which patrols the middle of the map and raids the player's home. */
const marauder = vs ? null : addShip(new Warship(waves, wind, world.islands, warshipHooks, { id: warshipId(), name: 'Marauder', faction: RAIDERS, colour: NPC_COLOUR, respawn: true, design: randomDesign(Math.random, 0.45) }));
/** The player's escorts: built at home, ordered about from the chart. */
const fleet: Warship[] = [];
const fleetBuilt = new Map<number, number>();
const FLEET_NAMES = ['Swift', 'Gannet', 'Petrel', 'Osprey', 'Heron', 'Kestrel', 'Curlew', 'Tern', 'Fulmar', 'Shrike', 'Dunlin', 'Merlin', 'Plover', 'Skua', 'Avocet', 'Harrier'];
/** A name for the nth ship a captain builds; past the end of the list they take a number. */
const fleetName = (n: number) => FLEET_NAMES[n % FLEET_NAMES.length] + (n >= FLEET_NAMES.length ? ` ${1 + Math.floor(n / FLEET_NAMES.length)}` : '');
const escortsOf = (faction: number) => ships.filter((w) => w.faction === faction && !w.flagship && w.state !== 'gone');
const hostileShips = () => ships.filter((w) => w.alive && w.reveal > 0.3 && factions.hostile(ME, w.faction));
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
  if (targeted && (targeted.state === 'gone' || targeted.reveal <= 0)) targeted = null;
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
/** Chained orders for the flagship: where to sail after `course`. */
let courseQueue: THREE.Vector3[] = [];
type OrderKind = 0 | 1 | 2; // follow the flagship, move, patrol a zone
/** Give one of a captain's ships a chart order (on the host this is also how a guest's orders land). */
function applyOrder(w: Warship, kind: OrderKind, x = 0, z = 0, r = 0, append = false, attack = false): void {
  if (kind === 1) {
    const to = new THREE.Vector3(x, 0, z);
    if (append && w.order) w.queue.push(to);
    else {
      w.order = to;
      w.queue = [];
    }
    w.attackMove = attack;
    w.patrol = null;
  } else {
    w.order = null;
    w.queue = [];
    w.patrol = kind === 2 ? { x, z, r: Math.min(Math.max(r, 40), 400) } : null;
  }
}
function orderShips(ids: number[], kind: OrderKind, x = 0, z = 0, r = 0, append = false, attack = false): void {
  const mine = ids.map((id) => fleet.find((f) => f.id === id)).filter((w): w is Warship => !!w);
  // several ships sent to one spot take station around it rather than piling up on it
  const spread = kind === 1 && mine.length + (ids.includes(0) ? 1 : 0) > 1 ? 26 + mine.length * 4 : 0;
  mine.forEach((w, i) => {
    const a = (i / mine.length) * Math.PI * 2;
    const tx = x + Math.cos(a) * spread;
    const tz = z + Math.sin(a) * spread;
    applyOrder(w, kind, tx, tz, r, append, attack);
    if (!authority) link!.toHost(['o', w.id, kind, r1(tx), r1(tz), r1(r), append ? 1 : 0, attack ? 1 : 0]);
  });
}
const chart = new MapView(document.body, {
  order: (ids, x, z, append, attack) => {
    if (ids.includes(0)) {
      const to = new THREE.Vector3(x, 0, z);
      if (append && course) courseQueue.push(to);
      else {
        course = to;
        courseQueue = [];
      }
    }
    orderShips(ids, 1, x, z, 0, append, attack);
  },
  patrol: (ids, x, z, r) => orderShips(ids, 2, x, z, r),
  follow: (ids) => orderShips(ids, 0),
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
    courseQueue = [];
    return false;
  }
  const p = ship.body.position;
  const left = Math.hypot(course.x - p.x, course.z - p.z);
  if (left < Math.max(18, ship.length * 1.5)) {
    course = courseQueue.shift() ?? null;
    if (!course) return false;
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
    tellShot(owner, BROADSIDE.kind, from, vel);
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
      if (factions.get(from)?.kind === 'ai') say(from, pickLine(captainOf(from).lines.lost));
    }
    if (from === ME && wasHome) {
      if (online) sinkPlayer(); // out of the match: her flag comes down for everyone
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
  pay: (side, id, n) => charge(side, id, n),
}, factions, { mode: match.mode, forts: match.forts });
territory.remote = !authority;
islandMarkers.colourOf = (f) => factions.colour(f);
scene.add(territory.group);
islandMarkers.refresh();
const territoryUi = new TerritoryUi(hudRoot, document.body, {
  retry: () => {
    if (online) return leaveMatch();
    if (vs) saveMatch({ ...match, autostart: true });
    location.reload();
  },
  newMap: () => {
    if (online) return leaveMatch();
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
let buildWait = 0;
function tryBuild(island: Island): void {
  if (!authority) {
    // a guest pays here and asks the host, who holds the islands, to do the building
    const offer = territory.offer(island);
    if (!offer || buildWait > 0 || (offer.act === 'build' && island !== buildIsland) || !canAfford(offer.cost, hold.stock, null)) return;
    pay(offer.cost, hold.stock, null);
    buildWait = 1.5;
    link!.toHost(['b', world.islands.indexOf(island)]);
    audio.woodHit(ship.body.position);
    weatherUi.announce(offer.act === 'build' ? 'Outpost founded' : offer.label.replace('Upgrade to', 'Building a'), `Work begins at ${island.name}`, 'good');
    return;
  }
  if (!territory.build(island, island === buildIsland)) return;
  audio.woodHit(ship.body.position);
  const s = territory.at(island)!;
  weatherUi.announce(s.levelName, s.home ? `Your home at ${island.name} grows stronger` : `${island.name} flies your colours`, 'good');
}
chart.islandActions = (island) => territoryUi.chartRows(territory, island, buildIsland, hold, fleet.length, escortDesigns(), { price: upgrades.price(), summary: upgrades.summary(), count: upgrades.count, traders: tradersOf(ME), traderCost: TRADE.cost });
chart.onIslandAction = (island, act) => {
  if (act === 'yard') return openYard(true);
  if (act === 'upgrade') return buyUpgrade();
  if (act === 'trader') {
    const why = buildTrader(ME);
    if (why) weatherUi.announce('Cannot build her yet', why, 'danger');
    return;
  }
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
function buildEscort(design: HullDesign = PRESETS[1], faction = ME, free = false): string {
  const owner = factions.get(faction)!;
  const cost = escortCost(design);
  const n = fleetBuilt.get(faction) ?? 0;
  const berth = homeBerth(1 + (n % 8), faction);
  if (!berth) return 'Your home island is lost.';
  if (!free && !canAfford(cost, owner.stores, null)) return `An escort ${design.name} needs ${costLabel(cost)}.`;
  if (!free) pay(cost, owner.stores, null);
  if (!authority) {
    // a guest pays here; the host builds her and she turns up with the next news from them
    link!.toHost(['e', design]);
    weatherUi.announce('Escort ordered', `A ${design.name} is fitting out at home. Give her orders on the chart (M).`, 'good');
    return '';
  }
  fleetBuilt.set(faction, n + 1);
  const w = addShip(
    new Warship(waves, wind, world.islands, warshipHooks, {
      id: warshipId(),
      name: fleetName(n + faction * 3),
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
  if (f.kind !== 'ai' || !authority) continue;
  const flagship = addShip(
    new Warship(waves, wind, world.islands, warshipHooks, {
      id: warshipId(),
      name: f.name,
      faction: f.id,
      colour: f.colour,
      respawn: true,
      berth: () => homeBerth(0, f.id),
      flagship: true,
      design: randomDesign(Math.random, match.ai === 'hard' ? 0.75 : match.ai === 'easy' ? 0.25 : 0.45),
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
        launchEscort: (id) => buildEscort(randomDesign(Math.random, match.ai === 'hard' ? 0.4 : 0.2), id) === '',
        threatNear: (id, at, range) =>
          (factions.hostile(id, ME) && sunkFor < 0 && mode === 'play' && ship.body.position.distanceTo(at) < range) ||
          ships.some((w) => w.alive && factions.hostile(id, w.faction) && w.position.distanceTo(at) < range),
      },
      match.ai,
    ),
  );
  captains[captains.length - 1].onAttack = (target) => {
    // a taunt when they come for something of yours (now and then, not every time)
    if (target.side === ME && Math.random() < 0.7) say(f.id, pickLine(captainOf(f.id).lines.attack));
  };
}

// --- Online play ----------------------------------------------------------------------
// Every copy of an online match builds the same world from the same seed and
// the same lobby. After that:
//   * each player's copy sails their own flagship, and tells the rest where she
//     is a dozen times a second ('p'); the others show her as a remote Warship
//   * the host's copy sails everything else and holds the islands, and sends
//     the lot eight times a second ('w'), with the list of ships when it changes ('r')
//   * every shot is announced ('s') and flown on every copy; only the copy that
//     owns what it hits counts the damage
//   * guests pay for outposts and escorts from their own stores and ask the
//     host to build them ('b', 'e'), and pass on chart orders ('o')
/** The other players' flagships, by faction. */
const humanShips = new Map<number, Warship>();
function setHumanShip(f: number, design: HullDesign): void {
  const owner = factions.get(f);
  if (!owner) return;
  const old = humanShips.get(f);
  const w = new Warship(waves, wind, world.islands, warshipHooks, { id: HUMAN_ID_BASE + f, name: design.name || 'Flagship', faction: f, colour: owner.colour, respawn: false, flagship: true, design, remote: true });
  if (old) {
    const fw = old.ship.body.forward(new THREE.Vector3());
    w.placeAt(old.position.x, old.position.z, Math.atan2(-fw.x, -fw.z));
    scene.remove(old.group);
    ships.splice(ships.indexOf(old), 1);
    if (targeted === old) targeted = null;
  } else {
    const berth = homeBerth(0, f);
    if (berth) w.placeAt(berth.x, berth.z, berth.heading);
  }
  humanShips.set(f, addShip(w));
}
/** Tell the others what ship this player sails (at the start, and after a refit). */
function tellDesign(to: number | null = null): void {
  link?.send(['d', ship instanceof DesignedShip ? ship.design : PRESETS[0]], true, to);
}
function leaveMatch(): void {
  link?.leave();
  saveMatch(null);
  location.reload();
}
const netEl = document.createElement('div');
netEl.className = 'hud-net';
netEl.hidden = true;
hudRoot.append(netEl);
/** The host's list of the ships it sails: [id, faction, name, flagship, design] each. */
type Roster = [number, number, string, number, HullDesign][];
const roster = (): Roster => ships.filter((w) => !w.remote).map((w) => [w.id, w.faction, w.name, w.flagship ? 1 : 0, w.ship.design]);
let rosterKey = '';
let gotRoster = false;
let askIn = 0;
let sinceWorld = 0;
let hostGone = false;
let tellIn = 0;
let worldIn = 0;
function applyRoster(list: Roster): void {
  gotRoster = true;
  const ids = new Set(list.map((r) => r[0]));
  for (let i = ships.length - 1; i >= 0; i--) {
    const w = ships[i];
    if (w.id >= HUMAN_ID_BASE || ids.has(w.id)) continue;
    scene.remove(w.group);
    ships.splice(i, 1);
    if (fleet.includes(w)) fleet.splice(fleet.indexOf(w), 1);
    if (targeted === w) targeted = null;
  }
  for (const [id, faction, name, flag, design] of list) {
    if (ships.some((w) => w.id === id)) continue;
    const w = addShip(new Warship(waves, wind, world.islands, warshipHooks, { id, name: String(name), faction, colour: factions.colour(faction), respawn: false, flagship: !!flag, design: sanitizeDesign(design), remote: true }));
    if (faction === ME && !flag) fleet.push(w);
  }
}
if (link) {
  weather.auto = false; // no storms or sea monsters online yet: they are not shared between copies
  for (const f of factions.list) if (f.kind === 'human' && f.id !== ME) setHumanShip(f.id, PRESETS[1]);
  const on = link.handlers;
  on.set('p', (from, m) => {
    const w = humanShips.get(from);
    if (w) w.applyNet([w.id, ...(m.slice(1, 11) as number[])]);
    // the host keeps a copy of each guest's stores, to know what their forts and escorts can afford
    const stores = factions.get(from)?.stores;
    if (link.host && stores && m.length >= 14) Object.assign(stores, { wood: Number(m[11]), stone: Number(m[12]), salvage: Number(m[13]) });
  });
  on.set('d', (from, m) => {
    if (from !== ME) setHumanShip(from, sanitizeDesign(m[1] as HullDesign));
  });
  on.set('s', (_from, m) => {
    const a = m as number[];
    for (let i = 1; i + 7 < a.length; i += 8) {
      const kind = a[i + 1] === 1 ? 1 : 0;
      muzzlePos.set(a[i + 2], a[i + 3], a[i + 4]);
      shotVel.set(a[i + 5], a[i + 6], a[i + 7]);
      projectiles.spawn(muzzlePos, shotVel, kind, a[i]);
      effects.muzzle(muzzlePos, muzzleDir.copy(shotVel).normalize(), _zero, kind ? 1.5 : 0.8);
      audio.play('cannon', { volume: kind ? 0.9 : 0.55, rate: kind ? 1 : 1.4, rateJitter: 0.06, position: muzzlePos });
    }
  });
  on.set('chat', (from, m) => {
    const text = String(m[1] ?? '').slice(0, 120).trim();
    if (text) say(from, text);
  });
  on.set('ready', (from) => {
    tellDesign(from);
    if (link.host) link.send(['r', roster()], true, from);
  });
  if (link.host) {
    on.set('b', (from, m) => {
      const island = world.islands[Number(m[1])];
      if (island) territory.build(island, true, from, true);
    });
    on.set('e', (from, m) => void buildEscort(sanitizeDesign(m[1] as HullDesign), from, true));
    on.set('t', (from) => void buildTrader(from, true));
    on.set('o', (from, m) => {
      const w = ships.find((x) => x.id === m[1] && x.faction === from && !x.flagship);
      const kind = Number(m[2]);
      const n = (i: number) => (Number.isFinite(Number(m[i])) ? Number(m[i]) : 0);
      if (w && (kind === 0 || kind === 1 || kind === 2) && w.queue.length < 24) applyOrder(w, kind, n(3), n(4), n(5), !!m[6], !!m[7]);
    });
  } else {
    on.set('k', (from, m) => {
      // the host paid us: salvage hauled or a bounty
      if (from !== 0) return;
      const k = m[4] === 'trade' ? upgrades.mods.trade : upgrades.mods.salvage;
      const n = (i: number) => Math.round(Math.max(0, Math.min(500, Number(m[i]) || 0)) * k);
      hold.stock.wood += n(1);
      hold.stock.stone += n(2);
      hold.stock.salvage += n(3);
    });
    on.set('u', (from, m) => {
      // the host says we sank a ghost ship: this is what she gave up
      const u = from === 0 ? upgradeById(String(m[1])) : undefined;
      if (u) takeUpgrade((upgrades.taken.get(u.id) ?? 0) < u.max ? u : (upgrades.roll() ?? u), 'ghost');
    });
    on.set('f', (from, m) => {
      if (from === 0) flotsam.spawn(_flot.set(Number(m[2]), 0, Number(m[3])), { wood: Number(m[4]), stone: Number(m[5]), salvage: Number(m[6]) }, Number(m[1]));
    });
    on.set('g', (from, m) => {
      if (from !== 0) return;
      flotsam.remove(Number(m[1]));
      if (Number(m[2]) === ME) weatherUi.announce('Salvage hauled aboard', stockLabel({ wood: Number(m[3]), stone: Number(m[4]), salvage: Number(m[5]) }), 'good');
    });
    on.set('c', (from, m) => {
      // the host's bill for what this player's forts and escorts used
      if (from !== 0) return;
      hold.stock.wood = Math.max(0, hold.stock.wood - Number(m[1]));
      hold.stock.stone = Math.max(0, hold.stock.stone - Number(m[2]));
      hold.stock.salvage = Math.max(0, hold.stock.salvage - Number(m[3]));
    });
    on.set('r', (from, m) => {
      if (from === 0) applyRoster(m[1] as Roster);
    });
    on.set('w', (from, m) => {
      if (from !== 0) return;
      sinceWorld = 0;
      wind.angle = Number(m[1]);
      const a = m[2] as number[];
      for (let i = 0; i + 10 < a.length; i += 11) {
        const w = ships.find((x) => x.id === a[i]);
        if (w) w.applyNet(a.slice(i, i + 11));
        else gotRoster = false; // a ship we have not heard of: ask again
      }
      territory.applyNet(m[3] as number[]);
    });
  }
  link.onLeft = (f) => {
    if (!link.host && f === 0) {
      hostGone = true;
      return;
    }
    weatherUi.announce(`${factions.name(f)} has left`, 'Their ship goes down; their islands are there for the taking', 'danger');
    humanShips.get(f)?.scuttle();
  };
  link.send(['ready']);
  tellDesign();
}
/** Once a frame: send what the other copies need from this one. */
function netTick(dt: number): void {
  if (!link) return;
  if (outShots.length) {
    link.send(['s', ...outShots]);
    outShots.length = 0;
  }
  if (!voyageStarted) return;
  tellIn -= dt;
  if (tellIn <= 0) {
    tellIn = 1 / 12;
    const b = ship.body;
    b.forward(fwd);
    link.send(['p', r1(b.position.x), r1(b.position.z), r2(Math.atan2(-fwd.x, -fwd.z)), r1(b.velocity.x), r1(b.velocity.z), r2(ship.sail), r2(ship.rudder), Math.round(hull.fraction * 100), sunkFor >= 0 ? 3 : 0, ship instanceof DesignedShip ? ship.rig.downMask : 0, hold.stock.wood, hold.stock.stone, hold.stock.salvage], false);
  }
  if (link.host) {
    for (const [f, bill] of owed) link.send(['c', bill.wood, bill.stone, bill.salvage], true, f);
    owed.clear();
    worldIn -= dt;
    if (worldIn > 0) return;
    worldIn = 1 / 8;
    const mine = ships.filter((w) => !w.remote);
    const key = mine.map((w) => w.id).join();
    if (key !== rosterKey) {
      rosterKey = key;
      link.send(['r', roster()]);
    }
    link.send(['w', r2(wind.angle), mine.flatMap((w) => w.netState()), territory.netState()], false);
    return;
  }
  askIn -= dt;
  if (!gotRoster && askIn <= 0) {
    askIn = 2;
    link.toHost(['ready']);
  }
  sinceWorld += dt;
  const quiet = hostGone || sinceWorld > 15;
  netEl.hidden = !quiet && gotRoster;
  if (!netEl.hidden) netEl.textContent = quiet ? 'The host has gone. Leave the match from the menu (Esc).' : 'Waiting for the host...';
}

// --- Trade ships ---------------------------------------------------------------------
const trade = new TradeRoutes({
  home: (f) => {
    const h = territory.homes.get(f);
    return h && h.side === f ? h : null;
  },
  held: (f) => territory.held(f),
  deliver: (f, cargo, from) => {
    credit(f, cargo, 'trade');
    if (f === ME) weatherUi.announce(`Trade from ${from.name}`, stockLabel(cargo), 'calm');
  },
});
/** Trade ships are named for what they are; that is how a guest's copy tells them apart. */
const TRADER_NAME = 'Merchant';
const tradersOf = (f: number) => ships.filter((w) => w.faction === f && w.alive && w.name.startsWith(TRADER_NAME)).length;
let tradersBuilt = 0;

/** Build a trade ship at a captain's home, paid from their stores. Returns why not, or ''. */
function buildTrader(faction = ME, free = false): string {
  const owner = factions.get(faction)!;
  const berth = homeBerth(2 + (tradersBuilt % 6), faction);
  if (!berth) return 'Your home island is lost.';
  if (territory.held(faction).length < 2) return 'Hold a second island first: trade ships need somewhere to trade with.';
  if (!free && !canAfford(TRADE.cost, owner.stores, null)) return `A trade ship needs ${costLabel(TRADE.cost)}.`;
  if (!free) pay(TRADE.cost, owner.stores, null);
  if (!authority) {
    link!.toHost(['t']);
    weatherUi.announce('Trade ship ordered', 'She will sail between your islands. Keep her guarded', 'good');
    return '';
  }
  tradersBuilt++;
  const w = addShip(new Warship(waves, wind, world.islands, warshipHooks, { id: warshipId(), name: `${TRADER_NAME} ${tradersBuilt}`, faction, colour: owner.colour, respawn: false, design: MERCHANT }));
  w.placeAt(berth.x, berth.z, berth.heading);
  trade.add(w);
  if (faction === ME) weatherUi.announce('Trade ship launched', 'She will sail between your islands. Keep her guarded', 'good');
  return '';
}

// --- Captains and their chatter -----------------------------------------------------
/** Who sails for each faction: the lobby's pick, or the player's own from Settings. */
function captainOf(f: number): Captain {
  if (f === ME && !online) return captainById(settings.settings.captain);
  return captainById(captainSlots[f]?.captain);
}
const chat = new Chat(hudRoot);
chat.canType = online;
chat.onSend = (text) => {
  say(ME, text);
  link?.send(['chat', text]);
};
/** A captain speaks, in their own colour, with their portrait's mouth going. */
function say(f: number, text: string): void {
  const human = factions.get(f)?.kind === 'human';
  const name = f === ME || !human ? captainOf(f).name : `${captainSlots[f]?.name ?? 'Captain'} (${captainOf(f).name})`;
  chat.say(captainOf(f), factions.colour(f), name, text);
}
/** The match begins: your captain says their piece, and the AI captains answer. */
function greet(): void {
  say(ME, pickLine(captainOf(ME).lines.hello));
  let delay = 2500;
  for (const f of factions.list) {
    if (f.kind !== 'ai') continue;
    setTimeout(() => say(f.id, pickLine(captainOf(f.id).lines.hello)), delay);
    delay += 1800;
  }
}

// --- Upgrades and ghost ships ------------------------------------------------------
/** Seconds the match has been running: events and ghosts come thicker as it goes on. */
let matchTime = 0;
/** This captain's upgrades (each copy keeps its own player's). */
const upgrades = new UpgradeSet();

// each captain starts with their two upgrades and any extra stores
{
  const me = captainOf(ME);
  for (const id of me.upgrades) {
    const u = upgradeById(id);
    if (u) upgrades.take(u);
  }
  for (const f of factions.list) {
    if (f.kind !== 'human' && f.kind !== 'ai') continue;
    const c = captainOf(f.id);
    if (f.id === ME || f.kind === 'ai') {
      f.stores.wood += c.stock?.wood ?? 0;
      f.stores.stone += c.stock?.stone ?? 0;
      f.stores.salvage += c.stock?.salvage ?? 0;
    }
    // the AI only feels the income upgrades (the rest are about steering a ship by hand)
    if (f.kind === 'ai') territory.incomeMul.set(f.id, 1 + 0.08 * c.upgrades.filter((u) => u === 'tax').length);
  }
}

/** Push the upgrade multipliers into the flagship, her guns and the islands. */
function applyMods(): void {
  const m = upgrades.mods;
  broadside.speedMul = m.range;
  broadside.reloadMul = m.reload;
  gun.reloadMul = m.swivelReload;
  ship.speedMul = m.speed;
  ship.windMul = m.windBoost;
  ship.turnMul = m.turn;
  const max = Math.round(100 * m.hull);
  if (hull.max !== max) {
    hull.hp = (hull.hp / hull.max) * max;
    hull.max = max;
  }
  hull.repairRate = 2.5 * m.repair;
  territory.incomeMul.set(ME, m.income);
}

/** Metal a salvo of `metal` shots really costs, with Powder Monkeys letting some go free. */
function freeShots(metal: number): number {
  let n = 0;
  for (let i = 0; i < metal; i++) if (Math.random() >= upgrades.mods.freeShot) n++;
  return n;
}

function takeUpgrade(u: Upgrade, from: 'ghost' | 'hq'): void {
  upgrades.take(u);
  audio.woodHit(ship.body.position);
  weatherUi.announce(from === 'ghost' ? `Ghost banished: ${u.name}` : `Upgrade: ${u.name}`, u.text, 'good');
}

/** A captain sank a ghost ship: they get an upgrade (an AI captain takes a purse instead). */
function grantUpgrade(faction: number): void {
  const f = factions.get(faction);
  if (!f) return;
  if (faction === ME) {
    const u = upgrades.roll();
    if (u) takeUpgrade(u, 'ghost');
    else credit(ME, { wood: 30, stone: 15, salvage: 30 });
  } else if (f.kind === 'human' && link?.host) {
    // the guest's own copy keeps their upgrades and swaps a maxed one for another
    link.send(['u', UPGRADES[Math.floor(Math.random() * UPGRADES.length)].id], true, faction);
  } else if (f.kind === 'ai') {
    f.stores.wood += 30;
    f.stores.stone += 15;
    f.stores.salvage += 30;
  }
}

/** The HQ's upgrade button: a random upgrade for a price that climbs each time. */
function buyUpgrade(): void {
  const price = upgrades.price();
  if (!canAfford(price, territory.stores, null)) {
    weatherUi.announce('Not enough in your stores', `The next upgrade needs ${costLabel(price)}`, 'danger');
    return;
  }
  const u = upgrades.roll();
  if (!u) {
    weatherUi.announce('Nothing left to learn', 'Every upgrade is as good as it gets', 'danger');
    return;
  }
  pay(price, territory.stores, null);
  upgrades.bought++;
  takeUpgrade(u, 'hq');
}

/** Ghost ships: now and then one drifts in somewhere, sails about, and fades away if nobody sinks her. */
const GHOST = { first: 150, every: [240, 110] as const, life: 210, most: 2 };
let ghostIn = GHOST.first;
const ghostBorn = new Map<Warship, number>();
function updateGhosts(dt: number): void {
  // the longer the match, the more often they come (from every 4 minutes down to under 2)
  const k = Math.min(1, matchTime / 1800);
  ghostIn -= dt;
  const afloat = ships.filter((w) => w.faction === GHOSTS && !w.lost);
  if (ghostIn <= 0 && afloat.length < GHOST.most) {
    ghostIn = THREE.MathUtils.lerp(GHOST.every[0], GHOST.every[1], k) * (0.8 + Math.random() * 0.4);
    const at = openWater(0.3, 0.8);
    const w = addShip(new Warship(waves, wind, world.islands, warshipHooks, { id: warshipId(), name: 'Ghost Ship', faction: GHOSTS, colour: '#d8fff0', respawn: false, design: randomDesign(Math.random, 0.3 + Math.random() * 0.5) }));
    w.placeAt(at.x, at.z, Math.random() * Math.PI * 2);
    ghostBorn.set(w, matchTime);
    weatherUi.announce('A ghost ship is abroad', 'Sink her for an upgrade', 'calm');
  }
  for (const w of afloat) {
    if (!w.alive) {
      ghostBorn.delete(w);
      continue;
    }
    // wander from one stretch of open sea to the next
    if (!w.order || Math.hypot(w.order.x - w.position.x, w.order.z - w.position.z) < 40) {
      const to = openWater(0.15, 0.85);
      w.order = new THREE.Vector3(to.x, 0, to.z);
      w.attackMove = true;
    }
    // her time is up: she fades away
    if (matchTime - (ghostBorn.get(w) ?? matchTime) > GHOST.life) {
      ghostBorn.delete(w);
      w.scuttle();
    }
  }
}

/** A random point at sea, between these shares of the world's radius, clear of islands. */
function openWater(lo: number, hi: number): { x: number; z: number } {
  for (let tries = 0; tries < 40; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = WORLD_RADIUS * (lo + Math.random() * (hi - lo));
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (world.islands.every((i) => Math.hypot(x - i.center.x, z - i.center.z) > i.radius * 1.8 + 40)) return { x, z };
  }
  return { x: 0, z: 0 };
}

// --- Sinking and coming back ---------------------------------------------------------
/** Seconds since the flagship went down; below zero while she is afloat. */
let sunkFor = -1;
const RESPAWN_TIME = 7;
function sinkPlayer(): void {
  if (sunkFor >= 0) return;
  sunkFor = 0;
  course = null;
  courseQueue = [];
  ship.sail = 0;
  gathering.select(null);
  leaveWreckage(ship.body.position, 100);
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
  lookouts.push({ x: ship.body.position.x, z: ship.body.position.z, range: 210 * upgrades.mods.sight });
  // allies share what they see
  for (const w of ships) if (w.alive && factions.allied(ME, w.faction)) lookouts.push({ x: w.position.x, z: w.position.z, range: 170 });
  for (const s of territory.strongholds) if (factions.allied(ME, s.side)) lookouts.push({ x: s.site.x, z: s.site.z, range: 150 + s.level * 25 });
  fog.update(dt, lookouts, world.islands);
}
const _hd = new THREE.Vector3();
function mapState(): MapState {
  const colour = myColour();
  const ships_: MapShip[] = [
    { id: 0, position: ship.body.position, heading: compass(ship.body.forward(_hd)), colour, name: ship.displayName, hostile: false, health: hull.fraction, course, route: courseQueue, note: course ? 'Under orders' : 'At your command' },
  ];
  for (const w of ships) {
    if (!w.alive) continue;
    const mine = w.faction === ME;
    const hostile = factions.hostile(ME, w.faction);
    const note = hostile ? '' : w.trader ? trade.note(w) : w.state === 'fight' ? 'Engaging the enemy' : w.state === 'raid' ? 'Shelling a stronghold' : !mine ? `${factions.name(w.faction)}, your ally` : w.order ? (w.attackMove ? 'Attack-moving' : 'Under orders') : w.patrol ? 'Patrolling her zone' : 'Following the flagship';
    ships_.push({ id: w.id, position: w.position, heading: compass(w.ship.body.forward(_hd)), colour: factions.colour(w.faction), name: w.name, hostile, mine, health: w.hp / w.maxHp, course: mine ? w.order : null, route: mine ? w.queue : undefined, attack: mine && w.attackMove, patrol: mine ? w.patrol : null, note });
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
  const leave = !link ? '' : link.host ? 'End the match for everyone' : 'Leave the match';
  if (won) territoryUi.showVictory(vs ? null : territory.enemyHome, leave);
  else territoryUi.showDefeat(territory.home, leave);
  if (won) say(ME, pickLine(captainOf(ME).lines.win));
}

/** Push the player's settings (colour, fire mode) into the game. */
function applySettings(): void {
  const s = settings.settings;
  ship.setColour(myColour());
  broadside.fireMode = s.fireMode;
  factions.me.colour = myColour();
  territory.refreshColours();
  islandMarkers.refresh();
  for (const w of fleet) w.ship.setColour(myColour());
  yard.colour = myColour();
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
function updateGathering(dt: number): void {
  const at = ship.body.position;
  gathering.update(dt, at);
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
    // in a Vs match this button reads "Leave match": back to the solo voyage on its own map
    if (online) return leaveMatch();
    if (vs) saveMatch(null);
    else rollWorldSeed();
    location.reload();
  },
  versus: () => {
    menu.hide();
    lobby.open();
  },
});
const lobby = new Lobby(document.body, {
  start: (m) => {
    saveMatch(m);
    location.reload();
  },
  back: () => {
    lobby.close();
    openMenu();
  },
  colour: () => settings.settings.colour,
  captain: () => settings.settings.captain,
  setCaptain: (id) => settings.setCaptain(id),
  summon: () => {
    if (voyageStarted && online) return false;
    menu.hide();
    lobby.open();
    return true;
  },
});

/** Vs: who is still in it, and how many islands each holds. */
const teamsEl = document.createElement('div');
teamsEl.className = 'hud-panel hud-teams';
teamsEl.hidden = !vs;
hudRoot.append(teamsEl);
let teamsKey = '';
function updateScoreboard(): void {
  if (!vs) return;
  const rows = factions.list.filter((f) => f.kind !== 'raiders' && f.kind !== 'ghosts').map((f) => ({ f, held: territory.held(f.id).length }));
  const key = rows.map((r) => `${r.f.alive}${r.held}${r.f.colour}`).join('|');
  if (key === teamsKey) return;
  teamsKey = key;
  teamsEl.innerHTML = rows
    .map(({ f, held }) => `<div class="row ${f.alive ? '' : 'out'}"><i style="background:${f.colour}"></i><b>${f.name}${f.id !== ME && factions.allied(ME, f.id) ? ' <em>ally</em>' : ''}</b><span>${f.alive ? `${held} island${held === 1 ? '' : 's'}` : 'out'}</span></div>`)
    .join('');
}


/** The shipyard works only at the home dock (or before the voyage has begun, when the ship is still there). */
function openYard(fromChart = false): void {
  if (voyageStarted && !atHomeDock() && !(fromChart && territory.home.side === ME)) {
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
    if (voyageStarted && !atHomeDock()) {
      yard.warn('Your flagship can only be refitted alongside your home. You can still build this design as an escort from here.');
      return;
    }
    // cannons beyond the first few are paid for in metals, once each
    const extra = Math.max(0, computeStats(design).guns - FREE_CANNONS);
    const due = { wood: 0, stone: 0, salvage: Math.max(0, extra - cannonsPaid) * METALS_PER_CANNON };
    if (!canAfford(due, territory.stores, hold)) {
      yard.warn(`The extra cannons need ${due.salvage} metals and you have ${hold.stock.salvage}. Gather more, or take some guns off.`);
      return;
    }
    pay(due, territory.stores, hold);
    cannonsPaid = Math.max(cannonsPaid, extra);
    setShip(new DesignedShip(design, waves, wind, myColour(), RAFT_ID));
    yard.close();
    startPlay();
  },
  useRaft: () => {
    if (voyageStarted && !atHomeDock()) {
      yard.warn('Your flagship can only be changed alongside your home.');
      return;
    }
    if (!(ship instanceof Raft)) setShip(new Raft(waves, wind));
    yard.close();
    startPlay();
  },
  back: () => leaveYard(),
  escort: (design) => buildEscort(design),
  fleet: () => `${fleet.length}`,
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
  if (!voyageStarted) greet();
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
  menu.show(voyageStarted, !voyageStarted || atHomeDock(), vs);
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
    renderer,
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
    link,
    humanShips,
    fog,
    buildEscort,
    tryBuild,
    presets: PRESETS,
    /** Tests: put to sea in one of the stock designs. */
    launchPreset: (n: number) => setShip(new DesignedShip(PRESETS[n], waves, wind, myColour(), RAFT_ID)),
    announce: (title: string, sub: string, tone: 'calm' | 'danger' | 'good') => weatherUi.announce(title, sub, tone),
    atHomeDock,
    /** Tests: run the game ahead by this many seconds without drawing. */
    fastForward: async (seconds: number) => {
      fastForwarding = true;
      for (let i = 0; i < seconds * 20; i++) {
        step(0.05);
        input.endFrame();
        // let the projectile worker answer between steps
        await new Promise((r) => setTimeout(r, 0));
      }
      fastForwarding = false;
    },
    openYard,
    get sunkFor() {
      return sunkFor;
    },
    chart,
    get course() {
      return course;
    },
    flotsam,
    upgrades,
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
      // a ship sailed by another copy of the game loses her masts when that copy says so
      if (w && !w.remote && factions.hostile(by, w.faction) && w.hitMast(mast.mast, e.kind)) mastFell(w);
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
      if (!w.remote && w.hit(e.kind)) {
        if (e.owner === RAFT_ID) targets.score += 10;
        // the side that sank her is paid a bounty on top of the wreckage
        const v = wreckValue(w.maxHp);
        const bounty = { wood: 0, stone: 0, salvage: Math.round(v.salvage * FLOTSAM.bounty) + 2 };
        credit(by, bounty);
        if (w.faction === GHOSTS) grantUpgrade(by);
        if (by === ME && w.faction !== GHOSTS) weatherUi.announce(`${w.name} sunk`, `Bounty: ${stockLabel(bounty)}. Sail over her wreckage for more`, 'good');
      }
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

let fireHeld = 0;
let fireRepeat = 0;
/** Timber owed for hull repairs under way. */
let hullWood = 0;
hull.spend = (hp) => {
  hullWood += (hp / ECONOMY.hullPerWood) * upgrades.mods.repairWood;
  if (hullWood < 1) return true;
  if (hold.stock.wood < 1) {
    hullWood = 1;
    return false;
  }
  hold.stock.wood--;
  hullWood -= 1;
  return true;
};
const _flot = new THREE.Vector3();
const _shove = new THREE.Vector3();
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

/** Tests: the game is being run ahead by `fastForward`, so the frame loop stands by. */
let fastForwarding = false;
/** Ships further than this from the camera sample the sea under half their hull each step. */
const FAR_PHYSICS = 180;
/** Crews and villagers further than this from the camera are too small to see, so they are not drawn. */
const CREW_SEEN = 240;
function frame(): void {
  timer.update();
  if (fastForwarding) {
    requestAnimationFrame(frame);
    return;
  }
  step(timer.getDelta());
  renderer.render(scene, camera);
  input.endFrame();
  requestAnimationFrame(frame);
}

/** Advance the whole game by one frame's worth of time (everything but the drawing). */
function step(rawDt: number): void {
  const dt = Math.min(rawDt, 0.1);

  const playing = mode === 'play';
  /** The world goes on: an online match does not stop for one player's menu, or their defeat. */
  const running = online ? voyageStarted : playing;
  /** Playing with the flagship afloat: the helm, guns and crew answer. */
  const active = playing && sunkFor < 0;
  if (input.wasPressed('Escape')) {
    if (settings.visible) settings.close();
    else if (lobby.visible) {
      lobby.close();
      openMenu();
    } else if (chart.visible) chart.close();
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
    if (online && input.wasPressed('Enter')) chat.openInput();
    if (input.wasPressed('KeyB')) fireBarrage(barrage.size);
  }

  wind.update(dt);
  if (active) {
    if (!followCourse(dt)) ship.control(dt, input.throttle, input.steer);
  } else if (!playing && mode !== 'over' && !voyageStarted && !vs) autopilot(dt);
  else ship.control(dt, ship.sail > 0.02 ? -1 : 0, 0); // nobody at the helm: the sail comes in
  // ships far from the camera sample the sea more sparsely: nobody can see the difference out there
  for (const w of ships) w.ship.body.coarse = w.position.distanceToSquared(follow.focusPoint) > FAR_PHYSICS * FAR_PHYSICS;
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
    if (sunkFor >= RESPAWN_TIME && mode === 'play' && (!online || factions.me.alive)) {
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
    tellShot(RAFT_ID, SWIVEL.kind, muzzlePos, shotVel);
    effects.muzzle(muzzlePos, muzzleDir, ship.body.velocity, 0.8);
    audio.play('cannon', { volume: 0.55, rate: 1.4, rateJitter: 0.05, position: muzzlePos });
  }
  // --- Broadside ---
  if (active && input.wasPressed('KeyC')) broadside.setVisible(!broadside.visible);
  if (active && broadside.visible) {
    broadside.aimAt(aimLevel, dt);
    // each press fires one gun deck; held down, the decks follow one another
    const press = input.wasPressed('Space') || input.wasPressed('KeyF') || input.wasPressed('KeyX');
    fireHeld = input.fire ? fireHeld + dt : 0;
    fireRepeat -= dt;
    if (press || (fireHeld > 0.45 && fireRepeat <= 0)) {
      fireRepeat = 0.3;
      const metal = broadside.nextSalvo * ECONOMY.shotMetal;
      if (metal > 0 && hold.stock.salvage >= metal) {
        if (broadside.tryFire()) hold.stock.salvage -= freeShots(metal);
      } else if (metal > 0 && press) weatherUi.announce('No metal for the guns', `That salvo needs ${metal} metals`, 'danger');
    }
  }
  broadsideShots.length = 0;
  broadside.update(dt, broadsideShots);
  for (const shot of broadsideShots) {
    shotVel.copy(shot.direction).multiplyScalar(BROADSIDE.muzzleSpeed * broadside.speedMul);
    projectiles.spawn(shot.position, shotVel, BROADSIDE.kind, RAFT_ID);
    tellShot(RAFT_ID, BROADSIDE.kind, shot.position, shotVel);
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
  _playerSight.alive = online ? running && sunkFor < 0 : active;
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
  if (running) for (const c of captains) c.update(dt);
  for (let i = ships.length - 1; i >= 0; i--) {
    const w = ships[i];
    if (w.lost) {
      scene.remove(w.group);
      ships.splice(i, 1);
      const at = fleet.indexOf(w);
      if (at >= 0) fleet.splice(at, 1);
      continue;
    }
    if (!w.remote && !w.flagship && !w.trader && factions.get(w.faction)?.kind === 'human') {
      // a player's escort keeps station on their flagship
      w.escort = w.faction === ME ? ship.body.position : (humanShips.get(w.faction)?.position ?? null);
      // an escort shells any hostile stronghold it finds itself near
      const mark = territory.strongholds.find((s) => factions.hostile(w.faction, s.side) && !s.ruined && Math.hypot(s.site.x - w.position.x, s.site.z - w.position.z) < 150);
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
    w.update(dt, foe, running);
    // ships out of sight of the player's own ships and islands are hidden, and fade in at the edge
    const seen = !voyageStarted || factions.allied(ME, w.faction) || fog.canSee(w.position.x, w.position.z);
    w.showAs(THREE.MathUtils.clamp(w.reveal + (seen ? dt : -dt) * 1.4, 0, 1));
    if (w.alive) {
      edgeCurrent(w.position, w.ship.body.velocity, dt);
      if (!w.remote) {
        const knock = ground(w.position, w.ship.body.velocity, w.collider.radius, world.islands);
        if (knock > 0 && authority && knocks.ready(w.id, waves.currentTime)) {
          effects.splinters(w.position, 14);
          audio.woodHit(w.position);
          w.scrape(knock);
        }
      }
    }
  }
  // crews and villagers are hundreds of tiny meshes: only those near enough to make out are drawn
  for (const w of ships) w.ship.crew.group.visible = w.ship.group.position.distanceToSquared(camera.position) < CREW_SEEN * CREW_SEEN;
  for (const s of territory.strongholds) s.crew.group.visible = s.site.distanceToSquared(camera.position) < CREW_SEEN * CREW_SEEN;
  flotsam.update(dt, running ? sights : [], authority, (item, by) => {
    if (by >= 0) credit(by, item.stock);
    if (by === ME) weatherUi.announce('Salvage hauled aboard', stockLabel(item.stock), 'good');
    link?.send(['g', item.id, by, item.stock.wood, item.stock.stone, item.stock.salvage]);
  });
  ship.setCargo(hold.stock, CARGO_FULL);
  // the current at the rim turns every ship back
  const atEdge = edgeCurrent(ship.body.position, ship.body.velocity, dt);
  if (sunkFor < 0) {
    const knock = ground(ship.body.position, ship.body.velocity, Math.max(1.7, ship.length * 0.36), world.islands);
    if (knock > 0 && playing && knocks.ready(RAFT_ID, waves.currentTime)) {
      effects.splinters(ship.body.position, 16);
      audio.woodHit(ship.body.position);
      hull.damage(knock);
      if (knock > 6) weatherUi.announce('Rocks!', 'You struck a reef and holed the hull', 'danger');
    }
  }
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
  chat.update(dt);
  if (running) matchTime += dt;
  weather.escalation = Math.min(1, matchTime / 1800);
  applyMods();
  if (running && authority) updateGhosts(dt);
  if (running && authority) trade.update(dt);
  buildWait -= dt;
  territory.update(dt, sights, running);
  territoryUi.update(territory, buildIsland, hold, fleet.length, active && atHomeDock());
  updateScoreboard();
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
  netTick(dt);

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
  hud.update(rawDt, ship.body.forwardSpeed, ship.backing ? -0.4 : ship.sail, Math.atan2(fwd.x, -fwd.z));
  hud.updateSailing(Math.atan2(wind.direction.x, -wind.direction.z), ship.windBoost, ship.sail);
  hud.updateCombat(gun.reloadProgress, broadside.visible ? broadside.reloadProgress : -1, targets.score, projectiles.stats.active, projectiles.stats.threaded, projectiles.stats.workerMs);

  streaks.update(dt, camera, follow.focusPoint);
  audio.updateListener(camera);
  audio.updateAmbience(wind.strength, ship.sail, Math.abs(ship.body.forwardSpeed));
}
applySettings();
if (vs) {
  // a match begins at each captain's home, in a proper ship: your saved design if it needs no extra metals, else a Sloop
  const own = loadDesign();
  setShip(new DesignedShip(own && computeStats(own).guns <= FREE_CANNONS ? own : PRESETS[1], waves, wind, myColour(), RAFT_ID));
  berthFlagship();
}
openMenu();
if (vs && match.autostart) {
  // straight from the lobby: to sea, and a plain reload afterwards comes back to the menu
  saveMatch({ ...match, autostart: false });
  startPlay();
}
follow.yaw = 2.3;
follow.pitch = 0.2;
warmShaders();
requestAnimationFrame(frame);

/**
 * Compile every shader the game will need now, while it loads, instead of the
 * first time something new comes into view: an eruption, rain, a ghost ship or
 * a ship sliding out of the fog each cost a stall of a frame or more (worst on
 * Windows, where shaders are translated for Direct3D). Hidden things are shown
 * for the moment of the call, and effects that only exist mid-game lend a prop.
 */
function warmShaders(): void {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  const props = new THREE.Group();
  props.add(...weather.warmup());
  scene.add(props);
  try {
    void renderer.compileAsync(scene, camera);
  } finally {
    scene.remove(props);
    for (const o of hidden) o.visible = false;
  }
}
