// Parameter presets (values in mm). Keys not listed fall back to the defaults in robot.js.
// Only the lift numbers of the first preset come from CAD (MAIN_LIFT_ASSEMBLY.step: chassis 780 x 450 x 25,
// fold shafts 640 apart, leg ~620 from pivot to foot). Actuator, link and payload sizes are placeholders.
export const PRESETS = {
  'Default (lift from CAD + placeholder values)': {},
  'Example: long legs (for high sills)': { L1: 500, L2: 600, L3: 100, liftStroke: 450 },
  'Example: compact (for small holes)': {
    plateL: 600, plateW: 340, plateT: 20, actD: 70, actT: 45, L1: 300, L2: 260, L3: 80, payL: 380, payW: 300, payH: 200,
    liftSX: 460, liftSY: 250, liftLen: 330, liftStroke: 120, liftLegW: 40, liftPivotDrop: 35, wheelD: 90, linkD: 35,
  },
};
