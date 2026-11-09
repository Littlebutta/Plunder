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
  private dragDist = 0;
  private downAt = 0;
  private clickedNow = false;
  /** Right mouse button held (fires the swivel gun). */
  rightDown = false;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.rightDown = false;
    });
    // a second button going down or up while one is held arrives as a move, not a down/up
    target.addEventListener('pointermove', (e) => (this.rightDown = (e.buttons & 2) !== 0));

    target.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        this.rightDown = true;
        return;
      }
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragDist = 0;
      this.downAt = performance.now();
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointerup', (e) => {
      if (e.button === 2) {
        this.rightDown = false;
        return;
      }
      if (e.button !== 0) return;
      this.dragging = false;
      target.releasePointerCapture(e.pointerId);
      // A short press that barely moved is a click (select), not an orbit drag.
      if (this.dragDist < 6 && performance.now() - this.downAt < 600 && e.button === 0) this.clickedNow = true;
    });
    target.addEventListener('pointermove', (e) => {
      const r = target.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      this.pointer.inside = true;
      if (!this.dragging) return;
      this.dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.dragDist < 6) return; // ignore jitter
      this.dx += e.movementX;
      this.dy += e.movementY;
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

  /** Main guns: Space, held or tapped (the reload sets the pace). */
  get fire(): boolean {
    return this.isDown('Space');
  }

  /** Swivel gun: right mouse button, held or tapped. */
  get fireSwivel(): boolean {
    return this.rightDown;
  }

  /** True on the frame the player clicked (not dragged) on the scene. Used to select things. */
  get clicked(): boolean {
    return this.clickedNow;
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
  endFrame(): void {
    this.pressed.clear();
    this.clickedNow = false;
  }

  get element(): HTMLElement {
    return this.target;
  }
}
