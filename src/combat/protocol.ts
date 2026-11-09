import type { SeaState } from '../ocean/waves';
import type { StepResult } from './ProjectileSim';

export interface WorkerRequest {
  frame: number;
  /** Seconds of game time to advance. */
  dt: number;
  /** Wave clock at the end of this step. */
  waveTime: number;
  /** Packed spawns [x y z vx vy vz kind owner] * n. */
  spawns?: Float32Array;
  /** Packed colliders [x y z r id] * n (replaces the previous set). */
  colliders?: Float32Array;
  /** Sent only when the sea state changes. */
  sea?: SeaState;
}

export interface WorkerResponse extends StepResult {
  frame: number;
}
