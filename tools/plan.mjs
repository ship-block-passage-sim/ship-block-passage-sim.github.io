#!/usr/bin/env node
// CLI planner: node tools/plan.mjs (--env <id|substring> | --all) [--task hole|longi|<taskId>] [--envs table.csv | --examples]
//                                 [--params file.json] [--set key=value ...] [--opt key=value ...] [--json out.json] [--list] [-v]
// Environments: --envs <file.csv>; default is private/environments.csv when present, otherwise the built-in examples.
import { buildRobot } from '../src/robot.js';
import { listEnvs, buildEnv } from '../src/env.js';
import { plan } from '../src/planner.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnvsFromArgs } from './envs.mjs';
const args = process.argv.slice(2), get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
loadEnvsFromArgs(args);
if (args.includes('--list')) { for (const e of listEnvs()) console.log(e.id.padEnd(72), e.tasks.map(t => t.id).join(' ')); process.exit(0); }
let params = {}; if (get('--params')) params = JSON.parse(readFileSync(get('--params'), 'utf8'));
const opts = {};
args.forEach((a, i) => { if (a === '--set') { const [k, v] = args[i + 1].split('='); params[k] = isNaN(+v) ? v : +v; } if (a === '--opt') { const [k, v] = args[i + 1].split('='); opts[k] = +v; } });
const sel = get('--env') || listEnvs()[0].id, tsel = get('--task') || listEnvs()[0].tasks[0].type;
const all = args.includes('--all');
const envs = listEnvs().filter(e => all || e.id === sel || e.id.includes(sel));
let nOK = 0, nAll = 0; const t00 = Date.now(), why = {};
const robot = buildRobot(params);
for (const env of envs) {
  const geo = buildEnv(env);
  for (const task of env.tasks.filter(t => (all && !get('--task')) || t.id === tsel || t.type === tsel)) {
    const r = plan(robot, env, geo, task, opts, args.includes('-v') ? m => process.stderr.write(m + '\n') : undefined);
    console.log(`${r.ok ? 'SUCCESS' : 'FAIL   '} ${env.id} [${task.id}]  ${(r.stats.ms / 1000).toFixed(1)}s  frames=${r.frames.length} dur=${r.stats.duration.toFixed(0)}s checks=${r.stats.checks} rrt=${r.stats.rrtCalls}`);
    nAll++; if (r.ok) nOK++; else { const k = `${task.type} | ${r.failure.phase} | ${r.failure.reason}`; why[k] = (why[k] || 0) + 1; }
    if (!r.ok) console.log(`        phase: ${r.failure.phase} | ${r.failure.message}`);
    if (args.includes('-v')) { for (const l of r.log) console.log('        · ' + l); console.log('        info', JSON.stringify(r.info)); console.log('        phases:', r.phases.map(p => p.label).join(' → ')); }
    if (get('--json')) writeFileSync(get('--json'), JSON.stringify({ ...r, frames: r.frames.map(f => Array.from(f)) }));
  }
}
if (nAll > 1) { console.log(`\nTotal: ${nOK} / ${nAll} succeeded  (${((Date.now() - t00) / 1000).toFixed(1)} s)`); for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${n} failed: ${k}`); }
