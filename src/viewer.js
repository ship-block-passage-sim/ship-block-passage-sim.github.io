// three.js viewer: environment + robot (one mesh per collision shape), support polygon / CoM overlay.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { BOX } from './collide.js';
import { NQ } from './robot.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
/** Free the GPU resources of everything below obj. */
function disposeTree(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) for (const m of [].concat(o.material)) { if (m.map) m.map.dispose(); m.dispose(); }
  });
}
export const STATUS_COLORS = { none: 0xc9d1dc, ok: 0x2f9e5f, partial: 0xe0a33a, fail: 0xd64545 };
const STATUS_CSS = { none: '#8a94a3', ok: '#1f8a4c', partial: '#c7861a', fail: '#c62828' };

/** Meshes of an environment (from buildEnv(...).visuals). opts: {wallOpacity, edges, ghosts, beads}. */
function envMeshes(visuals, opts) {
  const { wallOpacity = 0.45, edges = true, ghosts = true, beads = true } = opts || {};
  const edgeMat = edges ? new THREE.LineBasicMaterial({ color: 0x3b4252, transparent: true, opacity: 0.35 }) : null;
  const out = [];
  for (const v of visuals) {
    if ((v.ghost && !ghosts) || (v.type === 'bead' && !beads)) continue;
    let mesh;
    if (v.type === 'box') {
      const g = new THREE.BoxGeometry(v.max[0] - v.min[0], v.max[1] - v.min[1], v.max[2] - v.min[2]);
      mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial(v.ghost ? { color: v.color, roughness: 0.9, transparent: true, opacity: 0.22, depthWrite: false } : { color: v.color, roughness: 0.75, metalness: 0.15 }));
      mesh.position.set((v.min[0] + v.max[0]) / 2, (v.min[1] + v.max[1]) / 2, (v.min[2] + v.max[2]) / 2);
      mesh.castShadow = !v.ghost && v.max[2] > 1; mesh.receiveShadow = !v.ghost; if (v.ghost) { mesh.renderOrder = 4; mesh.userData.ghost = true; }
    } else if (v.type === 'wall') {
      const sh = new THREE.Shape(); sh.moveTo(v.x0, 0);
      const slots = v.slots.map(([a, b, top]) => [Math.max(a, v.x0 + 0.01), Math.min(b, v.x1 - 0.01), top]).filter(q => q[1] > q[0]).sort((p, q) => p[0] - q[0]);
      for (const [a, b, top] of slots) { sh.lineTo(a, 0); sh.lineTo(a, top); sh.lineTo(b, top); sh.lineTo(b, 0); }
      sh.lineTo(v.x1, 0); sh.lineTo(v.x1, v.height); sh.lineTo(v.x0, v.height); sh.closePath();
      for (const h of v.holes) {
        const p = new THREE.Path(), xl = h.c - h.W / 2, xr = h.c + h.W / 2, zb = h.sill, zt = h.sill + h.H, R = Math.min(h.R, h.W / 2, h.H / 2);
        p.moveTo(xl + R, zb); p.lineTo(xr - R, zb); if (R > 0) p.absarc(xr - R, zb + R, R, -Math.PI / 2, 0, false);
        p.lineTo(xr, zt - R); if (R > 0) p.absarc(xr - R, zt - R, R, 0, Math.PI / 2, false);
        p.lineTo(xl + R, zt); if (R > 0) p.absarc(xl + R, zt - R, R, Math.PI / 2, Math.PI, false);
        p.lineTo(xl, zb + R); if (R > 0) p.absarc(xl + R, zb + R, R, Math.PI, 1.5 * Math.PI, false);
        sh.holes.push(p);
      }
      const g = new THREE.ExtrudeGeometry(sh, { depth: v.t, bevelEnabled: false, curveSegments: 16 });
      mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: v.color, roughness: 0.7, metalness: 0.15, transparent: true, opacity: wallOpacity, side: THREE.DoubleSide, depthWrite: wallOpacity > 0.95 }));
      mesh.matrixAutoUpdate = false; mesh.matrix.makeBasis(V(1, 0, 0), V(0, 0, 1), V(0, -1, 0)); mesh.matrix.setPosition(0, v.y0 + v.t, 0);
      mesh.userData.wall = true; mesh.renderOrder = 5; mesh.receiveShadow = false;
    } else if (v.type === 'bead') {
      const g = new THREE.CylinderGeometry(1, 1, v.x1 - v.x0, 12); g.rotateZ(Math.PI / 2);
      mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: v.color, roughness: 0.6 }));
      mesh.scale.set(1, v.w / 2, v.h); mesh.position.set((v.x0 + v.x1) / 2, v.y, 0);
    }
    mesh.userData.baseColor = v.color; mesh.userData.kind = v.kind || v.type; mesh.userData.cx = v.c; mesh.userData.name = v.name;
    if (edgeMat && v.type !== 'bead' && !v.ghost) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), edgeMat));
    out.push(mesh);
  }
  return out;
}

