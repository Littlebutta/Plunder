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
  /** Pointer position in normalized device coords (-1..1), for aiming. */
  readonly pointer = { x: 0, y: -0.2, inside: false };
  private downAt = 0;
  private dragDist = 0;
  private clicked = false;
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
      this.downAt = performance.now();
      this.dragDist = 0;
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointerup', (e) => {
      this.dragging = false;
      target.releasePointerCapture(e.pointerId);
      // A short press that barely moved is a click (fire), not an orbit drag.
      if (this.dragDist < 6 && performance.now() - this.downAt < 600 && e.button === 0) this.clicked = true;
    });
    target.addEventListener('pointermove', (e) => {
      const r = target.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      this.pointer.inside = true;
      if (!this.dragging) return;
      this.dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.dragDist < 6) return; // ignore jitter during a click
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.idleOrbit = 0;
    });
    target.addEventListener('pointerleave', () => (this.pointer.inside = false));
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

  get trim(): number {
    return this.axis(['KeyQ'], ['KeyE']);
  }

  /** Fire request this frame: a click on the sea or Space. */
  get fire(): boolean {
    return this.clicked || this.wasPressed('Space');
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
    this.clicked = false;
    if (!this.dragging) this.idleOrbit += dt;
  }

  get element(): HTMLElement {
    return this.target;
  }
}
