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
import { MainMenu } from './ui/MainMenu';
import type { Island } from './world/Islands';

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
const sunDir = new THREE.Vector3(-0.45, 0.55, -0.7).normalize();
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
scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x1d5f99, 1.3));

// --- World ----------------------------------------------------------------
const world = createIslands();
const waves = new WaveField();
waves.shore = world.shore; // calm shallows around the islands
const ocean = new Ocean(waves, sunDir, world.shore);
const sky = new Sky(sunDir);
scene.add(sky.group, ocean.mesh, world.group);

const wind = new Wind();
const raft = new Raft(waves, wind);
raft.body.placeOnWater(0, 0, 0);
scene.add(raft.group);

// Swivel gun on the bow
const RAFT_ID = 0;
const gun = new SwivelGun(waves);
gun.mount.position.copy(raft.bowMount);
raft.group.add(gun.mount);
scene.add(gun.preview);

// Broadside battery (press C to fit / remove): two light cannons per side.
const broadside = new Broadside(
  raft.group,
  [
    new THREE.Vector3(1.12, 0.3, -0.55),
    new THREE.Vector3(1.12, 0.3, 0.55),
    new THREE.Vector3(-1.12, 0.3, -0.55),
    new THREE.Vector3(-1.12, 0.3, 0.55),
  ],
  waves,
);
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
raft.onSailFilled = () => audio.play('sailFull', { volume: 0.8, rateJitter: 0.04 });

// Debug: buoyancy probe markers (P)
const probeMarkers = new THREE.Group();
probeMarkers.visible = false;
const probeGeo = new THREE.SphereGeometry(0.08, 8, 6);
const wetMat = new THREE.MeshBasicMaterial({ color: 0xff3355, depthTest: false });
const dryMat = new THREE.MeshBasicMaterial({ color: 0xffee55, depthTest: false });
for (let i = 0; i < raft.body.probeWorld.length; i++) {
  const m = new THREE.Mesh(probeGeo, dryMat);
  m.renderOrder = 10;
  probeMarkers.add(m);
}
scene.add(probeMarkers);

const sim = new Simulation();

// --- Controls / UI --------------------------------------------------------
const input = new Input(canvas);
const follow = new FollowCamera(camera, input, waves);
const hudRoot = document.getElementById('hud')!;
const hud = new Hud(hudRoot);

// --- Gathering --------------------------------------------------------------
const hold = new Hold();
const gathering = new Gathering(world.islands, hold);
const gatherUi = new GatherUi(hudRoot);
gathering.onHaul = () => audio.woodHit(raft.body.position);
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
  const ship = raft.body.position;
  gathering.update(dt, ship);
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
    const a = Math.atan2(ship.z - target.center.z, ship.x - target.center.x);
    const r = target.shoreAt(a) * 0.85;
    const lx = Math.cos(a) * r;
    const lz = Math.sin(a) * r;
    marker.position.set(target.center.x + lx, Math.max(0, target.heightAt(lx, lz)) + 7 + bob, target.center.z + lz);
  }
  marker.rotation.y += dt * 1.5;
  markerMat.color.set(!gathering.selected ? 0xffffff : gathering.working ? 0x9be37a : 0xffb27a);
}

