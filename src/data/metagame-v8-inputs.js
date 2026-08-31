import {
  METAGAME_V12_REPRESENTATIVE_INPUTS,
  METAGAME_V12_SWEEP_INPUTS,
  METAGAME_V12_SWEEP_MIN_COST,
  METAGAME_V12_SWEEP_MAX_COST,
} from "./metagame-v12-sweep-inputs.js";

// V12 precomputes every requested cost from 100 through 200 at one-cost
// increments for all seven attribute groups. Keep representative inputs above
// that range available for legacy/other callers without duplicating the exact
// 100/200 anchors already present in the sweep.
const REPRESENTATIVE_INPUTS_OUTSIDE_SWEEP = METAGAME_V12_REPRESENTATIVE_INPUTS.filter((input) => (
  Number(input.totalCost) < METAGAME_V12_SWEEP_MIN_COST
  || Number(input.totalCost) > METAGAME_V12_SWEEP_MAX_COST
));

export const METAGAME_V8_INPUTS = Object.freeze([
  ...METAGAME_V12_SWEEP_INPUTS,
  ...REPRESENTATIVE_INPUTS_OUTSIDE_SWEEP,
]);
