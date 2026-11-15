// Compares an environment table (CSV) with the parts extracted from the STEP files it was taken from.
// usage: node tests/env_check.mjs <step_parts.json from tests/step_parts.py> <environments.csv>
// Rows need the columns step_file (and step_prefix when one STEP file holds several environments).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { envsFromCSV, buildEnv } from '../src/env.js';
const [stepJson, csvPath] = process.argv.slice(2);
if (!stepJson || !csvPath) { console.error('usage: node tests/env_check.mjs <step_parts.json> <environments.csv>'); process.exit(2); }
const step = JSON.parse(readFileSync(stepJson)), { envs, errors } = envsFromCSV(readFileSync(csvPath, 'utf8'));
for (const e of errors) console.log('CSV:', e);
let nEnv = 0, nPart = 0, bad = errors.length, maxBB = 0, maxVol = 0; const skipped = [], usedFiles = new Set();
for (const e of envs) {
  const file = e.stepFile && basename(e.stepFile);
  if (!file || !step[file]) { skipped.push(e.id); continue; }
  usedFiles.add(file);
  const mine = step[file].filter(p => p.name.startsWith(e.stepPrefix || ''));
  const sp = mine.filter(p => !p.name.includes('floorbead')), js = buildEnv(e).parts;
  if (mine.length - sp.length !== e.beads.length) { bad++; console.log('BEAD COUNT', e.id, mine.length - sp.length, e.beads.length); }
  if (sp.length !== js.length) { bad++; console.log('PART COUNT', e.id, 'step', sp.length, 'csv', js.length); continue; }
  const sf = sp.find(p => /floor$/.test(p.name)), off = [sf.bbox[0] - js[0].bbox[0], sf.bbox[1] - js[0].bbox[1], 0], used = new Set();
  for (const jp of js) {       // match every part to the STEP part with the closest bounding box
    let best = -1, bd = Infinity;
    sp.forEach((p, i) => { if (used.has(i)) return; let d = 0; for (let k = 0; k < 6; k++) d = Math.max(d, Math.abs(p.bbox[k] - off[k % 3] - jp.bbox[k])); if (d < bd) { bd = d; best = i; } });
    used.add(best); const p = sp[best];
    const dv = Math.abs(p.volume - jp.volume) / p.volume, isWall = jp.name.startsWith('wall');
    maxBB = Math.max(maxBB, bd); if (!isWall) maxVol = Math.max(maxVol, dv);
    if (bd > 1e-3 || dv > (isWall ? 2e-3 : 1e-6)) { bad++; console.log('MISMATCH', e.id, jp.name, '<>', p.name, 'bbox diff', bd.toFixed(4), 'vol rel diff', dv.toExponential(2)); }
    nPart++;
  }
  nEnv++;
}
console.log(`environments checked against STEP: ${nEnv} (parts ${nPart}), mismatches: ${bad}, max bbox diff ${maxBB.toExponential(2)} mm, max non-wall volume diff ${maxVol.toExponential(2)}`);
console.log(`rows without a STEP counterpart: ${skipped.length}`);
console.log('STEP files not referenced:', Object.keys(step).filter(f => !usedFiles.has(f)).join(', ') || '-');
process.exit(bad ? 1 : 0);
