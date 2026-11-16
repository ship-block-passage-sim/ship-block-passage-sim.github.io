# Ship-Block Passage Simulator

Enter the dimensions of the four-legged wheel-leg robot (Yaw–Pitch–Pitch–Yaw–Wheel per leg) with its table-leg lift, and the app

1. builds the robot model from those dimensions and exports it as **URDF / SRDF**,
2. **plans the passage motion** through the ship-block environments (access hole, longis) and reports success or failure,
3. saves the result as an **MP4 video**.

Everything runs in the browser; there is no server-side computation. All lengths are in mm (the URDF uses m).

## Run

```bash
node tools/serve.mjs          # → http://localhost:8080  (other port: node tools/serve.mjs 9000)
```

Open it in Chrome or Edge. `python3 -m http.server 8080` works too. Opening `index.html` by double-click (`file://`) does not work.
The app is static files only, so deploying later means copying the folder to any static host.

## Workflow

1. Enter the dimensions on the left (table below). The 3D model updates immediately.
2. When the page opens it asks for the environment table: press **Load environment CSV…** and choose the file (or drop it on the page).
   All environments in the file are loaded at once. The **Source** buttons above the 3D view narrow the list to one data source
   (one button per value of the CSV column `source`). Then pick an **Environment** and a **Task** (hole passage / longi crossing) → **Plan**.
3. Check the motion with the timeline. The right panel shows the result, the failure reason and the phase list (click a phase to jump to it).
4. **Save video** writes the current result as MP4. **Batch: group / Batch: all** plan many environments at once (Batch: all covers the
   current source selection); **Save all videos** then
   writes `SUCCESS__….mp4` / `FAIL__….mp4` into a folder you choose. **Save CSV** writes the result table.
5. **Save URDF / Save SRDF** and **Save trajectory** (joint trajectory as JSON in m / rad / s) hand the model and motion to MoveIt2, RViz or other tools.

The upper view is 3D, the lower strip is a section view (hole task: side section through the hole centre; longi task: front view).
The green outline is the support polygon and the green dot the centre of mass. At a failure, the colliding parts are shown in red.

**All environments** (below the 3D view) lays out every environment of the current source selection side by side in one scene.
After a batch the tiles are coloured green (all tasks passed), amber (some) or red (none). Click a tile to open that environment.

## Input parameters

| Group | Fields | Meaning in the model |
|---|---|---|
| 1. Centre plate | length, width, thickness | Length = travel direction (X). The hips and the lift attach to it |
| 2. Actuator | diameter, thickness, hip joint layout | All four joint actuators of a leg are the same cylinder. Yaw1 stands on top of the plate inside each corner, tangent to both plate edges from the inside. Where Pitch1 sits depends on the hip joint layout (below) |
| 3. Leg links | L1, L2, L3 | Pitch1–Pitch2, Pitch2–Yaw2, Yaw2–wheel axis |
| 4. Payload | length, width, height | A box centred on top of the plate (used for collision and centre of mass) |
| 5. Lift leg spacing | lengthwise (X), crosswise (Y) | Distance between the fold shafts, distance between left and right legs |
| 6. Lift legs | length, stroke | Pivot-to-sole length when retracted, linear extension |

`Advanced settings` holds the geometry assumptions (wheel diameter/width, link tube diameter, zero direction of Yaw1, Yaw1–Pitch1 distances,
lift folding, leg width, pivot position), joint limits and masses.

### Hip joint layout (Yaw1–Pitch1)

| Layout | Where Pitch1 sits | Axes | Set with |
|---|---|---|---|
| `offset` (default) | beside Yaw1, just outside the plate, pitch axis at the mid-height of the yaw actuator | do not meet: the pitch axis is a horizontal distance away from the yaw axis | `Advanced: Offset layout: Yaw1–Pitch1 axis distance` (0 = one actuator diameter) |
| `cross-axis` | stacked on top of Yaw1, centred over its axis (a post fills any gap between the two) | intersect: the pitch axis crosses the yaw axis | `Advanced: Cross-axis layout: Yaw1 actuator top to Pitch1 axis` (0 = one actuator diameter) |

