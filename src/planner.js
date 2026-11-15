// Motion planning for the two tasks (access-hole passage, longi crossing).
// Scripted gait (keyframes) + collision-checked interpolation + RRT-Connect for every leg swing,
// with a search over the gait parameters. Units mm / rad.
import { hit } from './collide.js';
import { cloneState, lerpState, wrapPi, NQ, Q_FOLD_F, Q_FOLD_R, Q_SLIDE, LEG_LABELS } from './robot.js';
import { xExtent, planningLongis } from './env.js';

const DEG = Math.PI / 180;
export const PLAN_DEFAULTS = {
  envMargin: 10,        // required clearance robot <-> environment [mm]
  selfMargin: 5,        // required clearance between robot parts [mm]
  stabMargin: 20,       // CoM must stay this far inside the support polygon [mm]
  res: 12,              // max displacement of any robot point between two collision checks [mm]
  seed: 1,
  rrtIter: 1500,        // RRT-Connect iterations per leg swing in the first pass (escalated x8, x40 when no path is found)
  maxFull: 10,          // full plans attempted per pass before giving up
  timeBudgetMs: 60000,
  nCross: 1,            // longi task: number of longis to cross
  vDrive: 150, vShift: 80, wJoint: 50 * DEG, vLift: 80, wFold: 40 * DEG, // playback speeds
};

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ collision / stability checks
class Checker {
  constructor(robot, geo, o) {
    this.r = robot; this.o = o; this.S = robot.shapes;
    this.env = geo.shapes.filter(s => !s.isFloor);
    this.allIdx = this.S.map((_, i) => i);
    this.bodyIdx = this.S.filter(s => s.link === 0).map(s => s.idx).concat(robot.liftShapeIdx);
    const pairsOf = idxs => { const set = new Set(idxs); return robot.selfPairs.filter(([i, j]) => set.has(i) || set.has(j)); };
    this.legPairs = robot.legShapeIdx.map(pairsOf);
    this.liftPairs = pairsOf(robot.liftShapeIdx);
  }
  /** Robot shapes (by index) vs. environment + floor. wheelContact: wheels may touch the floor. */
  envHit(idxs, wheelContact = true) {
    const m = this.o.envMargin, S = this.S, E = this.env;
    for (let a = 0; a < idxs.length; a++) {
      const s = S[idxs[a]];
      if ((s.isWheel && wheelContact) || s.isLiftFoot) { if (s.aabb[2] < -0.6) return { type: 'floor', a: s.name, b: 'floor' }; }
      else if (s.aabb[2] < m) return { type: 'floor', a: s.name, b: 'floor' };
      for (let e = 0; e < E.length; e++) if (hit(s, E[e], m)) return { type: 'env', a: s.name, b: E[e].name };
    }
    return null;
  }
  selfHit(pairs) {
    const m = this.o.selfMargin, S = this.S;
    for (let k = 0; k < pairs.length; k++) { const p = pairs[k]; if (hit(S[p[0]], S[p[1]], m)) return { type: 'self', a: S[p[0]].name, b: S[p[1]].name }; }
    return null;
  }
}

function hull2d(pts) {
  const p = pts.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
/** Signed distance of point c to the convex hull of pts (positive = inside). */
export function supportMargin(c, pts) {
  const h = hull2d(pts);
  if (h.length < 3) return -Infinity;
  let m = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    m = Math.min(m, (ex * (c[1] - a[1]) - ey * (c[0] - a[0])) / L);
  }
  return m;
}

// ------------------------------------------------------------------ RRT-Connect (generic, small dimension)
function rrtConnect(qs, qg, edgeOK, lim, rng, W, step, maxIter, deadline) {
  const dim = qs.length;
  const dist = (a, b) => { let s = 0; for (let k = 0; k < dim; k++) { const d = (a[k] - b[k]) * W[k]; s += d * d; } return Math.sqrt(s); };
  const nearest = (T, q) => { let bi = 0, bd = Infinity; for (let i = 0; i < T.length; i++) { const d = dist(T[i].q, q); if (d < bd) { bd = d; bi = i; } } return bi; };
  const steer = (a, b) => { const d = dist(a, b); if (d <= step) return { q: b.slice(), reached: true }; const t = step / d; return { q: a.map((v, k) => v + (b[k] - v) * t), reached: false }; };
  if (edgeOK(qs, qg)) return [qs.slice(), qg.slice()];
  let Ta = [{ q: qs.slice(), p: -1 }], Tb = [{ q: qg.slice(), p: -1 }], swapped = false;
  for (let it = 0; it < maxIter; it++) {
    if ((it & 63) === 0 && Date.now() > deadline) return null;
    const qr = lim.map(([lo, hi]) => lo + (hi - lo) * rng());
    const ia = nearest(Ta, qr), sa = steer(Ta[ia].q, qr);
    if (edgeOK(Ta[ia].q, sa.q)) {
      Ta.push({ q: sa.q, p: ia });
      let ib = nearest(Tb, sa.q), guard = 0;
      while (guard++ < 400) {
        const sb = steer(Tb[ib].q, sa.q);
        if (!edgeOK(Tb[ib].q, sb.q)) break;
        Tb.push({ q: sb.q, p: ib }); ib = Tb.length - 1;
        if (sb.reached) {
          const pa = [], pb = [];
          for (let i = Ta.length - 1; i >= 0; i = Ta[i].p) pa.push(Ta[i].q);
          for (let i = ib; i >= 0; i = Tb[i].p) pb.push(Tb[i].q);
          pa.reverse(); pb.shift();
          const path = pa.concat(pb);
          return swapped ? path.reverse() : path;
        }
      }
    }
    const t = Ta; Ta = Tb; Tb = t; swapped = !swapped;
  }
  return null;
}
function shortcut(path, edgeOK, rng, tries = 120) {
  for (let k = 0; k < tries && path.length > 2; k++) {
    const i = Math.floor(rng() * (path.length - 2)), j = i + 2 + Math.floor(rng() * (path.length - i - 2));
    if (edgeOK(path[i], path[j])) path.splice(i + 1, j - i - 1);
  }
  return path;
}

// ------------------------------------------------------------------ simulation / execution of a transition list
const SUP4 = (lift = false) => ({ w: [1, 1, 1, 1], lift });
const supWithout = (i, lift) => ({ w: [0, 1, 2, 3].map(k => (k === i ? 0 : 1)), lift });