// --- Main menu ------------------------------------------------------------
let mode: 'menu' | 'play' = 'menu';
let voyageStarted = false;
const menu = new MainMenu(document.body, {
  play: () => startPlay(),
  toggleSound: () => {
    audio.setMuted(!audio.muted);
    return !audio.muted;
  },
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
  if (!voyageStarted) raft.sail = 0;
  voyageStarted = true;
  menu.hide();
  hudRoot.classList.remove('in-menu');
  gun.preview.visible = true;
  broadside.ribbon.visible = broadside.visible;
  applyViewOffset();
  canvas.focus();
}

function openMenu(): void {
  mode = 'menu';
  menu.show(voyageStarted);
  hudRoot.classList.add('in-menu');
  gun.preview.visible = false;
  broadside.ribbon.visible = false;
  marker.visible = false;
  applyViewOffset();
}

/** Menu backdrop: the raft sails a lazy circle around the start on its own. */
function autopilot(dt: number): void {
  const p = raft.body.position;
  raft.body.forward(fwd);
  const r = Math.hypot(p.x, p.z) || 1;
  const k = THREE.MathUtils.clamp((r - 45) / 30, -1, 1);
  const dx = -p.z / r - (p.x / r) * k;
  const dz = p.x / r - (p.z / r) * k;
  const turn = fwd.x * dz - fwd.z * dx;
  raft.control(dt, raft.sail < 0.75 ? 1 : 0, THREE.MathUtils.clamp(turn * 2, -1, 1));
}
// Barrage stress test: shells arc in from a ring of unseen ships and land around the raft.
const barrage = {
  size: 400,
  fire: () => fireBarrage(barrage.size),
};
const gui = createDebugPanel(waves, ocean, wind, () => projectiles.markSeaDirty(), barrage);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  applyViewOffset();
});

// Expose a handle for console tinkering / automated checks.
Object.assign(window, { plunder: { aimPoint: () => aimPoint, gathering, hold, startPlay, openMenu, scene, camera, waves, raft, ocean, follow, sim, wind, gun, broadside, world, projectiles, targets, audio, barrage } });

// --- Combat wiring ----------------------------------------------------------
projectiles.onImpact = (e: ImpactEvent) => {
  const size = e.kind === 1 ? 1.5 : 0.55;
  if (e.type === 'splash') {
    effects.splash(e.position, size);
    audio.splash(e.position, size);
    return;
  }
  if (e.type === 'land') {
    effects.splinters(e.position, e.kind === 1 ? 8 : 4);
    audio.woodHit(e.position);
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
  }
};

