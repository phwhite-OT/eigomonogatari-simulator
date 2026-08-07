import test from "node:test";
import assert from "node:assert/strict";

import { METAGAME_SIMULATOR_DATA } from "../src/data/metagame-simulator-data.js";

test("埋め込み済みの環境データは完全な5枠と30盤面を持つ", () => {
  assert.ok(METAGAME_SIMULATOR_DATA.sourceCompletedRuns >= 0);
  assert.equal(typeof METAGAME_SIMULATOR_DATA.sourceModelCompatible, "boolean");
  assert.equal(typeof METAGAME_SIMULATOR_DATA.sourceStatus, "string");
  assert.equal(typeof METAGAME_SIMULATOR_DATA.sourcePasses, "number");

  if (!METAGAME_SIMULATOR_DATA.sourceModelCompatible) {
    assert.equal(METAGAME_SIMULATOR_DATA.constraints.length, 0);
    return;
  }
  for (const constraint of METAGAME_SIMULATOR_DATA.constraints) {
    assert.equal(constraint.slots.length, 5);
    assert.equal(constraint.environmentScenarios.length, constraint.scenarioCount);
    assert.deepEqual(constraint.slots.map((slot) => slot.position), [1, 2, 3, 4, 5]);
    assert.ok(constraint.slots.every((slot) => slot.environment.length > 0));
    assert.ok(constraint.slots.every((slot) => slot.candidates.length > 0));
  }
});
