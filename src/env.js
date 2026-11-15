// Ship-block environments, defined by a CSV table (one row = one environment).
// The repository only contains made-up example rows (EXAMPLE_ROWS). Real dimensions are kept in a separate CSV file
// that is loaded at run time (browser: "Load environment CSV"; command line: --envs <file>).
// Units mm. Floor top at z = 0, longitudinals (longis) run along +Y, transverse walls are plates in the XZ plane.
import { box, hull, updateAABB } from './collide.js';

export const FLOOR_T = 15, WEB_T = 12, SLOT_CL = 15;
const COL = { floor: 0x999ea8, longi: 0x386bb8, web: 0xccd1db, bead: 0xf28c1a };

const g = v => String(+(+v).toFixed(6));
export function profLabel(p) { return p.kind === 'FB' ? `FB${g(p.h)}x${g(p.tw)}` : `${p.kind}${g(p.h)}x${g(p.wf)}_w${g(p.tw)}_f${g(p.tf)}`; }
export function holeLabel(h) { return `${g(h.W)}x${g(h.H)}_R${g(h.R)}_sill${g(h.sill)}`; }
/** x-range occupied by a longi (seen from above) whose web centre is at c. */
export function xExtent(p, c) {
  if (p.kind === 'FB') return [c - p.tw / 2, c + p.tw / 2];
  if (p.kind === 'T') return [c - p.wf / 2, c + p.wf / 2];
  return [c - p.tw / 2, c - p.tw / 2 + p.wf];        // L: flange toward +x
}

// ------------------------------------------------------------------ CSV format
/** Columns of the environment table: [name, description]. Lists inside a cell are separated by ";". */
export const ENV_COLUMNS = [
  ['id', 'Unique name of the environment (also used in file names). Required.'],
  ['source', 'Where the data comes from (e.g. a shipyard or a test plan). The app offers one filter button per source.'],
  ['group', 'Group heading in the environment list.'],
  ['label', 'Text shown in the list and in videos.'],
  ['floor_x', 'Floor size across the longis. Default: longi_n x longi_pitch.'],
  ['floor_y', 'Floor size along the longis. Default: 4000 with a wall, 2400 without.'],
  ['longi_kind', 'Profile type T, L or FB (flat bar). One value, or one per longi.'],
  ['longi_h', 'Longi height, floor to top of flange. One value, or one per longi.'],
  ['longi_tw', 'Web thickness. One value, or one per longi.'],
  ['longi_wf', 'Flange width (T, L). One value, or one per longi.'],
  ['longi_tf', 'Flange thickness (T, L). One value, or one per longi.'],
  ['longi_pitch', 'Spacing of evenly spaced longis (with longi_n).'],
  ['longi_n', 'Number of evenly spaced longis.'],
  ['longi_x0', 'x of the first evenly spaced longi. Default: longi_pitch / 2.'],
  ['longi_x', 'Explicit list of longi positions (web centre x); replaces longi_pitch / longi_n.'],
  ['wall_y', 'y of the wall mid-plane. Default: floor_y / 2.'],
  ['wall_t', 'Wall thickness. Default: 12.'],
  ['wall_height', 'Wall height. Default: 2000.'],
  ['wall_x0', 'Start x of each wall panel (list). Default: one wall over the full floor width.'],
  ['wall_x1', 'End x of each wall panel (list).'],
  ['hole_c', 'x of each hole centre (list). Default for a single hole: wall centre.'],
  ['hole_W', 'Hole width. One value, or one per hole.'],
  ['hole_H', 'Hole height. One value, or one per hole.'],
  ['hole_R', 'Hole corner radius (R = W/2 gives an obround hole). Default: 0.'],
  ['hole_sill', 'Height of the hole bottom above the floor. One value, or one per hole.'],
  ['bead_y', 'y positions of floor weld beads (list). Drawn only, not part of the collision model.'],
  ['step_file', 'Optional: STEP file this row was taken from (used by tests/env_check.mjs).'],
  ['step_prefix', 'Optional: part-name prefix of this environment inside step_file.'],
];

