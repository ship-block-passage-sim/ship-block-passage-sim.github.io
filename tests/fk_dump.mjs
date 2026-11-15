// Writes URDFs for a few parameter sets + JS forward-kinematics results for random joint values (checked by tests/fk_check.py).
import { buildRobot, NQ, Q_FOLD_F, Q_FOLD_R, Q_SLIDE } from '../src/robot.js';
import { toURDF, toSRDF, jointNames } from '../src/urdf.js';
import { writeFileSync } from 'node:fs';
const outDir = process.argv[2];
let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const variants = { default: {}, side: { hipMount: 'side', L1: 380, L2: 520, L3: 80, actD: 110, actT: 70, hipOffset: 140 }, nofold: { liftFold: 0, liftLen: 300, liftStroke: 200, plateL: 600 } };
const dump = {};
for (const [vn, pv] of Object.entries(variants)) {
  const robot = buildRobot(pv);
  writeFileSync(`${outDir}/robot_${vn}.urdf`, toURDF(robot));
  writeFileSync(`${outDir}/robot_${vn}.srdf`, toSRDF(robot));
  const samples = [];
  for (let n = 0; n < 40; n++) {
    const st = robot.newState();
    for (let i = 0; i < 4; i++) { for (let k = 0; k < 4; k++) st.q[5 * i + k] = (rnd() * 2 - 1) * robot.jointLimits[k]; st.q[5 * i + 4] = (rnd() * 2 - 1) * 3; }
    if (robot.fold) { st.q[Q_FOLD_F] = rnd() * Math.PI / 2; st.q[Q_FOLD_R] = rnd() * Math.PI / 2; }
    st.q[Q_SLIDE] = rnd() * robot.P.liftStroke;
    robot.fk(st);
    const joints = {};
    for (const L of robot.links) if (L.qi >= 0) joints[L.jname] = L.jtype === 'prismatic' ? st.q[L.qi] / 1000 : st.q[L.qi];
    const linksOut = {}; for (const L of robot.links) linksOut[L.name] = { p: Array.from(L.wp).map(v => v / 1000), R: Array.from(L.wR) };
    const geoms = {}; for (const s of robot.shapes) geoms[s.name] = { p: Array.from(s.p).map(v => v / 1000), axis: [s.R[2], s.R[5], s.R[8]] };
    const com = robot.com().map(v => v / 1000);
    samples.push({ joints, links: linksOut, geoms, com });
  }
  dump[vn] = { samples, mass: robot.totalMass, names: jointNames(robot) };
}
writeFileSync(`${outDir}/fk_dump.json`, JSON.stringify(dump));
console.log('wrote URDFs + fk_dump.json to', outDir);
