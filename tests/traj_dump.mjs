// Plans a task and dumps everything an independent checker needs (URDF, environment pieces, trajectory).
// usage: node tests/traj_dump.mjs <envId-substring> <hole|longi|taskId> <out.json> [--envs table.csv] [key=value ...]
// Without --envs the built-in example environments are used.
import { buildRobot } from '../src/robot.js';
import { listEnvs, buildEnv } from '../src/env.js';
import { loadEnvsFromArgs } from '../tools/envs.mjs';
import { plan, PLAN_DEFAULTS } from '../src/planner.js';
import { toURDF } from '../src/urdf.js';
import { BOX } from '../src/collide.js';
import { writeFileSync } from 'node:fs';
const [sel, tsel, out, ...rest] = process.argv.slice(2);
const ei = rest.indexOf('--envs'); loadEnvsFromArgs(ei >= 0 ? ['--envs', rest[ei + 1]] : ['--examples'], { quiet: true });
const kv = rest.filter((a, i) => a.includes('=') && !(ei >= 0 && i === ei + 1));
const params = {}; for (const a of kv) { const [k, v] = a.split('='); params[k] = isNaN(+v) ? v : +v; }
const env = listEnvs().find(e => e.id.includes(sel));
if (!env) { console.error(`No environment matches "${sel}"`); process.exit(1); }
const geo = buildEnv(env), task = env.tasks.find(t => t.id === tsel || t.type === tsel);
const robot = buildRobot(params), r = plan(robot, env, geo, task, {});
const joints = robot.links.filter(L => L.qi >= 0).map(L => ({ name: L.jname, qi: L.qi, prismatic: L.jtype === 'prismatic' }));
const shapes = robot.shapes.map(s => ({ name: s.name, link: robot.links[s.link].name, wheel: !!s.isWheel, liftFoot: !!s.isLiftFoot }));
const envShapes = geo.shapes.filter(s => !s.isFloor).map(s => s.type === BOX ? { type: 'box', name: s.name, p: Array.from(s.p), half: [s.hx, s.hy, s.hz] } : { type: 'hull', name: s.name, verts: Array.from(s.verts) });
writeFileSync(out, JSON.stringify({ env: env.id, task: task.id, ok: r.ok, failure: r.failure, urdf: toURDF(robot), joints, shapes, envShapes,
  envMargin: PLAN_DEFAULTS.envMargin, selfMargin: PLAN_DEFAULTS.selfMargin, frames: r.frames.map(f => Array.from(f)) }));
console.log(`${r.ok ? 'SUCCESS' : 'FAIL'} ${env.id} [${task.id}] frames=${r.frames.length} -> ${out}`);