/** Made-up example environments shipped with the app (not taken from any real vessel). */
export const EXAMPLE_ROWS = [
  { id: 'example/cell-A', group: 'Examples (made-up dimensions)', label: 'Cell A: longi T300×100 pitch 700 · hole 600×600 R100 sill 600',
    floor_y: 4000, longi_kind: 'T', longi_h: 300, longi_tw: 10, longi_wf: 100, longi_tf: 12, longi_pitch: 700, longi_n: 6,
    wall_height: 2000, hole_W: 600, hole_H: 600, hole_R: 100, hole_sill: 600, bead_y: '1000;3000' },
  { id: 'example/cell-B', group: 'Examples (made-up dimensions)', label: 'Cell B: longi T450×150 pitch 850 · hole 600×800 R100 sill 900',
    floor_y: 4000, longi_kind: 'T', longi_h: 450, longi_tw: 12, longi_wf: 150, longi_tf: 15, longi_pitch: 850, longi_n: 6,
    wall_height: 2200, hole_W: 600, hole_H: 800, hole_R: 100, hole_sill: 900, bead_y: '1000;3000' },
  { id: 'example/flat-bar-panel', group: 'Examples (made-up dimensions)', label: 'Panel: flat bars FB250×12, pitch 500',
    floor_x: 4500, floor_y: 2400, longi_kind: 'FB', longi_h: 250, longi_tw: 12, longi_pitch: 500, longi_n: 5, longi_x0: 1250, bead_y: '1200' },
  { id: 'example/mixed-longis', group: 'Examples (made-up dimensions)', label: 'Panel: mixed longis T250 / T350 / T450 / L400, pitch 800',
    floor_y: 2400, longi_kind: 'T;T;T;L', longi_h: '250;350;450;400', longi_tw: 10, longi_wf: '90;110;130;120', longi_tf: 15, longi_pitch: 800, longi_n: 4 },
  { id: 'example/obround-hole', group: 'Examples (made-up dimensions)', label: 'Wall with an obround hole 500×700 (R250), sill 500',
    floor_x: 2000, floor_y: 3000, wall_height: 2000, hole_W: 500, hole_H: 700, hole_R: 250, hole_sill: 500 },
  { id: 'example/two-holes', group: 'Examples (made-up dimensions)', label: 'Wall with two holes: 600×600 R100 sill 500 · 800×1000 R300 sill 600',
    floor_x: 4400, floor_y: 3000, wall_height: 2000, hole_c: '1100;3300', hole_W: '600;800', hole_H: '600;1000', hole_R: '100;300', hole_sill: '500;600' },
];

/** RFC-4180 style CSV reader -> array of rows (arrays of strings). Blank lines and lines starting with "#" are skipped. */
export function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== '') && !r[0].trim().startsWith('#'));
}

/** Rows (objects keyed by column name) -> CSV text with every column of ENV_COLUMNS. */
export function envsToCSV(rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ENV_COLUMNS.map(c => c[0]);
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n') + '\n';
}
export const EXAMPLE_CSV = envsToCSV(EXAMPLE_ROWS);

