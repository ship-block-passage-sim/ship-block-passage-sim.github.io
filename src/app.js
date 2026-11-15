// UI: parameter panel, environment/task selection, planning (web workers), playback, MP4 export.
import { Viewer, Trajectory } from './viewer.js';
import { PARAM_SCHEMA, defaultParams, buildRobot, NQ, Q_FOLD_F, Q_FOLD_R, Q_SLIDE } from './robot.js';
import { listEnvs, getEnv, buildEnv, loadCatalogCSV, useExamples, catalogSource, EXAMPLE_CSV } from './env.js';
import { toURDF, toSRDF } from './urdf.js';
import { diagnose } from './planner.js';
import { PRESETS } from './presets.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const LS_KEY = 'shipblock-sim-params-v1';
const LS_ENV = 'shipblock-sim-envcsv-v1';   // environment CSV loaded by the user (kept in this browser only)

const S = { params: null, robot: null, env: null, geo: null, task: null, cur: null, t: 0, playing: false, manual: null, batch: [], busy: 0, stale: false, hlCache: new Map() };
const viewer = new Viewer($('gl'));
const hud = $('hud'), hctx = hud.getContext('2d');

// ------------------------------------------------------------------ parameters
function loadParams() {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY)); if (p && typeof p === 'object') return { ...defaultParams(), ...p }; } catch { /* ignore */ }
  return { ...defaultParams(), ...Object.values(PRESETS)[0] };
}
function buildParamForm() {
  const form = $('params'); form.innerHTML = '';
  const groups = new Map();
  for (const row of PARAM_SCHEMA) { if (!groups.has(row[3])) groups.set(row[3], []); groups.get(row[3]).push(row); }
  let adv = null;
  for (const [gname, rows] of groups) {
    const isAdv = gname.startsWith('Advanced');
    if (isAdv && !adv) { adv = document.createElement('details'); adv.className = 'adv'; adv.innerHTML = '<summary>Advanced settings (geometry assumptions · joint limits · masses)</summary>'; form.appendChild(adv); }
    const fs = document.createElement('fieldset'); fs.innerHTML = `<legend>${gname.replace('Advanced: ', '').replace(/^./, c => c.toUpperCase())}</legend>`;
    for (const [key, def, label, , unit] of rows) {
      const d = document.createElement('div'); d.className = 'p';
      let input;
      if (key === 'hipMount') input = `<select name="${key}"><option value="end">along length (end)</option><option value="side">across (side)</option></select>`;
      else if (key === 'liftFold') input = `<select name="${key}"><option value="1">foldable</option><option value="0">fixed vertical</option></select>`;
      else input = `<input type="number" name="${key}" step="${Number.isInteger(def) ? 1 : 0.1}" min="0">`;
      d.innerHTML = `<label for="p_${key}">${label}${unit ? ` <span class="u">[${unit}]</span>` : ''}</label>${input}`;
      d.lastElementChild.id = `p_${key}`; fs.appendChild(d);
    }
    (isAdv ? adv : form).appendChild(fs);
  }
  form.addEventListener('input', () => { readForm(); onParamsChanged(); });
}
function writeForm() { for (const [key] of PARAM_SCHEMA) { const el = $('p_' + key); if (el) el.value = S.params[key]; } }
function readForm() {
  for (const [key, def] of PARAM_SCHEMA) {
    const el = $('p_' + key); if (!el) continue;
    if (typeof def === 'number') { const v = parseFloat(el.value); if (Number.isFinite(v)) S.params[key] = v; } else S.params[key] = el.value;
  }
}
function onParamsChanged() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S.params)); } catch { /* storage unavailable */ }
  S.robot = buildRobot(S.params); viewer.setRobot(S.robot);
  $('warnings').innerHTML = S.robot.warnings.map(w => `<div>${w}</div>`).join('');
  if (S.cur) { S.cur = null; S.stale = true; renderResult(); }
  S.hlCache.clear(); S.playing = false; updatePlayButton(); showFrame();
}
function paramSummary(p = S.params) {
  return `Plate ${p.plateL}×${p.plateW}×${p.plateT} · actuator ⌀${p.actD}×${p.actT} · links ${p.L1}/${p.L2}/${p.L3} · payload ${p.payL}×${p.payW}×${p.payH} · lift spacing ${p.liftSX}×${p.liftSY}, legs ${p.liftLen}+${p.liftStroke}`;
}