/** Canvas texture with an environment's name and status (overview labels). */
function labelTexture(title, sub, status) {
  const W = 1024, H = 232, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), r = 36;
  x.fillStyle = 'rgba(255,255,255,0.96)';
  x.beginPath(); x.moveTo(r, 0); x.arcTo(W, 0, W, H, r); x.arcTo(W, H, 0, H, r); x.arcTo(0, H, 0, 0, r); x.arcTo(0, 0, W, 0, r); x.closePath(); x.fill();
  x.fillStyle = STATUS_CSS[status] || STATUS_CSS.none; x.beginPath(); x.arc(70, H / 2, 34, 0, 2 * Math.PI); x.fill();
  const fit = (t, px) => { x.font = `700 ${px}px system-ui, Arial, sans-serif`; while (x.measureText(t).width > W - 150 && t.length > 4) t = t.slice(0, -2); return t; };
  let t = title; x.font = '700 66px system-ui, Arial, sans-serif';
  if (x.measureText(t).width > W - 150) { t = fit(t, 66); if (t !== title) t = t.replace(/.$/, '…'); }
  x.fillStyle = '#1c2330'; x.textBaseline = 'middle'; x.fillText(t, 130, 78);
  x.font = '500 50px system-ui, Arial, sans-serif'; x.fillStyle = STATUS_CSS[status] || '#566173'; x.fillText(fit(sub, 50), 130, 162);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0xeef1f5);
    this.camera = new THREE.PerspectiveCamera(38, 1, 30, 120000); this.camera.up.set(0, 0, 1); this.camera.position.set(3000, -3500, 2500);
    this.controls = new OrbitControls(this.camera, canvas); this.controls.enableDamping = false; this.controls.target.set(0, 0, 400);
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.95));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.25); this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    this.envGroup = new THREE.Group(); this.robotGroup = new THREE.Group(); this.overlay = new THREE.Group();
    this.scene.add(this.envGroup, this.robotGroup, this.overlay);
    this.robot = null; this.meshes = []; this.envMeshes = new Map(); this.wallOpacity = 0.45; this.showSupport = true; this.dirty = true;
    // optional second viewport: orthographic section view. Layers: 0 = both views, 1 = main view only, 2 = section view only
    this.renderer.localClippingEnabled = true;
    this.secCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 60000); this.secCam.up.set(0, 0, 1);
    this.camera.layers.enable(1); this.secCam.layers.enable(2);
    this.section = null; this.split = 0.4;   // split: height fraction of the section strip
    this.cutGroup = new THREE.Group(); this.scene.add(this.cutGroup);
    this.ovGroup = new THREE.Group(); this.scene.add(this.ovGroup); this.overview = null;   // 'all environments' layout
    // support polygon + CoM marker
    this.supLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x12a150, linewidth: 2 }));
    this.supLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 12), 3));
    this.comDot = new THREE.Mesh(new THREE.SphereGeometry(18, 16, 12), new THREE.MeshBasicMaterial({ color: 0x12a150 }));
    this.comLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0, 0, 1)]), new THREE.LineDashedMaterial({ color: 0x12a150, dashSize: 30, gapSize: 20 }));
    this.overlay.add(this.supLine, this.comDot, this.comLine);
  }

  resize(w, h, ratio = Math.min(window.devicePixelRatio || 1, 2)) {
    this.renderer.setPixelRatio(ratio); this.renderer.setSize(w, h, false);
    this.dirty = true;
  }

  // ------------------------------------------------------------ environment
  setEnv(env, geo) {
    disposeTree(this.envGroup); this.envGroup.clear(); this.envMeshes.clear(); this.env = env; this.walls = geo.visuals.filter(v => v.type === 'wall');
    for (const mesh of envMeshes(geo.visuals, { wallOpacity: this.wallOpacity })) {
      const n = mesh.userData.name; if (!this.envMeshes.has(n)) this.envMeshes.set(n, []); this.envMeshes.get(n).push(mesh);
      this.envGroup.add(mesh);
    }
    // surrounding ground + grid
    const F = env.floor, cx = (F.x0 + F.x1) / 2, cy = (F.y0 + F.y1) / 2, ext = Math.max(F.x1 - F.x0, F.y1 - F.y0) + 6000;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(ext, ext), new THREE.MeshStandardMaterial({ color: 0xdfe3e9, roughness: 1 }));
    ground.position.set(cx, cy, -16); ground.receiveShadow = true; ground.userData.ground = true; this.envGroup.add(ground);
    const grid = new THREE.GridHelper(ext, Math.round(ext / 500), 0xb4bcc8, 0xcfd5dd); grid.rotation.x = Math.PI / 2; grid.position.set(cx, cy, -15); grid.userData.ground = true; this.envGroup.add(grid);
    this.envCenter = [cx, cy, 300]; this.envExtent = Math.max(F.x1 - F.x0, F.y1 - F.y0);
    this._placeSun(cx, cy);
    this.setSection(this.section);
  }
  /**
   * Second viewport with an orthographic section view.
   * spec: null | {type:'hole', xc, yc, halfH} (side view, environment cut at the hole centre plane x = xc)
   *            | {type:'longi', xc, yc, halfH} (front view along the longis); halfH = half of the visible height [mm]
   */
  setSection(spec) {
    this.section = spec; this.cutGroup.clear();
    const hole = spec && spec.type === 'hole';
    for (const m of this.envGroup.children) {
      if (!m.isMesh) continue;
      const mainOnly = hole && (m.userData.wall || (m.userData.kind === 'web' && m.userData.ghost) || (m.userData.kind === 'longi' && m.userData.cx > spec.xc + 1));
      m.traverse(o => o.layers.set(mainOnly ? 1 : 0));
    }
    if (hole) { // wall cross-section at the hole centre plane (solid below the sill and above the opening), section view only
      const mat = new THREE.MeshBasicMaterial({ color: 0x1c2330 });
      for (const w of this.walls || []) {
        if (spec.xc < w.x0 || spec.xc > w.x1) continue;
        const cuts = [];
        for (const hl of w.holes) { const dx = Math.abs(spec.xc - hl.c); if (dx < hl.W / 2) { const R = Math.min(hl.R, hl.W / 2, hl.H / 2), e = dx > hl.W / 2 - R ? R - Math.sqrt(Math.max(0, R * R - (dx - (hl.W / 2 - R)) ** 2)) : 0; cuts.push([hl.sill + e, hl.sill + hl.H - e]); } }
        for (const [a, b, top] of w.slots) if (spec.xc > a && spec.xc < b) cuts.push([0, top]);
        cuts.sort((p, q) => p[0] - q[0]);
        let z = 0; const solid = [];
        for (const [a, b] of cuts) { if (a > z) solid.push([z, a]); z = Math.max(z, b); }
        if (z < w.height) solid.push([z, w.height]);
        for (const [a, b] of solid) { const c = new THREE.Mesh(new THREE.BoxGeometry(30, w.t, b - a), mat); c.position.set(spec.xc, w.y0 + w.t / 2, (a + b) / 2); c.layers.set(2); this.cutGroup.add(c); }
      }
    }
    if (spec) {
      const d = 9000;
      if (hole) this.secCam.position.set(spec.xc + d, spec.yc, 0); else this.secCam.position.set(spec.xc, spec.yc - d, 0);
      this.secCam.lookAt(spec.xc, spec.yc, 0);
    }
    this.dirty = true;
  }
  _placeSun(cx, cy) {
    const r = Math.min(this.envExtent || 4000, 6000) * 0.75 + 1500;
    this.sun.position.set(cx + 2200, cy - 1600, 6000); this.sun.target.position.set(cx, cy, 0);
    const c = this.sun.shadow.camera; c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = 100; c.far = 16000; c.updateProjectionMatrix();
  }
  setWallOpacity(a) {
    this.wallOpacity = a;
    this.envGroup.traverse(m => { if (m.userData.wall) { m.material.opacity = a; m.material.depthWrite = a > 0.95; m.material.needsUpdate = true; } });
    this.dirty = true;
  }

  // ------------------------------------------------------------ robot
  setRobot(robot) {
    disposeTree(this.robotGroup); this.robotGroup.clear(); this.robot = robot; this.meshes = [];
    for (const s of robot.shapes) {
      let g;
      if (s.type === BOX) g = new THREE.BoxGeometry(2 * s.hx, 2 * s.hy, 2 * s.hz);
      else { g = new THREE.CylinderGeometry(s.r, s.r, 2 * s.h, s.kind === 'tube' ? 16 : 32); g.rotateX(Math.PI / 2); }
      const pay = s.kind === 'payload';
      const mat = new THREE.MeshStandardMaterial({ color: s.color, roughness: s.kind === 'tube' ? 0.45 : 0.6, metalness: s.kind === 'plate' || s.kind === 'liftrod' ? 0.5 : 0.2, transparent: pay, opacity: pay ? 0.42 : 1, depthWrite: !pay });
      const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; m.castShadow = !pay; m.receiveShadow = !pay; if (pay) m.renderOrder = 6;
      m.userData.baseColor = s.color;
      if (s.kind === 'wheel') { // hub stripe so that wheel rotation is visible
        const hub = new THREE.Mesh(new THREE.BoxGeometry(s.r * 1.5, s.r * 0.28, 2 * s.h + 4), new THREE.MeshStandardMaterial({ color: 0x3f8cff, roughness: 0.5 })); m.add(hub);
      }
      if (pay || s.kind === 'plate') m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: pay ? 0xa01525 : 0x4b5563 })));
      this.robotGroup.add(m); this.meshes.push(m);
    }
    this.dirty = true;
  }
  /** st: {base, q}; flags: frame flag bits (support / failing). */
  setState(st, flags = 15) {
    const r = this.robot; if (!r) return;
    r.fk(st);
    for (let i = 0; i < r.shapes.length; i++) {
      const s = r.shapes[i], R = s.R, p = s.p;
      this.meshes[i].matrix.set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
    }
    // support polygon + CoM
    const pts = [];
    for (let i = 0; i < 4; i++) if (flags & (1 << i)) { const c = r.wheelCenter(i); pts.push([c[0], c[1]]); }
    if (flags & 16) for (const f of r.liftFeet()) pts.push([f[0], f[1]]);
    const hull = convexHull(pts), pos = this.supLine.geometry.attributes.position;
    for (let i = 0; i < hull.length && i < 12; i++) pos.setXYZ(i, hull[i][0], hull[i][1], 4);
    pos.needsUpdate = true; this.supLine.geometry.setDrawRange(0, Math.min(hull.length, 12));
    const c = r.com();
    this.comDot.position.set(c[0], c[1], 6);
    this.comLine.position.set(c[0], c[1], 6); this.comLine.scale.set(1, 1, Math.max(1, c[2] - 6)); this.comLine.computeLineDistances();
    this.overlay.visible = this.showSupport;
    this.lastCom = c; this.dirty = true;
  }
  /** Tint robot shapes / environment parts by name (collision display). */
  setHighlights(names) {
    const set = names instanceof Set ? names : new Set(names || []);
    this.robot.shapes.forEach((s, i) => { const m = this.meshes[i].material; if (set.has(s.name)) { m.color.setHex(0xff2d2d); m.emissive.setHex(0x990000); } else { m.color.setHex(this.meshes[i].userData.baseColor); m.emissive.setHex(0); } });
    for (const [name, list] of this.envMeshes) for (const m of list) { if (set.has(name)) { m.material.color.setHex(0xff6b5b); m.material.emissive.setHex(0x661100); } else { m.material.color.setHex(m.userData.baseColor); m.material.emissive.setHex(0); } }
    this.dirty = true;
  }

  // ------------------------------------------------------------ overview: every environment side by side
  /**
   * items: [{env, geo, status: 'none'|'ok'|'partial'|'fail', sub}], currentId: environment shown in full detail at the origin.
   * Rows follow the groups of the table; long groups wrap. The current environment keeps its place at the origin, the others
   * are laid out around it (simplified: no edges, no weld beads, no continuation).
   */
  setOverview(items, currentId) {
    this.clearOverview();
    // rows of at most perRow tiles; a whole group joins the current row when it fits, otherwise it starts a new row (and wraps)
    const GAP = 1600, BAND = 1100, n = items.length, perRow = Math.max(4, Math.ceil(Math.sqrt(n * 2)));
    const size = new Map(); for (const it of items) size.set(it.env.group, (size.get(it.env.group) || 0) + 1);
    const pos = []; let x = 0, y = 0, rowH = 0, inRow = 0, group = null;
    for (const it of items) {
      const F = it.env.floor, w = F.x1 - F.x0, h = F.y1 - F.y0, newGroup = it.env.group !== group;
      if (inRow && (newGroup ? inRow + Math.min(size.get(it.env.group), perRow) > perRow : inRow >= perRow)) { y -= rowH + BAND + GAP; x = 0; rowH = 0; inRow = 0; }
      else if (inRow && newGroup) x += 2 * GAP;                                  // extra space between groups sharing a row
      pos.push([x - F.x0, y - F.y0, w, h]); x += w + GAP; rowH = Math.max(rowH, h); inRow++; group = it.env.group;
    }
    const ci = Math.max(0, items.findIndex(it => it.env.id === currentId)), o = [pos[ci][0], pos[ci][1]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.overview = { tiles: [], labels: [] };
    items.forEach((it, i) => {
      const F = it.env.floor, g = new THREE.Group(), ox = pos[i][0] - o[0], oy = pos[i][1] - o[1];
      g.position.set(ox, oy, 0);
      if (i !== ci) for (const m of envMeshes(it.geo.visuals, { wallOpacity: 0.6, edges: false, ghosts: false, beads: false })) { m.castShadow = false; g.add(m); }
      const w = F.x1 - F.x0 + 500, h = F.y1 - F.y0 + 500 + BAND;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: STATUS_COLORS[it.status] || STATUS_COLORS.none }));
      tile.position.set((F.x0 + F.x1) / 2, (F.y0 + F.y1) / 2 - BAND / 2, -24); tile.userData.envId = it.env.id; g.add(tile);
      const lw = Math.min(F.x1 - F.x0, 5200), label = new THREE.Mesh(new THREE.PlaneGeometry(lw, lw * 232 / 1024), new THREE.MeshBasicMaterial({ map: labelTexture(it.env.label, it.sub, it.status), transparent: true }));
      label.position.set(F.x0 + lw / 2, F.y0 - 150 - lw * 116 / 1024, 2); g.add(label);
      this.ovGroup.add(g); this.overview.tiles.push(tile); this.overview.labels.push({ mesh: label, env: it.env, key: it.status + '|' + it.sub });
      minX = Math.min(minX, ox + F.x0 - 250); maxX = Math.max(maxX, ox + F.x1 + 250); minY = Math.min(minY, oy + F.y0 - 250 - BAND); maxY = Math.max(maxY, oy + F.y1 + 250);
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 12000, maxY - minY + 12000), new THREE.MeshStandardMaterial({ color: 0xdfe3e9, roughness: 1 }));
    ground.position.set((minX + maxX) / 2, (minY + maxY) / 2, -60); ground.userData.ground = true; this.ovGroup.add(ground);
    this.overview.bounds = [minX, minY, maxX, maxY];
    for (const m of this.envGroup.children) if (m.userData.ground || m.userData.ghost) m.visible = false;
    this.camera.near = 200; this.camera.far = 2e6; this.dirty = true;   // large tables: keep the farthest rows inside the frustum
    return this.overview.bounds;
  }
  /** Recolour tiles / labels: status map envId -> {status, sub}. */
  updateOverviewStatus(map) {
    if (!this.overview) return;
    for (const t of this.overview.tiles) { const st = map[t.userData.envId]; t.material.color.setHex(STATUS_COLORS[st ? st.status : 'none']); }
    for (const l of this.overview.labels) {          // redraw only the labels whose text changed
      const st = map[l.env.id] || { status: 'none', sub: '' }, key = st.status + '|' + st.sub;
      if (l.key === key) continue;
      l.key = key; l.mesh.material.map.dispose(); l.mesh.material.map = labelTexture(l.env.label, st.sub, st.status); l.mesh.material.needsUpdate = true;
    }
    this.dirty = true;
  }
  clearOverview() {
    disposeTree(this.ovGroup); this.ovGroup.clear(); this.overview = null; this.camera.near = 30; this.camera.far = 120000;
    for (const m of this.envGroup.children) if (m.userData.ground || m.userData.ghost) m.visible = true;
    this.dirty = true;
  }
  /** Camera that shows the whole overview from the south, slightly from above. */
  overviewView(aspect) {
    // closest camera (fixed viewing direction) from which all tile corners project inside the frame; the top keeps room for the HUD
    const [x0, y0, x1, y1] = this.overview.bounds, c = V((x0 + x1) / 2, (y0 + y1) / 2, 0), dir = V(0, -0.5, 1).normalize();
    const cam = new THREE.PerspectiveCamera(this.camera.fov, aspect || this.camera.aspect, 100, 1e7); cam.up.set(0, 0, 1);
    const corners = [V(x0, y0, 0), V(x1, y0, 0), V(x0, y1, 0), V(x1, y1, 0), V(x0, y0, 2000), V(x1, y0, 2000), V(x0, y1, 2000), V(x1, y1, 2000)];
    const fits = (d, t) => { cam.position.copy(t).addScaledVector(dir, d); cam.lookAt(t); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      return corners.every(p => { const q = p.clone().project(cam); return Math.abs(q.x) <= 0.94 && q.y >= -0.94 && q.y <= 0.7; }); };
    let t = c.clone(), lo = 1000, hi = 2e6;
    for (let k = 0; k < 3; k++) {                    // a few rounds: fit distance, then re-centre the projected box
      lo = 1000; hi = 2e6; for (let i = 0; i < 50; i++) { const m = Math.sqrt(lo * hi); if (fits(m, t)) hi = m; else lo = m; }
      cam.position.copy(t).addScaledVector(dir, hi); cam.lookAt(t); cam.updateMatrixWorld();
      let ymin = Infinity, ymax = -Infinity; for (const p of corners) { const q = p.clone().project(cam); ymin = Math.min(ymin, q.y); ymax = Math.max(ymax, q.y); }
      const shift = ((ymin + ymax) / 2 - (-0.12)) * 0.5 * (y1 - y0) / Math.max(0.1, ymax - ymin); t.y += shift;
    }
    return { pos: t.clone().addScaledVector(dir, hi * 1.02).toArray(), target: t.toArray() };
  }
  /** Environment id under the canvas point (client coordinates), or null. */
  pickOverview(clientX, clientY) {
    if (!this.overview) return null;
    const r = this.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.overview.tiles, false)[0];
    return hit ? hit.object.userData.envId : null;
  }

  lookFrom(pos, target) { this.camera.position.set(...pos); this.controls.target.set(...target); this.controls.update(); this.dirty = true; }
  render() {
    const r = this.renderer, size = r.getSize(new THREE.Vector2()), w = size.x, h = size.y;
    if (!this.section) {
      r.setScissorTest(false); r.setViewport(0, 0, w, h);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); r.render(this.scene, this.camera);
    } else { // perspective view on top, orthographic section strip below
      const hb = Math.round(h * this.split), ht = h - hb, c = this.secCam, hh = this.section.halfH, hw = hh * w / hb;
      r.setScissorTest(true);
      r.setViewport(0, hb, w, ht); r.setScissor(0, hb, w, ht);
      this.camera.aspect = w / ht; this.camera.updateProjectionMatrix(); r.render(this.scene, this.camera);
      c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh; c.position.z = hh - 160; c.updateProjectionMatrix(); c.updateMatrixWorld();
      r.setViewport(0, 0, w, hb); r.setScissor(0, 0, w, hb); r.render(this.scene, c);
      r.setScissorTest(false);
    }
    this.dirty = false;
  }
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}