/** One CSV record (keys lower-case) -> environment description. Throws an Error with a readable message. */
function rowToEnv(rec) {
  const str = k => rec[k.toLowerCase()] ?? '';
  const list = k => str(k).split(';').map(s => s.trim()).filter(s => s !== '');
  const nums = k => list(k).map(s => { const v = Number(s); if (!Number.isFinite(v)) throw new Error(`${k}: "${s}" is not a number`); return v; });
  const one = (k, def) => { const a = nums(k); if (a.length > 1) throw new Error(`${k}: expected a single value`); return a.length ? a[0] : def; };
  const spread = (k, n, def) => {
    const a = nums(k);
    if (!a.length) { if (def === undefined) throw new Error(`${k} is required`); return Array(n).fill(def); }
    if (a.length === 1) return Array(n).fill(a[0]);
    if (a.length !== n) throw new Error(`${k}: ${a.length} values given, expected 1 or ${n}`);
    return a;
  };
  const id = str('id'); if (!id) throw new Error('id is required');

  // longi positions: explicit list, or evenly spaced
  let xs = nums('longi_x');
  const explicit = xs.length > 0, pitch = one('longi_pitch'), n = one('longi_n');
  if (!explicit && n > 0) {
    if (!(pitch > 0)) throw new Error('longi_pitch is required together with longi_n');
    const x0 = one('longi_x0', pitch / 2);
    xs = Array.from({ length: n }, (_, k) => x0 + k * pitch);
  }
  const nHoles = Math.max(...['hole_c', 'hole_W', 'hole_H', 'hole_R', 'hole_sill'].map(k => list(k).length));
  const hasWall = nHoles > 0 || str('wall_height') !== '' || str('wall_y') !== '';
  const floorY = one('floor_y', hasWall ? 4000 : 2400);
  const floorX = one('floor_x', !explicit && n > 0 ? n * pitch : undefined);
  if (!(floorX > 0)) throw new Error('floor_x is required');
  if (!(floorY > 0)) throw new Error('floor_y must be positive');

  const longis = [];
  if (xs.length) {
    const nl = xs.length, kinds = list('longi_kind').map(s => s.toUpperCase());
    if (kinds.length > 1 && kinds.length !== nl) throw new Error(`longi_kind: ${kinds.length} values given, expected 1 or ${nl}`);
    const h = spread('longi_h', nl), tw = spread('longi_tw', nl), wf = spread('longi_wf', nl, 0), tf = spread('longi_tf', nl, 0);
    for (let i = 0; i < nl; i++) {
      const kind = kinds.length ? kinds[kinds.length === 1 ? 0 : i] : 'T';
      if (!['T', 'L', 'FB'].includes(kind)) throw new Error(`longi_kind: "${kind}" is not T, L or FB`);
      if (!(h[i] > 0) || !(tw[i] > 0)) throw new Error('longi_h and longi_tw must be positive');
      if (kind !== 'FB' && !(wf[i] > 0 && tf[i] > 0 && tf[i] < h[i])) throw new Error('longi_wf and longi_tf are required for T and L profiles');
      if (xs[i] < 0 || xs[i] > floorX) throw new Error(`longi ${i + 1} (x = ${xs[i]}) lies outside the floor`);
      longis.push({ c: xs[i], y0: 0, y1: floorY, prof: { h: h[i], tw: tw[i], wf: kind === 'FB' ? 0 : wf[i], tf: kind === 'FB' ? 0 : tf[i], kind }, name: `longi${i + 1}` });
    }
  }

  const walls = [];
  if (hasWall) {
    const t = one('wall_t', WEB_T), height = one('wall_height', 2000), wy = one('wall_y', floorY / 2);
    const a0 = nums('wall_x0'), a1 = nums('wall_x1');
    if (a0.length !== a1.length) throw new Error('wall_x0 and wall_x1 need the same number of values');
    const spans = a0.length ? a0.map((a, k) => [a, a1[k]]) : [[0, floorX]];
    spans.forEach(([a, b], k) => {
      if (!(b > a)) throw new Error(`wall ${k + 1}: wall_x1 must be larger than wall_x0`);
      walls.push({ x0: a, x1: b, y0: wy - t / 2, t, height, holes: [], slots: longis.filter(l => l.c > a && l.c < b).map(l => ({ c: l.c, prof: l.prof })), name: `wall${k + 1}` });
    });
    if (nHoles > 0) {
      const W = spread('hole_W', nHoles), H = spread('hole_H', nHoles), R = spread('hole_R', nHoles, 0), sill = spread('hole_sill', nHoles);
      let c = nums('hole_c');
      if (!c.length) { if (nHoles === 1 && walls.length === 1) c = [(walls[0].x0 + walls[0].x1) / 2]; else throw new Error('hole_c is required when there are several holes or walls'); }
      else if (c.length !== nHoles) throw new Error(`hole_c: ${c.length} values given, expected ${nHoles}`);
      for (let k = 0; k < nHoles; k++) {
        const w = walls.find(v => c[k] - W[k] / 2 >= v.x0 && c[k] + W[k] / 2 <= v.x1);
        if (!w) throw new Error(`hole ${k + 1} does not lie inside a wall`);
        if (!(W[k] > 0 && H[k] > 0) || R[k] < 0 || R[k] > Math.min(W[k], H[k]) / 2 + 1e-9) throw new Error(`hole ${k + 1}: need W, H > 0 and 0 <= R <= min(W, H) / 2`);
        if (sill[k] < 0 || sill[k] + H[k] > w.height) throw new Error(`hole ${k + 1} does not fit in the wall height`);
        w.holes.push({ c: c[k], W: W[k], H: H[k], R: R[k], sill: sill[k] });
      }
    }
  }

  const sorted = longis.slice().sort((p, q) => p.c - q.c);
  const edges = [0, ...sorted.flatMap(l => [l.c - l.prof.tw / 2, l.c + l.prof.tw / 2]), floorX], beads = [];
  for (const y of nums('bead_y')) for (let j = 0; j < edges.length; j += 2) beads.push({ x0: edges[j], x1: edges[j + 1], y, name: 'bead' });

  return { id, source: str('source'), group: str('group') || 'Environments', label: str('label') || id, floor: { x0: 0, x1: floorX, y0: 0, y1: floorY, name: 'floor' }, longis, walls, beads, stepFile: str('step_file'), stepPrefix: str('step_prefix') };
}