With the cross-axis layout the hip is higher (by half an actuator thickness plus that distance), and the thigh starts directly above the
yaw actuator, so it can only point downward until it touches the yaw actuator. A distance of one diameter lets the thigh point about
50° below horizontal; half a diameter (Pitch1 resting directly on Yaw1) only about 20°, which is too little for the planned gaits with the
default links. The hole cross-section check counts the stacked pitch actuators as part of the body. With the built-in examples and the
default dimensions, `offset` passes 11 of 12 tasks and `cross-axis` 10 of 12 (the higher hip needs longer legs at high sills).

### Modelling assumptions

- **The lift is modelled as folding legs.** `MAIN_LIFT_ASSEMBLY.step` contains shafts, gears and motors, so the model assumes that the front and rear leg
  pairs each fold up under the plate about their shaft (towards the centre), and each leg extends linearly. So that the folded pairs do not
  overlap, the rear pair is automatically narrower (`Advanced: Rear pair crosswise spacing` sets it directly). With folding switched off
  (`fixed vertical`) the legs always point down.
- Of the defaults, only **plate 780×450×25, lift lengthwise spacing 640 and leg length 620 were read from the lift CAD**. In the CAD the
  outer pair is about 530 apart crosswise (about 620–650 overall) and the inner pair about 315; with those values the body cross-section does
  not fit through a 600×600 hole (checked with this tool: width 580–614 > 600 minus clearance), so the default is 400.
  **Actuator, links, payload, wheel, masses and stroke are placeholder values** — replace them with the real ones.
- Leg joints: Yaw1 (vertical axis) → Pitch1 → Pitch2 → Yaw2 (rotation about the shank axis = wheel steering) → wheel. The links lie in the
  joint plane (no lateral offsets).
- A wheel rolls within the leg plane (Yaw2 = 0), or is steered by Yaw2 when the shank is vertical.

## Environments

The environments are **not part of the code**. They come from a CSV table with one row per environment:

- When the page opens, a dialog asks for the CSV. Without one the app shows six **built-in examples with made-up dimensions**,
  so that it can still be tried.
- Real dimensions (vessel longi sizes, access-hole sizes, test pieces) are kept in a separate CSV that is **not in this repository**.
  Share that file with the team directly; each person loads it with **Load environment CSV**.
- The file is read inside the browser and kept in that browser's local storage, so it only has to be loaded once per browser.
  Nothing is uploaded. **Back to examples** forgets it again.
- **CSV template** downloads the example table as a starting point.

When the app runs from a local checkout (`node tools/serve.mjs`), `private/environments.csv` is loaded automatically if it exists.
The `private/` folder is git-ignored. The command-line tools use the same file by default (`--envs <file.csv>` for another table,
`--examples` for the built-in examples). `?envs=<url>` in the address loads a table from a URL.

### CSV format

Comma-separated, first line = column names, UTF-8. Several values in one cell are separated by `;`. Empty cells take the default.
Coordinates: floor from (0, 0) to (`floor_x`, `floor_y`), floor top at z = 0, longis along Y, walls across X.

| Column | Meaning | Default |
|---|---|---|
| `id` | unique name, also used in video file names | required |
| `source` | where the data comes from (e.g. a shipyard or a test plan); one filter button per value | none |
| `group`, `label` | heading and text in the environment list | `Environments`, the id |
| `floor_x`, `floor_y` | floor size across / along the longis | `longi_n × longi_pitch`; 4000 with a wall, 2400 without |
| `longi_kind` | `T`, `L` or `FB` (flat bar); one value or one per longi | `T` |
| `longi_h`, `longi_tw` | height (floor to top of flange), web thickness; one value or one per longi | required with longis |
| `longi_wf`, `longi_tf` | flange width and thickness (T, L); one value or one per longi | required for T and L |
| `longi_pitch`, `longi_n`, `longi_x0` | evenly spaced longis: spacing, count, x of the first | `longi_x0` = pitch / 2 |
| `longi_x` | explicit list of longi positions instead of pitch / count | |
| `wall_y`, `wall_t`, `wall_height` | wall mid-plane position, thickness, height | `floor_y` / 2, 12, 2000 |
| `wall_x0`, `wall_x1` | lists, for several separate wall panels | one wall over the full floor width |
| `hole_W`, `hole_H`, `hole_R`, `hole_sill` | hole width, height, corner radius, height of the hole bottom above the floor; one value or one per hole | `hole_R` = 0 |
| `hole_c` | x of each hole centre | wall centre (single hole) |
| `bead_y` | y positions of floor weld beads (drawn only) | none |
| `step_file`, `step_prefix` | optional: STEP file and part-name prefix the row was taken from, for `tests/env_check.mjs` | |

