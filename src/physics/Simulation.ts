/**
 * Fixed-timestep driver. Waves and every floating body advance together in
 * lockstep, so buoyancy always sees the water at the same moment the hull is
 * at, regardless of render frame rate.
 */
export class Simulation {
  static readonly DT = 1 / 120;
  private accumulator = 0;

  constructor(
    private readonly maxSteps = 10,
  ) {}

  /** Runs `step(h)` as many times as needed for this frame's `dt`. */
  advance(dt: number, step: (h: number) => void): void {
    this.accumulator += Math.min(dt, 0.1);
    let n = 0;
    while (this.accumulator >= Simulation.DT && n < this.maxSteps) {
      step(Simulation.DT);
      this.accumulator -= Simulation.DT;
      n++;
    }
    if (n === this.maxSteps) this.accumulator = 0; // drop time rather than spiral
  }
}
