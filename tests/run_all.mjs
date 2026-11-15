#!/usr/bin/env node
// Runs the verification suite on the built-in example environments.
// Needs python3 with `mujoco`, `numpy`, `scipy` for the cross-checks.
//   node tests/run_all.mjs
//   STEP_PARTS=<json from tests/step_parts.py> ENVS_CSV=<environments.csv> node tests/run_all.mjs   (also: CSV table vs. STEP files)
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), tmp = mkdtempSync(join(tmpdir(), 'shipblock-test-'));
const results = [];
function step(name, cmds) {
  console.log(`\n=== ${name}`);
  let ok = true;
  for (const [cmd, ...args] of cmds) { const r = spawnSync(cmd, args, { stdio: 'inherit' }); if (r.status !== 0) { ok = false; break; } }
  results.push([name, ok]);
}
step('Collision test (GJK) vs MuJoCo', [['node', join(here, 'gjk_pairs.mjs'), '6000', join(tmp, 'pairs.json')], ['python3', join(here, 'gjk_check.py'), join(tmp, 'pairs.json')]]);
step('URDF export / forward kinematics vs MuJoCo', [['node', join(here, 'fk_dump.mjs'), tmp], ['python3', join(here, 'fk_check.py'), tmp]]);
step('Environment CSV parser', [['node', join(here, 'csv_check.mjs')]]);
if (process.env.STEP_PARTS && process.env.ENVS_CSV) step('Environment table vs STEP', [['node', join(here, 'env_check.mjs'), process.env.STEP_PARTS, process.env.ENVS_CSV]]);
for (const [env, task] of [['example/cell-A', 'hole'], ['example/two-holes', 'hole:0:1'], ['example/cell-B', 'longi'], ['example/flat-bar-panel', 'longi']]) {
  const f = join(tmp, `traj_${results.length}.json`);
  step(`Planned trajectory replay (MuJoCo): ${env} ${task}`, [['node', join(here, 'traj_dump.mjs'), env, task, f], ['python3', join(here, 'traj_check.py'), f]]);
}
console.log('\n=== Summary');
for (const [n, ok] of results) console.log(`${ok ? '  OK  ' : ' FAIL '} ${n}`);
process.exit(results.every(r => r[1]) ? 0 : 1);