/** CSV text -> { envs, errors }. Rows with errors are skipped and reported. */
export function envsFromCSV(text) {
  const rows = parseCSV(text), errors = [], envs = [], seen = new Set();
  if (!rows.length) return { envs, errors: ['The file is empty.'] };
  const head = rows[0].map(h => h.trim().toLowerCase()), known = new Set(ENV_COLUMNS.map(c => c[0].toLowerCase()));
  if (!head.includes('id')) return { envs, errors: ['The first line must be the header and contain the column "id".'] };
  const unknown = head.filter(h => h && !known.has(h));
  if (unknown.length) errors.push(`Unknown column(s) ignored: ${unknown.join(', ')}`);
  for (let r = 1; r < rows.length; r++) {
    const rec = {}; head.forEach((h, k) => { rec[h] = (rows[r][k] ?? '').trim(); });
    try {
      const e = rowToEnv(rec);
      if (seen.has(e.id)) throw new Error('this id is used more than once');
      e.tasks = makeTasks(e);
      if (!e.tasks.length) throw new Error('nothing to plan: the row has neither longis nor a hole');
      seen.add(e.id); envs.push(e);
    } catch (err) { errors.push(`Row ${r + 1}${rec.id ? ` (${rec.id})` : ''}: ${err.message}`); }
  }
  return { envs, errors };
}

// ------------------------------------------------------------------ current catalogue
let _catalog = null, _source = { kind: 'examples', name: 'Built-in examples' };
export function useExamples() { _catalog = envsFromCSV(EXAMPLE_CSV).envs; _source = { kind: 'examples', name: 'Built-in examples' }; return _catalog; }
/** Replace the catalogue by the environments of a CSV text. Returns { envs, errors }; nothing changes if no row is valid. */
export function loadCatalogCSV(text, name = 'environments.csv') {
  const r = envsFromCSV(text);
  if (r.envs.length) { _catalog = r.envs; _source = { kind: 'csv', name }; }
  return r;
}
export function listEnvs() { return _catalog || useExamples(); }
export function getEnv(id) { return listEnvs().find(e => e.id === id); }
export function catalogSource() { return _source; }

/** Tasks offered by an environment: every access hole, and crossing of each distinct longi. */
function makeTasks(e) {
  const tasks = [];
  const nHoles = e.walls.reduce((a, w) => a + w.holes.length, 0);
  e.walls.forEach((w, wi) => w.holes.forEach((h, hi) => tasks.push({ id: `hole:${wi}:${hi}`, type: 'hole', wall: wi, hole: hi, label: `Hole passage: ${g(h.W)}×${g(h.H)} R${g(h.R)} sill ${g(h.sill)}${nHoles > 1 ? ` (x=${g(h.c)})` : ''}` })));
  if (e.longis.length) {
    const yWall = e.walls.length ? e.walls[0].y0 : null;
    const yc = yWall != null ? (e.floor.y0 + yWall) / 2 : (e.floor.y0 + e.floor.y1) / 2;
    const uniform = e.longis.every(l => profLabel(l.prof) === profLabel(e.longis[0].prof));
    // identical longis: one representative crossing (ending in the hole channel when there is one); otherwise one task per longi
    const idxs = uniform ? [Math.max(0, Math.floor(e.longis.length / 2) - 1)] : e.longis.map((_, i) => i);
    for (const i of idxs) tasks.push({ id: `longi:${i}`, type: 'longi', longi: i, y: yc, label: `Longi crossing: longi #${i + 1} (${profLabel(e.longis[i].prof)})` });
  }
  return tasks;
}

// ------------------------------------------------------------------ geometry
// The CAD pieces are finite samples of a structure that continues. For planning the environment is treated as unbounded:
//   - longis are infinitely long (BIG), and the longi pattern continues beyond the outermost longis at the outermost pitch
//     (never inside the modelled floor);
//   - walls continue sideways and upward without further openings;
//   - the floor is an unbounded plane.
// The continuation is drawn faded ("ghost") for GHOST mm beyond the modelled part.
const BIG = 20000, GHOST = 3000, N_CONT = 3;

