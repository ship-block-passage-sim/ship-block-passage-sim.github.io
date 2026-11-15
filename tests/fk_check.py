"""Load the exported URDF in MuJoCo and compare link poses / COM with the JS forward kinematics."""
import json, sys, re, numpy as np, mujoco
d = sys.argv[1]; dump = json.load(open(f"{d}/fk_dump.json")); ok = True
for vn, D in dump.items():
    urdf = open(f"{d}/robot_{vn}.urdf").read()
    urdf = urdf.replace("<robot ", '<robot ', 1).replace(">\n  <material", '>\n  <mujoco><compiler fusestatic="false" discardvisual="true" balanceinertia="true"/></mujoco>\n  <material', 1)
    m = mujoco.MjModel.from_xml_string(urdf); data = mujoco.MjData(m)
    perr = rerr = cerr = 0.0
    for smp in D["samples"]:
        for jn, v in smp["joints"].items():
            jid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, jn); assert jid >= 0, jn
            data.qpos[m.jnt_qposadr[jid]] = v
        mujoco.mj_forward(m, data)
        for ln, T in smp["links"].items():
            bid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, ln); assert bid >= 0, ln
            perr = max(perr, np.abs(data.xpos[bid] - np.array(T["p"])).max())
            rerr = max(rerr, np.abs(data.xmat[bid] - np.array(T["R"])).max())
        com = data.subtree_com[0] if m.nbody else None
        cerr = max(cerr, np.abs(com - np.array(smp["com"])).max())
    mass = m.body_subtreemass[0]
    print(f"[{vn}] bodies={m.nbody} joints={m.njnt} geoms={m.ngeom}  max |dp|={perr*1000:.2e} mm  max |dR|={rerr:.2e}  max |dCOM|={cerr*1000:.2e} mm  mass js={D['mass']:.3f} mj={mass:.3f}")
    ok &= perr < 1e-6 and rerr < 1e-6 and cerr < 1e-5 and abs(mass - D["mass"]) < 1e-3
print("FK CHECK", "OK" if ok else "FAILED"); sys.exit(0 if ok else 1)
