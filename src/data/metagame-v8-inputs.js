import { METAGAME_V7_INPUTS } from "./metagame-v7-inputs.js";
import { METAGAME_V8_COST_200_INPUTS } from "./metagame-v8-cost-200-inputs.js";

// The evaluator is versioned separately from the source spreadsheets.  Keep
// the existing v7-named export intact for compatibility while giving v8.5 one
// ordered queue of every requested environment.
export const METAGAME_V8_INPUTS = Object.freeze([
  ...METAGAME_V7_INPUTS,
  ...METAGAME_V8_COST_200_INPUTS,
]);