// ------------------------------------------------------------------ environment / task
/** Environments of the current source selection (all of them when the table has no source column). */
function visibleEnvs() { return listEnvs().filter(e => !S.source || e.source === S.source); }
/** One filter button per data source of the loaded table (hidden when there are fewer than two). */
function renderSourceChips() {
  const box = $('sourceChips'), all = listEnvs(), sources = [...new Set(all.map(e => e.source).filter(Boolean))];
  if (S.source && !sources.includes(S.source)) S.source = '';
  box.hidden = sources.length < 2; box.innerHTML = '';
  if (box.hidden) return;
  const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Source'; box.appendChild(lbl);
  for (const s of ['', ...sources]) {
    const b = document.createElement('button'), n = s ? all.filter(e => e.source === s).length : all.length;
    b.dataset.source = s; b.className = (S.source || '') === s ? 'on' : '';
    b.innerHTML = `${esc(s || 'All')}<span class="n">${n}</span>`;
    b.onclick = () => setSource(s); box.appendChild(b);
  }
}
/** Restrict the environment list, the overview and "Batch: all" to one data source ('' = all). */
function setSource(s) {
  S.source = s || ''; renderSourceChips(); buildEnvSelect();
  const wasOverview = !!S.overview;
  if (!visibleEnvs().some(e => e.id === S.env.id)) selectEnv(visibleEnvs()[0].id);
  else $('env').value = S.env.id;
  if (wasOverview) { setOverview(false, { fit: false }); setOverview(true); }
  updateBatchLabel(); renderBatch();
}
function updateBatchLabel() { const n = visibleEnvs().length; $('btnBatchAll').textContent = S.source ? `Batch: all ${S.source} (${n})` : `Batch: all (${n})`; }
function buildEnvSelect() {
  const sel = $('env'); sel.innerHTML = '';
  const groups = new Map();
  for (const e of visibleEnvs()) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group).push(e); }
  for (const [gname, envs] of groups) {
    const og = document.createElement('optgroup'); og.label = gname;
    for (const e of envs) { const o = document.createElement('option'); o.value = e.id; o.textContent = e.label; og.appendChild(o); }
    sel.appendChild(og);
  }
}
/** Shows where the environments come from; lists problems found in the CSV. */
function renderEnvSource(errors = []) {
  const s = catalogSource(), n = listEnvs().length;
  $('envSource').textContent = s.kind === 'csv' ? `${s.name} · ${n} environments${S.envStored ? ' (kept in this browser only)' : ''}` : `Built-in examples (${n}). Load a CSV for your own dimensions.`;
  $('btnEnvReset').hidden = s.kind !== 'csv';
  const box = $('envErrors'); box.hidden = !errors.length; box.innerHTML = errors.map(e => `<div>${esc(e)}</div>`).join('');
}
/** Rebuild lists and views after the catalogue changed. */
function catalogChanged(errors) {
  S.batch = []; S.cur = null; S.stale = false; S.hlCache.clear();
  S.source = ''; renderSourceChips(); buildEnvSelect(); selectEnv(listEnvs()[0].id); updateBatchLabel(); renderBatch(); renderEnvSource(errors);
}
/** Load an environment table (CSV text). persist: remember it in this browser. Returns { envs, errors }. */
function loadEnvCSV(text, name = 'environments.csv', persist = true) {
  const r = loadCatalogCSV(text, name);
  if (!r.envs.length) { const errs = [`${name}: no usable environment found.`, ...r.errors]; renderEnvSource(errs); const box = $('startErrors'); box.hidden = false; box.innerHTML = errs.map(e => `<div>${esc(e)}</div>`).join(''); return r; }
  $('startDlg').hidden = true; $('startErrors').hidden = true;
  if (persist) { try { localStorage.setItem(LS_ENV, JSON.stringify({ name, text })); S.envStored = true; } catch { /* storage unavailable */ } }
  catalogChanged(r.errors); return r;
}
function resetEnvs() { try { localStorage.removeItem(LS_ENV); } catch { /* ignore */ } S.envStored = false; useExamples(); catalogChanged([]); }
/** At start-up: a CSV stored earlier, else ?envs=<url>, else (local development only) private/environments.csv. ?examples=1 skips all of it. */
async function restoreEnvs(url) {
  if (url.get('examples')) return;
  let loaded = false;
  try { const st = JSON.parse(localStorage.getItem(LS_ENV)); if (st && st.text) { S.envStored = true; loaded = loadEnvCSV(st.text, st.name, false).envs.length > 0; } } catch { /* ignore */ }
  if (!loaded) {
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const src = url.get('envs') || (local ? 'private/environments.csv' : null);
    if (src) { try { const res = await fetch(src, { cache: 'no-store' }); if (res.ok) loaded = loadEnvCSV(await res.text(), src.split('/').pop(), false).envs.length > 0; } catch { /* not available */ } }
  }
  if (loaded && url.get('env')) selectEnv(url.get('env'), url.get('task'));
  if (!loaded) $('startDlg').hidden = false;      // nothing loaded yet: ask for the environment CSV right away
}
/** envId -> {status, sub} for the overview tiles, from the batch results. */
function envStatusMap() {
  const m = {};
  for (const e of listEnvs()) {
    const rs = S.batch.filter(b => b.env.id === e.id && b.result), ok = rs.filter(b => b.result.ok).length, n = e.tasks.length;
    m[e.id] = !rs.length ? { status: 'none', sub: `${n} task${n > 1 ? 's' : ''}` } : { status: ok === rs.length ? 'ok' : ok === 0 ? 'fail' : 'partial', sub: `${ok} / ${rs.length} passed` };
  }
  return m;
}
const viewAspect = () => $('view').clientWidth / Math.max(1, $('view').clientHeight);
/** Show / hide all environments side by side. fit: move the camera to show everything (or back to the default view). */
function setOverview(on, { fit = true } = {}) {
  on = !!on; if (on === !!S.overview) return;
  S.overview = on; $('btnOverview').classList.toggle('on', on);
  if (on) {
    const st = envStatusMap();
    viewer.setOverview(visibleEnvs().map(e => ({ env: e, geo: e.id === S.env.id ? S.geo : buildEnv(e), status: st[e.id].status, sub: st[e.id].sub })), S.env.id);
    viewer.setSection(null);
    if (fit) { const v = viewer.overviewView(viewAspect()); viewer.lookFrom(v.pos, v.target); }
  } else { viewer.clearOverview(); viewer.setSection(sectionSpec()); if (fit) setView('iso'); }
  showFrame();
}
function selectEnv(id, taskId) {
  const env = getEnv(id); if (!env) return;
  if (S.overview) setOverview(false, { fit: false });
  S.env = env; S.geo = buildEnv(env); $('env').value = id;
  viewer.setEnv(env, S.geo); viewer.setWallOpacity(parseFloat($('wallOpacity').value));
  const ts = $('task'); ts.innerHTML = '';
  for (const t of env.tasks) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; ts.appendChild(o); }
  selectTask(taskId && env.tasks.some(t => t.id === taskId) ? taskId : env.tasks[0].id);
}
function selectTask(id) {
  S.task = S.env.tasks.find(t => t.id === id) || S.env.tasks[0]; $('task').value = S.task.id;
  const b = S.batch.find(r => r.env.id === S.env.id && r.task.id === S.task.id && r.result);
  S.cur = b ? makeCur(b.result, S.env, S.task) : null; S.t = 0; S.playing = false; S.hlCache.clear();
  viewer.setSection(sectionSpec()); setView('iso'); renderResult(); updatePlayButton(); showFrame();
}
function viewFor(kind) {
  const env = S.env, task = S.task;
  let c, span;
  if (task.type === 'hole') { const w = env.walls[task.wall], h = w.holes[task.hole]; c = [h.c, w.y0, h.sill * 0.5 + 200]; span = 1; }
  else { const l = env.longis[task.longi]; c = [l.c + 250, task.y, 320]; span = 1; }
  const k = span;
  if (kind === 'side') return { pos: [c[0] + 5200 * k, c[1], c[2] + 900], target: c };
  if (kind === 'front') return { pos: [c[0], c[1] - 5200 * k, c[2] + 1100], target: c };
  if (kind === 'top') return { pos: [c[0], c[1] - 1, c[2] + 6500 * k], target: c };
  return task.type === 'hole' ? { pos: [c[0] + 3300, c[1] - 2900, c[2] + 2000], target: [c[0], c[1] - 300, c[2] - 150] } : { pos: [c[0] + 900, c[1] - 3900, c[2] + 2100], target: [c[0], c[1], c[2] - 100] };
}
function setView(kind) { const v = viewFor(kind); viewer.lookFrom(v.pos, v.target); }
function sectionSpec() {
  if (!$('showSection').checked) return null;
  const env = S.env, task = S.task;
  if (task.type === 'hole') { const w = env.walls[task.wall], h = w.holes[task.hole]; return { type: 'hole', xc: h.c, yc: w.y0 - 300, halfH: Math.max(1050, (w.height + 300) / 2) }; }
  const l = env.longis[task.longi]; return { type: 'longi', xc: l.c + 200, yc: task.y, halfH: 1050 };
}

