// Web Worker: runs one planning job and returns packed frames.
// The environment description itself is sent with the job (it may come from a CSV loaded in the page).
import { buildRobot } from './robot.js';
import { buildEnv } from './env.js';
import { plan } from './planner.js';

self.onmessage = e => {
  const { id, params, env, taskId, opts } = e.data;
  try {
    const robot = buildRobot(params), geo = buildEnv(env), task = env.tasks.find(t => t.id === taskId);
    const r = plan(robot, env, geo, task, opts, msg => self.postMessage({ id, progress: msg }));
    const W = r.frames[0].length, buf = new Float32Array(r.frames.length * W);
    r.frames.forEach((f, i) => buf.set(f, i * W));
    self.postMessage({ id, result: { ...r, frames: buf, frameWidth: W } }, [buf.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