class Sim {
  constructor(robot, geo, o) {
    this.r = robot; this.o = o; this.chk = new Checker(robot, geo, o);
    this.rng = mulberry32(o.seed); this.frames = []; this.phases = []; this.t = 0; this.st = null; this.sup = SUP4();
    const P = robot.P;
    this.legLever = [robot.a0 + P.L1 + robot.Ls + robot.rw, P.L1 + robot.Ls + robot.rw, robot.Ls + robot.rw, robot.rw + P.wheelW];
    this.deadline = Infinity; this.rrtCalls = 0; this.checks = 0; this.noPath = 0;
  }
  snapshot() { return { n: this.frames.length, np: this.phases.length, t: this.t, st: cloneState(this.st), sup: { w: this.sup.w.slice(), lift: this.sup.lift } }; }
  restore(s) { this.frames.length = s.n; this.phases.length = s.np; this.t = s.t; this.st = cloneState(s.st); this.sup = { w: s.sup.w.slice(), lift: s.sup.lift }; }
  start(st, sup) { this.frames.length = 0; this.phases.length = 0; this.t = 0; this.st = cloneState(st); this.sup = sup; this.r.fk(this.st); this.phases.push({ label: 'Start pose', t0: 0, t1: 0 }); this._push(this.st, 0, sup); }
  _push(st, dt, sup, bad = 0) {
    this.t += dt; sup = sup || this.sup || SUP4();
    const f = new Float32Array(4 + NQ + 3);
    f.set(st.base, 0); f.set(st.q, 4);
    f[4 + NQ] = this.t; f[5 + NQ] = this.phases.length - 1;
    f[6 + NQ] = (sup.w[0] ? 1 : 0) | (sup.w[1] ? 2 : 0) | (sup.w[2] ? 4 : 0) | (sup.w[3] ? 8 : 0) | (sup.lift ? 16 : 0) | (bad ? 32 : 0);
    this.frames.push(f);
    if (this.phases.length) this.phases[this.phases.length - 1].t1 = this.t;
  }
  /** Static stability for the current FK. */
  stable(sup) {
    const pts = [];
    for (let i = 0; i < 4; i++) if (sup.w[i]) pts.push(this.r.wheelCenter(i));
    if (sup.lift) pts.push(...this.r.liftFeet());
    const m = supportMargin(this.r.com(), pts);
    return m >= this.o.stabMargin ? null : { type: 'stability', margin: m };
  }
  /** Checks for the current FK. scope: 'full' | 'drive' | 'body' | 'lift' | leg index. */
  problem(st, scope, sup, wheelContact = true) {
    this.checks++;
    if (!this.r.inLimits(st)) return { type: 'limit' };
    const c = this.chk;
    let p;
    if (scope === 'full') p = c.envHit(c.allIdx) || c.selfHit(this.r.selfPairs);
    else if (scope === 'drive') p = c.envHit(c.allIdx);
    else if (scope === 'body') p = c.envHit(c.bodyIdx);
    else if (scope === 'lift') p = c.envHit(this.r.liftShapeIdx) || c.selfHit(c.liftPairs);
    else p = c.envHit(this.r.legShapeIdx[scope], wheelContact) || c.selfHit(c.legPairs[scope]);
    if (p) return p;
    return sup ? this.stable(sup) : null;
  }
  _steps(a, b) {
    const res = this.o.res, r = this.r;
    let d = Math.hypot(b.base[0] - a.base[0], b.base[1] - a.base[1], b.base[2] - a.base[2]);
    d = Math.max(d, Math.abs(wrapPi(b.base[3] - a.base[3])) * (r.P.plateL / 2 + this.legLever[0]));
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(b.q[5 * i + k] - a.q[5 * i + k]) * this.legLever[k]);
    d = Math.max(d, Math.abs(b.q[Q_FOLD_F] - a.q[Q_FOLD_F]) * (r.P.liftLen + r.P.liftStroke), Math.abs(b.q[Q_FOLD_R] - a.q[Q_FOLD_R]) * (r.P.liftLen + r.P.liftStroke), Math.abs(b.q[Q_SLIDE] - a.q[Q_SLIDE]));
    return Math.max(1, Math.ceil(d / res));
  }
  _dt(a, b, type) {
    const o = this.o;
    let t = Math.hypot(b.base[0] - a.base[0], b.base[1] - a.base[1], b.base[2] - a.base[2]) / (type === 'drive' ? o.vDrive : o.vShift);
    if (type !== 'drive') for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) t = Math.max(t, Math.abs(b.q[5 * i + k] - a.q[5 * i + k]) / o.wJoint);
    t = Math.max(t, Math.abs(b.q[Q_FOLD_F] - a.q[Q_FOLD_F]) / o.wFold, Math.abs(b.q[Q_FOLD_R] - a.q[Q_FOLD_R]) / o.wFold, Math.abs(b.q[Q_SLIDE] - a.q[Q_SLIDE]) / o.vLift);
    return t;
  }
  /**
   * Interpolate from the current state to `target`, checking every step.
   * feet: {legIndex: [x,y,z]} wheel centres that stay planted (solved by IK each step).
   */
  _interp(T, quick) {
    const r = this.r, a = cloneState(this.st), target = T.target, scope = T.scope, sup = T.during;
    const full = this._steps(a, target), n = quick ? (T.type === 'shift' || T.type === 'drive' ? Math.max(1, Math.ceil(full / 3)) : 1) : full, prev = cloneState(a);
    for (let k = 1; k <= n; k++) {
      const s = lerpState(a, target, k / n);
      if (T.feet) for (const i in T.feet) {
        const sol = r.ik(+i, s.base, T.feet[i], 1);
        if (!sol) { this.st = prev; return { reason: 'reach', leg: +i, msg: `${LEG_LABELS[i]} leg cannot reach its planted foothold (out of reach)` }; }
        let q1 = sol[0]; if (q1 - prev.q[5 * i] > Math.PI) q1 -= 2 * Math.PI; else if (q1 - prev.q[5 * i] < -Math.PI) q1 += 2 * Math.PI;
        s.q[5 * i] = q1; s.q[5 * i + 1] = sol[1]; s.q[5 * i + 2] = sol[2];
      }
      if (T.type === 'drive' && !quick) { // wheel spin (visual only)
        const dx = s.base[0] - prev.base[0], dy = s.base[1] - prev.base[1];
        for (let i = 0; i < 4; i++) { const R = r.links[r.legLinks[i].wheel].wR; s.q[5 * i + 4] = prev.q[5 * i + 4] + (-dy * R[1] + dx * R[4]) / r.rw; }
      }
      r.fk(s);
      let p = this.problem(s, scope, sup);
      if (!p && quick && T.type !== 'drive' && scope !== 'full') p = this.problem(s, 'full', null); // keyframes: always the complete check
      if (p) { if (!quick) this._push(s, this._dt(prev, s, T.type), sup, 1); this.st = quick ? s : prev; this.badState = s; return { reason: p.type, ...p }; }
      if (!quick) this._push(s, this._dt(prev, s, T.type), sup);
      prev.base.set(s.base); prev.q.set(s.q);
    }
    this.st = prev; return null;
  }
  _swing(T, quick) {
    const r = this.r, i = T.leg, st = cloneState(this.st), o = this.o, sup = T.during;
    const q0 = Array.from(st.q.subarray(5 * i, 5 * i + 4)), qg = Array.from(T.target.q.subarray(5 * i, 5 * i + 4));
    const lim = r.jointLimits.map(l => [-l, l]);
    const setQ = q => { for (let k = 0; k < 4; k++) st.q[5 * i + k] = q[k]; r.fkLeg(i, st); };
    const valid = (q, contact) => { for (let k = 0; k < 4; k++) if (q[k] < lim[k][0] - 1e-9 || q[k] > lim[k][1] + 1e-9) return false; setQ(q); this.checks++; return !(this.chk.envHit(r.legShapeIdx[i], contact) || this.chk.selfHit(this.chk.legPairs[i])); };
    const lev = this.legLever;
    const nSeg = (a, b) => { let d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(b[k] - a[k]) * lev[k]); return Math.max(1, Math.ceil(d / o.res)); };
    const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
    const edge = contact => (a, b) => { const n = nSeg(a, b); for (let k = 1; k <= n; k++) if (!valid(mix(a, b, k / n), contact)) return false; return true; };
    const fail = (p) => { setQ(q0); r.fk(this.st); return p; };
    // stability with the leg unloaded (start) and goal validity
    r.fk(st);
    const s0 = this.stable(sup);
    if (s0) return fail({ reason: 'stability', margin: s0.margin, msg: `${LEG_LABELS[i]} leg: not statically stable when it is lifted (support-polygon margin ${s0.margin.toFixed(0)} mm)` });
    if (!valid(qg, true)) {
      setQ(qg); const p = this.chk.envHit(r.legShapeIdx[i], true) || this.chk.selfHit(this.chk.legPairs[i]) || { type: 'limit' };
      if (!quick) { // show the leg moving straight to the (invalid) target pose
        const n = nSeg(q0, qg); let prev = cloneState(this.st);
        for (let k = 1; k <= n; k++) { setQ(mix(q0, qg, k / n)); const s = cloneState(st); this._push(s, this._dt(prev, s, 'swing'), sup, k === n ? 1 : 0); prev = s; }
      }
      return fail({ reason: p.type, ...p, goal: true, msg: `${LEG_LABELS[i]} leg: target foothold pose is not feasible — ` + describe(p.type === 'limit' ? { reason: 'limit' } : { reason: p.type, a: p.a, b: p.b }) });
    }
    if (quick) { setQ(qg); r.fk(st); const s1 = this.stable(T.after); this.st = st; return s1 ? { reason: 'stability', margin: s1.margin } : null; }
    // lift-off / touch-down by `h` (vertical, via IK); fall back to planning straight from the stance
    const raise = (q, h) => { setQ(q); const c = r.wheelCenter(i); const sol = r.ik(i, st.base, [c[0], c[1], c[2] + h], q[2] >= 0 ? 1 : -1); return sol ? [sol[0], sol[1], sol[2], q[3]] : null; };
    const W = [1, 0.9, 0.55, 0.12];
    let path = null;
    const q0u = raise(q0, 35), qgu = raise(qg, 35);
    this.rrtCalls++;
    // sampling box: first a band around start/goal (most swings stay inside it), then the full joint range
    const pad = [70 * DEG, 100 * DEG, 110 * DEG, 40 * DEG];
    const band = lim.map(([lo, hi], k) => [Math.max(lo, Math.min(q0[k], qg[k]) - pad[k]), Math.min(hi, Math.max(q0[k], qg[k]) + pad[k])]);
    const lifted = q0u && qgu && edge(true)(q0, q0u) && edge(true)(qgu, qg) && valid(q0u, false) && valid(qgu, false);
    for (const [box, iters] of [[band, o.rrtIter], [lim, o.rrtIter * 2]]) {
      if (lifted) { const mid = rrtConnect(q0u, qgu, edge(false), box, this.rng, W, 0.22, iters, this.deadline); if (mid) { path = [q0, ...shortcut(mid, edge(false), this.rng), qg]; break; } }
      else { const p2 = rrtConnect(q0, qg, edge(true), box, this.rng, W, 0.22, iters, this.deadline); if (p2) { path = shortcut(p2, edge(true), this.rng); break; } }
    }
    if (!path) this.noPath++;
    if (!path) {
      // illustrate with the straight joint-space motion up to the first collision
      const n = nSeg(q0, qg); let prev = cloneState(this.st);
      for (let k = 1; k <= n; k++) {
        const q = mix(q0, qg, k / n), ok = valid(q, true); const s = cloneState(st);
        this._push(s, this._dt(prev, s, 'swing'), sup, ok ? 0 : 1); prev = s;
        if (!ok) { const p = this.chk.envHit(r.legShapeIdx[i], true) || this.chk.selfHit(this.chk.legPairs[i]) || {}; this.badState = s; return fail({ reason: 'nopath', a: p.a, b: p.b, msg: `${LEG_LABELS[i]} leg: no swing path found (randomized search, RRT ${o.rrtIter * 3} iterations; not a proof of impossibility; the straight motion collides: ${p.a || "?"} ↔ ${p.b || "?"})` }); }
      }
      return fail({ reason: 'nopath', msg: `${LEG_LABELS[i]} leg: no swing path found (randomized search, RRT ${o.rrtIter * 3} iterations; not a proof of impossibility)` });
    }
    // execute
    let prev = cloneState(this.st);
    for (let s = 0; s + 1 < path.length; s++) {
      const n = nSeg(path[s], path[s + 1]);
      for (let k = 1; k <= n; k++) {
        setQ(mix(path[s], path[s + 1], k / n));
        const cur = cloneState(st), sb = this.stable(sup);
        this._push(cur, this._dt(prev, cur, 'swing'), sup, sb ? 1 : 0); prev = cur;
        if (sb) { this.badState = cur; return fail({ reason: 'stability', margin: sb.margin, msg: `${LEG_LABELS[i]} leg: not statically stable during the swing (margin ${sb.margin.toFixed(0)} mm)` }); }
      }
    }
    this.st = prev; r.fk(this.st);
    return null;
  }
  /**
   * Hardware rules checked before a transition starts:
   *  - leg joints (yaw / pitch) may only move while the lift carries the body; without it the legs are rigid and the robot can only roll;
   *  - when rolling, every wheel must stand upright with its axle across the driving direction.
   */
  _rules(T) {
    const r = this.r, a = this.st, b = T.target;
    let legsMove = false;
    for (let i = 0; i < 4 && !legsMove; i++) for (let k = 0; k < 4; k++) if (Math.abs(b.q[5 * i + k] - a.q[5 * i + k]) > 1e-9) { legsMove = true; break; }
    if (legsMove && !(T.during && T.during.lift)) return { reason: 'nolift', msg: 'Leg joints can only move while the lift supports the body' };
    if (T.type === 'drive') {
      const dx = b.base[0] - a.base[0], dy = b.base[1] - a.base[1], L = Math.hypot(dx, dy);
      if (L > 1e-6) {
        r.fk(a);
        for (let i = 0; i < 4; i++) {
          const R = r.links[r.legLinks[i].wheel].wR;       // wheel axle = local y axis
          if (Math.abs(R[7]) > 0.035 || Math.abs((R[1] * dx + R[4] * dy) / L) > 0.035) return { reason: 'wheel', msg: `${LEG_LABELS[i]} wheel cannot roll in the driving direction (axle not across the direction of travel, or wheel tilted)` };
        }
      }
    }
    return null;
  }
  /** Run transitions in order. Returns null or {index, label, ...failure}. */
  run(trans, quick = false, onStep = null) {
    for (let k = 0; k < trans.length; k++) {
      const T = trans[k];
      if (!quick) { this.phases.push({ label: T.label, t0: this.t, t1: this.t, type: T.type }); if (onStep) onStep(k, T); }
      if (Date.now() > this.deadline) return { index: k, label: T.label, reason: 'timeout', msg: 'Time limit exceeded' };
      let f = this._rules(T);
      if (!f) f = T.type === 'swing' ? this._swing(T, quick) : this._interp(T, quick);
      if (!f && T.after) { this.r.fk(this.st); const s = this.stable(T.after); if (s) f = { reason: 'stability', margin: s.margin }; }
      if (f) return { index: k, label: T.label, ttype: T.type, ...f };
      this.sup = T.after || T.during;
    }
    return null;
  }
}

