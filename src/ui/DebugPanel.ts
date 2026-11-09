import GUI from 'lil-gui';
import { WaveField } from '../ocean/waves';
import { Ocean } from '../ocean/Ocean';
import { RAFT_DRIVE, RAFT_HULL } from '../raft/Raft';

/**
 * Live tuning panel (toggle with G). Wave edits update the shader uniforms AND
 * the CPU sampler together, so the raft keeps floating on what you see.
 */
export function createDebugPanel(waves: WaveField, ocean: Ocean): GUI {
  const gui = new GUI({ title: 'Plunder tuning' });
  const sync = () => {
    waves.syncUniforms();
    ocean.refreshAmplitude();
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
  phys.add(RAFT_DRIVE, 'maxThrust', 200, 5000, 10).name('sail thrust (N)');
  phys.add(RAFT_DRIVE, 'steerTorque', 200, 5000, 10).name('steer torque');
  phys.add(RAFT_HULL.dragForward, 'quadratic', 5, 200, 1).name('forward drag');
  phys.add(RAFT_HULL.dragLateral, 'quadratic', 50, 2000, 10).name('lateral drag');
  phys.add(RAFT_HULL, 'heaveDamping', 0, 1000, 5).name('heave damping');

  gui.hide();
  return gui;
}
