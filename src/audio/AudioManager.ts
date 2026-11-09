import * as THREE from 'three';

/** Recorded sound files in public/sounds/ (name -> file). */
const SAMPLES = {
  cannon: 'sounds/cannon-fire.mp3',
  sailFull: 'sounds/sail-full.mp3',
} as const;
export type SampleName = keyof typeof SAMPLES;

/** Music tracks in public/music/ (name -> file). */
const MUSIC = {
  log: 'music/sailors-log.m4a',
  calm: 'music/sailing-the-calm-seas.m4a',
  fog: 'music/sailing-into-the-fog.m4a',
} as const;
export type MusicName = keyof typeof MUSIC;
/** Seconds to fade a track in or out. */
const MUSIC_FADE = 2.5;
/** Level of the music under the game's other sounds. */
const MUSIC_LEVEL = 0.55;

export interface PlayOptions {
  volume?: number;
  /** Playback rate; >1 is higher-pitched and shorter (a small gun). */
  rate?: number;
  /** Random +- variation applied to rate, so repeats don't sound identical. */
  rateJitter?: number;
  /** World position for 3D panning/attenuation; omit for UI/2D sounds. */
  position?: THREE.Vector3;
}

/**
 * Web Audio mixer: Devin's recorded samples plus a few synthesized sounds
 * (splashes, wood hits, ocean and wind beds) so the game has a full
 * soundscape before more recordings exist.
 *
 * Browsers only allow audio after a user gesture, so `unlock()` is wired to
 * the first key/pointer press.
 */
export type AudioBus = 'master' | 'effects' | 'ambience' | 'music';
const MASTER_GAIN = 0.9;

export class AudioManager {
  muted = false;
  /** 0..1 volume per bus, set from the settings panel. */
  readonly volumes: Record<AudioBus, number> = { master: 1, effects: 1, ambience: 1, music: 1 };
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Guns, splashes, hits. */
  private effects: GainNode | null = null;
  /** Sea and wind beds. */
  private ambience: GainNode | null = null;
  /** Music tracks play through here. */
  music: GainNode | null = null;
  private readonly buffers = new Map<SampleName, AudioBuffer>();
  private noise: AudioBuffer | null = null;
  private oceanGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private playlist: MusicName[] = [];
  private track: { name: MusicName; el: HTMLAudioElement; gain: GainNode } | null = null;
  private readonly musicUrls = new Map<MusicName, Promise<string>>();
  /** Limits how many copies of one sound may start within a short window. */
  private readonly recent = new Map<string, number[]>();