/** Longis considered by the planner, sorted by x: the modelled ones plus N_CONT continued copies on either side ({virtual: true}). */
export function planningLongis(e) {
  const m = e.longis.slice().sort((a, b) => a.c - b.c), out = m.map(l => ({ c: l.c, prof: l.prof, name: l.name, virtual: false }));
  if (m.length >= 2) {
    const f = m[0], l = m[m.length - 1], pf = m[1].c - f.c, pl = l.c - m[m.length - 2].c;
    const x0 = Math.min(f.c - pf, e.floor.x0), x1 = Math.max(l.c + pl, e.floor.x1);
    for (let k = 0; k < N_CONT; k++) { out.push({ c: x0 - k * pf, prof: f.prof, name: 'longi (continued)', virtual: true }); out.push({ c: x1 + k * pl, prof: l.prof, name: 'longi (continued)', virtual: true }); }
  }
  return out.sort((a, b) => a.c - b.c);
}

/** Rectangle decomposition of a wall (x-z plane) minus rectangular cut-outs -> [[xa, xb, za, zb]]. */
function wallRects(w) {
  const cuts = [];
  for (const sl of w.slots) { const [a, b] = xExtent(sl.prof, sl.c); cuts.push([a - SLOT_CL, b + SLOT_CL, 0, sl.prof.h + SLOT_CL]); }
  for (const h of w.holes) cuts.push([h.c - h.W / 2, h.c + h.W / 2, h.sill, h.sill + h.H]);
  const xs = [...new Set([w.x0, w.x1, ...cuts.flatMap(c => [c[0], c[1]])].filter(x => x >= w.x0 && x <= w.x1))].sort((a, b) => a - b);
  const rects = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i], xb = xs[i + 1];
    const blk = cuts.filter(c => c[0] <= xa + 1e-9 && c[1] >= xb - 1e-9).map(c => [c[2], c[3]]).sort((a, b) => a[0] - b[0]);
    let z = 0;
    for (const [a, b] of blk) { if (a > z + 1e-9) rects.push([xa, xb, z, a]); z = Math.max(z, b); }
    if (z < w.height - 1e-9) rects.push([xa, xb, z, w.height]);
  }
  // merge horizontally adjacent rectangles with identical z-range
  rects.sort((a, b) => a[2] - b[2] || a[3] - b[3] || a[0] - b[0]);
  const merged = [];
  for (const r of rects) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m[2] - r[2]) < 1e-9 && Math.abs(m[3] - r[3]) < 1e-9 && Math.abs(m[1] - r[0]) < 1e-9) m[1] = r[1]; else merged.push([...r]);
  }
  return merged;
}
/** Corner fillets of a hole as triangles [[x,z] x3] in the wall plane (solid side, slightly conservative). */
function holeFillets(h) {
  const tris = [];
  if (!(h.R > 0)) return tris;
  const nSeg = Math.max(6, Math.ceil(h.R / 25));     // chord sagitta < 1 mm
  const xl = h.c - h.W / 2, xr = h.c + h.W / 2, zb = h.sill, zt = h.sill + h.H, R = h.R;
  const corners = [[xl, zb, xl + R, zb + R, Math.PI, 1.5 * Math.PI], [xr, zb, xr - R, zb + R, 1.5 * Math.PI, 2 * Math.PI], [xr, zt, xr - R, zt - R, 0, 0.5 * Math.PI], [xl, zt, xl + R, zt - R, 0.5 * Math.PI, Math.PI]];
  for (const [cx, cz, ox, oz, a0, a1] of corners) for (let k = 0; k < nSeg; k++) {
    const t0 = a0 + (a1 - a0) * k / nSeg, t1 = a0 + (a1 - a0) * (k + 1) / nSeg;
    tris.push([[cx, cz], [ox + R * Math.cos(t0), oz + R * Math.sin(t0)], [ox + R * Math.cos(t1), oz + R * Math.sin(t1)]]);
  }
  return tris;
}

