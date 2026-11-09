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
import { Effects } from './fx/Effects';
import { Wake } from './fx/Wake';
import { WindStreaks } from './fx/WindStreaks';
import { AudioManager } from './audio/AudioManager';

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
const waves = new WaveField();
const ocean = new Ocean(waves, sunDir);
const sky = new Sky(sunDir);
const islands = createIslands();
scene.add(sky.group, ocean.mesh, islands);

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
const hud = new Hud(document.getElementById('hud')!);
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
});

// Expose a handle for console tinkering / automated checks.
Object.assign(window, { plunder: { scene, camera, waves, raft, ocean, follow, sim, wind, gun, projectiles, targets, audio, barrage } });

// --- Combat wiring ----------------------------------------------------------
projectiles.onImpact = (e: ImpactEvent) => {
  const size = e.kind === 1 ? 1.5 : 0.55;
  if (e.type === 'splash') {
    effects.splash(e.position, size);
    audio.splash(e.position, size);
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

// Mouse aim: ray from the camera through the cursor onto the (moving) sea.
const raycaster = new THREE.Raycaster();
const aimPoint = new THREE.Vector3();
function updateAimPoint(): void {
  raycaster.setFromCamera(new THREE.Vector2(input.pointer.x, input.pointer.y), camera);
  const ray = raycaster.ray;
  let planeY = waves.heightAt(raft.body.position.x, raft.body.position.z);
  const maxRange = 260;
  for (let i = 0; i < 3; i++) {
    const t = ray.direction.y < -1e-3 ? (planeY - ray.origin.y) / ray.direction.y : Infinity;
    if (!isFinite(t) || t < 0 || t > maxRange * 2) {
      // looking at/above the horizon: aim at max range along the view
      const flat = new THREE.Vector3(ray.direction.x, 0, ray.direction.z).normalize();
      aimPoint.copy(raft.body.position).addScaledVector(flat, maxRange);
      aimPoint.y = waves.heightAt(aimPoint.x, aimPoint.z);
      return;
    }
    ray.at(t, aimPoint);
    planeY = waves.heightAt(aimPoint.x, aimPoint.z);
  }
  aimPoint.y = planeY;
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

  if (input.wasPressed('KeyG')) gui._hidden ? gui.show() : gui.hide();
  if (input.wasPressed('KeyH')) hud.toggleHelp();
  if (input.wasPressed('KeyP')) probeMarkers.visible = !probeMarkers.visible;
  if (input.wasPressed('KeyT')) raft.autoTrim = !raft.autoTrim;
  if (input.wasPressed('KeyM')) audio.setMuted(!audio.muted);
  if (input.wasPressed('KeyB')) fireBarrage(barrage.size);

  wind.update(dt);
  raft.control(dt, input.throttle, input.steer, input.trim);
  sim.advance(dt, (h) => {
    waves.update(h);
    raft.physicsStep(h);
  });
  raft.syncVisuals(dt);

  // --- Gun ---
  updateAimPoint();
  gun.aimAt(aimPoint);
  gun.update(dt, raft.body.velocity);
  if (input.fire && gun.tryFire()) {
    gun.muzzle(muzzlePos, muzzleDir);
    shotVel.copy(muzzleDir).multiplyScalar(SWIVEL.muzzleSpeed).add(raft.body.velocity);
    projectiles.spawn(muzzlePos, shotVel, SWIVEL.kind, RAFT_ID);
    effects.muzzle(muzzlePos, muzzleDir, raft.body.velocity, 0.8);
    audio.play('cannon', { volume: 0.55, rate: 1.4, rateJitter: 0.05, position: muzzlePos });
  }
  for (let i = queuedShots.length - 1; i >= 0; i--) {
    const q = queuedShots[i];
    q.delay -= dt;
    if (q.delay > 0) continue;
    projectiles.spawn(q.pos, q.vel, 1, -2);
    if (Math.random() < 0.15) audio.play('cannon', { volume: 0.9, rate: 0.85, rateJitter: 0.08, position: q.pos });
    queuedShots.splice(i, 1);
  }

  targets.update(dt, waves.currentTime);
  projectiles.setColliders([{ id: RAFT_ID, position: raft.body.position, radius: 1.7 }, ...targets.colliders()]);
  projectiles.update(dt);
  effects.update(dt);

  // --- Wake + wind FX ---
  stern.set(0, 0, 1.9).applyQuaternion(raft.body.quaternion).add(raft.body.position);
  starboard.set(1, 0, 0).applyQuaternion(raft.body.quaternion).setY(0).normalize();
  wake.update(dt, stern, starboard, raft.body.forwardSpeed);

  raft.body.forward(fwd);
  const heading = Math.atan2(-fwd.x, -fwd.z); // camera yaw that sits behind the ship
  follow.update(dt, raft.body.position, heading, raft.body.forwardSpeed);

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
  hud.updateSailing(Math.atan2(wind.direction.x, -wind.direction.z), raft.sailEfficiency, THREE.MathUtils.radToDeg(raft.trim), raft.autoTrim, raft.sail);
  hud.updateCombat(gun.reloadProgress, targets.score, projectiles.stats.active, projectiles.stats.threaded, projectiles.stats.workerMs);

  streaks.update(dt, camera, follow.focusPoint);
  audio.updateListener(camera);
  audio.updateAmbience(wind.strength, raft.sail, Math.abs(raft.body.forwardSpeed));

  renderer.render(scene, camera);
  input.endFrame(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
