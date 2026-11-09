import * as THREE from 'three';
import GUI from 'lil-gui';
import { WaveField } from '../ocean/waves';
import { Ocean } from '../ocean/Ocean';
import { RAFT_DRIVE, RAFT_HULL } from '../raft/Raft';
import { Wind } from '../world/Wind';
import { SWIVEL } from '../combat/SwivelGun';

/**
 * Live tuning panel (toggle with G). Wave edits update the shader uniforms AND
 * the CPU sampler together, so the raft keeps floating on what you see.
 */
export function createDebugPanel(waves: WaveField, ocean: Ocean, wind: Wind, onSeaChange: () => void, barrage: { size: number; fire: () => void }): GUI {
  const gui = new GUI({ title: 'Plunder tuning' });
  const sync = () => {
    waves.syncUniforms();
    ocean.refreshAmplitude();
    onSeaChange();
  };

  const sea = gui.addFolder('Sea state');
  sea.add(waves, 'intensity', 0, 2, 0.01).name('roughness').onChange(sync);
  sea.add(waves, 'speed', 0, 3, 0.01).name('time scale');
  sea.add(ocean.material.uniforms.uFoamAmount, 'value', 0, 1.5, 0.01).name('foam');

  const wf = gui.addFolder('Waves').close();
  waves.waves.forEach((w, i) => {
    const f = wf.addFolder(`Wave ${i + 1}`).close();
    f.add(w, 'direction', -180, 180, 1).onChange(sync);
    f.add(w, 'wavelength', 2, 120, 0.5).onChange(sync);
    f.add(w, 'steepness', 0, 0.4, 0.005).onChange(sync);
  });

  const w = gui.addFolder('Wind');
  const windView = {
    get heading() {
      return Math.round(((THREE.MathUtils.radToDeg(wind.angle) + 90) % 360 + 360) % 360);
    },
    set heading(v: number) {
      wind.angle = THREE.MathUtils.degToRad(v - 90);
    },
  };
  w.add(windView, 'heading', 0, 359, 1).name('blows toward (°)').listen();
  w.add(wind, 'baseStrength', 0, 1.2, 0.01).name('strength');
  w.add(wind, 'wander', 0, 0.1, 0.001).name('direction wander');

  const combat = gui.addFolder('Combat').close();
  combat.add(SWIVEL, 'muzzleSpeed', 20, 120, 1).name('swivel muzzle m/s');
  combat.add(SWIVEL, 'reload', 0.05, 5, 0.05).name('swivel reload s');
  combat.add(barrage, 'size', 10, 4000, 10).name('barrage shells');
  combat.add(barrage, 'fire').name('fire barrage (B)');

  const colours = gui.addFolder('Ocean colours').close();
  const u = ocean.material.uniforms;
  for (const [key, label] of [
    ['uDeep', 'deep'],
    ['uMid', 'mid'],
    ['uShallow', 'crest'],
    ['uFoam', 'foam'],
    ['uHorizon', 'horizon'],
  ] as const) {
    colours.addColor(u[key], 'value').name(label);
  }

  const phys = gui.addFolder('Raft physics').close();
  phys.add(RAFT_DRIVE, 'sailPower', 20, 400, 1).name('sail power');
  phys.add(RAFT_DRIVE, 'leeway', 0, 1.5, 0.01).name('leeway');
  phys.add(RAFT_DRIVE, 'steerTorque', 200, 5000, 10).name('steer torque');
  phys.add(RAFT_HULL.dragForward, 'quadratic', 5, 200, 1).name('forward drag');
  phys.add(RAFT_HULL.dragLateral, 'quadratic', 50, 2000, 10).name('lateral drag');
  phys.add(RAFT_HULL, 'heaveDamping', 0, 1000, 5).name('heave damping');

  gui.hide();
  return gui;
}
