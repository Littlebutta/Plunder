import * as THREE from 'three';
import { AtmosphereState, createAtmosphere, copyAtmosphere, lerpAtmosphere, luminance } from './Atmosphere';
import { DayNight } from './DayNight';
import { Rain, Lightning } from './Rain';
import { Lurkers, LURKER_ID_BASE } from './Lurkers';
import { CursedFleet, CURSED_ID_BASE } from './CursedFleet';
import type { WaveField } from '../ocean/waves';
import type { Wind } from '../world/Wind';
import type { Collider } from '../combat/ProjectileSystem';
import type { Sky } from '../sky/Sky';
import type { Ocean } from '../ocean/Ocean';

export type WeatherKind = 'fog' | 'storm' | 'lurker' | 'armageddon';
export const WEATHER_KINDS: WeatherKind[] = ['fog', 'storm', 'lurker', 'armageddon'];

/** Names and one-line hints for the banner, per level 1..3. */
export const WEATHER_INFO: Record<WeatherKind, { names: [string, string, string]; hint: [string, string, string] }> = {
  fog: {
    names: ['Sea Mist', 'Heavy Fog', 'Blinding Fog'],
    hint: ['A light mist rolls in.', 'Fog swallows the horizon.', 'You can barely see your own bow.'],
  },
  storm: {
    names: ['Squall', 'Storm', 'Tempest'],
    hint: ['Rain and a freshening wind.', 'Lightning, rain and rough seas.', 'The sea heaves under a black sky.'],
  },
  lurker: {
    names: ['Eyes in the Deep', 'The Lurkers Hunt', 'The Lurkers Swarm'],
    hint: ['Something is following you. Keep moving.', 'Two pairs of eyes below. Steer clear of the tentacles.', 'They are everywhere. Shoot the eyes to drive them off.'],
  },
  armageddon: {
    names: ['Blood Tide', 'Armageddon', 'Armageddon Unleashed'],
    hint: ['The sea turns red. Cursed ships rise.', 'A cursed fleet climbs out of the deep.', 'The damned fleet hunts you. Sink them all.'],
  },
};

/** How long each event lasts at full strength (s), before fading out. */
const DURATION: Record<WeatherKind, [number, number]> = {
  fog: [80, 120],
  storm: [80, 120],
  lurker: [90, 130],
  armageddon: [150, 200],
};
const FADE_IN = 10;
const FADE_OUT = 10;

export interface WeatherHooks {
  dayNight: DayNight;
  waves: WaveField;
  wind: Wind;
  ocean: Ocean;
  sky: Sky;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Call after the sea state changes (sync uniforms, recalibrate, tell the projectile worker). */
  refreshSea(): void;
  splash(at: THREE.Vector3, size: number): void;
  splinters(at: THREE.Vector3, count: number): void;
  /** The player's ship took a hit from the weather. */
  hitShip(damage: number, at: THREE.Vector3, shove: THREE.Vector3): void;
  /** A cursed ship fires a cannonball. */
  fire(from: THREE.Vector3, velocity: THREE.Vector3, owner: number, dir: THREE.Vector3): void;
  /** Show a message banner. */
  announce(title: string, subtitle: string, tone: 'calm' | 'danger' | 'good'): void;
  thunder?(distance: number, strength: number): void;
  /** 0..1 rain loudness. */
  rainSound?(amount: number): void;
}

export interface ShipState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  length: number;
}

interface ActiveEvent {
  kind: WeatherKind;
  level: number;
  time: number;
  duration: number;
  ending: boolean;
  weight: number;
}

/**
 * Weather director. Owns the day-night cycle and the weather events (fog,
 * storm, sea creatures, the red-sea armageddon), each with three intensity
 * levels, and turns them into one atmosphere per frame for the sky, sea, fog
 * and lights.
 *
 * Events are meant to roll between rounds: `nextRound()` picks one. Until the
 * round loop exists, `auto` rolls one after a calm spell of a couple of
 * minutes. The debug panel (G) can start any event at any level.
 */
export class Weather {
  readonly dayNight: DayNight;
  readonly atmosphere: AtmosphereState = createAtmosphere();
  readonly rain = new Rain();
  readonly lightning = new Lightning();
  readonly lurkers: Lurkers;
  readonly fleet: CursedFleet;
  readonly group = new THREE.Group();

  event: ActiveEvent | null = null;
  /** Roll events on a timer (until rounds exist). */
  auto = true;
  /** Seconds of calm left before the next automatic event. */
  calm = 120;
  calmRange: [number, number] = [100, 170];

