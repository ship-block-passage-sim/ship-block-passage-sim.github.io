// Convex collision primitives + boolean GJK (with clearance margin).
// Units: mm. Rotation matrices are row-major Float64Array(9).

export const BOX = 0, CYL = 1, HULL = 2;

/** Box with half extents (hx,hy,hz) in its local frame. */
export function box(hx, hy, hz) {
  return { type: BOX, hx, hy, hz, R: ident(), p: new Float64Array(3), aabb: new Float64Array(6), rad: Math.hypot(hx, hy, hz) };
}
/** Cylinder, axis = local z, radius r, half length h. */
export function cyl(r, h) {
  return { type: CYL, r, h, R: ident(), p: new Float64Array(3), aabb: new Float64Array(6), rad: Math.hypot(r, h) };
}
/** Convex hull given by world-space vertices (static shapes only). */
export function hull(verts) {
  const v = Float64Array.from(verts), n = v.length / 3;
  const p = new Float64Array(3), aabb = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const x = v[3 * i + k]; p[k] += x / n;
    if (x < aabb[k]) aabb[k] = x; if (x > aabb[3 + k]) aabb[3 + k] = x;
  }
  return { type: HULL, verts: v, R: ident(), p, aabb, rad: 0 };
}
function ident() { return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); }

/** Recompute the world AABB of a box / cylinder from its pose. */
export function updateAABB(s) {
  const R = s.R, p = s.p, a = s.aabb;
  if (s.type === BOX) {
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(R[3 * k]) * s.hx + Math.abs(R[3 * k + 1]) * s.hy + Math.abs(R[3 * k + 2]) * s.hz;
      a[k] = p[k] - e; a[3 + k] = p[k] + e;
    }
  } else if (s.type === CYL) {
    for (let k = 0; k < 3; k++) {
      const az = R[3 * k + 2];
      const e = s.h * Math.abs(az) + s.r * Math.sqrt(Math.max(0, 1 - az * az));
      a[k] = p[k] - e; a[3 + k] = p[k] + e;
    }
  }
}

export function aabbOverlap(a, b, m) {
  return a[0] - m <= b[3] && b[0] - m <= a[3] && a[1] - m <= b[4] && b[1] - m <= a[4] && a[2] - m <= b[5] && b[2] - m <= a[5];
}

/** Lowest world z of a shape. */
export function minZ(s) { return s.aabb[2]; }

function support(s, dx, dy, dz, out) {
  if (s.type === HULL) {
    const v = s.verts; let best = -Infinity, bi = 0;
    for (let i = 0; i < v.length; i += 3) {
      const d = v[i] * dx + v[i + 1] * dy + v[i + 2] * dz;
      if (d > best) { best = d; bi = i; }
    }
    out[0] = v[bi]; out[1] = v[bi + 1]; out[2] = v[bi + 2];
    return;
  }
  const R = s.R;
  const lx = R[0] * dx + R[3] * dy + R[6] * dz, ly = R[1] * dx + R[4] * dy + R[7] * dz, lz = R[2] * dx + R[5] * dy + R[8] * dz;
  let sx, sy, sz;
  if (s.type === BOX) {
    sx = lx >= 0 ? s.hx : -s.hx; sy = ly >= 0 ? s.hy : -s.hy; sz = lz >= 0 ? s.hz : -s.hz;
  } else {
    const n = Math.hypot(lx, ly);
    if (n > 1e-12) { sx = s.r * lx / n; sy = s.r * ly / n; } else { sx = 0; sy = 0; }
    sz = lz >= 0 ? s.h : -s.h;
  }
  out[0] = R[0] * sx + R[1] * sy + R[2] * sz + s.p[0];
  out[1] = R[3] * sx + R[4] * sy + R[5] * sz + s.p[1];
  out[2] = R[6] * sx + R[7] * sy + R[8] * sz + s.p[2];
}

// ---- GJK scratch storage (simplex: a = newest, then b, c, d)
const _sa = new Float64Array(3), _sb = new Float64Array(3);
let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0, ex = 0, ey = 0, ez = 0;
let dirx = 0, diry = 0, dirz = 0, nS = 0;

