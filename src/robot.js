// Parametric robot model: body plate + payload + 4 legs (Yaw-Pitch-Pitch-Yaw-Wheel) + table-leg lift.
// Units: mm / rad. Body frame: x forward (plate length), y left (plate width), z up, origin = plate centre.
import { box, cyl, updateAABB } from './collide.js';

export const LEG_NAMES = ['fl', 'fr', 'rl', 'rr'];
export const LEG_LABELS = ['Front-left', 'Front-right', 'Rear-left', 'Rear-right'];
export const NQ = 23;                       // 4 legs x 5 + fold front + fold rear + slide
export const Q_FOLD_F = 20, Q_FOLD_R = 21, Q_SLIDE = 22;
const DEG = Math.PI / 180;

/** Parameter schema: [key, default, label, group, unit]. Groups 1-6 are the user's six input groups. */
export const PARAM_SCHEMA = [
  ['plateL', 780, 'Plate length (travel direction, X)', '1. Centre plate', 'mm'],
  ['plateW', 450, 'Plate width (Y)', '1. Centre plate', 'mm'],
  ['plateT', 25, 'Plate thickness (Z)', '1. Centre plate', 'mm'],
  ['actD', 90, 'Actuator diameter', '2. Actuator (cylinder)', 'mm'],
  ['actT', 50, 'Actuator thickness', '2. Actuator (cylinder)', 'mm'],
  ['L1', 450, 'Link 1: Pitch1–Pitch2', '3. Leg links', 'mm'],
  ['L2', 450, 'Link 2: Pitch2–Yaw2', '3. Leg links', 'mm'],
  ['L3', 100, 'Link 3: Yaw2–Wheel', '3. Leg links', 'mm'],
  ['payL', 500, 'Payload length (X)', '4. Payload', 'mm'],
  ['payW', 400, 'Payload width (Y)', '4. Payload', 'mm'],
  ['payH', 250, 'Payload height (Z)', '4. Payload', 'mm'],
  ['liftSX', 640, 'Leg spacing, lengthwise (X, front–rear)', '5. Lift leg spacing', 'mm'],
  ['liftSY', 400, 'Leg spacing, crosswise (Y, left–right)', '5. Lift leg spacing', 'mm'],
  ['liftLen', 620, 'Leg length (retracted, pivot to foot sole)', '6. Lift legs', 'mm'],
  ['liftStroke', 300, 'Linear stroke', '6. Lift legs', 'mm'],
  // ---- advanced / assumed
  ['hipMount', 'end', 'Yaw1 zero direction (end = along the plate length, side = across)', 'Advanced: geometry', ''],
  ['hipOffset', 0, 'Yaw1–Pitch1 axis distance (0 = auto: one diameter)', 'Advanced: geometry', 'mm'],
  ['linkD', 40, 'Link tube diameter', 'Advanced: geometry', 'mm'],
  ['wheelD', 100, 'Wheel diameter', 'Advanced: geometry', 'mm'],
  ['wheelW', 40, 'Wheel width', 'Advanced: geometry', 'mm'],
  ['liftFold', 1, 'Folding lift legs (1 = foldable, 0 = fixed vertical)', 'Advanced: lift', ''],
  ['liftSYin', 0, 'Rear pair crosswise spacing (0 = auto: nested inside the front pair)', 'Advanced: lift', 'mm'],
  ['liftLegW', 50, 'Lift leg section width', 'Advanced: lift', 'mm'],
  ['liftPivotDrop', 45, 'Plate underside to fold pivot', 'Advanced: lift', 'mm'],
  ['liftFootD', 35, 'Lift foot diameter', 'Advanced: lift', 'mm'],
  ['yaw1Lim', 170, 'Yaw1 limit ±', 'Advanced: joint limits', 'deg'],
  ['pitch1Lim', 120, 'Pitch1 limit ±', 'Advanced: joint limits', 'deg'],
  ['pitch2Lim', 160, 'Pitch2 limit ±', 'Advanced: joint limits', 'deg'],
  ['yaw2Lim', 180, 'Yaw2 limit ±', 'Advanced: joint limits', 'deg'],
  ['bodyMass', 6, 'Plate + electronics mass', 'Advanced: masses (for the stability check)', 'kg'],
  ['payMass', 10, 'Payload mass', 'Advanced: masses (for the stability check)', 'kg'],
  ['actMass', 0.9, 'Mass of one actuator', 'Advanced: masses (for the stability check)', 'kg'],
  ['wheelMass', 0.3, 'Wheel mass', 'Advanced: masses (for the stability check)', 'kg'],
  ['tubeMassPerM', 0.4, 'Link tube mass', 'Advanced: masses (for the stability check)', 'kg/m'],
  ['liftLegMass', 1.3, 'Mass of one lift leg', 'Advanced: masses (for the stability check)', 'kg'],
];
export function defaultParams() { const p = {}; for (const [k, v] of PARAM_SCHEMA) p[k] = v; return p; }

