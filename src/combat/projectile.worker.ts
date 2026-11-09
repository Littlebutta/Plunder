/// <reference lib="webworker" />
/**
 * Projectile worker: owns every shell in flight. The main thread sends one
 * `tick` per frame (spawns, colliders, sea state, elapsed time); the worker
 * steps the simulation and transfers back a snapshot + impact events.
 */
import { ProjectileSim } from './ProjectileSim';
import type { WorkerRequest, WorkerResponse } from './protocol';

const sim = new ProjectileSim();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.shore) sim.setShore(msg.shore);
  if (msg.sea) sim.setSeaState(msg.sea);
  if (msg.colliders) sim.setColliders(msg.colliders);
  if (msg.spawns && msg.spawns.length) sim.spawn(msg.spawns);
  const r = sim.step(msg.dt, msg.waveTime);
  const res: WorkerResponse = { ...r, frame: msg.frame };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, [r.snapshot.buffer, r.events.buffer]);
};