// ------------------------------------------------------------------ gait building blocks
function describe(f) {
  if (!f) return '';
  if (f.msg) return f.msg;
  switch (f.reason) {
    case 'env': return `Collision: robot '${f.a}' ↔ environment '${f.b}'`;
    case 'floor': return `Floor interference: '${f.a}'`;
    case 'self': return `Self-collision: '${f.a}' ↔ '${f.b}'`;
    case 'limit': return 'Joint limit exceeded';
    case 'stability': return `Not statically stable (centre of mass vs. support polygon: ${f.margin === -Infinity ? 'no support polygon' : 'margin ' + f.margin.toFixed(0) + ' mm'})`;
    case 'reach': return 'Leg out of reach';
    case 'nolift': return 'Leg joints can only move while the lift supports the body';
    case 'wheel': return 'A wheel cannot roll in the driving direction';
    default: return String(f.reason);
  }
}

class Gait {
  constructor(robot, o) {
    this.r = robot; this.o = o; this.P = robot.P; this.fold = robot.fold;
  }
  hipH(z) { return z + this.r.hips[0][2]; }
  /** Lift slide needed for the feet to touch the floor at plate-centre height z (legs vertical). */
  dTouch(z) { return z + this.r.zPiv - this.P.liftLen; }
  liftUsable(z) { const d = this.dTouch(z); return d >= 3 && d <= this.P.liftStroke; }
  liftStowed(st) { st.q[Q_FOLD_F] = st.q[Q_FOLD_R] = this.fold ? Math.PI / 2 : 0; st.q[Q_SLIDE] = 0; }
  /** Leg i straight along body angle `ang` with the wheel at radial distance rho from the hip yaw axis; q4 = 0. */
  legRadial(st, i, ang, rho, z, knee = 1) {
    const r = this.r, w = this.hipH(z) - r.rw, u = rho - r.a0, P = this.P;
    const c3 = (u * u + w * w - P.L1 * P.L1 - r.Ls * r.Ls) / (2 * P.L1 * r.Ls);
    if (c3 > 1 || c3 < -1) return false;
    const q3 = knee * Math.acos(c3), q2 = Math.atan2(w, u) - Math.atan2(r.Ls * Math.sin(q3), P.L1 + r.Ls * Math.cos(q3));
    st.q[5 * i] = r.yawFor(i, ang); st.q[5 * i + 1] = q2; st.q[5 * i + 2] = q3; st.q[5 * i + 3] = 0;
    return true;
  }
  /** Leg i along body angle `ang`, shank vertical, wheel steered to roll along the body x axis. */
  legVertical(st, i, ang, z) {
    const r = this.r, v = r.verticalShank(this.hipH(z) - r.rw);
    if (!v) return false;
    let q4 = wrapPi(ang); if (q4 > Math.PI / 2) q4 -= Math.PI; else if (q4 <= -Math.PI / 2) q4 += Math.PI;
    st.q[5 * i] = r.yawFor(i, ang); st.q[5 * i + 1] = v.q2; st.q[5 * i + 2] = v.q3; st.q[5 * i + 3] = q4;
    return true;
  }
  /** Transitions: deploy the lift (unfold, extend to the floor). */
  liftDeploy(from, z, tag) {
    const out = [], a = cloneState(from);
    if (this.fold) { a.q[Q_FOLD_F] = a.q[Q_FOLD_R] = 0; out.push({ type: 'joints', label: `${tag}Unfold lift legs`, target: cloneState(a), scope: 'lift', during: SUP4(false) }); }
    a.q[Q_SLIDE] = this.dTouch(z);
    out.push({ type: 'joints', label: `${tag}Extend lift to the floor (support)`, target: cloneState(a), scope: 'lift', during: SUP4(false), after: SUP4(true) });
    return { trans: out, state: a };
  }
  liftStow(from, tag) {
    const out = [], a = cloneState(from);
    a.q[Q_SLIDE] = 0; out.push({ type: 'joints', label: `${tag}Retract lift`, target: cloneState(a), scope: 'lift', during: SUP4(false) });
    if (this.fold) { a.q[Q_FOLD_F] = a.q[Q_FOLD_R] = Math.PI / 2; out.push({ type: 'joints', label: `${tag}Fold lift legs`, target: cloneState(a), scope: 'lift', during: SUP4(false) }); }
    return { trans: out, state: a };
  }
  swing(from, i, setLeg, label, lift) {
    const a = cloneState(from);
    if (!setLeg(a, i)) return null;
    return { trans: [{ type: 'swing', label, leg: i, target: a, during: supWithout(i, lift), after: SUP4(lift) }], state: a };
  }
}