const queuedShots: { delay: number; pos: THREE.Vector3; vel: THREE.Vector3 }[] = [];
function fireBarrage(n: number): void {
  const centre = raft.body.position;
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

/** Low-arc launch velocity from a to b at muzzle speed v (drag ignored). */
function ballisticVelocity(a: THREE.Vector3, b: THREE.Vector3, v: number): THREE.Vector3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dz);
  const g = 9.81;
  const disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
  const elev = disc < 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * d));
  return new THREE.Vector3((dx / d) * Math.cos(elev) * v, Math.sin(elev) * v, (dz / d) * Math.cos(elev) * v);
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
    aimRaw.copy(raft.body.position).addScaledVector(aimFlat, AIM_MAX_RANGE);
  }
  // keep the point within gun range of the raft
  aimFlat.subVectors(aimRaw, raft.body.position).setY(0);
  if (aimFlat.length() > AIM_MAX_RANGE) aimRaw.copy(raft.body.position).addScaledVector(aimFlat.normalize(), AIM_MAX_RANGE);

  if (!aimStarted) aimPoint.copy(aimRaw);
  else aimPoint.lerp(aimRaw, 1 - Math.exp(-dt / AIM_SMOOTHING));
  aimStarted = true;
  aimPoint.y = waves.heightAt(aimPoint.x, aimPoint.z);
}

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
    if (playing) openMenu();
    else if (voyageStarted) startPlay();
  }
  if (playing) {
    if (input.wasPressed('KeyG')) gui._hidden ? gui.show() : gui.hide();
    if (input.wasPressed('KeyH')) hud.toggleHelp();
    if (input.wasPressed('KeyP')) probeMarkers.visible = !probeMarkers.visible;
    if (input.wasPressed('KeyM')) audio.setMuted(!audio.muted);
    if (input.wasPressed('KeyB')) fireBarrage(barrage.size);
  }

  wind.update(dt);
  if (playing) raft.control(dt, input.throttle, input.steer);
  else autopilot(dt);
  sim.advance(dt, (h) => {
    waves.update(h);
    raft.physicsStep(h);
  });
  raft.syncVisuals(dt);

  // --- Gun ---
  if (playing) {
    updateAimPoint(dt);
    gun.aimAt(aimPoint);
  }
  gun.update(dt);
  if (playing && input.fire && gun.tryFire()) {
    gun.muzzle(muzzlePos, muzzleDir);
    shotVel.copy(muzzleDir).multiplyScalar(SWIVEL.muzzleSpeed);
    projectiles.spawn(muzzlePos, shotVel, SWIVEL.kind, RAFT_ID);
    effects.muzzle(muzzlePos, muzzleDir, raft.body.velocity, 0.8);
    audio.play('cannon', { volume: 0.55, rate: 1.4, rateJitter: 0.05, position: muzzlePos });
  }
  // --- Broadside ---
  if (playing && input.wasPressed('KeyC')) broadside.setVisible(!broadside.visible);
  if (playing && broadside.visible) {
    broadside.aimAt(aimPoint);
    if (input.wasPressed('KeyF') || input.wasPressed('KeyX')) broadside.tryFire();
  }
  broadsideShots.length = 0;
  broadside.update(dt, broadsideShots);
  for (const shot of broadsideShots) {
    shotVel.copy(shot.direction).multiplyScalar(BROADSIDE.muzzleSpeed);
    projectiles.spawn(shot.position, shotVel, BROADSIDE.kind, RAFT_ID);
    effects.muzzle(shot.position, shot.direction, raft.body.velocity, 1.5);
    audio.play('cannon', { volume: 0.9, rate: 1, rateJitter: 0.06, position: shot.position });
    // recoil shoves the raft the other way
    raft.body.velocity.addScaledVector(shot.direction, -0.25);
  }

  for (let i = queuedShots.length - 1; i >= 0; i--) {
    const q = queuedShots[i];
    q.delay -= dt;
    if (q.delay > 0) continue;
    projectiles.spawn(q.pos, q.vel, 1, -2);
    if (Math.random() < 0.15) audio.play('cannon', { volume: 0.9, rate: 0.85, rateJitter: 0.08, position: q.pos });
    queuedShots.splice(i, 1);
  }

  if (playing) updateGathering(dt);

  targets.update(dt, waves.currentTime);
  projectiles.setColliders([{ id: RAFT_ID, position: raft.body.position, radius: 1.7 }, ...targets.colliders()]);
  projectiles.update(dt);
  effects.update(dt);

  // --- Wake + wind FX ---
  stern.set(0, 0, 1.9).applyQuaternion(raft.body.quaternion).add(raft.body.position);
  starboard.set(1, 0, 0).applyQuaternion(raft.body.quaternion).setY(0).normalize();
  wake.update(dt, stern, starboard, raft.body.forwardSpeed);

  raft.body.forward(fwd);
  follow.update(dt, raft.body.position);

  ocean.update(follow.focusPoint);
  sky.update(dt, camera.position);

  // Shadow camera follows the raft.
  sun.position.copy(raft.body.position).addScaledVector(sunDir, 40);
  sun.target.position.copy(raft.body.position);

  if (probeMarkers.visible) {
    probeMarkers.children.forEach((m, i) => {
      m.position.copy(raft.body.probeWorld[i]);
      (m as THREE.Mesh).material = raft.body.probeDepth[i] > 0 ? wetMat : dryMat;
    });
  }

  // Compass heading: 0 = north (-Z), clockwise positive.
  hud.update(rawDt, raft.body.forwardSpeed, raft.sail, Math.atan2(fwd.x, -fwd.z));
  hud.updateSailing(Math.atan2(wind.direction.x, -wind.direction.z), raft.windBoost, raft.sail);
  hud.updateCombat(gun.reloadProgress, broadside.visible ? broadside.reloadProgress : -1, targets.score, projectiles.stats.active, projectiles.stats.threaded, projectiles.stats.workerMs);

  streaks.update(dt, camera, follow.focusPoint);
  audio.updateListener(camera);
  audio.updateAmbience(wind.strength, raft.sail, Math.abs(raft.body.forwardSpeed));

  renderer.render(scene, camera);
  input.endFrame();
  requestAnimationFrame(frame);
}
openMenu();
follow.yaw = 2.3;
follow.pitch = 0.2;
requestAnimationFrame(frame);
