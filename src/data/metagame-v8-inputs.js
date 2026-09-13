import {
  METAGAME_V12_REPRESENTATIVE_INPUTS,
  METAGAME_V12_SWEEP_INPUTS,
  METAGAME_V12_SWEEP_MIN_COST,
  METAGAME_V12_SWEEP_MAX_COST,
} from "./metagame-v12-sweep-inputs.js";

// V12 only materializes the representative precompute bands exposed by
// METAGAME_V12_SWEEP_INPUTS. Arbitrary user-entered costs inside the supported
// range are resolved on demand by resolveMetagameV12SweepInput(), so they must
// not expand this expensive precompute list into every integer cost.
// Keep any representative inputs outside the supported sweep range available
// for legacy/other callers without duplicating inputs already in the sweep.
const REPRESENTATIVE_INPUTS_OUTSIDE_SWEEP = METAGAME_V12_REPRESENTATIVE_INPUTS.filter((input) => (
  Number(input.totalCost) < METAGAME_V12_SWEEP_MIN_COST
  || Number(input.totalCost) > METAGAME_V12_SWEEP_MAX_COST
));

export const METAGAME_V8_INPUTS = Object.freeze([
  ...METAGAME_V12_SWEEP_INPUTS,
  ...REPRESENTATIVE_INPUTS_OUTSIDE_SWEEP,
]);
