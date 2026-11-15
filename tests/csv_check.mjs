// Unit checks of the environment CSV reader (src/env.js): quoting, lists, defaults, error reporting.
import assert from 'node:assert/strict';
import { parseCSV, envsFromCSV, envsToCSV, EXAMPLE_ROWS, EXAMPLE_CSV, buildEnv } from '../src/env.js';

assert.deepEqual(parseCSV('\ufeffa,b\r\n"x, ""y""",2\n# comment\n\n3,"multi\nline"\n'), [['a', 'b'], ['x, "y"', '2'], ['3', 'multi\nline']]);

// the built-in examples parse without complaints and survive a write/read round trip
const ex = envsFromCSV(EXAMPLE_CSV);
assert.equal(ex.errors.length, 0, ex.errors.join('; '));
assert.equal(ex.envs.length, EXAMPLE_ROWS.length);
assert.deepEqual(envsFromCSV(envsToCSV(EXAMPLE_ROWS)).envs, ex.envs);

// defaults: evenly spaced longis start at pitch / 2, the floor is n x pitch wide, a single hole sits at the wall centre
const a = ex.envs.find(e => e.id === 'example/cell-A');
assert.deepEqual(a.longis.map(l => l.c), [350, 1050, 1750, 2450, 3150, 3850]);
assert.equal(a.floor.x1, 4200); assert.equal(a.walls[0].holes[0].c, 2100); assert.equal(a.walls[0].y0, 1994); assert.equal(a.walls[0].slots.length, 6);
assert.deepEqual(a.tasks.map(t => t.id), ['hole:0:0', 'longi:2']);
// lists: one value per longi / per hole
const m = ex.envs.find(e => e.id === 'example/mixed-longis');
assert.deepEqual(m.longis.map(l => `${l.prof.kind}${l.prof.h}`), ['T250', 'T350', 'T450', 'L400']); assert.equal(m.tasks.length, 4);
const t = ex.envs.find(e => e.id === 'example/two-holes');
assert.deepEqual(t.walls[0].holes.map(h => [h.c, h.W, h.H, h.R, h.sill]), [[1100, 600, 600, 100, 500], [3300, 800, 1000, 300, 600]]);
for (const e of ex.envs) assert.ok(buildEnv(e).shapes.length > 1);

// column names are case-insensitive, unknown columns are reported, bad rows are skipped with the row number
const r = envsFromCSV('ID,Floor_X,HOLE_w,hole_H,hole_sill,colour\nok,2000,600,600,500,red\nbad1,2000,abc,600,500,\nbad2,,600,600,500,\nok,2000,600,600,500,\nbad3,2000,600,600,1900,\nbad4,1000,,,,\n');
assert.deepEqual(r.envs.map(e => e.id), ['ok']);
assert.equal(r.errors.length, 6);
assert.match(r.errors[0], /Unknown column.*colour/); assert.match(r.errors[1], /Row 3 \(bad1\).*not a number/); assert.match(r.errors[2], /Row 4 \(bad2\).*floor_x is required/);
assert.match(r.errors[3], /Row 5 \(ok\).*more than once/); assert.match(r.errors[4], /Row 6 \(bad3\).*wall height/); assert.match(r.errors[5], /Row 7 \(bad4\).*nothing to plan/);
assert.deepEqual(envsFromCSV('').errors, ['The file is empty.']);
assert.match(envsFromCSV('name,floor_x\na,1').errors[0], /column "id"/);
console.log('environment CSV parser: all checks passed');
