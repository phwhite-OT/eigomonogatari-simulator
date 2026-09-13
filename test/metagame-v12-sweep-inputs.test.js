import test from "node:test";
import assert from "node:assert/strict";

import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  METAGAME_V12_PRECOMPUTE_COSTS,
  METAGAME_V12_SWEEP_INPUTS,
  METAGAME_V12_SWEEP_INPUT_IDS,
  resolveMetagameV12SweepInput,
} from "../src/data/metagame-v12-sweep-inputs.js";

const GROUPS = [
  "fire",
  "water",
  "wind",
  "fire-water",
  "fire-wind",
  "water-wind",
  "fire-water-wind",
];

const PRECOMPUTE_COSTS = [100, 200, 300, 500];

test("V12 precompute sweep contains exactly four representative costs for all seven attribute groups", () => {
  assert.deepEqual(METAGAME_V12_PRECOMPUTE_COSTS, PRECOMPUTE_COSTS);
  assert.equal(METAGAME_V12_SWEEP_INPUTS.length, PRECOMPUTE_COSTS.length * GROUPS.length);
  assert.equal(new Set(METAGAME_V12_SWEEP_INPUT_IDS).size, PRECOMPUTE_COSTS.length * GROUPS.length);

  for (const cost of PRECOMPUTE_COSTS) {
    const ids = METAGAME_V12_SWEEP_INPUT_IDS.filter((id) => id.endsWith(`:${cost}`));
    assert.deepEqual(ids, GROUPS.map((group) => `${group}:${cost}`));
  }

  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS[0], "fire:100");
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.at(-1), "fire-water-wind:500");
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.includes("water-wind:199"), false);
});

test("intermediate costs are real cost constraints backed by the nearest available environment anchor", () => {
  const c101 = resolveMetagameV12SweepInput("fire:101");
  assert.equal(c101.totalCost, 101);
  assert.equal(c101.syntheticCostInput, true);
  assert.equal(c101.environmentTemplateCost, 100);

  const c150 = resolveMetagameV12SweepInput("fire:150");
  assert.equal(c150.totalCost, 150);
  assert.equal(c150.environmentTemplateCost, 100);

  const c151 = resolveMetagameV12SweepInput("fire:151");
  assert.equal(c151.totalCost, 151);
  assert.equal(c151.environmentTemplateCost, 200);

  const highCost = resolveMetagameV12SweepInput("fire:500");
  assert.equal(highCost.totalCost, 500);
  assert.equal(highCost.syntheticCostInput, true);
  assert.equal(highCost.environmentTemplateCost, 200);

  const all137 = resolveMetagameV12SweepInput("fire-water-wind:137");
  assert.equal(all137.totalCost, 137);
  assert.deepEqual(all137.allowedAttributes, ["fire", "water", "wind"]);
});

test("legacy METAGAME_V8_INPUTS exposes every representative precompute input without materializing every integer cost", () => {
  const byId = new Map(METAGAME_V8_INPUTS.map((input) => [input.id, input]));
  for (const id of METAGAME_V12_SWEEP_INPUT_IDS) {
    assert.ok(byId.has(id), `missing ${id}`);
  }
  assert.equal(byId.size, PRECOMPUTE_COSTS.length * GROUPS.length);
  assert.equal(byId.has("water-wind:199"), false);
  assert.equal(resolveMetagameV12SweepInput("water-wind:199").totalCost, 199);
});