function line() {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  if (-(abx * ax + aby * ay + abz * az) > 0) {
    // dir = (ab x ao) x ab
    const tx = aby * -az - abz * -ay, ty = abz * -ax - abx * -az, tz = abx * -ay - aby * -ax;
    dirx = ty * abz - tz * aby; diry = tz * abx - tx * abz; dirz = tx * aby - ty * abx;
    nS = 2;
  } else { dirx = -ax; diry = -ay; dirz = -az; nS = 1; }
}

function triangle() {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx; // abc
  // abc x ac
  let tx = ny * acz - nz * acy, ty = nz * acx - nx * acz, tz = nx * acy - ny * acx;
  if (-(tx * ax + ty * ay + tz * az) > 0) {
    if (-(acx * ax + acy * ay + acz * az) > 0) {
      // simplex = [a, c]; dir = (ac x ao) x ac
      bx = cx; by = cy; bz = cz;
      const ux = acy * -az - acz * -ay, uy = acz * -ax - acx * -az, uz = acx * -ay - acy * -ax;
      dirx = uy * acz - uz * acy; diry = uz * acx - ux * acz; dirz = ux * acy - uy * acx;
      nS = 2;
    } else line();
    return;
  }
  // ab x abc
  tx = aby * nz - abz * ny; ty = abz * nx - abx * nz; tz = abx * ny - aby * nx;
  if (-(tx * ax + ty * ay + tz * az) > 0) { line(); return; }
  if (-(nx * ax + ny * ay + nz * az) > 0) { dirx = nx; diry = ny; dirz = nz; }
  else {
    const qx = bx, qy = by, qz = bz; bx = cx; by = cy; bz = cz; cx = qx; cy = qy; cz = qz;
    dirx = -nx; diry = -ny; dirz = -nz;
  }
  nS = 3;
}

function tetra() {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const adx = ex - ax, ady = ey - ay, adz = ez - az;
  // abc
  if (-((aby * acz - abz * acy) * ax + (abz * acx - abx * acz) * ay + (abx * acy - aby * acx) * az) > 0) { triangle(); return false; }
  // acd
  if (-((acy * adz - acz * ady) * ax + (acz * adx - acx * adz) * ay + (acx * ady - acy * adx) * az) > 0) {
    bx = cx; by = cy; bz = cz; cx = ex; cy = ey; cz = ez; triangle(); return false;
  }
  // adb
  if (-((ady * abz - adz * aby) * ax + (adz * abx - adx * abz) * ay + (adx * aby - ady * abx) * az) > 0) {
    cx = bx; cy = by; cz = bz; bx = ex; by = ey; bz = ez; triangle(); return false;
  }
  return true;
}

/**
 * True if the two convex shapes are closer than `margin` (margin = 0: plain intersection).
 * Boolean GJK on the Minkowski difference inflated by a ball of radius `margin`.
 */
export function gjkHit(A, B, margin) {
  let dx = A.p[0] - B.p[0], dy = A.p[1] - B.p[1], dz = A.p[2] - B.p[2];
  if (dx * dx + dy * dy + dz * dz < 1e-12) { dx = 1; dy = 0; dz = 0; }
  nS = 0;
  for (let it = 0; it < 64; it++) {
    const n2 = dx * dx + dy * dy + dz * dz;
    if (n2 < 1e-20) return true;                    // origin lies on the simplex
    support(A, dx, dy, dz, _sa); support(B, -dx, -dy, -dz, _sb);
    let px = _sa[0] - _sb[0], py = _sa[1] - _sb[1], pz = _sa[2] - _sb[2];
    if (margin > 0) { const k = margin / Math.sqrt(n2); px += k * dx; py += k * dy; pz += k * dz; }
    if (px * dx + py * dy + pz * dz < 0) return false; // separating direction found
    // push front
    ex = cx; ey = cy; ez = cz; cx = bx; cy = by; cz = bz; bx = ax; by = ay; bz = az; ax = px; ay = py; az = pz;
    nS++;
    if (nS === 1) { dirx = -ax; diry = -ay; dirz = -az; }
    else if (nS === 2) line();
    else if (nS === 3) triangle();
    else if (tetra()) return true;
    dx = dirx; dy = diry; dz = dirz;
  }
  return true; // did not converge: treat as contact (conservative)
}

/** Collision test with AABB pre-check. */
export function hit(A, B, margin) {
  return aabbOverlap(A.aabb, B.aabb, margin) && gjkHit(A, B, margin);
}
