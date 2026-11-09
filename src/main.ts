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

const raft = new Raft(waves);
raft.body.placeOnWater(0, 0, 0);
scene.add(raft.group);

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
const gui = createDebugPanel(waves, ocean);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// Expose a handle for console tinkering / automated checks.
Object.assign(window, { plunder: { scene, camera, waves, raft, ocean, follow, sim } });

// --- Main loop ------------------------------------------------------------
const timer = new THREE.Timer();
timer.connect(document);
const fwd = new THREE.Vector3();

function frame(): void {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);

  if (input.wasPressed('KeyG')) gui._hidden ? gui.show() : gui.hide();
  if (input.wasPressed('KeyH')) hud.toggleHelp();
  if (input.wasPressed('KeyP')) probeMarkers.visible = !probeMarkers.visible;

  raft.control(dt, input.throttle, input.steer);
  sim.advance(dt, (h) => {
    waves.update(h);
    raft.physicsStep(h);
  });
  raft.syncVisuals(dt);

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
  hud.update(dt, raft.body.forwardSpeed, raft.sail, Math.atan2(fwd.x, -fwd.z));

  renderer.render(scene, camera);
  input.endFrame(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
