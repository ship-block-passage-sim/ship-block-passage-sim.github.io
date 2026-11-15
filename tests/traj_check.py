"""Independent verification of a planned trajectory with MuJoCo.
Rebuilds robot (from the exported URDF) + environment in MuJoCo, replays every frame and reports the smallest
robot-environment and robot-robot distances MuJoCo finds (contacts closer than 30 mm are examined)."""
import json, sys, numpy as np, mujoco
D = json.load(open(sys.argv[1])); S = 0.001; NQ = 23
urdf = D["urdf"].replace(">\n  <material", '>\n  <mujoco><compiler fusestatic="false" discardvisual="true" balanceinertia="true"/></mujoco>\n  <material', 1)
spec = mujoco.MjSpec.from_string(urdf)
base = spec.body("base_link"); base.add_freejoint()
env_names = []
for i, e in enumerate(D["envShapes"]):
    nm = f"env{i}"; env_names.append(e["name"])
    if e["type"] == "box":
        spec.worldbody.add_geom(name=nm, type=mujoco.mjtGeom.mjGEOM_BOX, pos=np.array(e["p"]) * S, size=np.array(e["half"]) * S)
    else:
        v = np.array(e["verts"]).reshape(-1, 3) * S
        mesh = spec.add_mesh(name=f"m{i}", uservert=v.flatten().tolist())
        spec.worldbody.add_geom(name=nm, type=mujoco.mjtGeom.mjGEOM_MESH, meshname=f"m{i}")
spec.worldbody.add_geom(name="floor", type=mujoco.mjtGeom.mjGEOM_PLANE, size=[50, 50, 0.1])
m = spec.compile(); d = mujoco.MjData(m)
m.geom_margin[:] = 0.03                       # report every pair closer than 30 mm
m.opt.disableflags |= 0                       # (collision detection only; no dynamics are stepped)
info = {s["name"] + "_col": s for s in D["shapes"]}
gname = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g) or "" for g in range(m.ngeom)]
is_env = np.array([n.startswith("env") or n == "floor" for n in gname])
body_name = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, b) for b in range(m.nbody)]
jadr = [(m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, j["name"])], j["qi"], S if j["prismatic"] else 1.0) for j in D["joints"]]
fadr = m.jnt_qposadr[m.body_jntadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "base_link")]]
min_env, min_self, min_floor = (9e9, None), (9e9, None), (9e9, None)
viol = []
frames = D["frames"]
for k, f in enumerate(frames):
    if f[4 + NQ + 2] and int(f[4 + NQ + 2]) & 32: continue          # frames flagged as failing are illustrative only
    yaw = f[3]
    d.qpos[fadr:fadr + 3] = np.array(f[0:3]) * S; d.qpos[fadr + 3:fadr + 7] = [np.cos(yaw / 2), 0, 0, np.sin(yaw / 2)]
    for adr, qi, sc in jadr: d.qpos[adr] = f[4 + qi] * sc
    mujoco.mj_kinematics(m, d); mujoco.mj_collision(m, d)
    for c in d.contact[:d.ncon]:
        g1, g2 = c.geom1, c.geom2; dist = c.dist / S
        e1, e2 = is_env[g1], is_env[g2]
        if e1 and e2: continue
        if e1 or e2:
            rg, eg = (g2, g1) if e1 else (g1, g2)
            s = info.get(gname[rg], {})
            if gname[eg] == "floor" and (s.get("wheel") or s.get("liftFoot")):
                if dist < min_floor[0]: min_floor = (dist, (k, gname[rg], "floor"))
                if dist < -1.0: viol.append((k, gname[rg], "floor", round(dist, 2)))
                continue
            ename = "floor" if gname[eg] == "floor" else env_names[int(gname[eg][3:])]
            if dist < min_env[0]: min_env = (dist, (k, gname[rg], ename))
            if dist < D["envMargin"] - 0.5: viol.append((k, gname[rg], ename, round(dist, 2)))
        else:
            b1, b2 = body_name[m.geom_bodyid[g1]], body_name[m.geom_bodyid[g2]]
            leg = lambda b: b[:2] if b[:2] in ("fl", "fr", "rl", "rr") else None
            if leg(b1) and leg(b1) == leg(b2) and {b1[3:], b2[3:]} == {"shank", "wheel"}: continue   # permanent neighbours (same exemption as the planner)
            if dist < min_self[0]: min_self = (dist, (k, gname[g1], gname[g2]))
            if dist < D["selfMargin"] - 0.5: viol.append((k, gname[g1], gname[g2], round(dist, 2)))
# hardware rule: leg joints (yaw1, pitch1, pitch2, yaw2) may only change while the lift supports the body (flag bit 4)
moved_without_lift = 0
for k in range(1, len(frames)):
    a, b = frames[k - 1], frames[k]
    if int(b[4 + NQ + 2]) & 32: continue
    moved = any(abs(b[4 + 5 * i + j] - a[4 + 5 * i + j]) > 1e-6 for i in range(4) for j in range(4))
    if moved and not (int(b[4 + NQ + 2]) & 16):
        moved_without_lift += 1
        if moved_without_lift <= 3: viol.append((k, "leg joints moved without lift support", "", 0))
n = len(frames)
print(f"{D['env']} [{D['task']}] planner says {'SUCCESS' if D['ok'] else 'FAIL'}; frames checked: {n}")
print(f"  frames in which a leg joint moved without lift support: {moved_without_lift}")
fmt = lambda v: f"{v[0]:.2f} mm  {v[1]}" if v[1] else "> 30 mm (no pair came closer)"
print(f"  min robot-environment distance : {fmt(min_env)}   (required >= {D['envMargin']})")
print(f"  min robot-robot distance       : {fmt(min_self)}   (required >= {D['selfMargin']})")
print(f"  min wheel/lift-foot to floor   : {fmt(min_floor)}")
print(f"  violations: {len(viol)}", viol[:8])
sys.exit(1 if viol else 0)