/** Playback helper: interpolated state at time t from packed frames. */
export class Trajectory {
  constructor(frames, width) {
    this.f = frames; this.W = width; this.n = frames.length / width;
    this.duration = this.n ? frames[(this.n - 1) * width + 4 + NQ] : 0;
    this.st = { base: new Float64Array(4), q: new Float64Array(NQ) };
  }
  time(i) { return this.f[i * this.W + 4 + NQ]; }
  /** Returns {st, phase, flags, index}. */
  at(t) {
    const W = this.W, f = this.f;
    let lo = 0, hi = this.n - 1;
    if (t <= 0) hi = 0; else if (t >= this.duration) lo = hi; else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.time(m) <= t) lo = m; else hi = m; } }
    const a = lo * W, b = hi * W, ta = f[a + 4 + NQ], tb = f[b + 4 + NQ], u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    for (let k = 0; k < 4; k++) this.st.base[k] = f[a + k] + (f[b + k] - f[a + k]) * u;
    for (let k = 0; k < NQ; k++) this.st.q[k] = f[a + 4 + k] + (f[b + 4 + k] - f[a + 4 + k]) * u;
    const idx = u > 0.5 ? hi : lo;
    return { st: this.st, phase: f[hi * W + 5 + NQ], flags: f[idx * W + 6 + NQ], index: idx };
  }
}