// ------------------------------------------------------------------ search bookkeeping
/** Remembers the most advanced failure (for the report and the failure video). */
class Tracker {
  constructor(sim) { this.sim = sim; this.best = null; }
  /** stage: coarse progress of the attempt; replay: {start, trans} to regenerate frames; haveFrames: sim currently holds this attempt's frames. */
  note(f, stage, replay, haveFrames) {
    const score = stage * 1000 + Math.max(0, (f.index ?? 0) + 1);
    if (this.best && score <= this.best.score) return;
    this.best = { score, f, replay, frames: haveFrames ? this.sim.frames.slice() : null, phases: haveFrames ? this.sim.phases.map(p => ({ ...p })) : null };
  }
  /** Leave the frames of the best failure in the sim and return the failure to report. */
  finalize() {
    const b = this.best, sim = this.sim;
    if (!b) return null;
    if (b.frames) { sim.frames = b.frames; sim.phases = b.phases; return b.f; }
    if (!b.replay) return b.f;
    const bad = () => { sim.frames[sim.frames.length - 1][6 + NQ] |= 32; };
    sim.start(b.replay.start, SUP4());
    const idx = b.f.index ?? 0;
    if (idx < 0) { bad(); return b.f; }                       // the start pose itself is invalid
    const saved = sim.deadline; sim.deadline = Date.now() + 8000;
    const f2 = sim.run(b.replay.trans.slice(0, idx + 1)); sim.deadline = saved;
    if (!f2) { bad(); return b.f; }                           // motion reaches the keyframe, but the keyframe itself is invalid
    if (f2.index < idx) return { ...f2, msg: `${describe(f2)} — in addition, the later phase '${b.f.label}' is not feasible either: ${describe(b.f)}` };
    return f2;
  }
}