  private readonly target = createAtmosphere();
  private nextStrike = 5;
  private seaTimer = 0;
  private windBase: number;
  private windSet: number;

  constructor(private readonly hooks: WeatherHooks) {
    this.group.name = 'weather';
    this.dayNight = hooks.dayNight;
    this.group.add(this.rain.mesh, this.lightning.mesh);
    this.lurkers = new Lurkers(hooks.waves, hooks.ocean.material.uniforms, {
      splash: hooks.splash,
      hitShip: hooks.hitShip,
      drivenOff: (left) => {
        if (left > 0) hooks.announce('Lurker driven off!', `${left} still hunting`, 'good');
        else {
          hooks.announce('The deep falls quiet', 'You drove them all off', 'good');
          this.stop();
        }
      },
    });
    this.fleet = new CursedFleet(hooks.waves, {
      splash: hooks.splash,
      splinters: hooks.splinters,
      fire: hooks.fire,
      sunk: (left) => {
        if (left > 0) hooks.announce('Cursed ship sunk!', `${left} left`, 'good');
      },
      cleared: () => {
        hooks.announce('The red tide ebbs', 'The cursed fleet is beaten', 'good');
        this.stop();
      },
    });
    this.group.add(this.lurkers.group, this.fleet.group);
    this.windBase = this.windSet = hooks.wind.baseStrength;
  }

  /** Label for the HUD chip, e.g. "Storm II". */
  get label(): string {
    if (!this.event) return 'Clear skies';
    return WEATHER_INFO[this.event.kind].names[this.event.level - 1];
  }

  /** Seconds until the current event starts to clear (0 when calm). */
  get timeLeft(): number {
    if (!this.event) return 0;
    return Math.max(0, this.event.duration - this.event.time);
  }

  start(kind: WeatherKind, level: number, ship: ShipState): void {
    this.endEffects();
    level = THREE.MathUtils.clamp(Math.round(level), 1, 3);
    const [lo, hi] = DURATION[kind];
    this.event = { kind, level, time: 0, duration: lo + Math.random() * (hi - lo), ending: false, weight: this.event?.weight ?? 0 };
    if (kind === 'lurker') this.lurkers.start(level, ship);
    if (kind === 'armageddon') this.fleet.start(level);
    this.nextStrike = 4;
    const info = WEATHER_INFO[kind];
    this.hooks.announce(info.names[level - 1], info.hint[level - 1], kind === 'fog' ? 'calm' : 'danger');
  }

  /** Begin clearing the current event. */
  stop(): void {
    if (!this.event || this.event.ending) return;
    this.event.ending = true;
    if (this.event.kind === 'armageddon') this.fleet.stop();
  }

  /** Pick a random event for the coming round; level rises with the round number. */
  nextRound(ship: ShipState, round = 1): void {
    const kind = WEATHER_KINDS[Math.floor(Math.random() * WEATHER_KINDS.length)];
    const maxLevel = THREE.MathUtils.clamp(1 + Math.floor(round / 2), 1, 3);
    const level = 1 + Math.floor(Math.random() * maxLevel);
    this.start(kind, level, ship);
  }

  colliders(): Collider[] {
    return [...this.lurkers.colliders(), ...this.fleet.colliders()];
  }

  /** True if the collider id belongs to the weather (creatures, cursed ships). */
  owns(id: number): boolean {
    return id >= LURKER_ID_BASE && id < CURSED_ID_BASE + 64;
  }

  /** A player shot hit one of ours. kind 0 = swivel, 1 = broadside. */
  hit(id: number, kind: number): THREE.Vector3 | null {
    const damage = kind === 1 ? 3 : 1;
    if (id >= CURSED_ID_BASE) return this.fleet.hit(id, damage);
    return this.lurkers.hit(id, kind === 1 ? 2 : 1);
  }

