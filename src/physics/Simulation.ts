/**
 * Physics stepping. Each frame's time is split into equal substeps of at most
 * `DT`, and waves and every floating body advance together through them, so
 * buoyancy always sees the water at the same moment the hull is at.
 *
 * The substeps follow the frame exactly (no leftover carried to the next
 * frame), so the ships move smoothly at any refresh rate: a fixed step without
 * interpolation made frames alternate between one and two steps (or two and
 * three) and the whole view judder, most of all on 75, 144 or 165 Hz screens.
 */
export class Simulation {
  static readonly DT = 1 / 120;

  constructor(
    private readonly maxSteps = 10,
  ) {}

  /** Runs `step(h)` enough times, with equal `h`, to cover this frame's `dt`. */
  advance(dt: number, step: (h: number) => void): void {
    const t = Math.min(dt, 0.1);
    if (!(t > 0)) return;
    const n = Math.min(this.maxSteps, Math.ceil(t / Simulation.DT - 1e-6));
    const h = t / n;
    for (let i = 0; i < n; i++) step(h);
  }
}