// ------------------------------------------------------------------ task: access hole
function planHole(ctx) {
  const { robot, env, task, sim, o, log } = ctx, P = robot.P, G = new Gait(robot, o);
  const wall = env.walls[task.wall], hole = wall.holes[task.hole];
  const yN = wall.y0, yF = wall.y0 + wall.t, xc = hole.c, yaw = Math.PI / 2;
  const hipF = robot.hips[0][0], hipR = robot.hips[2][0];
  const D = P.actD, rw = robot.rw;
  const info = {};

  // -- 1) heights at which the body (plate + payload + yaw actuators + stowed lift) fits through the hole
  const st = robot.newState(); G.liftStowed(st);
  for (let i = 0; i < 4; i++) st.q[5 * i + 1] = -Math.PI / 2;   // legs are not part of this check
  const span = Math.max(Math.abs(hipF), Math.abs(hipR)) + D + 40;
  const zs = [];
  for (let z = hole.sill - 50; z <= hole.sill + hole.H + 50; z += 5) {
    let ok = true;
    for (let y = yN - span; y <= yF + span && ok; y += 20) { st.base.set([xc, y, z, yaw]); robot.fk(st); if (sim.chk.envHit(sim.chk.bodyIdx)) ok = false; }
    if (ok) zs.push(z);
  }
  st.base.set([0, 0, 0, 0]); robot.fk(st);
  let bw = 0, zb = Infinity, zt = -Infinity;
  for (const i of sim.chk.bodyIdx) { const a = robot.shapes[i].aabb; bw = Math.max(bw, -a[1], a[4]); zb = Math.min(zb, a[2]); zt = Math.max(zt, a[5]); }
  info.bodyWidth = 2 * bw; info.bodyHeight = zt - zb;
  log(`Body cross-section (plate + payload + yaw actuators + stowed lift): width ${(2 * bw).toFixed(0)} × height ${(zt - zb).toFixed(0)} mm / hole ${hole.W}×${hole.H} R${hole.R}, sill ${hole.sill}`);
  const neutral = (z, y) => { const s0 = robot.newState(); G.liftStowed(s0); s0.base.set([xc, y, z, yaw]); for (let i = 0; i < 4; i++) { s0.q[5 * i] = robot.yawFor(i, i < 2 ? 0 : Math.PI); s0.q[5 * i + 1] = 0.9; s0.q[5 * i + 2] = 0.6; } return s0; };
  if (!zs.length) {
    const zTry = hole.sill + hole.H / 2 - (zt + zb) / 2, s0 = neutral(zTry, yN - span - 300);
    for (let i = 0; i < 4; i++) G.legRadial(s0, i, i < 2 ? 0 : Math.PI, robot.a0 + P.L1 * 0.6, zTry);
    const tgt = cloneState(s0); tgt.base[1] = yF + span;
    sim.start(s0, SUP4());
    const f = sim.run([{ type: 'drive', label: 'Body entering the hole (attempt)', target: tgt, scope: 'body', during: null }]) || {};
    return { ok: false, info, failure: { ...f, label: 'Body through the hole', msg: `Body cross-section (width ${(2 * bw).toFixed(0)} × height ${(zt - zb).toFixed(0)} mm) does not fit through the hole (${hole.W}×${hole.H}, R${hole.R}) with ${o.envMargin} mm clearance` } };
  }
  info.zWindow = [zs[0], zs[zs.length - 1]];
  log(`Plate-centre heights at which the body fits through the hole: ${zs[0]} – ${zs[zs.length - 1]} mm`);

  // -- 2) leg reach at those heights
  const zLeg = zs.filter(z => !!robot.verticalShank(G.hipH(z) - rw));
  if (!zLeg.length) {
    const w = G.hipH(zs[0]) - rw, maxDown = P.L1 + robot.Ls;
    const msg = w > maxDown ? `Legs too short: at the passage height the hip is ${w.toFixed(0)} mm above the wheel centre > L1+L2+L3 = ${maxDown.toFixed(0)} mm (wheels cannot reach the floor)`
      : (w - robot.Ls > P.L1 ? `Legs too short: at the passage height (hip ${G.hipH(zs[0]).toFixed(0)} mm) a wheel cannot be planted with a vertical shank (L2+L3+wheel radius = ${(robot.Ls + rw).toFixed(0)}, L1 = ${P.L1})`
        : `Leg geometry not feasible: the passage height (hip ${G.hipH(zs[0]).toFixed(0)} mm) is too low for the shank length`);
    const s0 = neutral(zs[0], yN - span - 200);
    if (w > maxDown) for (let i = 0; i < 4; i++) { s0.q[5 * i + 1] = Math.PI / 2; s0.q[5 * i + 2] = 0; }   // legs straight down: shows the gap to the floor
    sim.start(s0, SUP4());
    return { ok: false, info, failure: { label: 'Standing at the passage height', reason: 'reach', msg } };
  }
  // legs can only be repositioned while the lift carries the body: keep the heights at which the lift reaches the floor
  const zLift = zLeg.filter(z => G.liftUsable(z));
  if (!zLift.length) {
    sim.start(neutral(zLeg[0], yN - span - 200), SUP4());
    return { ok: false, info, failure: { label: 'Lift support at the passage height', reason: 'nolift', msg: `The lift cannot support the body at the passage height (pivot height ${(zLeg[0] + robot.zPiv).toFixed(0)}–${(zLeg[zLeg.length - 1] + robot.zPiv).toFixed(0)} mm, lift leg length ${P.liftLen}–${P.liftLen + P.liftStroke} mm), so the legs cannot be moved through the hole` } };
  }
  const pick = arr => { const n = arr.length; return [...new Set([arr[0], arr[Math.floor(n / 4)], arr[Math.floor(n / 2)], arr[Math.floor(3 * n / 4)], arr[n - 1]])]; };
  const zCands = pick(zLift);

  const trk = new Tracker(sim); let attempts = 0;
  const quickRun = (start, trans, startCheck) => {
    sim.st = cloneState(start); robot.fk(sim.st);
    if (startCheck) { const q = sim.problem(sim.st, 'full', SUP4()); if (q) return { index: -1, label: 'Start pose', reason: q.type, ...q }; }
    return sim.run(trans, true);
  };
  for (const z of zCands) {
    const lift = true, v = robot.verticalShank(G.hipH(z) - rw), w = G.hipH(z) - rw;
    const rhoMax = robot.a0 + Math.sqrt(Math.max(0, (P.L1 + robot.Ls) ** 2 * 0.97 - w * w));
    const rhos = [...new Set([v.rho, v.rho + 80, v.rho + 160, v.rho - 80].filter(x => x <= rhoMax && x > robot.a0 + 60).map(x => Math.round(x)))];
    for (const rho of rhos) {
      // entry: S (approach) -> A (front hips dh before the wall) -> lift -> front legs through the hole -> stow
      const entry = (dh, alpha) => {
        const S = robot.newState(); G.liftStowed(S);
        const yA = yN - dh - hipF;
        S.base.set([xc, yA - 250, z, yaw]);
        if (!G.legVertical(S, 0, Math.PI / 2 + alpha, z) || !G.legVertical(S, 1, -(Math.PI / 2 + alpha), z)) return null;
        if (!G.legRadial(S, 2, Math.PI, rho, z) || !G.legRadial(S, 3, Math.PI, rho, z)) return null;
        const tr = []; let cur = cloneState(S);
        const A = cloneState(S); A.base[1] = yA; tr.push({ type: 'drive', label: 'Drive up to the wall', target: A, scope: 'drive', during: SUP4() }); cur = A;
        if (lift) { const d = G.liftDeploy(cur, z, ''); tr.push(...d.trans); cur = d.state; }
        for (const i of [0, 1]) { const s = G.swing(cur, i, (a, k) => G.legRadial(a, k, 0, rho, z), `${LEG_LABELS[i]} leg: through the hole, plant on the far side`, lift); if (!s) return null; tr.push(...s.trans); cur = s.state; }
        if (lift) { const d = G.liftStow(cur, ''); tr.push(...d.trans); cur = d.state; }
        return { start: S, trans: tr, end: cur };
      };
      // exit: drive through until the rear hips are gr past the wall -> lift -> rear legs through -> stow -> drive off
      const exit = (from, gr, alpha) => {
        const tr = []; let cur = cloneState(from);
        const B = cloneState(cur); B.base[1] = yF + gr - hipR; tr.push({ type: 'drive', label: 'Drive the body through the hole', target: B, scope: 'drive', during: SUP4() }); cur = B;
        if (lift) { const d = G.liftDeploy(cur, z, ''); tr.push(...d.trans); cur = d.state; }
        for (const i of [2, 3]) { const ang = (i === 2 ? 1 : -1) * (Math.PI / 2 - alpha); const s = G.swing(cur, i, (a, k) => G.legVertical(a, k, ang, z), `${LEG_LABELS[i]} leg: through the hole, plant on the far side`, lift); if (!s) return null; tr.push(...s.trans); cur = s.state; }
        if (lift) { const d = G.liftStow(cur, ''); tr.push(...d.trans); cur = d.state; }
        const E = cloneState(cur); E.base[1] += 350; tr.push({ type: 'drive', label: 'Drive away from the wall', target: E, scope: 'drive', during: SUP4() });
        return { trans: tr };
      };
      const lo = D / 2 + o.envMargin + 3, hi = rho - wall.t - rw - o.envMargin - 3;
      if (hi < lo) { trk.note({ index: 0, label: 'Front legs through the hole', reason: 'reach', msg: `Not enough horizontal reach: with ${rho.toFixed(0)} mm from hip to wheel a foot cannot be planted beyond the wall` }, 0, { start: neutral(z, yN - span - 200), trans: [] }, false); continue; }
      const fr = [0.5, 0.25, 0.75, 0.05, 0.95], alphas = [0, -15 * DEG, 10 * DEG, -30 * DEG];
      const entries = [];
      for (const al of alphas) for (const f of fr) {
        const e = entry(lo + f * (hi - lo), al); if (!e) continue;
        const q = quickRun(e.start, e.trans, true);
        if (!q) entries.push(e); else trk.note(q, 1, { start: e.start, trans: e.trans }, false);
      }
      for (const e of entries) {
        e.exits = [];
        for (const al of alphas) for (const f of fr) {
          const x = exit(e.end, lo + f * (hi - lo), al); if (!x) continue;
          const q = quickRun(e.end, x.trans, false);
          if (!q) e.exits.push(x); else trk.note({ ...q, index: q.index + e.trans.length }, 3, { start: e.start, trans: e.trans.concat(x.trans) }, false);
        }
      }
      entries.sort((a, b) => b.exits.length - a.exits.length);
      for (const e of entries.slice(0, 3)) {
        if (attempts >= o.maxFull || Date.now() > sim.deadline) break;
        attempts++; ctx.progress(`Planning hole passage… (plate height ${z} mm, attempt ${attempts})`);
        sim.start(e.start, SUP4());
        const f1 = sim.run(e.trans);
        if (f1) { trk.note(f1, 2, null, true); continue; }
        const snap = sim.snapshot();
        for (const x of e.exits.slice(0, 3)) {
          sim.restore(snap);
          const f2 = sim.run(x.trans);
          if (!f2) { Object.assign(info, { z, rho, lift }); return { ok: true, info }; }
          trk.note({ ...f2, index: f2.index + e.trans.length }, 4, null, true);
        }
      }
      if (attempts >= o.maxFull || Date.now() > sim.deadline) break;
    }
    if (attempts >= o.maxFull || Date.now() > sim.deadline) break;
  }
  const f = trk.finalize();
  if (!sim.frames.length) sim.start(neutral(zCands[0], yN - span - 200), SUP4());
  return { ok: false, info, failure: f || { label: 'Search', reason: 'none', msg: 'No feasible pose candidate found' } };
}