// ---------------------------------------------------------------- small math
function rpy(r, p, y) { // URDF fixed-axis roll-pitch-yaw -> row-major 3x3
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return new Float64Array([cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, -sp, cp * sr, cp * cr]);
}
function mul(A, B, out) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
}
function axisAngle(ax, t, out) {
  const [x, y, z] = ax, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  out[0] = c + x * x * C; out[1] = x * y * C - z * s; out[2] = x * z * C + y * s;
  out[3] = y * x * C + z * s; out[4] = c + y * y * C; out[5] = y * z * C - x * s;
  out[6] = z * x * C - y * s; out[7] = z * y * C + x * s; out[8] = c + z * z * C;
}
export function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; }

// ---------------------------------------------------------------- model
export function buildRobot(params) {
  const P = { ...defaultParams(), ...params };
  for (const [k, def] of PARAM_SCHEMA) if (typeof def === 'number') P[k] = Number(P[k]);
  const a0 = P.hipOffset > 0 ? P.hipOffset : P.actD;
  const D = P.actD, T = P.actT, rl = P.linkD / 2, rw = P.wheelD / 2;
  const Ls = P.L2 + P.L3;
  const fold = !!P.liftFold;
  const warnings = [];

  const links = [], shapes = [];
  const I3 = () => rpy(0, 0, 0);
  function addLink(name, parent, o) {
    const L = {
      name, parent, idx: links.length, oP: o.p || [0, 0, 0], oRPY: o.rpy || [0, 0, 0], jtype: o.jtype || 'fixed', axis: o.axis || [0, 0, 1],
      qi: o.qi ?? -1, lower: o.lower ?? 0, upper: o.upper ?? 0, jname: o.jname || (name + '_joint'), mimic: o.mimic || null,
      mass: 0, mcom: [0, 0, 0], shapes: [], wR: new Float64Array(9), wp: new Float64Array(3), leg: o.leg ?? -1, group: o.group || 'body',
    };
    L.oR = rpy(...L.oRPY);
    links.push(L); return L.idx;
  }
  function addMass(li, m, c) { const L = links[li]; for (let k = 0; k < 3; k++) L.mcom[k] += m * c[k]; L.mass += m; }
  function addShape(li, name, kind, s, p, r, color, extra = {}) {
    s.name = name; s.kind = kind; s.link = li; s.lp = p; s.lRPY = r; s.lR = rpy(...r); s.color = color; s.idx = shapes.length;
    s.isWheel = kind === 'wheel'; s.isLiftFoot = kind === 'liftfoot'; s.leg = links[li].leg; Object.assign(s, extra);
    shapes.push(s); links[li].shapes.push(s); return s;
  }
  const AX_X = [0, Math.PI / 2, 0], AX_Y = [-Math.PI / 2, 0, 0], AX_Z = [0, 0, 0]; // cylinder (local z) -> axis
  const COL = { plate: 0xb9c0c8, pay: 0xd9434f, act: 0x3a3f47, tube: 0x18191c, wheel: 0x2b2b2e, lift: 0x8e98a6, rod: 0xd0d5dc, foot: 0x30343a };

  // ---- base
  // The yaw actuators are inscribed in the plate corners (tangent to both edges from the inside), so the plate
  // outline is a rectangle whose corners are rounded with the actuator radius: two crossed boxes + the actuator cylinders.
  const base = addLink('base_link', -1, {});
  if (D > Math.min(P.plateL, P.plateW) / 2) warnings.push('The actuator diameter is more than half of the plate width/length: the corner actuators overlap each other.');
  const cx = Math.max(1, P.plateL / 2 - D / 2), cy = Math.max(1, P.plateW / 2 - D / 2);
  addShape(base, 'plate', 'plate', box(P.plateL / 2, cy, P.plateT / 2), [0, 0, 0], [0, 0, 0], COL.plate);
  addShape(base, 'plate_ends', 'plate', box(cx, P.plateW / 2, P.plateT / 2), [0, 0, 0], [0, 0, 0], COL.plate);
  addMass(base, P.bodyMass, [0, 0, 0]);
  if (P.payL > 0 && P.payW > 0 && P.payH > 0) {
    addShape(base, 'payload', 'payload', box(P.payL / 2, P.payW / 2, P.payH / 2), [0, 0, P.plateT / 2 + P.payH / 2], [0, 0, 0], COL.pay);
    addMass(base, P.payMass, [0, 0, P.plateT / 2 + P.payH / 2]);
  }

  // ---- legs
  const side = P.hipMount === 'side';
  const hips = [], yaw0 = [];
  for (let i = 0; i < 4; i++) {
    const fx = i < 2 ? 1 : -1, fy = i % 2 === 0 ? 1 : -1;
    hips.push([fx * (P.plateL / 2 - D / 2), fy * (P.plateW / 2 - D / 2), 0]);     // inside the corner, tangent to both plate edges
    yaw0.push(side ? fy * Math.PI / 2 : (fx > 0 ? 0 : Math.PI));
  }
  const lim = [P.yaw1Lim * DEG, P.pitch1Lim * DEG, P.pitch2Lim * DEG, P.yaw2Lim * DEG];
  const legLinks = [];
  for (let i = 0; i < 4; i++) {
    const n = LEG_NAMES[i], g = 'leg' + i;
    addShape(base, `${n}_yaw1_act`, 'act', cyl(D / 2, T / 2), hips[i], AX_Z, COL.act);
    addMass(base, P.actMass, hips[i]);
    const hip = addLink(`${n}_hip`, base, { p: hips[i], rpy: [0, 0, yaw0[i]], jtype: 'revolute', axis: [0, 0, 1], qi: 5 * i, lower: -lim[0], upper: lim[0], jname: `${n}_yaw1`, leg: i, group: g });
    addShape(hip, `${n}_pitch1_act`, 'act', cyl(D / 2, T / 2), [a0, 0, 0], AX_Y, COL.act);
    addMass(hip, P.actMass, [a0, 0, 0]);
    const thigh = addLink(`${n}_thigh`, hip, { p: [a0, 0, 0], jtype: 'revolute', axis: [0, 1, 0], qi: 5 * i + 1, lower: -lim[1], upper: lim[1], jname: `${n}_pitch1`, leg: i, group: g });
    addShape(thigh, `${n}_link1`, 'tube', cyl(rl, P.L1 / 2), [P.L1 / 2, 0, 0], AX_X, COL.tube);
    addShape(thigh, `${n}_pitch2_act`, 'act', cyl(D / 2, T / 2), [P.L1, 0, 0], AX_Y, COL.act);
    addMass(thigh, P.tubeMassPerM * P.L1 / 1000, [P.L1 / 2, 0, 0]); addMass(thigh, P.actMass, [P.L1, 0, 0]);
    const shank = addLink(`${n}_shank`, thigh, { p: [P.L1, 0, 0], jtype: 'revolute', axis: [0, 1, 0], qi: 5 * i + 2, lower: -lim[2], upper: lim[2], jname: `${n}_pitch2`, leg: i, group: g });
    addShape(shank, `${n}_link2`, 'tube', cyl(rl, P.L2 / 2), [P.L2 / 2, 0, 0], AX_X, COL.tube);
    addShape(shank, `${n}_yaw2_act`, 'act', cyl(D / 2, T / 2), [P.L2, 0, 0], AX_X, COL.act);
    addMass(shank, P.tubeMassPerM * P.L2 / 1000, [P.L2 / 2, 0, 0]); addMass(shank, P.actMass, [P.L2, 0, 0]);
    const foot = addLink(`${n}_foot`, shank, { p: [P.L2, 0, 0], jtype: 'revolute', axis: [1, 0, 0], qi: 5 * i + 3, lower: -lim[3], upper: lim[3], jname: `${n}_yaw2`, leg: i, group: g });
    addShape(foot, `${n}_link3`, 'tube', cyl(rl, P.L3 / 2), [P.L3 / 2, 0, 0], AX_X, COL.tube);
    addMass(foot, Math.max(0.05, P.tubeMassPerM * P.L3 / 1000), [P.L3 / 2, 0, 0]);
    const wheel = addLink(`${n}_wheel`, foot, { p: [P.L3, 0, 0], jtype: 'continuous', axis: [0, 1, 0], qi: 5 * i + 4, jname: `${n}_wheel_spin`, leg: i, group: g });
    addShape(wheel, `${n}_wheel`, 'wheel', cyl(rw, P.wheelW / 2), [0, 0, 0], AX_Y, COL.wheel);
    addMass(wheel, P.wheelMass, [0, 0, 0]);
    legLinks.push({ hip, thigh, shank, foot, wheel });
  }

  // ---- lift (two pairs of table legs; each pair folds about a shaft across the width, each leg telescopes)
  const zPiv = -P.plateT / 2 - P.liftPivotDrop;
  const footH = 25, gap = 5;
  const Lh = P.liftLen - footH - gap;                       // housing length (pivot -> housing end)
  let wF = P.liftSY, wR = P.liftSYin > 0 ? P.liftSYin : (fold && P.liftLen > P.liftSX / 2 - P.liftLegW ? P.liftSY - 2 * (P.liftLegW + 10) : P.liftSY);
  if (wR < P.liftLegW) { warnings.push('The rear lift pair is too narrow: increase the crosswise spacing or reduce the leg width.'); wR = Math.max(wR, 10); }
  if (P.liftStroke > Lh) warnings.push(`Lift stroke (${P.liftStroke}) is longer than the leg housing (${Lh.toFixed(0)}): not possible with a single telescoping stage.`);
  if (fold && P.liftLen + 15 > P.liftSX) warnings.push('Lift legs are longer than the lengthwise spacing: when folded they hit the opposite shaft.');
  const liftPairs = [];
  const rodLen = Math.max(10, Math.min(P.liftStroke + 10, Lh - 5));
  for (let k = 0; k < 2; k++) {
    const front = k === 0, w = front ? wF : wR, nm = front ? 'lift_front' : 'lift_rear';
    const pair = addLink(nm, base, {
      p: [(front ? 1 : -1) * P.liftSX / 2, 0, zPiv], jtype: fold ? 'revolute' : 'fixed', axis: [0, front ? 1 : -1, 0],
      qi: fold ? (front ? Q_FOLD_F : Q_FOLD_R) : -1, lower: 0, upper: Math.PI / 2, jname: `${nm}_fold`, group: 'lift',
    });
    addShape(pair, `${nm}_shaft`, 'shaft', cyl(10, (w + P.liftLegW) / 2), [0, 0, 0], AX_Y, COL.lift);
    const rods = [];
    for (const sgn of [1, -1]) {
      const ln = `${nm}_${sgn > 0 ? 'l' : 'r'}`;
      addShape(pair, `${ln}_housing`, 'liftleg', box(P.liftLegW / 2, P.liftLegW / 2, Lh / 2), [0, sgn * w / 2, -Lh / 2], [0, 0, 0], COL.lift);
      addMass(pair, P.liftLegMass * 0.7, [0, sgn * w / 2, -Lh / 2]);
      const rod = addLink(`${ln}_rod`, pair, {
        p: [0, sgn * w / 2, -Lh], jtype: 'prismatic', axis: [0, 0, -1], qi: Q_SLIDE, lower: 0, upper: P.liftStroke, jname: `${ln}_slide`, group: 'lift',
        mimic: liftPairs.length || rods.length ? 'lift_front_l_slide' : null,
      });
      addShape(rod, `${ln}_rod`, 'liftrod', cyl(P.liftLegW * 0.3, rodLen / 2), [0, 0, rodLen / 2 - gap], AX_Z, COL.rod);
      addShape(rod, `${ln}_foot`, 'liftfoot', cyl(P.liftFootD / 2, footH / 2), [0, 0, -gap - footH / 2], AX_Z, COL.foot);
      addMass(rod, P.liftLegMass * 0.3, [0, 0, 0]);
      rods.push(rod);
    }
    liftPairs.push({ pair, rods, w });
  }
  for (const L of links) if (L.mass > 0) { L.com = L.mcom.map(v => v / L.mass); } else { L.com = [0, 0, 0]; L.mass = 0.01; }

  // ---- self-collision pair list (shape index pairs), skipping same / adjacent links and a few permanent neighbours
  const skip = new Set();
  const key = (a, b) => a < b ? a * 1000 + b : b * 1000 + a;
  for (const L of links) if (L.parent >= 0) skip.add(key(L.idx, L.parent));
  for (const l of legLinks) { skip.add(key(l.shank, l.wheel)); }
  const selfPairs = [];
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    const a = shapes[i].link, b = shapes[j].link;
    if (a === b || skip.has(key(a, b))) continue;
    selfPairs.push([i, j]);
  }
  const linkAdj = skip;

  const totalMass = links.reduce((s, L) => s + L.mass, 0);
  const tmpR = new Float64Array(9), tmpJ = new Float64Array(9);

  function fkLink(L, st) {
    if (L.parent < 0) {
      const c = Math.cos(st.base[3]), s = Math.sin(st.base[3]);
      L.wR.set([c, -s, 0, s, c, 0, 0, 0, 1]); L.wp[0] = st.base[0]; L.wp[1] = st.base[1]; L.wp[2] = st.base[2];
    } else {
      const Pn = links[L.parent], R = Pn.wR;
      const o = L.oP;
      let px = o[0], py = o[1], pz = o[2];
      if (L.jtype === 'prismatic') { const d = st.q[L.qi]; px += L.oR[0] * L.axis[0] * d + L.oR[1] * L.axis[1] * d + L.oR[2] * L.axis[2] * d; py += (L.oR[3] * L.axis[0] + L.oR[4] * L.axis[1] + L.oR[5] * L.axis[2]) * d; pz += (L.oR[6] * L.axis[0] + L.oR[7] * L.axis[1] + L.oR[8] * L.axis[2]) * d; }
      L.wp[0] = R[0] * px + R[1] * py + R[2] * pz + Pn.wp[0];
      L.wp[1] = R[3] * px + R[4] * py + R[5] * pz + Pn.wp[1];
      L.wp[2] = R[6] * px + R[7] * py + R[8] * pz + Pn.wp[2];
      mul(R, L.oR, tmpR);
      if ((L.jtype === 'revolute' || L.jtype === 'continuous') && L.qi >= 0) { axisAngle(L.axis, st.q[L.qi], tmpJ); mul(tmpR, tmpJ, L.wR); }
      else L.wR.set(tmpR);
    }
    for (const s of L.shapes) {
      const R = L.wR, lp = s.lp;
      mul(R, s.lR, s.R);
      s.p[0] = R[0] * lp[0] + R[1] * lp[1] + R[2] * lp[2] + L.wp[0];
      s.p[1] = R[3] * lp[0] + R[4] * lp[1] + R[5] * lp[2] + L.wp[1];
      s.p[2] = R[6] * lp[0] + R[7] * lp[1] + R[8] * lp[2] + L.wp[2];
      updateAABB(s);
    }
  }
  const legLinkIdx = legLinks.map(l => [l.hip, l.thigh, l.shank, l.foot, l.wheel]);
  const liftLinkIdx = liftPairs.flatMap(lp => [lp.pair, ...lp.rods]);
  const legShapeIdx = legLinkIdx.map(ls => ls.flatMap(li => links[li].shapes.map(s => s.idx)));
  const liftShapeIdx = liftLinkIdx.flatMap(li => links[li].shapes.map(s => s.idx));

  const robot = {
    P, a0, Ls, rw, links, shapes, selfPairs, linkAdj, hips, yaw0, legLinks, liftPairs, zPiv, Lh, warnings, totalMass,
    legShapeIdx, liftShapeIdx, legLinkIdx, liftLinkIdx, jointLimits: lim, fold,
    /** Full forward kinematics: updates every link + shape world pose. */
    fk(st) { for (const L of links) fkLink(L, st); },
    fkLeg(i, st) { for (const li of legLinkIdx[i]) fkLink(links[li], st); },
    fkLift(st) { for (const li of liftLinkIdx) fkLink(links[li], st); },
    /** Wheel centre (world) of leg i from the current FK. */
    wheelCenter(i) { return links[legLinks[i].wheel].wp; },
    /** Body-frame direction angle -> hip yaw joint value for leg i. */
    yawFor(i, bodyAngle) { return wrapPi(bodyAngle - yaw0[i]); },
    /**
     * Leg IK (position of the wheel centre). target: world [x,y,z]. Returns [q1,q2,q3] or null.
     * knee = +1: knee above the hip-foot line ("spider" posture), -1: below.
     */
    ik(i, baseArr, target, knee = 1) {
      const c = Math.cos(baseArr[3]), s = Math.sin(baseArr[3]);
      const wx = target[0] - baseArr[0], wy = target[1] - baseArr[1], wz = target[2] - baseArr[2];
      const bx = c * wx + s * wy - hips[i][0], by = -s * wx + c * wy - hips[i][1], bz = wz - hips[i][2];
      const q1 = wrapPi(Math.atan2(by, bx) - yaw0[i]);
      const u = Math.hypot(bx, by) - a0, w = -bz;
      const c3 = (u * u + w * w - P.L1 * P.L1 - Ls * Ls) / (2 * P.L1 * Ls);
      if (c3 > 1 || c3 < -1) return null;
      const q3 = knee * Math.acos(c3);
      const q2 = Math.atan2(w, u) - Math.atan2(Ls * Math.sin(q3), P.L1 + Ls * Math.cos(q3));
      return [q1, wrapPi(q2), q3];
    },
    /** Planar leg geometry at a given hip height above the wheel centre, shank vertical. Returns {q2,q3,rho} or null. */
    verticalShank(hipAboveWheel) {
      const sn = (hipAboveWheel - Ls) / P.L1;
      if (sn > 1 || sn < -1) return null;
      const q2 = Math.asin(sn);
      return { q2, q3: Math.PI / 2 - q2, rho: a0 + P.L1 * Math.cos(q2) };
    },
    inLimits(st) {
      for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) if (Math.abs(st.q[5 * i + k]) > lim[k] + 1e-9) return false;
      if (st.q[Q_SLIDE] < -1e-6 || st.q[Q_SLIDE] > P.liftStroke + 1e-6) return false;
      return true;
    },
    /** Centre of mass (world), from the current FK. */
    com() {
      let x = 0, y = 0, z = 0;
      for (const L of links) {
        const R = L.wR, cm = L.com, m = L.mass;
        x += m * (R[0] * cm[0] + R[1] * cm[1] + R[2] * cm[2] + L.wp[0]);
        y += m * (R[3] * cm[0] + R[4] * cm[1] + R[5] * cm[2] + L.wp[1]);
        z += m * (R[6] * cm[0] + R[7] * cm[1] + R[8] * cm[2] + L.wp[2]);
      }
      return [x / totalMass, y / totalMass, z / totalMass];
    },
    /** Lift foot bottom points (world) from the current FK: [[x,y,z] x4]. */
    liftFeet() {
      const out = [];
      for (const lp of liftPairs) for (const r of lp.rods) {
        const L = links[r], d = gap + footH, R = L.wR;
        out.push([L.wp[0] - R[2] * d, L.wp[1] - R[5] * d, L.wp[2] - R[8] * d]);
      }
      return out;
    },
    newState() { return { base: new Float64Array([0, 0, 0, 0]), q: new Float64Array(NQ) }; },
  };
  return robot;
}

export function cloneState(s) { return { base: Float64Array.from(s.base), q: Float64Array.from(s.q) }; }
export function lerpState(a, b, t, out) {
  out = out || { base: new Float64Array(4), q: new Float64Array(NQ) };
  for (let k = 0; k < 3; k++) out.base[k] = a.base[k] + (b.base[k] - a.base[k]) * t;
  out.base[3] = a.base[3] + wrapPi(b.base[3] - a.base[3]) * t;
  for (let k = 0; k < NQ; k++) out.q[k] = a.q[k] + (b.q[k] - a.q[k]) * t;
  return out;
}