function mkBox(x0, x1, y0, y1, z0, z1, name, kind) {
  const s = box((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);
  s.p.set([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]); updateAABB(s);
  s.name = name; s.kind = kind; return s;
}

/**
 * Build collision shapes + visual descriptors of an environment.
 * shapes: convex pieces (boxes / prisms); the ground is an unbounded slab flagged isFloor.
 */
export function buildEnv(e) {
  const shapes = [], visuals = [], parts = [];
  const F = e.floor;
  const ground = mkBox(-1e5, 1e5, -1e5, 1e5, -400, 0, 'floor', 'floor'); ground.isFloor = true; shapes.push(ground);
  visuals.push({ type: 'box', min: [F.x0, F.y0, -FLOOR_T], max: [F.x1, F.y1, 0], color: COL.floor, name: F.name });
  parts.push({ name: F.name, bbox: [F.x0, F.y0, -FLOOR_T, F.x1, F.y1, 0], volume: (F.x1 - F.x0) * (F.y1 - F.y0) * FLOOR_T });
  const profBoxes = (p, c) => p.kind === 'FB' ? [[c - p.tw / 2, c + p.tw / 2, 0, p.h]] : [[c - p.tw / 2, c + p.tw / 2, 0, p.h - p.tf], [...xExtent(p, c), p.h - p.tf, p.h]];
  for (const l of e.longis) {      // parts list: the modelled (finite) longis, as in the CAD
    const p = l.prof; let vol = 0; const bb = [Infinity, l.y0, 0, -Infinity, l.y1, p.h];
    for (const [xa, xb, za, zb] of profBoxes(p, l.c)) {
      visuals.push({ type: 'box', kind: 'longi', c: l.c, min: [xa, l.y0, za], max: [xb, l.y1, zb], color: COL.longi, name: l.name });
      vol += (xb - xa) * (l.y1 - l.y0) * (zb - za); bb[0] = Math.min(bb[0], xa); bb[3] = Math.max(bb[3], xb);
    }
    parts.push({ name: l.name, bbox: bb, volume: vol });
  }
  for (const l of planningLongis(e)) {      // collision: infinitely long, pattern continued sideways
    for (const [xa, xb, za, zb] of profBoxes(l.prof, l.c)) {
      shapes.push(mkBox(xa, xb, -BIG, BIG, za, zb, l.name, 'longi'));
      const ghost = (y0, y1) => visuals.push({ type: 'box', kind: 'longi', ghost: true, c: l.c, min: [xa, y0, za], max: [xb, y1, zb], color: COL.longi, name: l.name });
      if (l.virtual) ghost(F.y0 - GHOST, F.y1 + GHOST); else { ghost(F.y0 - GHOST, F.y0); ghost(F.y1, F.y1 + GHOST); }
    }
  }
  const panels = e.walls.slice().sort((a, b) => a.x0 - b.x0);
  for (const w of e.walls) {
    let vol = 0;
    for (const [xa, xb, za, zb] of wallRects(w)) { shapes.push(mkBox(xa, xb, w.y0, w.y0 + w.t, za, zb, w.name, 'web')); vol += (xb - xa) * (zb - za) * w.t; }
    for (const h of w.holes) for (const tri of holeFillets(h)) {
      const v = [];
      for (const y of [w.y0, w.y0 + w.t]) for (const [x, z] of tri) v.push(x, y, z);
      const s = hull(v); s.name = w.name; s.kind = 'web'; shapes.push(s);
      const [a, b, c] = tri; vol += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2 * w.t;
    }
    visuals.push({ type: 'wall', x0: w.x0, x1: w.x1, y0: w.y0, t: w.t, height: w.height, holes: w.holes, color: COL.web, name: w.name,
      slots: w.slots.map(sl => { const [a, b] = xExtent(sl.prof, sl.c); return [a - SLOT_CL, b + SLOT_CL, sl.prof.h + SLOT_CL]; }) });
    parts.push({ name: w.name, bbox: [w.x0, w.y0, 0, w.x1, w.y0 + w.t, w.height], volume: vol });
  }
  if (panels.length) {      // the wall plane continues: solid beside / between the modelled panels and above them
    const w0 = panels[0], gaps = [[-BIG, w0.x0], ...panels.slice(1).map((w, k) => [panels[k].x1, w.x0]), [panels[panels.length - 1].x1, BIG]];
    for (const [xa, xb] of gaps) if (xb - xa > 1e-6) {
      shapes.push(mkBox(xa, xb, w0.y0, w0.y0 + w0.t, 0, w0.height, 'wall (continued)', 'web'));
      visuals.push({ type: 'box', kind: 'web', ghost: true, min: [Math.max(xa, F.x0 - GHOST), w0.y0, 0], max: [Math.min(xb, F.x1 + GHOST), w0.y0 + w0.t, w0.height], color: COL.web, name: 'wall (continued)' });
    }
    shapes.push(mkBox(-BIG, BIG, w0.y0, w0.y0 + w0.t, w0.height, BIG, 'wall (continued)', 'web'));
  }
  for (const b of e.beads) visuals.push({ type: 'bead', x0: b.x0, x1: b.x1, y: b.y, w: 20, h: 10, color: COL.bead, name: b.name });
  return { shapes, visuals, parts };
}
