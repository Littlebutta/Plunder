/**
 * Keyboard + mouse state. Gameplay code reads axes; it never touches DOM events.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();

  /** Mouse drag delta accumulated since last `consumeMouse()` (pixels). */
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  dragging = false;
  /** Seconds since the user last orbited the camera by hand. */
  idleOrbit = Infinity;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    target.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointerup', (e) => {
      this.dragging = false;
      target.releasePointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.idleOrbit = 0;
    });
    target.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  axis(neg: string[], pos: string[]): number {
    return (this.isDown(...pos) ? 1 : 0) - (this.isDown(...neg) ? 1 : 0);
  }

  get throttle(): number {
    return this.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
  }

  get steer(): number {
    return this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
  }

  consumeMouse(): { dx: number; dy: number; wheel: number } {
    const r = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = this.dy = this.wheel = 0;
    return r;
  }

  /** Call at the end of each frame. */
  endFrame(dt: number): void {
    this.pressed.clear();
    if (!this.dragging) this.idleOrbit += dt;
  }

  get element(): HTMLElement {
    return this.target;
  }
}
