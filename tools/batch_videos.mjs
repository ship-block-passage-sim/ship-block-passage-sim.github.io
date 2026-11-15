#!/usr/bin/env node
// Batch planning + MP4 export without opening a browser window (drives the web app in headless Chrome).
//   node tools/batch_videos.mjs [--params robot_params.json] [--env <id substring>]... [--group <substring>]... [--all]
//                               [--envs table.csv | --examples] [--task hole|longi|both] [--only success|fail] [--out videos] [--speed 3]
//                               [--width 1280 --height 720 --fps 30] [--no-video] [--software] [--chrome /path/to/chrome]
// (--software: render without the GPU; slower, use it if the videos come out blank)
// Environments: --envs <file.csv>; default is private/environments.csv when present, otherwise the built-in examples.
// Output: <out>/SUCCESS__*.mp4, <out>/FAIL__*.mp4, <out>/results.csv, <out>/results.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './serve.mjs';
import { listEnvs } from '../src/env.js';
import { loadEnvsFromArgs } from './envs.mjs';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const vals = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
if (args.includes('-h') || args.includes('--help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch { console.error('puppeteer-core is missing. Run `npm install` in the project folder first.'); process.exit(1); }
const chrome = val('--chrome') || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!chrome) { console.error('Chrome executable not found. Pass it with --chrome <path>.'); process.exit(1); }

const envTable = loadEnvsFromArgs(args);
const envSel = vals('--env'), groupSel = vals('--group'), taskSel = val('--task', 'both'), only = val('--only');
const jobs = [];
for (const e of listEnvs()) {
  if (!args.includes('--all') && !(envSel.some(s => e.id.includes(s)) || groupSel.some(s => e.group.includes(s)))) continue;
  for (const t of e.tasks) if (taskSel === 'both' || t.type === taskSel || t.id === taskSel) jobs.push({ envId: e.id, taskId: t.id });
}
if (!jobs.length) { console.error('No task selected. Use --env <id substring>, --group <group substring> or --all. (List environments: node tools/plan.mjs --list)'); process.exit(1); }
const out = val('--out', 'videos'); mkdirSync(out, { recursive: true });
const params = val('--params') ? JSON.parse(readFileSync(val('--params'), 'utf8')) : null;
const vopts = { speed: +val('--speed', 3), width: +val('--width', 1280), height: +val('--height', 720), fps: +val('--fps', 30) };

const server = await startServer(0); const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', protocolTimeout: 0, args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', ...(args.includes('--software') ? ['--use-angle=swiftshader'] : ['--use-angle=gl-egl'])] });
let failed = false;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => console.error('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?examples=1`, { waitUntil: 'networkidle0' });   // the table is set explicitly below
  if (envTable.text) await page.evaluate((t, n) => { window.__app.loadEnvCSV(t, n, false); }, envTable.text, envTable.name);
  if (params) await page.evaluate(p => window.__app.setParams(p), params);
  console.log(`Planning ${jobs.length} task(s) …`);
  let done = 0; await page.exposeFunction('__tick', () => { done++; process.stdout.write(`\r  ${done} / ${jobs.length}`); });
  const res = await page.evaluate(j => window.__app.planMany(j, () => window.__tick()), jobs);
  process.stdout.write('\n');
  const usedParams = await page.evaluate(() => window.__app.S.params);
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = [['environment', 'task', 'result', 'failed_phase', 'reason', 'motion_s', 'compute_s', 'video'].join(',')];
  for (let i = 0; i < res.length; i++) {
    const r = res[i]; if (r.error) { failed = true; console.log(`  ERROR    ${r.envId} [${r.taskId}]: ${r.error}`); continue; }
    console.log(`  ${r.ok ? 'SUCCESS' : 'FAIL   '}  ${r.envId} [${r.taskId}]${r.ok ? '' : `  — ${r.failure.phase}: ${r.failure.message}`}`);
    let file = '';
    if (!args.includes('--no-video') && (!only || (only === 'success') === r.ok)) {
      const b64 = await page.evaluate((k, o) => window.__app.videoBase64(k, o), i, vopts);
      file = r.file; writeFileSync(join(out, file), Buffer.from(b64, 'base64'));
    }
    csv.push([q(r.envId), q(r.taskLabel), r.ok ? 'SUCCESS' : 'FAIL', q(r.failure?.phase), q(r.failure?.message), r.stats.duration.toFixed(1), (r.stats.ms / 1000).toFixed(2), q(file)].join(','));
  }
  writeFileSync(join(out, 'results.csv'), '﻿' + csv.join('\n') + '\n');
  writeFileSync(join(out, 'results.json'), JSON.stringify({ params: usedParams, results: res }, null, 2));
  const ok = res.filter(r => r.ok).length;
  console.log(`Done: ${ok} succeeded · ${res.length - ok} failed / ${res.length}  →  ${out}/`);
} catch (e) { failed = true; console.error(e); } finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