// ------------------------------------------------------------------ task: longi crossing (sideways, body parallel to the longis)
// The legs are rigid unless the lift carries the body, so the body advances by ROLLING on the wheels (legs frozen,
// leg planes across the longis so that the wheels roll sideways) and the legs are re-placed only at lift stops:
//   stop A (lift down): leading legs step forward over their longi, trailing legs are pulled up over theirs
//   roll r1 (lift stowed)
//   stop B (lift down): leading legs step back, trailing legs reach back again -> same stance as at the start
//   roll r2 = pitch - r1
function planLongi(ctx) {
  const { robot, env, task, sim, o, log } = ctx, P = robot.P, G = new Gait(robot, o);
  // longis as the planner sees them: infinitely long, with the pattern continued beyond the outermost ones
  const longis = planningLongis(env);
  const li = longis.findIndex(l => !l.virtual && l.c === env.longis[task.longi].c);
  const yaw = Math.PI / 2, yc = task.y, rw = robot.rw;
  const nCross = Math.max(1, Math.min(o.nCross | 0, longis.length - li));
  const typ = longis.length > 1 ? (longis[longis.length - 1].c - longis[0].c) / (longis.length - 1) : 800;
  const gapC = k => { // centre of the free gap left of longi k (k = longis.length: right of the last one), measured between flange edges
    const L = k > 0 ? xExtent(longis[k - 1].prof, longis[k - 1].c)[1] : xExtent(longis[0].prof, longis[0].c)[0] - typ;
    const R = k < longis.length ? xExtent(longis[k].prof, longis[k].c)[0] : xExtent(longis[longis.length - 1].prof, longis[longis.length - 1].c)[1] + typ;
    return (L + R) / 2;
  };
  const stops = Array.from({ length: nCross + 1 }, (_, c) => gapC(li + c));      // body position before / after each crossing
  const X0 = stops[0], X1 = stops[nCross];
  const hMax = Math.max(...longis.slice(li, li + nCross).map(l => l.prof.h));
  const info = { from: X0, to: X1 };
  const hipF = robot.hips[0][0], hipR = robot.hips[2][0], hipLat = Math.abs(robot.hips[0][1]);
  const neutral = z => { const s0 = robot.newState(); G.liftStowed(s0); s0.base.set([X0, yc, z, yaw]); for (let i = 0; i < 4; i++) { s0.q[5 * i] = robot.yawFor(i, (i % 2 ? -1 : 1) * Math.PI / 2); s0.q[5 * i + 1] = 0.2; s0.q[5 * i + 2] = 1.2; } return s0; };

  // -- 1) lowest body height that clears the longis while the body travels X0 -> X1 (lift stowed)
  const st = robot.newState(); G.liftStowed(st);
  for (let i = 0; i < 4; i++) st.q[5 * i + 1] = -Math.PI / 2;
  let zClear = null;
  for (let z = hMax; z <= hMax + 900; z += 5) {
    let ok = true;
    for (let x = X0 - 130; x <= X1 + 130 && ok; x += 15) { st.base.set([x, yc, z, yaw]); robot.fk(st); if (sim.chk.envHit(sim.chk.bodyIdx)) ok = false; }
    if (ok) { zClear = z; break; }
  }
  if (zClear == null) { sim.start(neutral(hMax + 400), SUP4()); return { ok: false, info, failure: { label: 'Body height', reason: 'env', msg: 'No body height found that clears the longi' } }; }
  const zLiftMin = Math.ceil((P.liftLen + 3 - robot.zPiv) / 5) * 5;   // lowest plate height at which the lift legs can swing down
  const zL = Math.max(zClear, zLiftMin);
  log(`Lowest plate-centre height that clears the longi (h ${hMax}): ${zClear} mm / lowest height at which the lift can deploy: ${zLiftMin} mm`);
  const zCands = [zL, zL + 60, zL + 130, zL + 220, zL + 320].filter(z => G.liftUsable(z) && G.hipH(z) - rw <= P.L1 + robot.Ls);
  if (!zCands.length) {
    sim.start(neutral(zL), SUP4());
    const w = G.hipH(zL) - rw;
    return { ok: false, info, failure: w > P.L1 + robot.Ls
      ? { label: 'Standing at the passage height', reason: 'reach', msg: `Legs too short: wheels cannot reach the floor from the required hip height ${G.hipH(zL).toFixed(0)} mm (L1+L2+L3 = ${P.L1 + robot.Ls} mm)` }
      : { label: 'Lift support', reason: 'nolift', msg: `The lift cannot support the body at a height that clears the longi (needed pivot height ${(zL + robot.zPiv).toFixed(0)} mm, lift leg length ${P.liftLen}–${P.liftLen + P.liftStroke} mm), so the legs cannot be moved` } };
  }

  // Footholds from which a wheel can roll sideways (along X). Two stance families:
  //   'lat' : leg plane across the longis (wheel directly beside its hip), any reachable distance, yaw2 = 0
  //   'vert': shank vertical, leg turned outward (front legs forward, rear legs backward), wheel steered with yaw2
  const hipX = i => (i % 2 ? 1 : -1) * hipLat, hipY = i => yc + (i < 2 ? hipF : hipR);     // hip position relative to the body centre (world axes)
  const LEAD = [1, 3], TRAIL = [0, 2];           // body yaw 90 deg: body-right legs are on the +X (leading) side
  /** Joint values [q1..q4] of leg i for body at (X, z) and wheel at world x = X + off, or null. */
  const stance = (i, X, z, off, fam) => {
    const base = [X, yc, z, yaw];
    let ty = hipY(i);
    if (fam === 'vert') {
      const v = robot.verticalShank(G.hipH(z) - rw); if (!v) return null;
      const dx = off - hipX(i), r2 = v.rho * v.rho - dx * dx; if (r2 < 0) return null;
      ty += (i < 2 ? 1 : -1) * Math.sqrt(r2);
    }
    const sol = robot.ik(i, base, [X + off, ty, rw], 1); if (!sol) return null;
    let q4 = 0;
    if (fam === 'vert') { q4 = wrapPi(robot.yaw0[i] + sol[0] + Math.PI / 2); if (q4 > Math.PI / 2) q4 -= Math.PI; else if (q4 <= -Math.PI / 2) q4 += Math.PI; }   // axle along the longis
    return [sol[0], sol[1], sol[2], q4];
  };
  const setLeg = (stt, i, off, fam) => { const q = stance(i, stt.base[0], stt.base[2], off, fam); if (!q) return false; for (let k = 0; k < 4; k++) stt.q[5 * i + k] = q[k]; return true; };

  const trk = new Tracker(sim); let attempts = 0, anyPattern = false; const dbg = { stops: 0, liftOK: 0, lead: 0, trail: 0 };
  outer:
  for (const z of zCands) {
    // single-leg test (limits + leg vs. environment / body) with the body at X and the wheel at X + off; cached
    const cache = new Map(), probe = robot.newState(); G.liftStowed(probe);
    for (let i = 0; i < 4; i++) probe.q[5 * i + 1] = -Math.PI / 2;
    const legOK = (i, X, off, fam) => {
      const key = ((i * 2 + (fam === 'vert' ? 1 : 0)) * 16384 + Math.round(X + 4000)) * 16384 + Math.round(off + 4000);
      let v = cache.get(key); if (v !== undefined) return v;
      const q = stance(i, X, z, off, fam);
      if (!q || q.some((val, k) => Math.abs(val) > robot.jointLimits[k] + 1e-9)) v = false;
      else { probe.base.set([X, yc, z, yaw]); const keep = Array.from(probe.q.subarray(5 * i, 5 * i + 4)); probe.q.set(q, 5 * i); robot.fk(probe); v = !(sim.chk.envHit(robot.legShapeIdx[i]) || sim.chk.selfHit(sim.chk.legPairs[i])); probe.q.set(keep, 5 * i); }
      cache.set(key, v); return v;
    };
    const both = (legs, X, off, fam) => legOK(legs[0], X, off, fam) && legOK(legs[1], X, off, fam);
    const rollOK = (legs, off, fam, Xs, Xe) => { for (let X = Xs; X < Xe - 1e-6; X += 20) if (!both(legs, X, off, fam)) return false; return both(legs, Xe, off, fam); };
    const liftCache = new Map();
    const liftFits = X => { const k = Math.round(X); let v = liftCache.get(k); if (v === undefined) { const t = robot.newState(); t.base.set([X, yc, z, yaw]); for (let i = 0; i < 4; i++) t.q[5 * i + 1] = -Math.PI / 2; t.q[Q_SLIDE] = G.dTouch(z); robot.fk(t); v = !sim.chk.envHit(robot.liftShapeIdx); liftCache.set(k, v); } return v; };

    const w = G.hipH(z) - rw, reach = Math.sqrt(Math.max(0, (P.L1 + robot.Ls) ** 2 * 0.98 - w * w));
    const v0 = robot.verticalShank(w), offMax = { lat: hipLat + robot.a0 + reach, vert: v0 ? hipLat + v0.rho : 0 };
    const nominal = hipLat + (v0 ? v0.rho * 0.7 : robot.a0 + reach * 0.6);
    const DELTAS = [0, 140, 180, 220, 260, 300, 350, 400, 460, 520];
    const build = (dl, fr, lead, trail) => {
      // lead = {a, d, fam}: distance a (short) <-> a + d (stepped forward); trail = {b, d, fam}: distance b (pulled up) <-> b + d (reaching back)
      const S = robot.newState(); G.liftStowed(S); S.base.set([X0 + dl, yc, z, yaw]);
      for (const i of LEAD) if (!setLeg(S, i, lead.a, lead.fam)) return null;
      for (const i of TRAIL) if (!setLeg(S, i, -(trail.b + trail.d), trail.fam)) return null;
      const tr = []; let cur = cloneState(S);
      const relocate = (offLead, offTrail, moveLead, moveTrail) => {
        if (!moveLead && !moveTrail) return true;
        const d = G.liftDeploy(cur, z, ''); tr.push(...d.trans); cur = d.state;
        for (const [legs, off, fam, move, what] of [[LEAD, offLead, lead.fam, moveLead, moveLead > 0 ? 'step forward over the longi' : 'step back'], [TRAIL, -offTrail, trail.fam, moveTrail, moveTrail > 0 ? 'pull up over the longi' : 'reach back']]) {
          if (!move) continue;
          for (const i of legs) { const sw = G.swing(cur, i, (stt, k) => setLeg(stt, k, off, fam), `${LEG_LABELS[i]} leg: ${what}`, true); if (!sw) return false; tr.push(...sw.trans); cur = sw.state; }
        }
        const u = G.liftStow(cur, ''); tr.push(...u.trans); cur = u.state; return true;
      };
      const roll = dist => { const T = cloneState(cur); T.base[0] += dist; tr.push({ type: 'drive', label: `Roll sideways ${dist.toFixed(0)} mm (legs rigid)`, target: T, scope: 'drive', during: SUP4() }); cur = T; };
      for (let c = 0; c < nCross; c++) {
        const D = stops[c + 1] - stops[c], r1 = Math.round(D * fr / 20) * 20;
        if (!relocate(lead.a + lead.d, trail.b, lead.d, trail.d)) return null;      // stop A
        roll(r1);
        if (!relocate(lead.a, trail.b + trail.d, -lead.d, -trail.d)) return null;   // stop B
        roll(D - r1);
      }
      return { start: S, trans: tr };
    };

    for (const dl of [0, 60, -60, 120, -120]) for (const fr of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      if (Date.now() > sim.deadline || attempts >= o.maxFull) break outer;
      dbg.stops++;
      // every lift stop must have room for the lift legs
      let liftOK = true; const stopsAB = [];
      for (let c = 0; c < nCross; c++) { const D = stops[c + 1] - stops[c], XA = stops[c] + dl, XB = XA + Math.round(D * fr / 20) * 20; stopsAB.push([XA, XB, XA + D]); if (!liftFits(XA) || !liftFits(XB)) liftOK = false; }
      if (!liftOK) continue;
      dbg.liftOK++;
      // stepping patterns per side that keep both legs valid at every stop and all along both rolls
      const leadOpts = [], trailOpts = [];
      for (const fam of ['vert', 'lat']) for (let a = 150; a <= offMax[fam]; a += 25) for (const d of DELTAS) {
        if (a + d > offMax[fam]) break;
        if (stopsAB.every(([XA, XB, XC]) => both(LEAD, XA, a, fam) && both(LEAD, XA, a + d, fam) && rollOK(LEAD, a + d, fam, XA, XB) && both(LEAD, XB, a, fam) && rollOK(LEAD, a, fam, XB, XC))) leadOpts.push({ a, d, fam, cost: Math.abs(a + d / 2 - nominal) + d * 0.5 });
      }
      if (!leadOpts.length) continue;
      dbg.lead++;
      for (const fam of ['vert', 'lat']) for (let b = 150; b <= offMax[fam]; b += 25) for (const d of DELTAS) {
        if (b + d > offMax[fam]) break;
        if (stopsAB.every(([XA, XB, XC]) => both(TRAIL, XA, -(b + d), fam) && both(TRAIL, XA, -b, fam) && rollOK(TRAIL, -b, fam, XA, XB) && both(TRAIL, XB, -(b + d), fam) && rollOK(TRAIL, -(b + d), fam, XB, XC))) trailOpts.push({ b, d, fam, cost: Math.abs(b + d / 2 - nominal) + d * 0.5 });
      }
      if (!trailOpts.length) continue;
      dbg.trail++; anyPattern = true;
      leadOpts.sort((p, q) => p.cost - q.cost); trailOpts.sort((p, q) => p.cost - q.cost);
      const spread = (arr, key) => { const out = []; for (const x of arr) { if (out.every(y => Math.abs(y[key] - x[key]) >= 75 || y.d !== x.d || y.fam !== x.fam)) out.push(x); if (out.length >= 3) break; } return out; };
      let full = 0;
      for (const lead of spread(leadOpts, 'a')) for (const trail of spread(trailOpts, 'b')) {
        if (Date.now() > sim.deadline || attempts >= o.maxFull) break outer;
        if (full >= 3) break;
        const g = build(dl, fr, lead, trail); if (!g) continue;
        sim.st = cloneState(g.start); robot.fk(sim.st);
        let q = sim.problem(sim.st, 'full', SUP4()); q = q ? { index: -1, label: 'Start pose', reason: q.type, ...q } : sim.run(g.trans, true);
        if (q) { trk.note(q, 1, { start: g.start, trans: g.trans }, false); continue; }
        attempts++; full++;
        ctx.progress(`Planning longi crossing… (plate height ${z} mm, attempt ${attempts})`);
        sim.start(g.start, SUP4());
        const f = sim.run(g.trans);
        if (!f) { Object.assign(info, { z, roll1: Math.round((stops[1] - stops[0]) * fr / 20) * 20, pitch: stops[1] - stops[0], leadOffset: lead.a, leadStep: lead.d, leadStance: lead.fam, trailOffset: trail.b, trailStep: trail.d, trailStance: trail.fam, lift: true }); return { ok: true, info }; }
        trk.note(f, 2, null, true);
      }
    }
  }
  if (o.debug) log(`[search] stop combinations ${dbg.stops}, lift fits ${dbg.liftOK}, with a leading-leg pattern ${dbg.lead}, with both patterns ${dbg.trail}`);
  const f = trk.finalize();
  if (!sim.frames.length) sim.start(neutral(zCands[0]), SUP4());
  return { ok: false, info, failure: f || { label: 'Stepping pattern search', reason: 'reach', msg: anyPattern ? 'No stepping pattern passed the full pose check' : (dbg.liftOK === 0 ? 'The lift legs do not fit between / astride the longis at any pair of stops, so the legs cannot be moved' : dbg.lead === 0 ? 'No stepping pattern for the leading legs: their wheels cannot roll inside a channel and step over the longi from the lift stops (leg reach vs. longi height / spacing)' : 'No stepping pattern for the trailing legs: their wheels cannot roll inside a channel and step over the longi from the lift stops (leg reach vs. longi height / spacing)') } };
}

