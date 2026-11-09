import * as THREE from 'three';
import { PALETTE } from '../render/palette';
import { AtmosphereState, createAtmosphere, lerpAtmosphere, copyAtmosphere } from './Atmosphere';

/**
 * Day-night cycle.
 *
 * `time` is the time of day, 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon,
 * 0.75 = sunset). The sun arcs across the sky and the moon follows on the
 * opposite side. Colours come from four keyframes picked by the sun's height
 * (night, dusk, golden hour, day), so sunrise and sunset get their warm
 * colours wherever the sun happens to be.
 *
 * Nights are kept short and moonlit: the clock runs faster while the sun is
 * down, and the moon lights the sea enough to sail and fight by.
 */
export class DayNight {
  /** 0..1 time of day. */
  time = 0.3;
  /** Real seconds for one full day, before the night speed-up. */
  dayLength = 600;
  /** How much faster the clock runs while the sun is down. */
  nightSpeed = 2.2;
  paused = false;

  /** Unit vector toward the sun / moon. */
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** Direction the key light comes from (sun by day, moon by night). */
  readonly lightDir = new THREE.Vector3();

  private readonly keys: { elevation: number; state: AtmosphereState }[];

  constructor() {
    this.keys = [
      { elevation: -0.28, state: night() },
      { elevation: -0.07, state: dusk() },
      { elevation: 0.07, state: golden() },
      { elevation: 0.32, state: day() },
    ];
    this.updateDirections();
  }

  /** 0 at night .. 1 in full day (handy for lanterns, eye glow, etc.). */
  get daylight(): number {
    return THREE.MathUtils.smoothstep(this.sunDir.y, -0.12, 0.15);
  }

  /** Clock text like "14:30". */
  get clock(): string {
    const mins = Math.floor(this.time * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  update(dt: number): void {
    if (!this.paused) {
      const speed = this.sunDir.y < -0.05 ? this.nightSpeed : 1;
      this.time = (this.time + (dt * speed) / Math.max(this.dayLength, 1)) % 1;
    }
    this.updateDirections();
  }

  private updateDirections(): void {
    // The sun rises in the east (+X), peaks high in the south-ish sky and sets in the west.
    const a = (this.time - 0.25) * Math.PI * 2;
    this.sunDir.set(Math.cos(a), Math.sin(a) * 0.92, -0.38).normalize();
    // Moon: roughly opposite, on a slightly different track so it isn't a mirror.
    this.moonDir.set(-Math.cos(a) * 0.9, -Math.sin(a) * 0.8, -0.55).normalize();
    const src = this.sunDir.y > -0.04 ? this.sunDir : this.moonDir;
    // Keep the light a little above the horizon so the toon bands stay readable.
    this.lightDir.copy(src);
    this.lightDir.y = Math.max(this.lightDir.y, 0.22);
    this.lightDir.normalize();
  }

  /** Writes the base (clear-weather) look for the current time into `out`. */
  compute(out: AtmosphereState): AtmosphereState {
    const e = this.sunDir.y;
    const k = this.keys;
    if (e <= k[0].elevation) copyAtmosphere(out, k[0].state);
    else if (e >= k[k.length - 1].elevation) copyAtmosphere(out, k[k.length - 1].state);
    else {
      for (let i = 0; i < k.length - 1; i++) {
        if (e < k[i + 1].elevation) {
          const t = (e - k[i].elevation) / (k[i + 1].elevation - k[i].elevation);
          copyAtmosphere(out, k[i].state);
          lerpAtmosphere(out, k[i + 1].state, t * t * (3 - 2 * t));
          break;
        }
      }
    }
    // The sun disc only shows while it is up; the moon while the sun is down.
    out.sunVis = THREE.MathUtils.smoothstep(e, -0.06, 0.02);
    out.moonVis = 1 - THREE.MathUtils.smoothstep(e, -0.1, 0.05);
    return out;
  }
}

function state(fill: (s: AtmosphereState) => void): AtmosphereState {
  const s = createAtmosphere();
  fill(s);
  return s;
}

function day(): AtmosphereState {
  return state((s) => {
    s.skyTop.set(PALETTE.skyTop);
    s.skyMid.set(PALETTE.skyMid);
    s.horizon.set(PALETTE.horizon);
    s.sunGlow.set(PALETTE.sunGlow);
    s.stars = 0;
    s.cloudColor.set(PALETTE.cloud);
    s.cloudGlow.set(0x9fc6e6);
    s.lightColor.set(0xfff1d6);
    s.lightIntensity = 2.4;
    s.hemiSky.set(0xbfe6ff);
    s.hemiGround.set(0x1d5f99);
    s.hemiIntensity = 1.3;
    s.waterLight.setRGB(1, 1, 1);
    s.fogColor.set(PALETTE.horizon);
  });
}

function golden(): AtmosphereState {
  return state((s) => {
    s.skyTop.set(0x3a6cb4);
    s.skyMid.set(0xe9a679);
    s.horizon.set(0xffcf96);
    s.sunGlow.set(0xffa860);
    s.stars = 0;
    s.cloudColor.set(0xffd2b0);
    s.cloudGlow.set(0xd88a6a);
    s.lightColor.set(0xffb878);
    s.lightIntensity = 1.9;
    s.hemiSky.set(0xffd2b4);
    s.hemiGround.set(0x2c4f86);
    s.hemiIntensity = 1.05;
    s.waterLight.setRGB(1.0, 0.86, 0.78);
    s.fogColor.set(0xf5c79a);
  });
}

function dusk(): AtmosphereState {
  return state((s) => {
    s.skyTop.set(0x1b2556);
    s.skyMid.set(0x5d4a85);
    s.horizon.set(0xc9786a);
    s.sunGlow.set(0xff7a50);
    s.stars = 0.35;
    s.cloudColor.set(0x8a7aa6);
    s.cloudGlow.set(0x6a4a7a);
    s.lightColor.set(0xd89a9a);
    s.lightIntensity = 0.7;
    s.hemiSky.set(0x8c86c4);
    s.hemiGround.set(0x1a2c5c);
    s.hemiIntensity = 0.8;
    s.waterLight.setRGB(0.62, 0.6, 0.78);
    s.fogColor.set(0x8a6a86);
  });
}

function night(): AtmosphereState {
  return state((s) => {
    s.skyTop.set(0x050a1c);
    s.skyMid.set(0x0e1b3e);
    s.horizon.set(0x22355e);
    s.sunGlow.set(0x6d8ad0);
    s.stars = 1;
    s.cloudColor.set(0x3a4a70);
    s.cloudGlow.set(0x1c2a4c);
    s.lightColor.set(0xa9c2ff);
    s.lightIntensity = 0.8;
    s.hemiSky.set(0x5b78c0);
    s.hemiGround.set(0x0b1a38);
    s.hemiIntensity = 0.75;
    s.waterLight.setRGB(0.42, 0.5, 0.72);
    s.fogColor.set(0x1d2e52);
  });
}
