import * as THREE from 'three';

/** Recorded sound files in public/sounds/ (name -> file). */
const SAMPLES = {
  cannon: 'sounds/cannon-fire.mp3',
  sailFull: 'sounds/sail-full.mp3',
} as const;
export type SampleName = keyof typeof SAMPLES;

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
export class AudioManager {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<SampleName, AudioBuffer>();
  private noise: AudioBuffer | null = null;
  private oceanGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
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
    this.master.gain.value = this.muted ? 0 : 0.9;
    // Gentle limiter so a barrage doesn't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    this.master.connect(comp).connect(ctx.destination);

    this.noise = this.makeNoise(ctx, 2);
    this.startBeds(ctx);
    for (const [name, url] of Object.entries(SAMPLES) as [SampleName, string][]) void this.load(name, url);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
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
    this.windGain.gain.setTargetAtTime(0.025 + windStrength * (0.04 + Math.max(sail, 0) * 0.06), t, 0.4);
    this.windFilter.frequency.setTargetAtTime(500 + windStrength * 900, t, 0.4);
    this.oceanGain.gain.setTargetAtTime(0.12 + Math.min(speed, 6) * 0.025, t, 0.5);
  }

  play(name: SampleName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(name);
    if (!ctx || !buf || !this.master || !this.allow(name, 10)) return;
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
      node.connect(this.master!);
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
    node.connect(pan).connect(this.master!);
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
    const loop = (filterType: BiquadFilterType, freq: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master!);
      src.start();
      return { f, g };
    };
    // Ocean: low rumble with a slow swell LFO.
    const ocean = loop('lowpass', 420);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(ocean.g.gain);
    lfo.start();
    this.oceanGain = ocean.g;
    // Wind: band-passed hiss.
    const wind = loop('bandpass', 800);
    wind.f.Q.value = 0.6;
    this.windGain = wind.g;
    this.windFilter = wind.f;
  }
}

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