A wall exists when the row has a hole or a `wall_height`. Longis that cross a wall pass through it in slots with 15 mm clearance.
Tasks are derived from the row: one hole-passage task per hole; one longi-crossing task (identical longis) or one per longi (different longis).
Rows with mistakes are skipped and listed under the environment bar with their row number.

Example (two rows):

```csv
id,group,label,longi_kind,longi_h,longi_tw,longi_wf,longi_tf,longi_pitch,longi_n,hole_W,hole_H,hole_R,hole_sill
cell-A,My vessel,Cell A,T,300,10,100,12,700,6,600,600,100,600
panel-B,My vessel,Mixed panel,T;T;L,250;350;400,10,90;110;120,15,800,3,,,,
```

Floor weld beads are drawn but are not part of the collision model.

### The environment is treated as unbounded

A CSV row describes a finite sample of a structure that continues, so the planner must not use its edges as a way round:

- **Longis are infinitely long.** The robot cannot go past or around their ends.
- **The longi pattern continues sideways** beyond the outermost longis, with the outermost longi and pitch, starting no closer than the
  edge of the modelled floor. Crossing the first or last longi therefore starts and ends in a real channel.
- **Walls continue sideways and upward** without further openings; the only way through is a hole.
- The floor is an unbounded plane.

The continuation is drawn faded.

## How passage is decided

MoveIt2 is not used; the app has its own planner (see "MoveIt2" below). Following the photos, it builds a **fixed sequence of motions (gait)**
and executes each segment with collision checking. Moving one leg is planned with **RRT-Connect** in that leg's 4-joint space.
Pose variables (body height, distance to the wall, leg spread angle, foot positions, rolling distances) are searched over candidates.

**Hardware rules built into every plan**

- **Leg joints (yaw, pitch) only move while the lift carries the body.** Without lift support the legs are rigid; the robot can then only
  roll on its wheels. A leg is therefore re-placed only at a lift stop, one leg at a time.
- When rolling, every wheel must stand upright with its axle across the direction of travel: either the leg plane points along the
  direction of travel (Yaw2 = 0), or the shank is vertical and the wheel is steered with Yaw2.

**Hole passage** (body lengthwise through the hole, constant body height)

1. Roll up to the wall with the front legs spread into the neighbouring channels (shanks vertical, wheels steered) and the rear legs trailing behind
2. Unfold the lift and stand on it → put the front legs through the hole one at a time and plant them on the far side → stow the lift
3. Roll on four wheels until the body is through the hole (the rear legs still reach back through the hole to the near-side floor)
4. On the far side, deploy the lift again → bring the rear legs through one at a time and plant them in the neighbouring channels → stow the lift → roll off

**Longi crossing** (body parallel to the longis, moving sideways)

1. Lift stop A: the leading legs step forward over their longi, the trailing legs are pulled up over theirs
2. Stow the lift → roll sideways with rigid legs (every wheel stays inside its channel)
3. Lift stop B: the leading legs step back, the trailing legs reach back again, which restores the starting stance
4. Stow the lift → roll the rest of the pitch. The lift is only used where its legs fit inside a channel or astride a longi.

**Success criteria**: at every instant robot–environment distance ≥ 10 mm, distance between robot parts ≥ 5 mm, joints within limits, and the
centre of mass at least 20 mm inside the support polygon (planted wheels + lift feet on the floor). The values are in `Options` on the right.

### Reading the results

