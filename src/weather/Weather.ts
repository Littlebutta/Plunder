import * as THREE from 'three';
import { AtmosphereState, createAtmosphere, copyAtmosphere, lerpAtmosphere, luminance } from './Atmosphere';
import { DayNight } from './DayNight';
import { Rain, Lightning, ASH } from './Rain';
import { Volcano } from './Volcano';
import type { Island } from '../world/Islands';
import { LurkerTarget, Lurkers, LURKER_ID_BASE } from './Lurkers';
import { CursedFleet, CURSED_ID_BASE } from './CursedFleet';
import { Tsunami } from './Tsunami';
import { Waterspouts } from './Waterspouts';
import type { WaveField } from '../ocean/waves';
import type { Wind } from '../world/Wind';
import type { Collider } from '../combat/ProjectileSystem';
import type { Sky } from '../sky/Sky';
import type { Ocean } from '../ocean/Ocean';

export type WeatherKind = 'fog' | 'storm' | 'lurker' | 'armageddon' | 'volcano' | 'tsunami' | 'tornado';
export const WEATHER_KINDS: WeatherKind[] = ['fog', 'storm', 'lurker', 'armageddon', 'volcano', 'tsunami', 'tornado'];

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
    hint: ['Something roams the dark water, hunting any ship it finds.', 'Two pairs of eyes prowl the sea. Steer clear of the tentacles.', 'They are everywhere tonight. Shoot the eyes to drive them off.'],
  },
  volcano: {
    names: ['The Mountain Rumbles', 'Eruption', 'Fire from the Sky'],
    hint: ['Smoke and the odd fireball. Watch for red rings on the water.', 'Fireballs rain down. Steer out of the red rings.', 'The mountain tears itself open. Keep moving.'],
  },
  tsunami: {
    names: ['Rogue Swell', 'Tsunami', 'The Great Wave'],
    hint: ['A great swell rolls across the sea. Meet it bow on.', 'A wall of water is loose on the map. Do not let it catch you broadside.', 'A monstrous wave wanders the sea, smashing what it catches.'],
  },
  tornado: {
    names: ['Waterspout', 'Twin Waterspouts', 'Tornado Season'],
    hint: ['A funnel touches down and wanders the sea. Keep clear of its foot.', 'Two funnels roam the sea, lifting any ship that strays too close.', 'Funnels everywhere. Get caught and you will fly.'],
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
  volcano: [80, 120],
  tsunami: [70, 100],
  tornado: [80, 120],
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
  /** Every island (a volcano wakes on a mountain one). */
  islands: Island[];
  /** A fireball came down: hurt whatever is within `radius`. */
  blast(at: THREE.Vector3, radius: number, damage: number): void;
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
 * A match has no rounds: `auto` rolls an event after each calm spell, and
 * both the calm and the pick follow `escalation`, so the sea gets angrier the
 * longer a match runs. The debug panel (G) can start any event at any level.
 */
export class Weather {
  readonly dayNight: DayNight;
  readonly atmosphere: AtmosphereState = createAtmosphere();
  readonly rain = new Rain();
  readonly lightning = new Lightning();
  readonly ash = new Rain(ASH);
  readonly volcano: Volcano;
  /** 0..1: how far into the match we are. Events come sooner and hit harder as it rises. */
  escalation = 0;
  readonly lurkers: Lurkers;
  readonly fleet: CursedFleet;
  readonly tsunami: Tsunami;
  readonly spouts: Waterspouts;
  readonly group = new THREE.Group();

  event: ActiveEvent | null = null;
  /** Roll events on a timer. */
  auto = true;
  /** Seconds of calm left before the next automatic event. */
  calm = 120;
  calmRange: [number, number] = [100, 170];

  private readonly target = createAtmosphere();
  private nextStrike = 5;
  private seaTimer = 0;
  private windBase: number;
  private windSet: number;

  /** Props for every effect that only appears mid-game, so main can compile their shaders up front. */
  warmup(): THREE.Object3D[] {
    return [...this.volcano.warmup(), ...this.spouts.warmup()];
  }

  constructor(private readonly hooks: WeatherHooks) {
    this.group.name = 'weather';
    this.dayNight = hooks.dayNight;
    this.group.add(this.rain.mesh, this.lightning.mesh, this.ash.mesh);
    this.volcano = new Volcano(hooks.waves, { splash: hooks.splash, blast: hooks.blast });
    this.group.add(this.volcano.group);
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
    this.tsunami = new Tsunami(hooks.waves, { splash: hooks.splash });
    this.spouts = new Waterspouts(hooks.waves, hooks.islands, { splash: hooks.splash });
    this.group.add(this.spouts.group);
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
    if (kind === 'lurker') {
      const prey = this.prey();
      this.lurkers.start(level, prey.length ? prey : [{ ...ship, hit: (d, at, shove) => this.hooks.hitShip(d, at, shove) }]);
    }
    if (kind === 'armageddon') this.fleet.start(level);
    if (kind === 'tsunami') this.tsunami.start(level, ship.position);
    if (kind === 'tornado') this.spouts.start(level, ship.position);
    if (kind === 'volcano') {
      const mount = this.mountainNear(ship.position);
      if (!mount) {
        this.event = null;
        this.start('storm', level, ship);
        return;
      }
      this.volcano.start(mount, level);
      this.hooks.announce(WEATHER_INFO.volcano.names[level - 1], `${mount.name} erupts! ${WEATHER_INFO.volcano.hint[level - 1]}`, 'danger');
      return;
    }
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

  /**
   * Pick a random event. Early in a match they are mild; as `escalation`
   * climbs the strong levels and the worst kinds (the volcano, armageddon)
   * come up more often.
   */
  /** Dark enough for the kraken. */
  get isNight(): boolean {
    return this.dayNight.daylight < 0.2;
  }

  /**
   * Everything the kraken may go for: every ship afloat (the player's among
   * them, but no more than any other). Set by the game; empty = only `ship`.
   */
  prey: () => LurkerTarget[] = () => [];

  nextEvent(ship: ShipState): void {
    const e = this.escalation;
    // the kraken only rises in the dark
    const weights: Record<WeatherKind, number> = { fog: 1.2 - e * 0.6, storm: 1, lurker: this.isNight ? 1.4 + e * 0.4 : 0, volcano: 0.5 + e, armageddon: 0.2 + e * 1.2, tsunami: 0.35 + e * 0.8, tornado: 0.6 + e * 0.6 };
    let roll = Math.random() * WEATHER_KINDS.reduce((n, k) => n + weights[k], 0);
    let kind: WeatherKind = 'fog';
    for (const k of WEATHER_KINDS) {
      roll -= weights[k];
      if (roll <= 0) {
        kind = k;
        break;
      }
    }
    // level 1 at the start; by half an hour in, mostly 2s and 3s
    const level = THREE.MathUtils.clamp(1 + Math.round(e * 2 + (Math.random() - 0.5) * 1.2), 1, 3);
    this.start(kind, level, ship);
  }

  /** The mountain island nearest a point (peaks first, then ridges). */
  private mountainNear(p: THREE.Vector3): Island | null {
    const mounts = this.hooks.islands.filter((i) => i.type === 'peak');
    const pool = mounts.length ? mounts : this.hooks.islands.filter((i) => i.type === 'ridge');
    let best: Island | null = null;
    let bestD = Infinity;
    for (const i of pool) {
      const d = Math.hypot(i.center.x - p.x, i.center.z - p.z) + Math.random() * 120;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
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
      if (this.calm <= 0) this.nextEvent(ship);
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
        // calm spells shorten as the match goes on
        this.calm = (this.calmRange[0] + Math.random() * (this.calmRange[1] - this.calmRange[0])) * (1 - this.escalation * 0.55);
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
    // dawn sends the kraken back down
    if (ev?.kind === 'lurker' && !ev.ending && this.dayNight.daylight > 0.45) this.stop();
    if (this.lurkers.active) {
      const prey = this.prey();
      this.lurkers.update(dt, prey.length ? prey : [{ ...ship, hit: (d, at, shove) => this.hooks.hitShip(d, at, shove) }]);
      if (!ev || ev.kind !== 'lurker') this.lurkers.clear();
    }
    this.fleet.update(dt, ship, ev?.kind === 'armageddon' ? ev.weight : 0);
    // tsunami and waterspouts: they go for nobody, they just wander, and whatever is in the way suffers
    if (this.tsunami.active || this.spouts.active) {
      const prey = this.prey();
      const all = prey.length ? prey : [{ ...ship, hit: (d: number, at: THREE.Vector3, shove: THREE.Vector3) => this.hooks.hitShip(d, at, shove) }];
      this.tsunami.presence = ev?.kind === 'tsunami' ? ev.weight : 0;
      this.tsunami.update(dt, all);
      this.spouts.presence = ev?.kind === 'tornado' ? ev.weight : 0;
      this.spouts.update(dt, all);
    }
    const erupting = ev?.kind === 'volcano' ? ev.weight : 0;
    this.volcano.presence = erupting;
    this.volcano.update(dt, ship);
    this.ash.amount = erupting * [0.3, 0.55, 0.85][level - 1];
    this.ash.update(dt, camera.position, this.hooks.wind.direction, this.hooks.wind.strength, luminance(a.horizon));

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
      case 'volcano': {
        // a red, ash-choked sky: the light goes orange and the horizon closes in
        const k = THREE.MathUtils.clamp(bright, 0.4, 1);
        t.skyTop.set(0x2b1a17).multiplyScalar(k);
        t.skyMid.set(0x6a2c1c).multiplyScalar(k);
        t.horizon.set(0xb4502a).multiplyScalar(k);
        t.sunGlow.set(0xff4a14);
        t.sunVis *= 0.35;
        t.moonVis *= 0.35;
        t.stars = 0;
        t.cloudColor.set(0x4a3a36).multiplyScalar(k);
        t.cloudGlow.set(0x8a3a1a).multiplyScalar(k);
        t.lightColor.set(0xff9a6a);
        t.lightIntensity *= [0.75, 0.62, 0.5][lv];
        t.hemiSky.set(0xc7744f).multiplyScalar(k);
        t.hemiGround.set(0x2a1410);
        t.fogColor.set(0x6e3a2a).multiplyScalar(k);
        t.fogNear = 30;
        t.fogFar = [700, 520, 380][lv];
        t.skyFog = [0.35, 0.5, 0.65][lv];
        t.waterTint.set(0x5a2a1a);
        t.waterTintAmount = [0.3, 0.42, 0.55][lv];
        t.windScale = 1.1;
        break;
      }
      case 'tornado': {
        // a low, bruised green-grey sky and a hard wind
        const k = THREE.MathUtils.clamp(bright, 0.3, 1);
        t.skyTop.set(0x39443f).multiplyScalar(k);
        t.skyMid.set(0x5d6b63).multiplyScalar(k);
        t.horizon.set(0x8c9a8e).multiplyScalar(k);
        t.sunGlow.copy(t.horizon);
        t.sunVis *= 0.25;
        t.moonVis *= 0.25;
        t.stars = 0;
        t.cloudColor.set(0x56605a).multiplyScalar(k);
        t.cloudGlow.set(0x2a302c).multiplyScalar(k);
        t.fogColor.copy(t.horizon);
        t.fogNear = 60;
        t.fogFar = [1100, 950, 800][lv];
        t.skyFog = 0.25;
        t.lightIntensity *= [0.7, 0.6, 0.5][lv];
        t.waterTint.set(0x2e4a44);
        t.waterTintAmount = [0.2, 0.3, 0.4][lv];
        t.waveScale = [1.1, 1.2, 1.3][lv];
        t.windScale = [1.4, 1.6, 1.8][lv];
        break;
      }
      case 'tsunami': {
        // an eerie stillness: pale sky, the ordinary sea drawn down flat ahead of the great wave
        t.horizon.lerp(_c.set(0xb8c4c4), 0.4);
        t.skyMid.lerp(t.horizon, 0.3);
        t.fogColor.lerp(_c.set(0xa9b6b8), 0.4);
        t.lightIntensity *= 0.85;
        t.waterTint.set(0x1d4a5a);
        t.waterTintAmount = [0.15, 0.22, 0.3][lv];
        t.waveScale = [0.75, 0.65, 0.55][lv];
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
    this.volcano.clear();
    this.tsunami.clear();
    this.spouts.clear();
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
