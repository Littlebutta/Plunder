import * as THREE from 'three';

/**
 * Everything the sky, sea, fog and lights need for one frame. The day-night
 * cycle fills in a base state, then each weather event pulls it toward its
 * own look, weighted by how far the event has faded in. `applyAtmosphere`
 * pushes the result into the scene.
 */
export interface AtmosphereState {
  skyTop: THREE.Color;
  skyMid: THREE.Color;
  horizon: THREE.Color;
  sunGlow: THREE.Color;
  /** 0..1 how visible the sun / moon discs are (clouds and fog hide them). */
  sunVis: number;
  moonVis: number;
  stars: number;
  cloudColor: THREE.Color;
  cloudGlow: THREE.Color;
  /** Key light (sun by day, moon by night). */
  lightColor: THREE.Color;
  lightIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** Multiplier on the water colour (dims the sea at night). */
  waterLight: THREE.Color;
  /** Colour the water is pulled toward, and how far (red tide). */
  waterTint: THREE.Color;
  waterTintAmount: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  /** 0..1 how far the sky dome itself fades into the fog colour. */
  skyFog: number;
  /** 0..1 lightning flash. */
  flash: number;
  /** Multipliers the weather applies to the sea and wind. */
  waveScale: number;
  windScale: number;
}

export function createAtmosphere(): AtmosphereState {
  return {
    skyTop: new THREE.Color(),
    skyMid: new THREE.Color(),
    horizon: new THREE.Color(),
    sunGlow: new THREE.Color(),
    sunVis: 1,
    moonVis: 0,
    stars: 0,
    cloudColor: new THREE.Color(),
    cloudGlow: new THREE.Color(),
    lightColor: new THREE.Color(),
    lightIntensity: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    waterLight: new THREE.Color(1, 1, 1),
    waterTint: new THREE.Color(),
    waterTintAmount: 0,
    fogColor: new THREE.Color(),
    fogNear: 300,
    fogFar: 1600,
    skyFog: 0,
    flash: 0,
    waveScale: 1,
    windScale: 1,
  };
}

/** Linear blend of every field of `a` toward `b` by t (a is modified). */
export function lerpAtmosphere(a: AtmosphereState, b: AtmosphereState, t: number): AtmosphereState {
  for (const key of Object.keys(a) as (keyof AtmosphereState)[]) {
    const va = a[key];
    const vb = b[key];
    if (va instanceof THREE.Color) va.lerp(vb as THREE.Color, t);
    else (a[key] as number) = (va as number) + ((vb as number) - (va as number)) * t;
  }
  return a;
}

export function copyAtmosphere(out: AtmosphereState, src: AtmosphereState): AtmosphereState {
  for (const key of Object.keys(out) as (keyof AtmosphereState)[]) {
    const v = src[key];
    if (v instanceof THREE.Color) (out[key] as THREE.Color).copy(v);
    else (out[key] as number) = v as number;
  }
  return out;
}

/** Rec. 709 luminance, for desaturating toward storm greys. */
export function luminance(c: THREE.Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}