- **Success** means a motion satisfying the criteria above was actually found.
- **Failure** means none was found within this motion sequence and search range; it is not a proof of impossibility. Geometric reasons
  such as `Body cross-section does not fit through the hole` or `Legs too short` are definite. `no swing path found` comes from a
  randomized search and is less definite (the planner retries with 8× and 40× the search effort before reporting it; time limit 60 s per task).
- Only kinematics and geometry are checked. **Joint torques, dynamics, wheel slip and structural stiffness are not.**
- If the robot should move in a different order (leg order, tilting the body, changing height), edit the sequences in `planHole` /
  `planLongi` in `src/planner.js`.

## Command-line tools

```bash
node tools/plan.mjs --list                                   # environments and tasks
node tools/plan.mjs --env cell-A --task hole -v              # plan one task without a browser
node tools/plan.mjs --all --params robot_params.json         # success/failure table for every task
node tools/plan.mjs --env cell-B --task hole --set L1=500 --set L2=600
node tools/plan.mjs --all --examples --set hipJoint=cross       # compare hip joint layouts (offset | cross)
node tools/plan.mjs --all --envs my_environments.csv         # use another environment table

npm install                                                  # once; needed for batch video export (puppeteer-core)
node tools/batch_videos.mjs --group "My vessel" --out videos               # plan a whole group + save MP4s
node tools/batch_videos.mjs --all --params robot_params.json --only fail   # videos of the failures only
```

### Intro film

```bash
node tools/make_intro_video.mjs --envs private/environments.csv --out videos/intro/intro.mp4
```

Renders a ~1 minute product film of the app (1920×1080, 30 fps): each feature is located in the app, then shown on a clean stage.
It plans every task of the table first (about a minute), then drives the app frame by frame in headless Chrome. The film shows the
environment table that is passed in, so treat the file like the table.

`robot_params.json` is the file written by **Save parameters** in the app. `batch_videos.mjs` drives the same web app in headless Chrome
and writes the MP4s plus `results.csv` and `results.json` into `videos/` (a few seconds per video). If the videos come out black, add
`--software` (renders without the GPU; slower).

## MoveIt2

MoveIt2 is not integrated. Its standard planners do not handle whole-body contact sequences (keeping feet planted, switching supports,
driving), so this problem needs a gait-level plan like the one above in any case. To continue in MoveIt2:

- The exported **URDF** parses with `check_urdf`, and loading it in MuJoCo reproduces the forward kinematics of the model.
- The **SRDF** has a planning group per leg, a lift group and adjacent-link collision exemptions: a starting point for the MoveIt Setup Assistant.
- The **trajectory** JSON (joint names + positions over time) can be replayed or checked in RViz / MoveIt.

## Verification

```bash
node tests/run_all.mjs      # needs python3 with mujoco, numpy, scipy
```

- Collision test (GJK) compared with MuJoCo distances on random shape pairs
- Exported URDF loaded in MuJoCo: link poses, centre of mass and mass compared with the JS model (both hip joint layouts)
- Whole planned trajectories replayed in MuJoCo with robot + environment: minimum distances must stay above the clearances, and no leg
  joint may move in a frame without lift support (both hip joint layouts)
- Environment CSV reader: quoting, lists, defaults and error reporting
- (optional) an environment table against the STEP files it was taken from: create the JSON with `tests/step_parts.py`, then
  `STEP_PARTS=<json> ENVS_CSV=<environments.csv> node tests/run_all.mjs`

## Layout

```
index.html, style.css     page
src/robot.js              parameters → links, joints, shapes; FK / IK; centre of mass
src/urdf.js               URDF / SRDF export
src/env.js                environment CSV format, built-in examples, geometry
src/collide.js            convex collision test (GJK)
src/planner.js            motion planning (gaits, RRT-Connect, search)
src/viewer.js, app.js     3D display, UI, MP4 export
src/worker.js             Web Worker for planning
src/presets.js            presets
tools/                    server, command-line planning, batch video export, intro film
private/                  (git-ignored) your own environments.csv
tests/                    verification scripts
vendor/                   three.js, OrbitControls, mp4-muxer (MIT)
```
