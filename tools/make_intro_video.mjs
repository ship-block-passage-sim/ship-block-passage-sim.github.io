#!/usr/bin/env node
// Renders a short product-intro film of the app (minimal, Apple-like). The real web app is driven in headless Chrome
// frame by frame (deterministic timing). Each feature is first located in the app (short zoom into the UI), then shown
// on a clean white stage: robot / environments only, large type, dimension call-outs. Frames are encoded with ffmpeg.
//
//   node tools/make_intro_video.mjs [--envs private/environments.csv] [--out videos/intro/ship_block_passage_sim_intro.mp4]
//                                   [--fps 30] [--software] [--ffmpeg /path/to/ffmpeg] [--only scene1,scene2]
//
// The environment table is shown in the film. If the table is confidential, so is the film.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { startServer } from './serve.mjs';
import { DEFAULT_ENV_CSV } from './envs.mjs';

const args = process.argv.slice(2), val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FPS = +val('--fps', 30), OUT = resolve(val('--out', 'videos/intro/ship_block_passage_sim_intro.mp4'));
const ONLY = val('--only') ? new Set(val('--only').split(',')) : null;
const ENV_CSV = val('--envs', DEFAULT_ENV_CSV);
if (!existsSync(ENV_CSV)) { console.error(`Environment CSV not found: ${ENV_CSV} (use --envs <file.csv>)`); process.exit(1); }
const csvText = readFileSync(ENV_CSV, 'utf8'), csvName = basename(ENV_CSV);
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch { console.error('puppeteer-core is missing. Run `npm install` first.'); process.exit(1); }
const chrome = val('--chrome') || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
function findFfmpeg() {
  if (val('--ffmpeg')) return val('--ffmpeg');
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { /* not on PATH */ }
  try { return execFileSync('python3', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim(); } catch { return null; }
}
const FFMPEG = findFfmpeg();
if (!chrome || !FFMPEG) { console.error(!chrome ? 'Chrome not found (--chrome <path>).' : 'ffmpeg not found (--ffmpeg <path>, or pip install imageio-ffmpeg).'); process.exit(1); }

const W = 1600, H = 900, DPR = 1.2;                      // CSS viewport; frames are 1920 x 1080
const FONTS = 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=block';

// ------------------------------------------------------------------ styles of the film overlay
const CSS = `
html, body { background: #f5f5f7 !important; overflow: hidden !important; }
body.stage { background: #fff !important; }
#__win { position: fixed; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; border-radius: 18px; overflow: hidden; background: #f4f6f9;
  box-shadow: 0 30px 90px rgba(0,0,0,.16), 0 0 0 1px rgba(0,0,0,.06); }
body.stage #__win { transform: none !important; border-radius: 0; box-shadow: none; background: #fff; }
body.stage #startDlg, body.stage #left, body.stage #right, body.stage #toolbar, body.stage #envbar, body.stage #viewbtns, body.stage #timeline, body.stage #hud { display: none !important; }
body.stage #app { grid-template-columns: 1fr !important; height: ${H}px !important; }
body.stage main { grid-template-rows: 1fr !important; height: ${H}px; }
.__f { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; }
#__layer { position: fixed; inset: 0; z-index: 800; pointer-events: none; }
.__tx { position: absolute; }
.__tx .e { font: 600 19px "Inter", sans-serif; color: #1d1d1f; margin-bottom: 14px; }
.__tx .h { font: 600 66px/1.04 "Inter Tight", "Inter", sans-serif; letter-spacing: -1.4px; color: #1d1d1f; }
.__tx .h .w { display: inline-block; white-space: pre; }
.__tx .s { font: 400 22px/1.42 "Inter", sans-serif; color: #6e6e73; margin-top: 18px; max-width: 560px; }
.__tx.center { text-align: center; } .__tx.center .s { margin-left: auto; margin-right: auto; max-width: 820px; }
.__pill { position: absolute; background: #fff; border: 1px solid #d2d2d7; border-radius: 999px; padding: 8px 16px; font: 600 17px "Inter", sans-serif; color: #1d1d1f; white-space: nowrap; box-shadow: 0 6px 18px rgba(0,0,0,.08); }
.__pill b { color: #0071e3; font-weight: 600; font-variant-numeric: tabular-nums; }
#__svg { position: fixed; inset: 0; width: ${W}px; height: ${H}px; z-index: 790; pointer-events: none; }
.__card { position: absolute; background: #fff; border-radius: 26px; box-shadow: 0 18px 50px rgba(0,0,0,.09), 0 0 0 1px rgba(0,0,0,.04); }
.__grey { background: #f5f5f7; box-shadow: none; }
.__mono { font: 400 17px/1.75 "JetBrains Mono", monospace; color: #1d1d1f; }
.__mono .t { color: #0071e3; } .__mono .a { color: #8e5bd0; } .__mono .v { color: #1d1d1f; } .__mono .m { color: #86868b; }
.__num { font: 600 92px/1 "Inter Tight", sans-serif; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
.__lbl { font: 500 19px "Inter", sans-serif; color: #6e6e73; margin-top: 10px; }
.__chipin { position: absolute; top: 34px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; background: rgba(255,255,255,.92);
  border-radius: 999px; padding: 9px 18px 9px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.08); font: 600 16px "Inter", sans-serif; color: #1d1d1f; z-index: 860; }
.__chipin span { background: #0071e3; color: #fff; border-radius: 999px; padding: 3px 10px; font-size: 13px; }
#__ring { position: fixed; border: 3px solid #0071e3; border-radius: 12px; box-shadow: 0 0 0 6px rgba(0,113,227,.18); z-index: 870; opacity: 0; pointer-events: none; }
#__cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 950; pointer-events: none; opacity: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
#__ripple { position: fixed; left: 0; top: 0; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 3px solid #0071e3; background: rgba(0,113,227,.15); z-index: 940; pointer-events: none; opacity: 0; }
#__fade { position: fixed; inset: 0; background: #fff; z-index: 980; opacity: 0; pointer-events: none; }
`;

// ------------------------------------------------------------------ page-side library (runs in the browser)
function pageLib(W, H) {
  const A = () => window.__app, V = () => window.__app.viewer;
  const q = s => document.querySelector(s), layer = document.createElement('div'); layer.id = '__layer'; document.body.appendChild(layer);
  const win = document.createElement('div'); win.id = '__win'; document.body.insertBefore(win, document.body.firstChild);
  win.appendChild(q('#app')); win.appendChild(q('#startDlg'));
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.id = '__svg'; document.body.appendChild(svg);
  for (const [id, html] of [['__ring', ''], ['__ripple', ''], ['__fade', ''],
    ['__cursor', '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>']]) {
    const d = document.createElement('div'); d.id = id; d.innerHTML = html; document.body.appendChild(d);
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const outCubic = x => 1 - Math.pow(1 - clamp01(x), 3);
  const outBack = x => { x = clamp01(x); const c1 = 1.55, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

  // ---- stage look (white, monochrome robot, light environment) ----------------------------------
  const COLOR_MAP = { 0x999ea8: 0xeeeef1, 0x386bb8: 0xc9d4e6, 0xccd1db: 0xd5d9e0, 0xf28c1a: 0xf1c9a3,
    0xb9c0c8: 0xf3f3f5, 0xd9434f: 0xdfe6f2, 0x3a3f47: 0xc7c7cc, 0x18191c: 0x2c2c2e, 0x2b2b2e: 0x1d1d1f, 0x8e98a6: 0xbfc1c7, 0xd0d5dc: 0xe8e8ed, 0x30343a: 0x3a3a3c, 0xdfe3e9: 0xffffff };
  let saved = null, floor = null;
  const restyle = () => {
    const v = V();
    for (const g of [v.envGroup, v.robotGroup, v.ovGroup]) g.traverse(m => {
      if (m.userData && m.userData.ground) { if (m.isMesh && !m.userData.styled) { m.userData.styled = true; m.material = new window.__T.ShadowMaterial({ opacity: 0.09 }); m.receiveShadow = true; } else if (!m.isMesh) m.visible = false; return; }
      if (m.isLineSegments) { if (!m.userData.styled) { m.userData.styled = true; m.material.color.setHex(0xb4b4ba); } return; }
      if (!m.isMesh || m.userData.styled || !m.material || !m.material.color) return;
      m.userData.styled = true;
      const c = m.userData.baseColor != null ? m.userData.baseColor : m.material.color.getHex();
      if (COLOR_MAP[c] != null) { m.userData.baseColor = COLOR_MAP[c]; m.material.color.setHex(COLOR_MAP[c]); }
      if ('metalness' in m.material) { m.material.metalness = Math.min(m.material.metalness, 0.1); m.material.roughness = Math.max(m.material.roughness, 0.55); }
    });
  };
  const stageLook = on => {
    const v = V(), C = v.scene.background.constructor, hemi = v.scene.children.find(o => o.isHemisphereLight);
    if (on && !saved) {
      saved = { bg: v.scene.background.getHex(), hemi: hemi.intensity, sun: v.sun.intensity };
      v.scene.background = new C(0xffffff); hemi.intensity = 1.75; v.sun.intensity = 1.2; v.showSupport = false;
      if (!floor) floor = window.__mkFloor();
    } else if (!on && saved) {
      v.scene.background = new C(saved.bg); hemi.intensity = saved.hemi; v.sun.intensity = saved.sun; v.showSupport = true; saved = null;
      v.camera.clearViewOffset(); floor.visible = false;
    }
  };

  // ---- text blocks ------------------------------------------------------------------------------
  const texts = new Map();
  function textBlock(spec, t) {
    let el = texts.get(spec.id);
    const key = JSON.stringify([spec.eyebrow, spec.lines, spec.sub, spec.align]);
    if (!el || el.__key !== key) {
      if (el) el.remove();
      el = document.createElement('div'); el.className = '__tx __f' + (spec.align === 'center' ? ' center' : ''); el.__key = key;
      const words = []; let html = spec.eyebrow ? `<div class="e">${spec.eyebrow}</div>` : '';
      html += '<div class="h">' + spec.lines.map(l => l.split(' ').map(w => `<span class="w">${w} </span>`).join('')).join('<br>') + '</div>';
      if (spec.sub) html += `<div class="s">${spec.sub}</div>`;
      el.innerHTML = html; layer.appendChild(el); texts.set(spec.id, el);
    }
    Object.assign(el.style, spec.align === 'center' ? { left: '0px', width: W + 'px', top: spec.y + 'px' } : { left: spec.x + 'px', top: spec.y + 'px', width: (spec.w || 640) + 'px' });
    const tin = t - (spec.t0 || 0), tout = spec.t1 != null ? spec.t1 - t : 99;
    const exitK = clamp01(1 - tout / 0.32);                         // 0 .. 1 while leaving
    const parts = [...el.querySelectorAll('.e, .w, .s')];
    parts.forEach((p, i) => {
      const d = p.classList.contains('e') ? 0 : p.classList.contains('s') ? 0.18 + 0.045 * (parts.length - 2) : 0.06 + 0.045 * (i - 1);
      const u = clamp01((tin - d) / 0.55), e = outCubic(u);
      p.style.opacity = (Math.min(1, u * 1.6) * (1 - exitK)).toFixed(3);
      p.style.transform = `translateY(${((1 - e) * 34 - exitK * 18).toFixed(2)}px)`;
      p.style.filter = u < 1 ? `blur(${((1 - e) * 7).toFixed(2)}px)` : 'none';
    });
  }

  // ---- generic animated html cards ---------------------------------------------------------------
  const cards = new Map();
  function card(spec, t) {
    let el = cards.get(spec.id);
    if (!el) { el = document.createElement('div'); el.className = spec.cls || '__card __f'; layer.appendChild(el); cards.set(spec.id, el); }
    if (el.__html !== spec.html) { el.innerHTML = spec.html; el.__html = spec.html; }
    const tin = t - (spec.t0 || 0), tout = spec.t1 != null ? spec.t1 - t : 99, u = clamp01(tin / (spec.dur || 0.6)), e = outBack(u), x = clamp01(1 - tout / 0.3);
    Object.assign(el.style, { left: spec.x + 'px', top: spec.y + 'px', width: spec.w ? spec.w + 'px' : '', height: spec.h ? spec.h + 'px' : '',
      opacity: (Math.min(1, u * 1.8) * (1 - x)).toFixed(3), transform: `translateY(${((1 - e) * 40 - x * 16).toFixed(1)}px) scale(${(0.94 + 0.06 * e).toFixed(4)})` });
    if (spec.style) Object.assign(el.style, spec.style);
  }

  // ---- dimension call-outs (projected 3D points) --------------------------------------------------
  const project = p => {
    const v = V(), cam = v.camera, r = v.canvas.getBoundingClientRect(), P = cam.position.constructor;
    const n = new P(p[0], p[1], p[2]).project(cam);
    return [r.left + (n.x + 1) / 2 * r.width, r.top + (1 - n.y) / 2 * r.height];
  };
  const pills = new Map();
  function dims(list) {
    svg.innerHTML = '';
    const seen = new Set();
    for (const d of list) {
      const a = project(d.a), b = project(d.b), dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * (d.off || 0), ny = dx / L * (d.off || 0);
      const A1 = [a[0] + nx, a[1] + ny], B1 = [b[0] + nx, b[1] + ny], pr = outCubic(d.prog), E = [A1[0] + (B1[0] - A1[0]) * pr, A1[1] + (B1[1] - A1[1]) * pr], tx = -dy / L * 7, ty = dx / L * 7;
      const op = (d.alpha ?? 1).toFixed(3), col = d.color || '#0071e3';
      const ln = (x1, y1, x2, y2, w) => { const e = document.createElementNS(NS, 'line'); Object.entries({ x1, y1, x2, y2, stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', opacity: op }).forEach(([k, v]) => e.setAttribute(k, v)); svg.appendChild(e); };
      if (d.off) { ln(a[0], a[1], A1[0], A1[1], 1); if (pr > 0.98) ln(b[0], b[1], B1[0], B1[1], 1); }
      ln(A1[0], A1[1], E[0], E[1], 2);
      ln(A1[0] - tx, A1[1] - ty, A1[0] + tx, A1[1] + ty, 2);
      if (pr > 0.98) ln(B1[0] - tx, B1[1] - ty, B1[0] + tx, B1[1] + ty, 2);
      for (const p of [A1, ...(pr > 0.98 ? [B1] : [])]) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', 3); c.setAttribute('fill', col); c.setAttribute('opacity', op); svg.appendChild(c); }
      let el = pills.get(d.id); if (!el) { el = document.createElement('div'); el.className = '__pill __f'; layer.appendChild(el); pills.set(d.id, el); }
      el.innerHTML = `${d.label} <b>${d.value}</b>`; seen.add(d.id);
      const m = [(A1[0] + B1[0]) / 2 + (d.lx || 0), (A1[1] + B1[1]) / 2 + (d.ly || 0)], s = outBack(clamp01((d.prog - 0.35) / 0.65));
      Object.assign(el.style, { left: m[0] + 'px', top: m[1] + 'px', opacity: (clamp01((d.prog - 0.3) * 3) * (d.alpha ?? 1)).toFixed(3), transform: `translate(-50%, -50%) scale(${(0.7 + 0.3 * s).toFixed(3)})` });
    }
    for (const [id, el] of pills) if (!seen.has(id)) el.style.opacity = 0;
  }

  // ---- robot on the empty stage ------------------------------------------------------------------
  function standState(r, o = {}) {
    const st = r.newState(), rw = r.rw, hipZ = r.hips[0][2], hw = r.Ls + r.P.L1 * 0.45, z = hw - hipZ + rw + (o.rise || 0);
    const v = r.verticalShank(hw);
    for (let i = 0; i < 4; i++) {
      const ang = (i % 2 ? -1 : 1) * (i < 2 ? 52 : 128) * Math.PI / 180;
      st.q[5 * i] = r.yawFor(i, ang); st.q[5 * i + 1] = v ? v.q2 : 0.4; st.q[5 * i + 2] = v ? v.q3 : 1.1; st.q[5 * i + 3] = 0;
    }
    st.q[20] = st.q[21] = r.fold ? (o.fold ?? Math.PI / 2) : 0; st.q[22] = o.slide || 0;
    st.base.set([0, 0, z, 0]);
    return st;
  }
  const setCam = (pos, target, shift) => {
    const v = V(), c = v.canvas, fw = c.clientWidth, fh = c.clientHeight;
    if (shift && (shift[0] || shift[1])) v.camera.setViewOffset(fw, fh, -shift[0] * fw, -shift[1] * fh, fw, fh); else v.camera.clearViewOffset();
    v.camera.position.set(...pos); v.controls.target.set(...target); v.controls.update();
  };

  window.__film = {
    rectLocal(sel) { const w = q('#__win'), tr = w.style.transform; w.style.transform = 'none'; const e = [].concat(sel).map(s => q(s)).filter(Boolean).map(x => x.getBoundingClientRect()); w.style.transform = tr;
      if (!e.length) return null; const x0 = Math.min(...e.map(r => r.left)), y0 = Math.min(...e.map(r => r.top)); return [x0, y0, Math.max(...e.map(r => r.right)) - x0, Math.max(...e.map(r => r.bottom)) - y0]; },
    async mode(m) {
      const v = V(), sec = q('#showSection');
      if (m === 'stage') {
        document.body.classList.add('stage'); stageLook(true);
        if (sec.checked) { sec.checked = false; sec.dispatchEvent(new Event('change')); }
      } else {
        document.body.classList.remove('stage'); stageLook(false);
        v.envGroup.visible = true; v.robotGroup.visible = true; v.ovGroup.visible = true;
        A().setParams(A().S.params);                                         // rebuild robot with the app colours
        if (A().S.env) A().selectEnv(A().S.env.id, A().S.task.id);           // rebuild environment with the app colours
        if (!sec.checked) { sec.checked = true; sec.dispatchEvent(new Event('change')); }
      }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    /** Robot alone on the stage. o: {params, fold, slide, rise, cam:{pos,target}, shift} */
    robot(o) {
      const a = A(), v = V();
      if (o.params) a.setParams({ ...a.S.params, ...o.params });
      v.envGroup.visible = false; v.ovGroup.visible = false; v.robotGroup.visible = true; floor.visible = true;
      const st = standState(a.S.robot, o); v.setState(st, 15); restyle();
      v.sun.position.set(2200, -2600, 6000); v.sun.target.position.set(0, 0, 0);
      const sc = v.sun.shadow.camera; sc.left = -2500; sc.right = 2500; sc.top = 2500; sc.bottom = -2500; sc.updateProjectionMatrix();
      setCam(o.cam.pos, o.cam.target, o.shift); v.render();
      return { z: st.base[2] };
    },
    /** Points used by the dimension call-outs, for the current robot pose. */
    robotPoints() {
      const r = A().S.robot, L = r.links, P = r.P, sh = n => r.shapes.find(s => s.name === n), g = i => Array.from(L[i].wp);
      const leg = r.legLinks[1], base = L[0], Rm = base.wR, tp = (x, y, z) => [Rm[0] * x + Rm[1] * y + Rm[2] * z + base.wp[0], Rm[3] * x + Rm[4] * y + Rm[5] * z + base.wp[1], Rm[6] * x + Rm[7] * y + Rm[8] * z + base.wp[2]];
      const act = sh('fr_yaw1_act'), rod = L[r.liftPairs[0].rods[1]], top = P.plateT / 2;
      return {
        p1: g(leg.thigh), p2: g(leg.shank), y2: g(leg.foot), wheel: g(leg.wheel),
        plA: tp(P.plateL / 2, -P.plateW / 2, top), plB: tp(-P.plateL / 2, -P.plateW / 2, top), plC: tp(P.plateL / 2, P.plateW / 2, top),
        actA: [act.p[0] - P.actD / 2, act.p[1], act.p[2] + P.actT / 2], actB: [act.p[0] + P.actD / 2, act.p[1], act.p[2] + P.actT / 2],
        payA: tp(P.payL / 2, -P.payW / 2, top), payB: tp(P.payL / 2, -P.payW / 2, top + P.payH),
        liftTop: tp(P.liftSX / 2, -(r.liftPairs[0].w / 2), r.zPiv), liftFoot: [rod.wp[0], rod.wp[1], rod.wp[2] - 30],
      };
    },
    /** Environment (and optionally the robot preview) on the stage. */
    env(o) {
      const a = A(), v = V();
      if (o.id && (!a.S.env || a.S.env.id !== o.id)) a.selectEnv(o.id, o.task);
      if (o.overview != null) a.setOverview(o.overview, { fit: false });
      v.envGroup.visible = true; v.ovGroup.visible = true; v.robotGroup.visible = o.robot !== false; floor.visible = false;
      restyle(); v.setWallOpacity(0.26);
      if (o.time != null) a.setTime(o.time); else a.showFrame();
      restyle(); a.showFrame();
      if (o.cam) setCam(o.cam.pos, o.cam.target, o.shift);
      v.render();
    },
    cam: () => { const v = V(); return { pos: v.camera.position.toArray(), target: v.controls.target.toArray() }; },
    overviewCam: () => V().overviewView(A().viewAspect()),
    viewCam: kind => { A().setView(kind || 'iso'); const v = V(); return { pos: v.camera.position.toArray(), target: v.controls.target.toArray() }; },
    setCam(c, shift) { setCam(c.pos, c.target, shift); V().render(); },
    restyle,
    /** Apply the 2D overlay of one frame. */
    frame(st) {
      const t = st.t, w = q('#__win');
      if (st.win) w.style.transform = `translate(${st.win[0]}px, ${st.win[1]}px) scale(${st.win[2]})`;
      const seenT = new Set(); for (const s of st.texts || []) { textBlock(s, t); seenT.add(s.id); }
      for (const [id, el] of texts) if (!seenT.has(id)) { el.remove(); texts.delete(id); }
      const seenC = new Set(); for (const s of st.cards || []) { card(s, t); seenC.add(s.id); }
      for (const [id, el] of cards) if (!seenC.has(id)) { el.remove(); cards.delete(id); }
      dims(st.dims || []);
      const chip = q('#__chipel');
      if (st.chip) {
        let c = chip; if (!c) { c = document.createElement('div'); c.id = '__chipel'; c.className = '__chipin'; document.body.appendChild(c); }
        c.innerHTML = `<span>In the app</span>${st.chip.text}`; const u = clamp01(st.chip.a); c.style.opacity = u; c.style.transform = `translateX(-50%) translateY(${(1 - outCubic(u)) * -14}px)`;
      } else if (chip) chip.style.opacity = 0;
      const ring = q('#__ring');
      if (st.ring && st.ring.a > 0) { const [x, y, ww, hh] = st.ring.r, p = 6; Object.assign(ring.style, { left: (x - p) + 'px', top: (y - p) + 'px', width: (ww + 2 * p) + 'px', height: (hh + 2 * p) + 'px', opacity: st.ring.a }); } else ring.style.opacity = 0;
      const cu = q('#__cursor'), ri = q('#__ripple');
      if (st.cur && st.cur.a > 0) {
        cu.style.opacity = st.cur.a; cu.style.transform = `translate(${st.cur.x - 3}px, ${st.cur.y - 2}px) scale(${st.cur.press ? 0.84 : 1})`;
        if (st.cur.ripple != null) { ri.style.opacity = (1 - st.cur.ripple) * 0.9; ri.style.transform = `translate(${st.cur.x}px, ${st.cur.y}px) scale(${0.3 + st.cur.ripple * 0.9})`; } else ri.style.opacity = 0;
      } else { cu.style.opacity = 0; ri.style.opacity = 0; }
      q('#__fade').style.opacity = st.fade || 0;
    },
  };
}

// a white floor that catches the robot's shadow (needs the THREE classes of the app)
async function floorLib() {
  const T = await import('/vendor/three.module.min.js');            // same module instance as the app's
  window.__T = T;
  window.__mkFloor = () => {
    const f = new T.Mesh(new T.PlaneGeometry(60000, 60000), new T.ShadowMaterial({ opacity: 0.1 }));
    f.position.set(0, 0, -1); f.receiveShadow = true; f.visible = false; window.__app.viewer.scene.add(f); return f;
  };
}

// ------------------------------------------------------------------ node-side helpers
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const outCubic = x => 1 - Math.pow(1 - clamp01(x), 3);
const outQuint = x => 1 - Math.pow(1 - clamp01(x), 5);
const lerp = (a, b, u) => a + (b - a) * u;
const lerpArr = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
function track(keys, t, fn = ease) {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b.t) { const u = fn((t - a.t) / Math.max(1e-6, b.t - a.t)); return Array.isArray(a.v) ? lerpArr(a.v, b.v, u) : lerp(a.v, b.v, u); }
  }
  return keys[keys.length - 1].v;
}
function camLerp(a, b, u) {
  const oa = a.pos.map((v, i) => v - a.target[i]), ob = b.pos.map((v, i) => v - b.target[i]);
  const la = Math.hypot(...oa), lb = Math.hypot(...ob), d = lerpArr(oa.map(v => v / la), ob.map(v => v / lb), u), dn = Math.hypot(...d);
  const L = la * Math.pow(lb / la, u), t = lerpArr(a.target, b.target, u);
  return { pos: t.map((v, i) => v + d[i] / dn * L), target: t };
}
const orbit = (target, dist, az, el) => ({ pos: [target[0] + dist * Math.cos(el) * Math.cos(az), target[1] + dist * Math.cos(el) * Math.sin(az), target[2] + dist * Math.sin(el)], target });
/** value that rises to `up`, swings to `down` and returns, inside [t0, t1] */
const swing = (t, t0, t1, v0, up, down = v0) => { const u = (t - t0) / (t1 - t0); if (u <= 0 || u >= 1) return v0; return u < 0.38 ? lerp(v0, up, ease(u / 0.38)) : u < 0.78 ? lerp(up, down, ease((u - 0.38) / 0.4)) : lerp(down, v0, ease((u - 0.78) / 0.22)); };
const fadeIO = (t, dur, a = 0.22, b = 0.22) => Math.max(1 - clamp01(t / a), clamp01((t - (dur - b)) / b));

// ------------------------------------------------------------------ run
mkdirSync(dirname(OUT), { recursive: true });
const server = await startServer(0), port = server.address().port;
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', protocolTimeout: 0,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars', args.includes('--software') ? '--use-angle=swiftshader' : '--use-angle=gl-egl'] });
let ff = null;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
  page.on('pageerror', e => console.error('[page error]', e.message));
  await page.setRequestInterception(true);          // like the hosted site: the CSV is loaded on screen, not next to the app
  page.on('request', r => (r.url().includes('/private/') ? r.respond({ status: 404, body: 'not found' }) : r.continue()));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.__app.S.ready);

  // -- plan everything once (the batch scene is a time-lapse of these results)
  const t0 = Date.now(); process.stdout.write('Planning every task of the table in advance … ');
  const info = await page.evaluate(async text => {
    const a = window.__app; a.loadEnvCSV(text, 'environments.csv', false);
    const envs = a.listEnvs(), jobs = [];
    for (const e of envs) for (const t of e.tasks) jobs.push({ envId: e.id, taskId: t.id });
    await a.planMany(jobs);
    window.__stash = a.S.batch.map(b => ({ envId: b.env.id, taskId: b.task.id, result: b.result }));
    const st = window.__stash, ok = st.filter(s => s.result && s.result.ok), holeOK = ok.filter(s => s.taskId.startsWith('hole'));
    const bySrc = {}; for (const e of envs) if (e.source) bySrc[e.source] = (bySrc[e.source] || 0) + 1;
    // scenes use environments chosen from the data: per source the visually richest one (holes, profiles, tall longis);
    // the planning scene uses a successful hole passage with longis and a tall opening
    const richness = e => 2 * e.walls.reduce((n, w) => n + w.holes.length, 0) + new Set(e.longis.map(l => JSON.stringify(l.prof))).size + Math.max(0, ...e.longis.map(l => l.prof.h)) / 300;
    const sources = [...new Set(envs.map(e => e.source || ''))];
    const best = src => envs.filter(e => (e.source || '') === src).reduce((b, e) => (!b || richness(e) > richness(b) ? e : b), null);
    const envOf = id => envs.find(e => e.id === id), holeH = s => { const t = envOf(s.envId).tasks.find(k => k.id === s.taskId), w = envOf(s.envId).walls[t.wall]; return w.holes[t.hole].H; };
    const plan = holeOK.filter(s => envOf(s.envId).longis.length).sort((x, y) => holeH(y) - holeH(x))[0] || holeOK[0];
    const fail = st.find(s => s.result && !s.result.ok && s.result.failure.reason === 'env') || st.find(s => s.result && !s.result.ok);
    const r = { nEnv: envs.length, nTask: jobs.length, nOK: ok.length, bySrc,
      cycle: sources.map(best).filter(Boolean).slice(0, 4).map(e => e.id),
      plan: plan && { envId: plan.envId, taskId: plan.taskId, phases: plan.result.phases.map(p => [p.label, p.t0]), dur: plan.result.stats.duration },
      fail: fail && { envId: fail.envId, taskId: fail.taskId, msg: fail.result.failure.message, phase: fail.result.failure.phase } };
    r.cycleLabels = r.cycle.map(id => { const e = envs.find(x => x.id === id); return [e.source, e.label]; });
    a.resetEnvs(); document.getElementById('startDlg').hidden = false;
    return r;
  }, csvText);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s: ${info.nOK} / ${info.nTask} succeeded.`);

  await page.addStyleTag({ url: FONTS }); await page.addStyleTag({ content: CSS });
  await page.evaluate(floorLib); await page.evaluate(pageLib, W, H);
  await page.evaluate(() => Promise.all(['600 66px "Inter Tight"', '600 19px "Inter"', '400 22px "Inter"', '500 19px "Inter"', '400 15px "JetBrains Mono"'].map(f => document.fonts.load(f))).then(() => document.fonts.ready));
  const fontsOK = await page.evaluate(() => document.fonts.check('600 66px "Inter Tight"'));
  if (!fontsOK) console.warn('Warning: "Inter Tight" did not load; a fallback font is used.');
  await page.evaluate(async () => { const m = await import('/src/viewer.js'); Object.assign(m.STATUS_COLORS, { none: 0xe8e8ed, ok: 0x34c759, partial: 0xff9f0a, fail: 0xff3b30 }); });
  await page.evaluate(() => window.__film.mode('app'));

  const cdp = await page.target().createCDPSession();
  ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  let frames = 0;
  const capture = async () => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
    if (!ff.stdin.write(Buffer.from(data, 'base64'))) await once(ff.stdin, 'drain');
    frames++;
  };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const film = (name, ...a) => page.evaluate((n, a) => window.__film[n](...a), name, a);
  let cursor = [W - 120, H - 60];
  async function scene(name, dur, fn) {
    if (ONLY && !ONLY.has(name)) return;
    const n = Math.round(dur * FPS), done = new Set(), t1 = Date.now();
    for (let i = 0; i < n; i++) {
      const t = i / FPS;
      const at = async (T, action) => { if (t >= T && !done.has(T)) { done.add(T); await action(); } };
      const st = (await fn(t, at)) || {};
      st.t = t;
      await page.evaluate(s => window.__film.frame(s), st);
      await capture();
    }
    console.log(`  ${name.padEnd(16)} ${dur.toFixed(1).padStart(5)} s   rendered in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  }
  const cursorAt = (t, keys, clicks = []) => {
    const p = track(keys.map(k => ({ t: k.t, v: k.p })), t); cursor = p;
    const c = clicks.find(tc => t >= tc && t < tc + 0.45);
    return { x: p[0], y: p[1], a: 1, press: clicks.some(tc => t >= tc && t < tc + 0.12), ripple: c != null ? (t - c) / 0.45 : null };
  };
  // app-window framing: full view, then a zoom that brings `rect` (untransformed app coordinates) to the centre
  const FULL = [W * 0.09, H * 0.12, 0.82];
  const zoomOn = (r, s) => [W / 2 - (r[0] + r[2] / 2) * s, H / 2 + 20 - (r[1] + r[3] / 2) * s, s];
  const toScreen = (win, p) => [win[0] + p[0] * win[2], win[1] + p[1] * win[2]];
  const toScreenR = (win, r) => [win[0] + r[0] * win[2], win[1] + r[1] * win[2], r[2] * win[2], r[3] * win[2]];
  const mid = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];
  /** A short look at the app: full window -> zoom on target, ring + cursor click. Returns after the scene. */
  async function glimpse(name, dur, sel, text, clickAt, action, zoom = 1.75) {
    if (ONLY && !ONLY.has(name)) return;
    await film('mode', 'app');
    const r = await film('rectLocal', sel), Z = zoomOn(r, zoom);
    await scene(name, dur, async (t, at) => {
      if (clickAt != null && action) await at(clickAt + 0.05, action);
      const win = track([{ t: 0, v: FULL }, { t: 0.15, v: FULL }, { t: 0.95, v: Z }], t, outQuint);
      const target = toScreen(win, mid(r));
      return { win, chip: { a: Math.min(t / 0.3, (dur - t) / 0.25), text }, ring: { r: toScreenR(win, r), a: clamp01((t - 0.75) / 0.25) * clamp01((dur - t) / 0.2) * (clickAt != null ? clamp01((clickAt + 0.45 - t) / 0.2) : 1) },
        cur: cursorAt(t, [{ t: 0.1, p: cursor }, { t: 0.95, p: target }], clickAt != null ? [clickAt] : []), fade: fadeIO(t, dur, 0.18, 0.2) };
    });
  }
  const urdfLines = await ev(async () => {
    const m = await import('/src/urdf.js'), L = m.toURDF(window.__app.S.robot).split('\n'), out = [];
    for (const j of ['fr_yaw1', 'fr_pitch1']) { const i = L.findIndex(l => l.includes(`<joint name="${j}"`)); if (i >= 0) { let k = i; while (k < L.length && !L[k].includes('</joint>')) out.push(L[k++]); out.push(L[k]); } }
    return out.map(l => l.replace(/^\s{2}/, '').replace(/effort="[^"]*" velocity="[^"]*"/, '…'));
  });

  // =============================================================== scenes
  // 1. opening
  await film('mode', 'stage');
  {
    const dur = 3.6;
    await scene('opening', dur, async t => {
      await film('robot', { cam: orbit([0, 0, 430], 4300 - 320 * outCubic(t / dur), -0.95 + 0.32 * t / dur, 0.44), shift: [0, 0.11] });
      return { texts: [{ id: 'o', align: 'center', y: 74, eyebrow: 'Ship-Block Passage Simulator', lines: ['Size the robot.', 'Test every block.'], t0: 0.15, t1: dur }], fade: Math.max(1 - clamp01(t / 0.35), clamp01((t - dur + 0.2) / 0.2)) };
    });
  }
  // 2. data
  await glimpse('data-app', 2.0, '#startDlg .card', 'Load environment CSV', 1.35, () => ev((tx, n) => window.__app.loadEnvCSV(tx, n), csvText, csvName), 1.45);
  await film('mode', 'stage');
  {
    const dur = 3.9, rows = csvText.split('\n').filter(l => l && !l.startsWith('#'));
    const cols = rows[0].split(','), ci = n => cols.indexOf(n), split = l => l.match(/("[^"]*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, ''));
    const head = 'id, source, longi_h, longi_pitch, hole_W×H, sill';
    const pickRows = rows.slice(1).filter((l, i, a) => i % Math.max(1, Math.floor(a.length / 8)) === 0).slice(0, 8);
    const body = pickRows.map(l => { const c = split(l); return [c[ci('id')].replace(/^V_/, '').replace(/\/.*$/, '').replace(/_/g, ' '), c[ci('source')], c[ci('longi_h')].split(';')[0], c[ci('longi_pitch')], c[ci('hole_W')] ? `${c[ci('hole_W')].split(';')[0]}×${c[ci('hole_H')].split(';')[0]}` : '', c[ci('hole_sill')].split(';')[0]]; });
    await ev(() => { const v = window.__app.viewer; v.envGroup.visible = false; v.robotGroup.visible = false; v.ovGroup.visible = false; v.render(); });
    await scene('data', dur, async t => {
      const n = Math.floor(clamp01((t - 0.5) / 1.4) * body.length);
      const sheet = `<div style="padding:26px 30px" class="__mono"><div class="m" style="margin-bottom:8px">environments.csv</div><div class="m">${head}</div>` +
        body.slice(0, n).map(r => `<div><span class="t">${r[0]}</span>, <span class="a">${r[1]}</span>, ${r[2] || '–'}, ${r[3] || '–'}, ${r[4] || '–'}, ${r[5] || '–'}</div>`).join('') + '</div>';
      const chips = Object.entries(info.bySrc).map(([k, v], i) => ({ id: 'c' + i, html: `<div style="padding:16px 22px"><div class="__f" style="font:600 34px 'Inter Tight';letter-spacing:-.5px">${Math.round(v * outCubic((t - 2.1 - 0.12 * i) / 0.8))}</div><div class="__lbl" style="margin-top:2px">${k}</div></div>`, x: 820 + i * 196, y: 640, w: 180, t0: 2.0 + 0.12 * i, cls: '__card __grey __f' }));
      return { texts: [{ id: 'd', x: 112, y: 300, w: 640, eyebrow: 'Data', lines: ['Confidential data.', 'Kept out of the code.'], sub: 'Vessel dimensions travel as a separate CSV file. It is read in the browser — never uploaded.', t0: 0.1, t1: dur }],
        cards: [{ id: 'sheet', html: sheet, x: 820, y: 190, w: 690, h: 420, t0: 0.25, t1: dur }, ...chips.map(c => ({ ...c, t1: dur }))], fade: fadeIO(t, dur, 0.2, 0.2) };
    });
  }
  // 3. robot dimensions
  await glimpse('robot-app', 1.8, 'fieldset:has(#p_L1)', 'Robot dimensions', null, null, 1.9);
  await film('mode', 'stage');
  const D = await ev(() => ({ ...window.__app.S.params }));
  {
    const dur = 9.8, R = v => Math.round(v);
    const B = { L: [0.6, 2.6], P: [2.7, 4.4], A: [4.5, 5.9], Y: [6.0, 7.5], F: [7.6, 9.6] };
    await scene('dimensions', dur, async t => {
      const p = { L1: R(swing(t, ...B.L, D.L1, 620, 380)), L2: R(swing(t, ...B.L, D.L2, 600, 380)), plateL: R(swing(t, ...B.P, D.plateL, 1000)), plateW: R(swing(t, ...B.P, D.plateW, 560)),
        actD: R(swing(t, ...B.A, D.actD, 132)), actT: R(swing(t, ...B.A, D.actT, 70)), payH: R(swing(t, ...B.Y, D.payH, 470)) };
      const lu = (t - B.F[0]) / (B.F[1] - B.F[0]);                     // lift: unfold, reach the floor, lift the body, return
      const fold = Math.PI / 2 * (1 - track([{ t: 0, v: 0 }, { t: 0.22, v: 1 }, { t: 0.82, v: 1 }, { t: 1, v: 0 }], lu));
      const touch = await ev(() => { const r = window.__app.S.robot, hwk = r.Ls + r.P.L1 * 0.45, z = hwk - r.hips[0][2] + r.rw; return z + r.zPiv - r.P.liftLen; });
      const slide = track([{ t: 0.2, v: 0 }, { t: 0.42, v: touch }, { t: 0.62, v: D.liftStroke }, { t: 0.82, v: D.liftStroke }, { t: 0.95, v: 0 }], lu);
      const rise = Math.max(0, slide - touch);
      const az = -1.05 + 0.5 * t / dur, cam = orbit([0, 0, 440], 3200, az, 0.47);
      await film('robot', { params: p, fold, slide, rise, cam, shift: [0.2, 0.02] });
      const P = await film('robotPoints');
      const k = (b, x0 = 0.08, x1 = 0.92) => { const u = (t - b[0]) / (b[1] - b[0]); return { prog: clamp01((u - x0) / 0.25), alpha: clamp01((x1 + 0.08 - u) / 0.08) * (u > 0 ? 1 : 0) }; };
      const dims = [];
      if (t > B.L[0] && t < B.L[1]) dims.push({ id: 'l1', a: P.p1, b: P.p2, off: -26, label: 'Link 1', value: `${p.L1} mm`, ...k(B.L) }, { id: 'l2', a: P.p2, b: P.y2, off: -26, label: 'Link 2', value: `${p.L2} mm`, ...k(B.L, 0.16) });
      if (t > B.P[0] && t < B.P[1]) dims.push({ id: 'pl', a: P.plA, b: P.plB, off: 30, label: 'Plate', value: `${p.plateL} × ${p.plateW} mm`, ...k(B.P) });
      if (t > B.A[0] && t < B.A[1]) dims.push({ id: 'ad', a: P.actA, b: P.actB, off: -34, label: 'Actuator', value: `Ø ${p.actD} mm`, ...k(B.A) });
      if (t > B.Y[0] && t < B.Y[1]) dims.push({ id: 'py', a: P.payA, b: P.payB, off: 36, label: 'Payload', value: `${p.payH} mm`, ...k(B.Y) });
      if (t > B.F[0] && t < B.F[1]) dims.push({ id: 'lf', a: P.liftTop, b: P.liftFoot, off: 40, label: 'Lift stroke', value: `${Math.round(slide)} mm`, ...k(B.F, 0.18, 0.84) });
      return { texts: [{ id: 'r', x: 112, y: 290, w: 600, eyebrow: 'Robot', lines: ['Every dimension.', 'One input away.'], sub: 'Link lengths, plate, actuators, payload and lift — the model rebuilds as you type.', t0: 0.1, t1: dur }], dims, fade: fadeIO(t, dur, 0.22, 0.01) };
    });
    await ev(d => window.__app.setParams(d), D);
  }
  // 4. URDF
  {
    const dur = 2.8;
    const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const hl = l => l.split(/(<\/?[a-z_]+|[a-z_]+="[^"]*"|\/?>)/).map(tok => {
      if (/^<\/?[a-z_]+$/.test(tok)) return `<span class="m">${esc(tok.replace(/[a-z_]+$/, ''))}</span><span class="t">${tok.replace(/^<\/?/, '')}</span>`;
      const m = tok.match(/^([a-z_]+)=("[^"]*")$/); if (m) return `<span class="a">${m[1]}</span>=<span class="v">${esc(m[2])}</span>`;
      return `<span class="m">${esc(tok)}</span>`;
    }).join('');
    await ev(() => { const v = window.__app.viewer; v.robotGroup.visible = false; v.envGroup.visible = false; v.render(); });
    await scene('urdf', dur, async t => {
      const n = Math.floor(clamp01((t - 0.3) / 1.4) * urdfLines.length);
      const code = `<div class="__mono" style="padding:30px 34px;font-size:16px;line-height:1.75;white-space:pre">${urdfLines.slice(0, n).map(hl).join('\n')}</div>`;
      return { texts: [{ id: 'u', x: 112, y: 320, w: 600, eyebrow: 'Export', lines: ['Straight to ROS 2.'], sub: 'URDF and SRDF from the same numbers — plus every planned trajectory as JSON.', t0: 0.0, t1: dur }],
        cards: [{ id: 'code', html: code, x: 780, y: 180, w: 730, h: 540, t0: 0.12, t1: dur }], fade: fadeIO(t, dur, 0.2, 0.22) };
    });
  }
  // 5. sources and environments
  await glimpse('env-app', 1.9, '#sourceChips', 'Filter by source', 1.3, () => ev(() => { const a = window.__app; a.setSource((a.listEnvs().find(e => e.source) || {}).source || ''); }), 1.8);
  await ev(() => window.__app.setSource(''));
  await film('mode', 'stage');
  {
    const dur = 2.7, src = Object.entries(info.bySrc);
    await ev(() => { const v = window.__app.viewer; v.envGroup.visible = false; v.robotGroup.visible = false; v.ovGroup.visible = false; v.render(); });
    await scene('sources', dur, async t => ({
      texts: [{ id: 's', align: 'center', y: 150, eyebrow: 'Environments', lines: [`${info.nEnv} environments.`, `${src.length} sources.`], t0: 0.05, t1: dur }],
      cards: src.map(([k, v], i) => ({ id: 'src' + i, cls: '__card __grey __f', x: 800 - (src.length * 330 - 30) / 2 + i * 330, y: 470, w: 300, h: 230, t0: 0.35 + 0.1 * i, t1: dur,
        html: `<div style="padding:34px 34px"><div class="__num" style="color:${i === 0 ? '#0071e3' : '#1d1d1f'}">${Math.round(v * outCubic((t - 0.45 - 0.1 * i) / 1.0))}</div><div class="__lbl">${k}</div></div>` })),
      fade: fadeIO(t, dur, 0.2, 0.2) }));
  }
  {
    const per = 1.1, dur = per * info.cycle.length;
    let shown = -1;
    await scene('env-cycle', dur, async t => {
      const i = Math.min(info.cycle.length - 1, Math.floor(t / per)), u = (t - i * per) / per;
      if (i !== shown) { shown = i; await film('env', { id: info.cycle[i], robot: true, overview: false }); }
      const c0 = await film('viewCam', 'iso'), cam = orbit(c0.target, Math.hypot(...c0.pos.map((v, k) => v - c0.target[k])) * (1.08 - 0.1 * u), Math.atan2(c0.pos[1] - c0.target[1], c0.pos[0] - c0.target[0]) + 0.25 - 0.3 * u, 0.5);
      await film('env', { cam });
      const [s, label] = info.cycleLabels[i];
      return { cards: [{ id: 'lab' + i, cls: '__card __f', x: 112, y: 760, html: `<div style="padding:16px 22px;font:500 18px Inter"><b style="color:#0071e3;font-weight:600">${s}</b>&nbsp;&nbsp;${label}</div>`, t0: i * per + 0.1, t1: (i + 1) * per - 0.05, dur: 0.45 }],
        fade: Math.max(fadeIO(t - i * per, per, 0.16, 0.16)) };
    });
  }
  // 6. overview
  {
    const dur = 4.3; let from = null, to = null;
    await scene('overview', dur, async (t, at) => {
      await at(0, async () => { from = await film('cam'); await film('env', { overview: true, robot: true }); const o = await film('overviewCam'); to = { pos: o.pos.map((v, k) => o.target[k] + (v - o.target[k]) * 1.24), target: o.target }; });
      await film('setCam', camLerp(from, to, ease(t / 3.0)), [0, 0.07 * ease(t / 3.0)]);
      return { texts: [{ id: 'ov', align: 'center', y: 54, eyebrow: 'Overview', lines: ['All of them, side by side.'], t0: 0.5, t1: dur }], fade: fadeIO(t, dur, 0.01, 0.22) };
    });
  }
  // 7. motion planning
  await ev(p => { const a = window.__app; a.setOverview(false, { fit: false }); a.selectEnv(p.envId, p.taskId); }, info.plan);
  await glimpse('plan-app', 1.7, '#btnPlan', 'Plan', 1.15, () => ev(async () => { const a = window.__app; await a.planCurrent(); a.S.playing = false; }), 2.2);
  await film('mode', 'stage');
  {
    const dur = 8.6, T = info.plan.dur, ph = info.plan.phases;
    const STEPS = [['Approach', /Drive up/], ['Lift down', /Unfold|Extend lift/], ['Front legs through', /^Front-(left|right) leg/], ['Body through', /Drive the body|Retract|Fold/], ['Rear legs through', /^Rear-(left|right) leg/], ['Clear', /Drive away/]];
    const stepAt = time => { let s = 0; for (const [label, t0] of ph) if (t0 <= time) { const k = STEPS.findIndex(([, re]) => re.test(label)); if (k > s) s = k; } return s; };
    await film('env', { robot: true, time: 0 });
    const base = await film('viewCam', 'iso');
    await scene('planning', dur, async t => {
      const time = T * clamp01((t - 0.45) / 7.6);
      const cam = { pos: base.pos.map((v, k) => base.target[k] + (v - base.target[k]) * (1.12 - 0.06 * t / dur)), target: base.target };
      await film('env', { time, cam, shift: [0.2, 0.0] });
      const s = stepAt(time);
      const list = STEPS.map(([l], k) => `<div style="display:flex;align-items:center;gap:14px;margin:9px 0;font:${k === s ? 600 : 500} 19px Inter;color:${k === s ? '#1d1d1f' : k < s ? '#86868b' : '#c7c7cc'}">` +
        `<span style="width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font:600 13px Inter;${k === s ? 'background:#0071e3;color:#fff' : k < s ? 'background:#e8e8ed;color:#86868b' : 'border:1.5px solid #d2d2d7;color:#c7c7cc'}">${k + 1}</span>${l}</div>`).join('');
      return { texts: [{ id: 'p', x: 112, y: 150, w: 560, eyebrow: 'Motion planning', lines: ['Finds its own way', 'through the hole.'], sub: 'Legs move only while the lift carries the body. Every frame is collision-checked.', t0: 0.1, t1: dur }],
        cards: [{ id: 'steps', cls: '__f', x: 112, y: 560, w: 420, html: list, t0: 0.6, t1: dur, style: { position: 'absolute' } }], fade: fadeIO(t, dur, 0.22, 0.22) };
    });
  }
  // 8. batch
  await glimpse('batch-app', 1.7, '#btnBatchAll', 'Batch: all', 1.15, null, 2.0);
  await film('mode', 'stage');
  {
    const dur = 5.8; let cam = null;
    await scene('batch', dur, async (t, at) => {
      await at(0, async () => {
        await ev(() => { const a = window.__app, envs = a.listEnvs(); a.S.batch = window.__stash.map(s => { const env = envs.find(e => e.id === s.envId); return { env, task: env.tasks.find(k => k.id === s.taskId), result: null }; }); a.renderBatch(); });
        await film('env', { overview: true, robot: false });
        const o = await film('overviewCam'); cam = { pos: o.pos.map((v, k) => o.target[k] + (v - o.target[k]) * 1.42), target: o.target };
      });
      const p = clamp01((t - 0.8) / 2.8);
      const c = await ev(p => { const a = window.__app, st = window.__stash, k = Math.round(st.length * p); let ch = false; for (let i = 0; i < k; i++) if (!a.S.batch[i].result) { a.S.batch[i].result = st[i].result; ch = true; } if (ch) a.renderBatch(); const d = a.S.batch.filter(b => b.result); return [d.filter(b => b.result.ok).length, d.length]; }, p);
      await film('setCam', { pos: cam.pos.map((v, k) => cam.target[k] + (v - cam.target[k]) * (1 - 0.05 * t / dur)), target: cam.target }, [0.19, 0.03]);
      await film('restyle');
      const stat = (y, n, l, col, i) => ({ id: 'st' + l, cls: '__f', x: 112, y, w: 300, t0: 0.45 + 0.08 * i, t1: dur, style: { position: 'absolute' }, html: `<div style="display:flex;align-items:baseline;gap:14px"><div class="__num" style="font-size:60px;color:${col}">${n}</div><div class="__lbl" style="margin:0">${l}</div></div>` });
      return { texts: [{ id: 'b', x: 112, y: 210, w: 560, eyebrow: 'Batch: all', lines: ['One click.', 'Every case.'], t0: 0.1, t1: dur }],
        cards: [stat(470, c[0], 'passed', '#0071e3', 0), stat(550, c[1] - c[0], 'failed', '#1d1d1f', 1), stat(630, info.nTask, 'runs in total', '#86868b', 2)], fade: fadeIO(t, dur, 0.22, 0.22) };
    });
  }
  // 9. diagnostics
  {
    const dur = 3.6;
    await ev(f => { const a = window.__app; a.setOverview(false, { fit: false }); a.selectEnv(f.envId, f.taskId); }, info.fail);
    await film('env', { robot: true });
    const base = await film('viewCam', 'iso'), T = await ev(() => window.__app.S.cur ? window.__app.S.cur.traj.duration : 0);
    await scene('diagnostics', dur, async t => {
      await film('env', { time: T * clamp01((t - 0.2) / 1.4), cam: { pos: base.pos.map((v, k) => base.target[k] + (v - base.target[k]) * (0.95 - 0.04 * t / dur)), target: base.target }, shift: [0.2, 0.02] });
      return { texts: [{ id: 'f', x: 112, y: 290, w: 560, eyebrow: 'Diagnostics', lines: ['And when it can’t,', 'it tells you why.'], sub: info.fail.msg, t0: 0.1, t1: dur }], fade: fadeIO(t, dur, 0.22, 0.25) };
    });
  }
  // 10. end
  {
    const dur = 3.4;
    await ev(() => { const v = window.__app.viewer; v.envGroup.visible = false; v.robotGroup.visible = false; v.render(); });
    await scene('end', dur, async t => ({
      texts: [{ id: 'e', align: 'center', y: 330, eyebrow: 'Ship-Block Passage Simulator', lines: ['Try it in your browser.'], sub: '<span style="color:#0071e3;font-weight:500;font-size:26px">ship-block-passage-sim.github.io</span>', t0: 0.15 }],
      fade: Math.max(1 - clamp01(t / 0.3), clamp01((t - dur + 0.5) / 0.5)) }));
  }

  ff.stdin.end(); await once(ff, 'close');
  console.log(`\nWrote ${OUT}  (${frames} frames, ${(frames / FPS).toFixed(1)} s, 1920 x 1080 @ ${FPS} fps)`);
} catch (e) {
  console.error(e); if (ff) ff.kill('SIGKILL'); process.exitCode = 1;
} finally {
  await browser.close(); server.close();
}