// ------------------------------------------------------------------ preview / manual pose
function previewState() {
  const r = S.robot, st = r.newState(), P = r.P, m = S.manual;
  const hip = m ? m.z : r.Ls + r.rw + P.L1 * 0.3;
  let x = 0, y = 0;
  if (S.task.type === 'hole') { const w = S.env.walls[S.task.wall]; x = w.holes[S.task.hole].c; y = w.y0 - P.plateL / 2 - P.actD - r.a0 - P.L1 - 250; }
  else { const ls = S.env.longis.map(l => l.c).sort((a, b) => a - b), i = ls.indexOf(S.env.longis[S.task.longi].c); x = i > 0 ? (ls[i - 1] + ls[i]) / 2 : ls[i] - 400; y = S.task.y; }
  st.base.set([x, y, hip, Math.PI / 2]);
  const v = r.verticalShank(hip - r.rw);
  for (let i = 0; i < 4; i++) {
    const ang = (i % 2 ? -1 : 1) * (i < 2 ? (m ? m.spread : 50) : 180 - (m ? m.spread : 50)) * DEG;
    st.q[5 * i] = r.yawFor(i, ang);
    if (m) { st.q[5 * i + 1] = m.p1 * DEG; st.q[5 * i + 2] = m.p2 * DEG; st.q[5 * i + 3] = m.y2 * DEG; }
    else if (v) { st.q[5 * i + 1] = v.q2; st.q[5 * i + 2] = v.q3; } else { st.q[5 * i + 1] = 0.5; st.q[5 * i + 2] = 1.0; }
  }
  st.q[Q_FOLD_F] = st.q[Q_FOLD_R] = r.fold ? (m ? m.fold * DEG : Math.PI / 2) : 0; st.q[Q_SLIDE] = m ? Math.min(m.ext, P.liftStroke) : 0;
  return st;
}
function buildManual() {
  const defs = [['z', 'Plate height', 200, 1500, 700, 'mm'], ['spread', 'Leg spread', 0, 170, 50, '°'], ['p1', 'Pitch1', -120, 120, 15, '°'], ['p2', 'Pitch2', -160, 160, 75, '°'], ['y2', 'Yaw2', -180, 180, 0, '°'], ['fold', 'Lift fold', 0, 90, 90, '°'], ['ext', 'Lift extension', 0, 800, 0, 'mm']];
  const box = $('manualSliders');
  for (const [k, label, lo, hi, v, u] of defs) {
    const d = document.createElement('div'); d.className = 'p';
    d.innerHTML = `<label>${label}</label><input type="range" min="${lo}" max="${hi}" value="${v}" step="1" data-k="${k}"><output>${v}${u}</output>`;
    d.querySelector('input').addEventListener('input', ev => {
      if (!S.manual) { S.manual = {}; for (const [kk, , , , vv] of defs) S.manual[kk] = vv; }
      S.manual[k] = +ev.target.value; d.querySelector('output').textContent = ev.target.value + u; S.playing = false; updatePlayButton(); showFrame();
    });
    box.appendChild(d);
  }
  $('manual').addEventListener('toggle', () => { if (!$('manual').open) { S.manual = null; showFrame(); } });
}