/** All colliding pairs of a state (for display). */
export function diagnose(robot, geo, st, userOpts = {}) {
  const o = { ...PLAN_DEFAULTS, ...userOpts }, c = new Checker(robot, geo, o), out = [], S = robot.shapes;
  robot.fk(st);
  for (const s of S) {
    if (s.isWheel || s.isLiftFoot) { if (s.aabb[2] < -0.6) out.push({ type: 'floor', a: s.name, b: 'floor' }); }
    else if (s.aabb[2] < o.envMargin) out.push({ type: 'floor', a: s.name, b: 'floor' });
    for (const e of c.env) if (hit(s, e, o.envMargin)) out.push({ type: 'env', a: s.name, b: e.name });
  }
  for (const [i, j] of robot.selfPairs) if (hit(S[i], S[j], o.selfMargin)) out.push({ type: 'self', a: S[i].name, b: S[j].name });
  return out;
}

// ------------------------------------------------------------------ entry point
/**
 * Plan one task. Returns {ok, frames:[Float32Array], phases, failure, info, log, stats}.
 * Frame layout: [x,y,z,yaw, q(23), t, phaseIndex, flags]; flags bit0-3 wheel support, bit4 lift support, bit5 failing state.
 */
export function plan(robot, env, geo, task, userOpts = {}, onProgress = () => {}) {
  const o = { ...PLAN_DEFAULTS, ...userOpts };
  const t0 = Date.now(), logLines = [];
  const sim = new Sim(robot, geo, o); sim.deadline = t0 + o.timeBudgetMs;
  const ctx = { robot, env, geo, task, sim, o, log: s => logLines.push(s), progress: onProgress };
  for (const wmsg of robot.warnings) logLines.push('Warning: ' + wmsg);
  let res;
  // Escalation: leg-swing planning is probabilistic, so when a pass fails only because no swing path was found,
  // repeat with a larger RRT budget (and other random numbers) while time remains.
  for (const mult of [1, 8, 40]) {
    o.rrtIter = (userOpts.rrtIter || PLAN_DEFAULTS.rrtIter) * mult; sim.noPath = 0; sim.rng = mulberry32(o.seed + mult);
    if (mult > 1) { onProgress(`Searching swing paths harder (RRT ×${mult})…`); logLines.push(`Swing-path search repeated with RRT iterations ×${mult}`); }
    try { res = task.type === 'hole' ? planHole(ctx) : planLongi(ctx); }
    catch (e) { res = { ok: false, failure: { label: 'Internal error', reason: 'error', msg: String(e && e.stack || e) } }; }
    if (res.ok || !sim.noPath || Date.now() > sim.deadline - 2000) break;
  }
  if (!sim.frames.length) { const s0 = robot.newState(); s0.base[2] = 600; sim.start(s0, SUP4()); }
  const F = res.failure;
  const failure = res.ok ? null : { phase: F.label || '', reason: F.reason, message: describe(F), a: F.a || null, b: F.b || null, timedOut: Date.now() > sim.deadline };
  if (failure && failure.timedOut) failure.message += ' (search time limit reached)';
  return {
    ok: !!res.ok, task: task.id, taskLabel: task.label, envId: env.id, frames: sim.frames, phases: sim.phases, failure, info: res.info || {}, log: logLines,
    stats: { ms: Date.now() - t0, checks: sim.checks, rrtCalls: sim.rrtCalls, duration: sim.t },
  };
}
