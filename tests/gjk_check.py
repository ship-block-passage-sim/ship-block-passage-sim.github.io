"""Cross-check the JS GJK verdicts against MuJoCo's mj_geomDistance."""
import json, sys, numpy as np, mujoco
pairs = json.load(open(sys.argv[1]))
S = 0.001  # mm -> m
def geom_xml(d, name):
    if d["type"] == "box":
        # as a convex mesh: MuJoCo's native box-box routine does not report separation distances
        hx, hy, hz = (x * S for x in d["size"])
        v = " ".join(f"{sx*hx} {sy*hy} {sz*hz}" for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1))
        return f'<geom name="{name}" type="mesh" mesh="m_{name}"/>', f'<mesh name="m_{name}" vertex="{v}"/>'
    if d["type"] == "cyl":
        return f'<geom name="{name}" type="cylinder" size="{d["size"][0]*S} {d["size"][1]*S}"/>', ""
    v = " ".join(str(x * S) for x in d["verts"])
    return f'<geom name="{name}" type="mesh" mesh="m_{name}"/>', f'<mesh name="m_{name}" vertex="{v}"/>'
from scipy.spatial import cKDTree
rng = np.random.default_rng(0)
def sample(d, n=6000):
    """Random surface points (independent distance estimate for the cases MuJoCo cannot decide)."""
    if d["type"] == "hull":
        V = np.array(d["verts"]).reshape(-1, 3); return rng.dirichlet(np.ones(len(V)) * 0.3, n) @ V
    R = np.array(d["R"]).reshape(3, 3); p = np.array(d["p"])
    if d["type"] == "box":
        sz = np.array(d["size"]); l = rng.uniform(-1, 1, (n, 3)) * sz
        k = rng.integers(0, 3, n); l[np.arange(n), k] = np.sign(l[np.arange(n), k]) * sz[k]
    else:
        r, h = d["size"]; a = rng.uniform(0, 2 * np.pi, n); rr = r * np.sqrt(rng.uniform(0, 1, n)); z = rng.uniform(-h, h, n)
        cap = rng.uniform(0, 1, n) < 0.5; rr[~cap] = r; z[cap] = np.sign(z[cap]) * h
        l = np.stack([rr * np.cos(a), rr * np.sin(a), z], 1)
    return l @ R.T + p
def volume_points(d, n=300000):
    if d["type"] == "hull":
        V = np.array(d["verts"]).reshape(-1, 3); return rng.dirichlet(np.ones(len(V)), n) @ V
    R = np.array(d["R"]).reshape(3, 3); p = np.array(d["p"])
    if d["type"] == "box": l = rng.uniform(-1, 1, (n, 3)) * np.array(d["size"])
    else:
        r, h = d["size"]; a = rng.uniform(0, 2 * np.pi, n); rr = r * np.sqrt(rng.uniform(0, 1, n))
        l = np.stack([rr * np.cos(a), rr * np.sin(a), rng.uniform(-h, h, n)], 1)
    return l @ R.T + p
def inside(d, P):
    if d["type"] == "hull":
        from scipy.spatial import Delaunay
        return Delaunay(np.array(d["verts"]).reshape(-1, 3)).find_simplex(P) >= 0
    L = (P - np.array(d["p"])) @ np.array(d["R"]).reshape(3, 3)
    if d["type"] == "box": return np.all(np.abs(L) <= np.array(d["size"]), axis=1)
    return (np.hypot(L[:, 0], L[:, 1]) <= d["size"][0]) & (np.abs(L[:, 2]) <= d["size"][1])
def overlap_bruteforce(pr):
    """True if any sampled point of one shape lies inside the other."""
    return bool(inside(pr["B"], volume_points(pr["A"])).any() or inside(pr["A"], volume_points(pr["B"])).any())
bad = near = undecided = overruled = 0; worst = []
for i, pr in enumerate(pairs):
    ga, aa = geom_xml(pr["A"], "a"); gb, ab = geom_xml(pr["B"], "b")
    m = mujoco.MjModel.from_xml_string(f'<mujoco><asset>{aa}{ab}</asset><worldbody><body mocap="true">{ga}</body><body mocap="true">{gb}</body></worldbody></mujoco>')
    d = mujoco.MjData(m)
    for k, key in enumerate(("A", "B")):
        if pr[key]["type"] != "hull":   # hull vertices are already in world coordinates
            d.mocap_pos[k] = np.array(pr[key]["p"]) * S
            q = np.zeros(4); mujoco.mju_mat2Quat(q, np.array(pr[key]["R"], dtype=float)); d.mocap_quat[k] = q
    mujoco.mj_forward(m, d)
    dist = mujoco.mj_geomDistance(m, d, 0, 1, 10.0, None) / S
    if dist == 0.0:   # MuJoCo's mesh-mesh distance occasionally gives up and returns exactly 0
        undecided += 1
        est = cKDTree(sample(pr["A"])).query(sample(pr["B"]))[0].min()   # upper bound on the true distance
        if pr["hit10"] and est > 40: bad += 1; worst.append((i, "hit10/sampled", round(est, 1)))
        if not pr["hit10"] and est < 10: bad += 1; worst.append((i, "nohit/sampled", round(est, 1)))
        continue
    for margin, key in ((0.0, "hit0"), (10.0, "hit10")):
        if abs(dist - margin) < 0.05: near += 1; continue
        if (dist < margin) != pr[key]:
            if margin == 0.0 and overlap_bruteforce(pr) == pr[key]:
                overruled += 1; continue        # brute force sides with the JS result (MuJoCo penetration solver failed)
            bad += 1; worst.append((i, key, pr["A"]["type"], pr["B"]["type"], round(dist, 3)))
print(f"pairs={len(pairs)} mismatches={bad} skipped_near_threshold={near} mujoco_undecided(checked by sampling)={undecided} mujoco_overruled_by_bruteforce={overruled}")
print("examples:", worst[:10])
print(f"hit0 rate {sum(p['hit0'] for p in pairs)/len(pairs):.2f}, hit10 rate {sum(p['hit10'] for p in pairs)/len(pairs):.2f}")
sys.exit(1 if bad else 0)