// ------------------------------------------------------------------ display
function makeCur(result, env, task) { return { result, env, task, traj: new Trajectory(result.frames, result.frameWidth) }; }
function highlightsFor(st, key) {
  if (S.hlCache.has(key)) return S.hlCache.get(key);
  const names = new Set();
  for (const h of diagnose(S.robot, S.geo, st, planOpts())) { names.add(h.a); if (h.b !== 'floor') names.add(h.b); }
  S.hlCache.set(key, names); return names;
}
function currentDisplay() {
  if (S.manual) { const st = previewState(); return { st, flags: 15, hl: highlightsFor(st, 'm' + JSON.stringify(S.manual)), phase: 'Manual pose', bad: false }; }
  if (S.cur) {
    const a = S.cur.traj.at(S.t), bad = !!(a.flags & 32);
    const st = { base: Float64Array.from(a.st.base), q: Float64Array.from(a.st.q) };
    return { st, flags: a.flags, hl: bad ? highlightsFor(st, 'f' + a.index) : null, phase: S.cur.result.phases[a.phase]?.label || '', phaseIdx: a.phase, bad };
  }
  return { st: previewState(), flags: 15, hl: null, phase: S.stale ? 'Parameters changed — plan again' : 'Preview pose' };
}
function showFrame() {
  if (!S.robot || !S.env) return;
  const d = currentDisplay();
  viewer.setState(d.st, d.flags); viewer.setHighlights(d.hl || []);
  viewer.render();
  drawHUD(hctx, hud.width, hud.height, hudData(d));
  if (S.cur) {
    $('seek').value = String(Math.round(1000 * S.t / Math.max(1e-6, S.cur.traj.duration)));
    $('timeLabel').textContent = `${S.t.toFixed(1)} / ${S.cur.traj.duration.toFixed(1)} s`;
    document.querySelectorAll('#phases li').forEach((li, i) => li.classList.toggle('cur', i === d.phaseIdx));
  } else $('timeLabel').textContent = '0.0 / 0.0 s';
}
function hudData(d) {
  if (S.overview) {
    const envs = visibleEnvs(), ids = new Set(envs.map(e => e.id)), nt = envs.reduce((a, e) => a + e.tasks.length, 0), done = S.batch.filter(b => b.result && ids.has(b.env.id)), ok = done.filter(b => b.result.ok).length;
    return { title: `${S.source ? S.source + ' · ' : 'All environments · '}${envs.length} environments, ${nt} tasks`, group: catalogSource().name, params: paramSummary(), phase: '', frac: done.length / Math.max(1, S.batch.length || 1), status: null, reason: '', final: false, bad: false, split: 0, secLabel: '',
      task: done.length ? `${ok} passed · ${done.length - ok} failed / ${done.length} planned` : 'Click a tile to open that environment' };
  }
  const c = S.manual ? null : S.cur, res = c && c.result, atEnd = c && S.t >= c.traj.duration - 1e-3;
  return {
    title: S.env.label, group: S.env.group, task: S.task.label, params: paramSummary(), phase: d.phase,
    frac: c ? S.t / Math.max(1e-6, c.traj.duration) : 0, status: res ? (res.ok ? 'ok' : 'bad') : null,
    reason: res && !res.ok ? `${res.failure.phase ? '[' + res.failure.phase + '] ' : ''}${res.failure.message}` : '', final: !!atEnd, bad: d.bad,
    split: viewer.section ? viewer.split : 0, secLabel: viewer.section ? (viewer.section.type === 'hole' ? 'Section view · side (cut through the hole centre)' : 'Section view · front (along the longis)') : '',
  };
}
function wrapText(ctx, text, maxW) {
  const lines = []; let line = '';
  for (const ch of text) { if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch.trimStart(); } else line += ch; }
  if (line) lines.push(line); return lines;
}
/** Heads-up display; drawn on the overlay canvas and burnt into exported videos. */
function drawHUD(ctx, w, h, d, clear = true) {
  const k = Math.max(0.75, Math.min(w / 1280, h / 720)), font = (px, wt = 400) => `${wt} ${Math.round(px * k)}px system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;
  if (clear) ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'top';
  const pad = 14 * k, yDiv = d.split ? Math.round(h * (1 - d.split)) : h;       // y of the divider between the two viewports
  // title block
  const tw0 = Math.min(w * 0.62, 780 * k);
  ctx.font = font(12); const pLines = wrapText(ctx, d.params, tw0);
  ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fillRect(pad, pad, tw0 + 24 * k, (64 + 16 * pLines.length) * k);
  ctx.fillStyle = '#6b7686'; ctx.font = font(11.5); ctx.fillText(d.group, pad + 12 * k, pad + 8 * k);
  ctx.fillStyle = '#1c2330'; ctx.font = font(16, 700); ctx.fillText(d.title, pad + 12 * k, pad + 23 * k, tw0);
  ctx.font = font(13.5, 600); ctx.fillStyle = '#1f4fa8'; ctx.fillText(d.task, pad + 12 * k, pad + 44 * k, tw0);
  ctx.font = font(12); ctx.fillStyle = '#566173'; pLines.forEach((l, i) => ctx.fillText(l, pad + 12 * k, pad + (63 + 16 * i) * k));
  // status badge
  if (d.status) {
    const txt = d.status === 'ok' ? 'PLAN SUCCEEDED' : 'PLAN FAILED'; ctx.font = font(17, 700);
    const tw = ctx.measureText(txt).width + 28 * k;
    ctx.fillStyle = d.status === 'ok' ? '#12864a' : '#c62828'; ctx.fillRect(w - pad - tw, pad, tw, 34 * k);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, w - pad - tw + 14 * k, pad + 8 * k);
  }
  // divider + caption of the section strip
  if (d.split) {
    ctx.fillStyle = 'rgba(28,35,48,0.6)'; ctx.fillRect(0, yDiv - 1, w, 2);
    ctx.font = font(12.5, 600); const cw = ctx.measureText(d.secLabel).width + 18 * k;
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(pad, yDiv + 8 * k, cw, 24 * k); ctx.fillStyle = '#1c2330'; ctx.fillText(d.secLabel, pad + 9 * k, yDiv + 13 * k);
  }
  // phase label (on the divider) + progress bar (bottom edge)
  const py = d.split ? yDiv - 15 * k : h - pad - 48 * k;
  if (d.phase) {
    ctx.font = font(15, 600); const tw = Math.min(w - 2 * pad, ctx.measureText(d.phase).width + 28 * k);
    ctx.fillStyle = d.bad ? 'rgba(198,40,40,0.95)' : 'rgba(28,35,48,0.88)'; ctx.fillRect((w - tw) / 2, py, tw, 30 * k);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(d.phase, w / 2, py + 7 * k, w - 2 * pad - 20 * k); ctx.textAlign = 'left';
  }
  ctx.fillStyle = 'rgba(28,35,48,0.18)'; ctx.fillRect(0, h - 5 * k, w, 5 * k);
  ctx.fillStyle = d.status === 'bad' ? '#c62828' : '#1f6feb'; ctx.fillRect(0, h - 5 * k, w * Math.min(1, d.frac), 5 * k);
  // failure reason banner
  if (d.status === 'bad' && (d.final || d.bad) && d.reason) {
    ctx.font = font(14.5, 500); const bw = w * 0.74, lines = wrapText(ctx, d.reason, bw), bh = (lines.length * 21 + 16) * k, bx = (w - bw) / 2, byy = py - 12 * k - bh;
    ctx.fillStyle = 'rgba(255,240,238,0.96)'; ctx.fillRect(bx - 12 * k, byy, bw + 24 * k, bh);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2 * k; ctx.strokeRect(bx - 12 * k, byy, bw + 24 * k, bh);
    ctx.fillStyle = '#8e1c1c'; lines.forEach((l, i) => ctx.fillText(l, bx, byy + (8 + 21 * i) * k));
  }
}
function resize() {
  const v = $('view'), w = v.clientWidth, h = v.clientHeight; if (!w || !h) return;
  const r = Math.min(window.devicePixelRatio || 1, 2);
  viewer.resize(w, h, r); hud.width = Math.round(w * r); hud.height = Math.round(h * r); showFrame();
}

// ------------------------------------------------------------------ result panel
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function renderResult() {
  const el = $('result'), ph = $('phases'); ph.innerHTML = '';
  const hasCur = !!S.cur; $('btnVideo').disabled = !hasCur; $('btnTraj').disabled = !hasCur; $('seek').disabled = !hasCur; $('btnPlay').disabled = !hasCur;
  if (!S.cur) { el.className = 'muted'; el.innerHTML = S.stale ? 'Parameters changed. Press <b>Plan</b> again.' : 'Choose an environment and a task, then press <b>Plan</b>.'; return; }
  const r = S.cur.result, i = r.info || {}; el.className = '';
  const rows = [];
  if (i.z != null) rows.push(['Plate-centre height', `${i.z} mm`]);
  if (i.zWindow) rows.push(['Heights that fit the hole', `${i.zWindow[0]} – ${i.zWindow[1]} mm`]);
  if (i.bodyWidth) rows.push(['Body cross-section', `width ${i.bodyWidth.toFixed(0)} × height ${i.bodyHeight.toFixed(0)} mm`]);
  if (i.steps) rows.push(['Steps', `${i.steps} × ${i.stepLength.toFixed(0)} mm`]);
  if (i.lift != null && r.ok) rows.push(['Lift support', i.lift ? 'used' : 'not used (three-wheel support)']);
  rows.push(['Motion time', `${r.stats.duration.toFixed(0)} s`], ['Compute time', `${(r.stats.ms / 1000).toFixed(1)} s (${r.stats.checks.toLocaleString('en-US')} collision checks)`]);
  el.innerHTML = `<span class="badge ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'Success' : 'Failed'}</span> <span class="muted">${esc(S.cur.task.label)}</span>` +
    (r.ok ? '' : `<div class="reason"><b>${esc(r.failure.phase)}</b><br>${esc(r.failure.message)}</div>`) +
    `<dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('')}</dl>` +
    (r.log.length ? `<ul class="log">${r.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  r.phases.forEach((p, k) => { const li = document.createElement('li'); li.textContent = p.label; if (!r.ok && k === r.phases.length - 1) li.classList.add('fail'); li.onclick = () => { S.t = p.t0; S.playing = false; updatePlayButton(); showFrame(); }; ph.appendChild(li); });
}
function updatePlayButton() { $('btnPlay').textContent = S.playing ? '⏸' : '▶'; }

// ------------------------------------------------------------------ planning (worker pool)
function planOpts() { return { envMargin: +$('optEnvMargin').value, selfMargin: +$('optSelfMargin').value, stabMargin: +$('optStab').value, nCross: +$('optCross').value }; }
class Pool {
  constructor(n) { this.idle = []; this.queue = []; this.jobs = new Map(); this.seq = 0; for (let i = 0; i < n; i++) this.idle.push(this._spawn()); }
  _spawn() {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => { const j = this.jobs.get(e.data.id); if (!j) return; if (e.data.progress) { j.onProgress && j.onProgress(e.data.progress); return; } this.jobs.delete(e.data.id); this.idle.push(w); this._next(); e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data.result); };
    w.onerror = e => console.error('worker error', e.message);
    return w;
  }
  _next() { while (this.idle.length && this.queue.length) { const j = this.queue.shift(), w = this.idle.pop(); this.jobs.set(j.id, j); w.postMessage(j.msg); } }
  run(msg, onProgress) { return new Promise((resolve, reject) => { const id = ++this.seq; this.queue.push({ id, msg: { ...msg, id }, resolve, reject, onProgress }); this._next(); }); }
}
const pool = new Pool(Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2)));
function setBusy(d, msg) { S.busy += d; $('busy').textContent = S.busy > 0 ? (msg || 'Planning…') : ''; for (const id of ['btnPlan', 'btnBatchGroup', 'btnBatchAll']) $(id).disabled = S.busy > 0; }

async function planCurrent() {
  const env = S.env, task = S.task; setBusy(1); S.manual = null;
  try {
    const result = await pool.run({ params: { ...S.params }, env, taskId: task.id, opts: planOpts() }, m => { $('busy').textContent = m; });
    S.stale = false; upsertBatch(env, task, result);
    if (S.env === env && S.task === task) { S.cur = makeCur(result, env, task); S.t = 0; S.hlCache.clear(); S.playing = true; renderResult(); updatePlayButton(); }
    renderBatch(); return result;
  } catch (e) { $('result').innerHTML = `<div class="reason">Error: ${esc(e.message)}</div>`; } finally { setBusy(-1); }
}
function upsertBatch(env, task, result) {
  let b = S.batch.find(r => r.env.id === env.id && r.task.id === task.id);
  if (!b) { b = { env, task }; S.batch.push(b); }
  b.result = result; b.params = { ...S.params };
}
async function runBatch(all) {
  const envs = (all ? visibleEnvs() : listEnvs().filter(e => e.group === S.env.group)), jobs = [];
  for (const env of envs) for (const task of env.tasks) jobs.push({ env, task });
  S.batch = jobs.map(j => ({ ...j, result: null })); S.stale = false; renderBatch();
  setBusy(1, `Batch planning 0 / ${jobs.length}`); let done = 0;
  const params = { ...S.params }, opts = planOpts();
  await Promise.all(S.batch.map(b => pool.run({ params, env: b.env, taskId: b.task.id, opts }).then(r => { b.result = r; b.params = params; }).catch(e => { b.error = e.message; }).finally(() => { done++; $('busy').textContent = `Batch planning ${done} / ${jobs.length}`; renderBatch(); })));
  setBusy(-1);
  const b = S.batch.find(r => r.env.id === S.env.id && r.task.id === S.task.id);
  if (b && b.result) { S.cur = makeCur(b.result, S.env, S.task); S.t = 0; S.hlCache.clear(); renderResult(); showFrame(); }
}
function renderBatch() {
  const tb = document.querySelector('#batch tbody'); tb.innerHTML = '';
  const onlyFail = $('onlyFail').checked; let ok = 0, bad = 0;
  for (const b of S.batch) {
    if (b.result) b.result.ok ? ok++ : bad++;
    if (onlyFail && (!b.result || b.result.ok)) continue;
    const tr = document.createElement('tr'); if (S.env && b.env.id === S.env.id && S.task && b.task.id === S.task.id) tr.className = 'sel';
    const st = b.error ? `<span class="bad">Error</span>` : !b.result ? '<span class="muted">queued</span>' : b.result.ok ? '<span class="ok">Success</span>' : `<span class="bad">Failed</span><span class="why">${esc(b.result.failure.phase)}</span>`;
    tr.innerHTML = `<td>${esc(b.env.label)}<span class="why">${esc(b.task.label)}</span></td><td>${st}</td>`;
    tr.title = b.result && !b.result.ok ? b.result.failure.message : '';
    tr.onclick = () => { selectEnv(b.env.id, b.task.id); if (S.cur) { S.playing = true; updatePlayButton(); } renderBatch(); };
    tb.appendChild(tr);
  }
  $('batchSummary').textContent = S.batch.length ? `${ok} succeeded · ${bad} failed / ${S.batch.length}` : '';
  if (S.overview) { viewer.updateOverviewStatus(envStatusMap()); showFrame(); }
  const any = S.batch.some(b => b.result); $('btnBatchVideos').disabled = !any; $('btnBatchCSV').disabled = !any;
}

// ------------------------------------------------------------------ export: files
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const safe = s => s.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 110);
function videoName(env, task, result) { return `${result.ok ? 'SUCCESS' : 'FAIL'}__${safe(env.id)}__${safe(task.id)}.mp4`; }
function trajectoryJSON(cur) {
  const r = S.robot, names = [], idx = [], scale = [];
  for (const L of r.links) if (L.qi >= 0) { names.push(L.jname); idx.push(L.qi); scale.push(L.jtype === 'prismatic' ? 0.001 : 1); }
  const pts = [], f = cur.result.frames, W = cur.result.frameWidth;
  for (let i = 0; i < f.length / W; i++) { const o = i * W; pts.push({ t: +f[o + 4 + NQ].toFixed(3), base_xyz_yaw: [f[o] / 1000, f[o + 1] / 1000, f[o + 2] / 1000, f[o + 3]].map(v => +v.toFixed(5)), positions: idx.map((q, k) => +(f[o + 4 + q] * scale[k]).toFixed(5)) }); }
  return JSON.stringify({ description: 'Planned motion. Units: m / rad / s. base_xyz_yaw = pose of base_link (plate centre) in the environment frame.', environment: cur.env.id, task: cur.task.id, success: cur.result.ok, joint_names: names, points: pts });
}

// ------------------------------------------------------------------ export: video (WebCodecs H.264 -> MP4)
async function encodeVideo(cur, { width = 1280, height = 720, fps = 30, speed = 3, onProgress } = {}) {
  if (!('VideoEncoder' in window)) throw new Error('This browser does not support WebCodecs (VideoEncoder). Use Chrome or Edge.');
  const cfg = { codec: 'avc1.640028', width, height, bitrate: 3_000_000, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) { cfg.codec = 'avc1.42001f'; if (!(await VideoEncoder.isConfigSupported(cfg)).supported) throw new Error('No H.264 encoder is available.'); }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
  enc.configure(cfg);
  const rec = document.createElement('canvas'); rec.width = width; rec.height = height; const ctx = rec.getContext('2d');
  // render at the video size with the current camera
  const v = $('view'), saved = { w: v.clientWidth, h: v.clientHeight, t: S.t, playing: S.playing, cur: S.cur, manual: S.manual };
  S.playing = false; S.cur = cur; S.manual = null; viewer.resize(width, height, 1);
  const T = cur.traj.duration, intro = 1.0, outro = cur.result.ok ? 2.0 : 4.0, n = Math.ceil((intro + T / speed + outro) * fps);
  try {
    for (let k = 0; k < n; k++) {
      S.t = Math.min(T, Math.max(0, (k / fps - intro) * speed));
      const d = currentDisplay();
      viewer.setState(d.st, d.flags); viewer.setHighlights(d.hl || []); viewer.render();
      ctx.drawImage(viewer.canvas, 0, 0, width, height); drawHUD(ctx, width, height, hudData(d), false);
      const vf = new VideoFrame(rec, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: k % (fps * 2) === 0 }); vf.close();
      if (err) throw err;
      if (enc.encodeQueueSize > 6 || k % 20 === 0) { await new Promise(r => setTimeout(r, 0)); onProgress && onProgress(k / n); }
    }
    await enc.flush(); muxer.finalize();
  } finally {
    enc.state !== 'closed' && enc.close();
    S.cur = saved.cur; S.t = saved.t; S.playing = saved.playing; S.manual = saved.manual; viewer.resize(saved.w, saved.h); hud.width = hud.width; showFrame();
  }
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
function overlay(msg) { const o = $('overlayMsg'); if (msg == null) o.hidden = true; else { o.hidden = false; o.textContent = msg; } }
async function saveCurrentVideo() {
  if (!S.cur) return;
  try { overlay('Encoding video…'); const blob = await encodeVideo(S.cur, { speed: +$('optVidSpeed').value, onProgress: p => overlay(`Encoding video… ${(p * 100).toFixed(0)}%`) }); saveBlob(blob, videoName(S.cur.env, S.cur.task, S.cur.result)); }
  catch (e) { alert('Saving the video failed: ' + e.message); } finally { overlay(null); }
}
async function saveBatchVideos() {
  const items = S.batch.filter(b => b.result); if (!items.length) return;
  let dir = null;
  if (window.showDirectoryPicker) { try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; } }
  const keep = { env: S.env.id, task: S.task.id };
  try {
    for (let i = 0; i < items.length; i++) {
      const b = items[i]; selectEnv(b.env.id, b.task.id);
      const cur = makeCur(b.result, b.env, b.task);
      const blob = await encodeVideo(cur, { speed: +$('optVidSpeed').value, onProgress: p => overlay(`Saving video ${i + 1} / ${items.length} … ${(p * 100).toFixed(0)}%`) });
      const name = videoName(b.env, b.task, b.result);
      if (dir) { const fh = await dir.getFileHandle(name, { create: true }), ws = await fh.createWritable(); await ws.write(blob); await ws.close(); } else saveBlob(blob, name);
    }
  } catch (e) { alert('Saving the video failed: ' + e.message); } finally { overlay(null); selectEnv(keep.env, keep.task); renderBatch(); }
}
function saveBatchCSV() {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['environment', 'task', 'result', 'failed_phase', 'reason', 'motion_s', 'compute_s'].join(',')];
  for (const b of S.batch) if (b.result) rows.push([q(b.env.id), q(b.task.label), b.result.ok ? 'SUCCESS' : 'FAIL', q(b.result.failure?.phase), q(b.result.failure?.message), b.result.stats.duration.toFixed(1), (b.result.stats.ms / 1000).toFixed(2)].join(','));
  saveBlob(new Blob(['﻿' + rows.join('\n') + '\n# params,' + q(JSON.stringify(S.params)) + '\n'], { type: 'text/csv' }), 'batch_results.csv');
}

// ------------------------------------------------------------------ wiring
function init() {
  S.params = loadParams();
  buildParamForm(); writeForm(); buildManual(); buildEnvSelect();
  const ps = $('preset'); for (const name of Object.keys(PRESETS)) { const o = document.createElement('option'); o.textContent = name; ps.appendChild(o); }
  const applyPreset = () => { S.params = { ...defaultParams(), ...PRESETS[ps.value] }; writeForm(); onParamsChanged(); };
  ps.onchange = applyPreset; $('btnReset').onclick = applyPreset;
  S.robot = buildRobot(S.params); viewer.setRobot(S.robot); $('warnings').innerHTML = S.robot.warnings.map(w => `<div>${w}</div>`).join('');
  const url = new URLSearchParams(location.search);
  selectEnv(url.get('env') && getEnv(url.get('env')) ? url.get('env') : listEnvs()[0].id, url.get('task'));
  renderEnvSource(); renderSourceChips(); updateBatchLabel();
  $('btnEnvLoad').onclick = () => $('fileEnv').click();
  $('fileEnv').onchange = async e => { const f = e.target.files[0]; if (f) loadEnvCSV(await f.text(), f.name); e.target.value = ''; };
  $('btnEnvTemplate').onclick = () => saveBlob(new Blob(['\ufeff' + EXAMPLE_CSV], { type: 'text/csv' }), 'environments_template.csv');
  $('btnEnvReset').onclick = resetEnvs;
  $('btnStartLoad').onclick = () => $('fileEnv').click();
  $('btnStartExamples').onclick = () => { $('startDlg').hidden = true; };
  // drag & drop of the CSV anywhere on the page
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) loadEnvCSV(await f.text(), f.name); });
  $('env').onchange = e => { selectEnv(e.target.value); renderBatch(); };
  $('task').onchange = e => { selectTask(e.target.value); renderBatch(); };
  $('btnPlan').onclick = planCurrent; $('btnBatchGroup').onclick = () => runBatch(false); $('btnBatchAll').onclick = () => runBatch(true);
  $('btnPlay').onclick = () => { if (!S.cur) return; if (S.t >= S.cur.traj.duration - 1e-3) S.t = 0; S.playing = !S.playing; S.manual = null; updatePlayButton(); };
  $('seek').oninput = e => { if (!S.cur) return; S.t = S.cur.traj.duration * e.target.value / 1000; S.playing = false; updatePlayButton(); showFrame(); };
  $('btnVideo').onclick = saveCurrentVideo; $('btnBatchVideos').onclick = saveBatchVideos; $('btnBatchCSV').onclick = saveBatchCSV; $('onlyFail').onchange = renderBatch;
  $('btnTraj').onclick = () => S.cur && saveBlob(new Blob([trajectoryJSON(S.cur)], { type: 'application/json' }), `trajectory__${safe(S.cur.env.id)}__${safe(S.cur.task.id)}.json`);
  $('btnURDF').onclick = () => saveBlob(new Blob([toURDF(S.robot)], { type: 'application/xml' }), 'ship_block_support_robot.urdf');
  $('btnSRDF').onclick = () => saveBlob(new Blob([toSRDF(S.robot)], { type: 'application/xml' }), 'ship_block_support_robot.srdf');
  $('btnSaveParams').onclick = () => saveBlob(new Blob([JSON.stringify(S.params, null, 2)], { type: 'application/json' }), 'robot_params.json');
  $('btnLoadParams').onclick = () => $('fileParams').click();
  $('fileParams').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { S.params = { ...defaultParams(), ...JSON.parse(await f.text()) }; writeForm(); onParamsChanged(); } catch (err) { alert('Could not read the parameter file: ' + err.message); } e.target.value = ''; };
  document.querySelectorAll('#viewbtns button[data-view]').forEach(b => { b.onclick = () => { if (S.overview) setOverview(false, { fit: false }); setView(b.dataset.view); showFrame(); }; });
  $('btnOverview').onclick = () => setOverview(!S.overview);
  { // overview: a click (not a drag) on a tile opens that environment
    let down = null;
    $('gl').addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    $('gl').addEventListener('pointerup', e => {
      if (!S.overview || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const id = viewer.pickOverview(e.clientX, e.clientY);
      if (id) { selectEnv(id); renderBatch(); }
    });
  }
  $('wallOpacity').oninput = e => { viewer.setWallOpacity(+e.target.value); showFrame(); };
  $('showSupport').onchange = e => { viewer.showSupport = e.target.checked; showFrame(); };
  $('showSection').onchange = () => { viewer.setSection(sectionSpec()); showFrame(); };
  for (const id of ['optEnvMargin', 'optSelfMargin', 'optStab']) $(id).onchange = () => { S.hlCache.clear(); showFrame(); };
  new ResizeObserver(resize).observe($('view')); resize();
  let last = performance.now();
  const loop = now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.playing && S.cur) { S.t += dt * +$('speed').value; if (S.t >= S.cur.traj.duration) { S.t = S.cur.traj.duration; S.playing = false; updatePlayButton(); } showFrame(); }
    else if (viewer.dirty) { viewer.render(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  S.ready = restoreEnvs(url).then(() => { if (url.get('autorun')) planCurrent(); });
}
init();

// hooks for scripted use (tools/batch_videos.mjs)
window.__app = {
  S, viewer, selectEnv, selectTask, planCurrent, runBatch, setSource, visibleEnvs, encodeVideo, makeCur, showFrame, setView, loadEnvCSV, resetEnvs, listEnvs, setOverview, envStatusMap, renderBatch, viewAspect,
  setParams(p) { S.params = { ...defaultParams(), ...p }; writeForm(); onParamsChanged(); },
  setTime(t) { S.t = t; S.playing = false; showFrame(); },
  setOpts(o) { for (const [k, id] of [['envMargin', 'optEnvMargin'], ['selfMargin', 'optSelfMargin'], ['stabMargin', 'optStab'], ['nCross', 'optCross']]) if (o[k] != null) $(id).value = o[k]; },
  /** Plan many jobs [{envId, taskId}] in parallel; results are kept in S.batch (same order). */
  async planMany(jobs, onDone) {
    const params = { ...S.params }, opts = planOpts();
    S.batch = jobs.map(j => { const env = getEnv(j.envId); if (!env) throw new Error(`Unknown environment "${j.envId}" (is the right environment CSV loaded?)`); return { env, task: env.tasks.find(t => t.id === j.taskId), result: null }; });
    await Promise.all(S.batch.map((b, i) => pool.run({ params, env: b.env, taskId: b.task.id, opts }).then(r => { b.result = r; b.params = params; }).catch(e => { b.error = e.message; }).finally(() => onDone && onDone(i))));
    renderBatch();
    return S.batch.map(b => ({ envId: b.env.id, envLabel: b.env.label, group: b.env.group, taskId: b.task.id, taskLabel: b.task.label, ok: b.result ? b.result.ok : null, failure: b.result ? b.result.failure : null, info: b.result ? b.result.info : null, stats: b.result ? b.result.stats : null, log: b.result ? b.result.log : null, error: b.error || null, file: b.result ? videoName(b.env, b.task, b.result) : null }));
  },
  /** Encode the video of batch entry i; returns base64 MP4. */
  async videoBase64(i, opts) {
    const b = S.batch[i]; selectEnv(b.env.id, b.task.id);
    const blob = await encodeVideo(makeCur(b.result, b.env, b.task), opts);
    const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
    for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
    return btoa(bin);
  },
};