  constructor() {
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN * this.volumes.master;
    // Gentle limiter so a barrage doesn't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);
    const bus = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.master!);
      return g;
    };
    this.effects = bus(this.volumes.effects);
    this.ambience = bus(this.volumes.ambience);
    this.music = bus(this.volumes.music);

    this.noise = this.makeNoise(ctx, 6);
    this.startBeds(ctx);
    this.applyVolumes();
    if (this.playlist.length) this.startTrack(this.playlist[0]);
    for (const [name, url] of Object.entries(SAMPLES) as [SampleName, string][]) void this.load(name, url);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
  }

  /** Set one bus's volume (0..1). */
  setVolume(bus: AudioBus, v: number): void {
    this.volumes[bus] = Math.min(1, Math.max(0, v));
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // sliders feel even when the gain follows the square of the setting
    const sq = (v: number) => v * v;
    this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN * sq(this.volumes.master), t, 0.05);
    this.effects?.gain.setTargetAtTime(sq(this.volumes.effects), t, 0.05);
    this.ambience?.gain.setTargetAtTime(sq(this.volumes.ambience), t, 0.05);
    this.music?.gain.setTargetAtTime(sq(this.volumes.music), t, 0.05);
  }

  private async load(name: SampleName, url: string): Promise<void> {
    if (!this.ctx) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${url}`);
      const data = await res.arrayBuffer();
      this.buffers.set(name, await this.ctx.decodeAudioData(data));
    } catch (err) {
      console.warn(`Could not load sound ${url}`, err);
    }
  }

  /**
   * Set the music: the tracks play in order and the list repeats. If the track
   * playing now is in the new list it carries on, so moving between screens
   * that share a track does not restart it. An empty list fades the music out.
   */
  setPlaylist(names: MusicName[]): void {
    this.playlist = [...names];
    if (!this.ctx) return; // starts on unlock
    if (this.track && names.includes(this.track.name)) return;
    if (names.length) this.startTrack(names[0]);
    else this.stopTrack();
  }

  /** Name of the track playing now, if any. */
  get nowPlaying(): MusicName | null {
    return this.track?.name ?? null;
  }

  private stopTrack(): void {
    const old = this.track;
    this.track = null;
    if (!old || !this.ctx) return;
    const t = this.ctx.currentTime;
    old.gain.gain.cancelScheduledValues(t);
    old.gain.gain.setTargetAtTime(0, t, MUSIC_FADE / 3);
    window.setTimeout(() => {
      old.el.pause();
      old.gain.disconnect();
    }, MUSIC_FADE * 1000 + 200);
  }

  private startTrack(name: MusicName): void {
    const ctx = this.ctx;
    if (!ctx || !this.music) return;
    this.stopTrack();
    // The file is fetched whole and played from memory, so playback does not
    // depend on how the page is served (the desktop app uses its own protocol).
    let url = this.musicUrls.get(name);
    if (!url) {
      url = fetch(`${import.meta.env.BASE_URL}${MUSIC[name]}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => URL.createObjectURL(b));
      this.musicUrls.set(name, url);
    }
    const el = new Audio();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain).connect(this.music);
    const track = { name, el, gain };
    this.track = track;
    el.addEventListener('ended', () => {
      if (this.track !== track || this.playlist.length === 0) return;
      const at = this.playlist.indexOf(name);
      this.startTrack(this.playlist[(at + 1) % this.playlist.length]);
    });
    url
      .then((src) => {
        if (this.track !== track) return;
        el.src = src;
        return el.play().then(() => gain.gain.setTargetAtTime(MUSIC_LEVEL, ctx.currentTime, MUSIC_FADE / 3));
      })
      .catch((err) => {
        this.musicUrls.delete(name);
        console.warn(`Could not play music ${MUSIC[name]}`, err);
      });
  }

  /** Keep the 3D listener on the camera. */
  updateListener(camera: THREE.Camera): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = camera.getWorldPosition(_p);
    const f = camera.getWorldDirection(_f);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  /** Ambient beds: wind follows wind strength x how exposed the sail is. */
  updateAmbience(windStrength: number, sail: number, speed: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter || !this.oceanGain) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.008 + windStrength * (0.014 + Math.max(sail, 0) * 0.022), t, 0.4);
    this.windFilter.frequency.setTargetAtTime(260 + windStrength * 320, t, 0.4);
    this.oceanGain.gain.setTargetAtTime(0.2 + Math.min(speed, 6) * 0.03, t, 0.5);
  }

  play(name: SampleName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(name);
    if (!ctx || !buf || !this.effects || !this.allow(name, 10)) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const jitter = opts.rateJitter ?? 0;
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    src.connect(gain);
    this.route(gain, opts.position);
    src.start();
  }

  /** Synth splash: filtered noise with a sharp attack; bigger = lower and longer. */
  splash(position: THREE.Vector3, size = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.allow('splash', 14)) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200 / Math.sqrt(size), t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.5 * size + 0.2);
    const g = ctx.createGain();
    const dur = 0.35 + size * 0.45;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 * Math.min(size, 1.6), t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g);
    this.route(g, position);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** Synth wood crack + thump for hits on barrels and hulls. */
  woodHit(position: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.allow('wood', 8)) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    src.connect(bp).connect(g);
    this.route(g, position);
    src.start(t, Math.random(), 0.3);

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(og);
    this.route(og, position);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  private route(node: AudioNode, position?: THREE.Vector3): void {
    const ctx = this.ctx!;
    if (!position) {
      node.connect(this.effects!);
      return;
    }
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 8;
    pan.rolloffFactor = 1;
    pan.maxDistance = 2000;
    pan.positionX.value = position.x;
    pan.positionY.value = position.y;
    pan.positionZ.value = position.z;
    node.connect(pan).connect(this.effects!);
  }

  /** Voice limiter: at most `max` starts of `key` per 150 ms. */
  private allow(key: string, max: number): boolean {
    const now = performance.now();
    const list = (this.recent.get(key) ?? []).filter((t) => now - t < 150);
    if (list.length >= max) {
      this.recent.set(key, list);
      return false;
    }
    list.push(now);
    this.recent.set(key, list);
    return true;
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startBeds(ctx: AudioContext): void {
    // A looping noise source through a chain of filters into the ambience bus.
    const loop = (filters: BiquadFilterNode[], rate: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = 0;
      let node: AudioNode = src;
      for (const f of filters) node = node.connect(f);
      node.connect(g).connect(this.ambience!);
      src.start(0, Math.random() * 3);
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    // Ocean: a deep rumble with a slow swell. Two low-pass stages in a row cut
    // the hiss a single filter lets through; the noise is also played slow,
    // which shifts what is left further down.
    this.oceanGain = loop([filter('lowpass', 230), filter('lowpass', 300)], 0.5);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain).connect(this.oceanGain.gain);
    lfo.start();
    // Wind: a soft low whoosh, not a hiss.
    this.windFilter = filter('bandpass', 400, 1.1);
    this.windGain = loop([this.windFilter, filter('lowpass', 900)], 0.8);
  }
}

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