  update(dt: number, ship: ShipState, camera: THREE.Camera, playing: boolean): void {
    this.dayNight.update(dt);
    const a = this.dayNight.compute(this.atmosphere);

    // --- event timeline ---
    if (!this.event && this.auto && playing) {
      this.calm -= dt;
      if (this.calm <= 0) this.nextRound(ship, 3);
    }
    const ev = this.event;
    if (ev) {
      ev.time += dt;
      if (ev.time > ev.duration) this.stop();
      ev.weight = ev.ending ? Math.max(0, ev.weight - dt / FADE_OUT) : Math.min(1, ev.weight + dt / FADE_IN);
      this.blendEvent(a, ev);
      if (ev.ending && ev.weight <= 0 && !this.fleet.alive) {
        this.endEffects();
        this.event = null;
        this.calm = this.calmRange[0] + Math.random() * (this.calmRange[1] - this.calmRange[0]);
      }
    }

    // --- storm: rain and lightning ---
    const storm = ev?.kind === 'storm' ? ev.weight : 0;
    const level = ev?.level ?? 1;
    this.rain.amount = storm * [0.35, 0.65, 1][level - 1];
    if (storm > 0.4) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        const gap = [[12, 20], [6, 12], [3, 7]][level - 1];
        this.nextStrike = gap[0] + Math.random() * (gap[1] - gap[0]);
        this.strike(ship, camera.position, level);
      }
    }
    this.lightning.update(dt);
    a.flash = Math.max(a.flash, this.lightning.flash);

    // --- creatures and cursed ships ---
    this.lurkers.presence = ev?.kind === 'lurker' ? ev.weight : 0;
    if (this.lurkers.active) {
      this.lurkers.update(dt, ship);
      if (!ev || ev.kind !== 'lurker') this.lurkers.clear();
    }
    this.fleet.update(dt, ship, ev?.kind === 'armageddon' ? ev.weight : 0);

    this.hooks.rainSound?.(this.rain.amount);
    this.rain.update(dt, camera.position, this.hooks.wind.direction, this.hooks.wind.strength, luminance(a.horizon));
    this.applySeaAndWind(dt, a);
    this.apply(a);
  }

  private strike(ship: ShipState, cam: THREE.Vector3, level: number): void {
    const near = level === 3 && Math.random() < 0.3;
    const ang = Math.random() * Math.PI * 2;
    const r = near ? 18 + Math.random() * 15 : 90 + Math.random() * 260;
    const at = new THREE.Vector3(ship.position.x + Math.cos(ang) * r, 0, ship.position.z + Math.sin(ang) * r);
    at.y = this.hooks.waves.heightAt(at.x, at.z);
    this.lightning.strike(at, cam, near ? 1 : 0.7);
    if (near) this.hooks.splash(at, 2);
    this.hooks.thunder?.(cam.distanceTo(at), near ? 1 : 0.6);
  }

  /** Pull the base atmosphere toward the event's look by its weight. */
  private blendEvent(a: AtmosphereState, ev: ActiveEvent): void {
    const t = copyAtmosphere(this.target, a);
    const lv = ev.level - 1;
    // how bright the base sky is: fog and storm greys follow day and night
    const bright = THREE.MathUtils.clamp(luminance(a.horizon) / 0.85, 0.12, 1);
    switch (ev.kind) {
      case 'fog': {
        const grey = _c.setRGB(0.8, 0.84, 0.86).multiplyScalar(bright);
        t.fogColor.lerp(grey, 0.75);
        t.horizon.copy(t.fogColor);
        t.fogNear = [10, 0, 0][lv];
        t.fogFar = [220, 110, 60][lv];
        t.skyFog = [0.7, 0.9, 1][lv];
        t.sunVis *= 0.3;
        t.moonVis *= 0.3;
        t.stars *= 0.15;
        t.lightIntensity *= 0.75;
        t.waveScale = 0.85;
        t.windScale = [0.7, 0.55, 0.4][lv];
        break;
      }
      case 'storm': {
        const dark = [0.55, 0.42, 0.32][lv];
        for (const c of [t.skyTop, t.skyMid, t.horizon]) {
          const l = luminance(c);
          c.setRGB(l * 0.9, l * 0.95, l * 1.05).multiplyScalar(dark);
        }
        t.skyMid.lerp(t.horizon, 0.5);
        t.sunGlow.copy(t.horizon);
        t.cloudColor.setRGB(0.42, 0.45, 0.5).multiplyScalar(bright);
        t.cloudGlow.setRGB(0.15, 0.17, 0.2).multiplyScalar(bright);
        t.fogColor.copy(t.horizon);
        t.fogNear = 60;
        t.fogFar = [900, 650, 450][lv];
        t.skyFog = 0.3;
        t.sunVis = 0;
        t.moonVis = 0;
        t.stars = 0;
        t.lightIntensity *= [0.6, 0.45, 0.35][lv];
        t.hemiIntensity *= 0.8;
        t.waterLight.multiplyScalar(0.8);
        t.waterTint.setRGB(0.1, 0.16, 0.22).multiplyScalar(bright + 0.2);
        t.waterTintAmount = [0.35, 0.5, 0.6][lv];
        t.waveScale = [1.2, 1.38, 1.55][lv];
        t.windScale = [1.25, 1.45, 1.65][lv];
        break;
      }
      case 'lurker': {
        t.fogColor.lerp(_c.setRGB(0.32, 0.5, 0.5).multiplyScalar(bright + 0.15), 0.45);
        t.horizon.lerp(t.fogColor, 0.5);
        t.fogFar = [800, 650, 500][lv];
        t.skyFog = 0.25;
        t.lightIntensity *= 0.8;
        t.waterLight.multiply(_c.setRGB(0.82, 0.92, 0.9));
        t.windScale = 0.8;
        break;
      }
      case 'armageddon': {
        const k = THREE.MathUtils.clamp(bright, 0.45, 1);
        t.skyTop.set(0x2a0505).multiplyScalar(k);
        t.skyMid.set(0x7a1408).multiplyScalar(k);
        t.horizon.set(0xff5a26).multiplyScalar(k);
        t.sunGlow.set(0xff2a0a);
        t.sunVis *= 0.6;
        t.moonVis *= 0.6;
        t.stars *= 0.3;
        t.cloudColor.set(0x5a1812).multiplyScalar(k);
        t.cloudGlow.set(0x8a1a08).multiplyScalar(k);
        t.lightColor.set(0xff7050);
        t.lightIntensity = 1.6 * k;
        t.hemiSky.set(0xff7a58).multiplyScalar(k);
        t.hemiGround.set(0x3a0606);
        t.hemiIntensity = 1.0;
        t.waterLight.setRGB(1, 1, 1).multiplyScalar(0.6 + 0.4 * k);
        t.waterTint.set(0xc0180c);
        t.waterTintAmount = [0.88, 0.95, 1][lv];
        t.fogColor.set(0x8a2410).multiplyScalar(k);
        t.fogFar = [1000, 850, 700][lv];
        t.skyFog = 0.15;
        t.waveScale = [1.05, 1.15, 1.25][lv];
        t.windScale = 1.1;
        break;
      }
    }
    lerpAtmosphere(a, t, ev.weight * ev.weight * (3 - 2 * ev.weight));
  }

  /**
   * Scale the sea's wave height (waves.amplitudeScale, which the tuning
   * panel's roughness leaves alone) and the wind by the weather. If someone
   * changes the wind by hand (debug panel), that becomes the new base.
   */
  private applySeaAndWind(dt: number, a: AtmosphereState): void {
    const { waves, wind } = this.hooks;
    if (Math.abs(wind.baseStrength - this.windSet) > 1e-6) this.windBase = wind.baseStrength;
    this.seaTimer -= dt;
    const want = a.waveScale;
    if (this.seaTimer <= 0 && Math.abs(want - waves.amplitudeScale) > 0.004) {
      this.seaTimer = 0.25;
      waves.amplitudeScale = want;
      this.hooks.refreshSea();
    }
    wind.baseStrength = this.windSet = Math.min(1.2, this.windBase * a.windScale);
  }

  private endEffects(): void {
    this.lurkers.clear();
    this.fleet.clear();
  }

  /** Push the atmosphere into the scene. */
  private apply(a: AtmosphereState): void {
    const { scene, sun, hemi, sky, ocean } = this.hooks;
    sun.color.copy(a.lightColor);
    sun.intensity = a.lightIntensity * (1 + a.flash * 0.6);
    hemi.color.copy(a.hemiSky);
    hemi.groundColor.copy(a.hemiGround);
    hemi.intensity = a.hemiIntensity + a.flash * 2.2;
    const fog = scene.fog as THREE.Fog;
    fog.color.copy(a.fogColor);
    fog.near = a.fogNear;
    fog.far = a.fogFar;
    sky.applyAtmosphere(a);
    const u = ocean.material.uniforms;
    (u.uHorizon.value as THREE.Color).copy(a.fogColor);
    (u.uFogRange.value as THREE.Vector2).set(a.fogNear, a.fogFar);
    (u.uLight.value as THREE.Color).copy(a.waterLight);
    (u.uTint.value as THREE.Color).copy(a.waterTint);
    u.uTintAmount.value = a.waterTintAmount;
    u.uFlash.value = a.flash;
  }
}

const _c = new THREE.Color();
