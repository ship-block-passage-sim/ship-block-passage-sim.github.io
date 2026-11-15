// Generates random shape pairs + JS GJK verdicts, to be cross-checked against MuJoCo (tests/gjk_check.py).
import { box, cyl, hull, updateAABB, gjkHit, BOX, CYL, HULL } from '../src/collide.js';
import { writeFileSync } from 'node:fs';
let seed = 12345; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const U = (a, b) => a + (b - a) * rnd();
function randR() { // random rotation from quaternion
  let q = [U(-1, 1), U(-1, 1), U(-1, 1), U(-1, 1)]; const n = Math.hypot(...q); q = q.map(v => v / n);
  const [w, x, y, z] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
function randShape() {
  const t = rnd();
  let s, desc;
  if (t < 0.4) { const h = [U(5, 400), U(5, 300), U(5, 60)]; s = box(...h); desc = { type: 'box', size: h }; }
  else if (t < 0.85) { const r = U(15, 60), h = U(10, 300); s = cyl(r, h); desc = { type: 'cyl', size: [r, h] }; }
  else { // triangular prism (like the hole-fillet pieces), built directly in world space
    const c = [U(-200, 200), U(-200, 200), U(-200, 200)], v = [];
    const pts = [[0, 0], [U(20, 120), U(-10, 10)], [U(-10, 60), U(20, 120)]];
    for (const y of [-6, 6]) for (const [x, z] of pts) v.push(c[0] + x, c[1] + y, c[2] + z);
    s = hull(v); return { s, desc: { type: 'hull', verts: v } };
  }
  s.R.set(randR()); s.p.set([U(-250, 250), U(-250, 250), U(-250, 250)]); updateAABB(s);
  desc.R = Array.from(s.R); desc.p = Array.from(s.p);
  return { s, desc };
}
const N = +process.argv[2] || 20000, out = [];
let t0 = performance.now(), cnt = 0;
for (let i = 0; i < N; i++) {
  const A = randShape(), B = randShape();
  if (A.desc.type === 'hull' && B.desc.type === 'hull') { i--; continue; }
  out.push({ A: A.desc, B: B.desc, hit0: gjkHit(A.s, B.s, 0), hit10: gjkHit(A.s, B.s, 10) }); cnt += 2;
}
console.log(`${cnt} GJK calls in ${(performance.now() - t0).toFixed(1)} ms (incl. shape generation)`);
writeFileSync(process.argv[3], JSON.stringify(out));
