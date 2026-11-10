import * as THREE from 'three';

const W = 128;
const H = 16;

/**
 * A health bar that hangs over something in the world and always faces the
 * camera. It is one sprite with its own little picture (a dark rim, a dark
 * trough and the coloured fill), redrawn only when the health shown changes.
 *
 * Forts used to draw theirs as two sprites, a dark back and a fill offset to
 * one side. A sprite always faces the camera but the offset did not, so from
 * most angles the fill slid off the back and left dark slabs hanging in the sky.
 */
export class HealthBar {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private shown = -1;

  /** @param width in metres (the height follows) */
  constructor(width = 6) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(width, (width * H) / W, 1);
    this.sprite.renderOrder = 9;
    this.sprite.name = 'health-bar';
    this.set(1);
  }

  /** Health 0..1. Full health hides the bar. */
  set(f: number): void {
    f = THREE.MathUtils.clamp(f, 0, 1);
    this.sprite.visible = f < 0.999;
    const step = Math.round(f * 100);
    if (step === this.shown) return;
    this.shown = step;
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    round(c, 0, 0, W, H, 6);
    c.fillStyle = 'rgba(42, 23, 8, 0.92)';
    c.fill();
    round(c, 3, 3, W - 6, H - 6, 4);
    c.fillStyle = 'rgba(255, 240, 215, 0.18)';
    c.fill();
    const fw = Math.max(0, (W - 6) * (step / 100));
    if (fw > 0.5) {
      round(c, 3, 3, fw, H - 6, Math.min(4, fw / 2));
      c.fillStyle = f > 0.5 ? '#7ed957' : f > 0.25 ? '#ffc04d' : '#e23b3b';
      c.fill();
      // a lighter band along the top keeps it from reading as a flat slab
      c.fillStyle = 'rgba(255, 255, 255, 0.28)';
      c.fillRect(5, 4, Math.max(0, fw - 4), 2);
    }
    this.texture.needsUpdate = true;
  }
}

function round(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
