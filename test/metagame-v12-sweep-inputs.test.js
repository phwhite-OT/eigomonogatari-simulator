import test from "node:test";
import assert from "node:assert/strict";

import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  METAGAME_V12_PLANNED_PRECOMPUTE_COSTS,
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

const PLANNED_PRECOMPUTE_COSTS = [100, 200, 300, 500];
const READY_PRECOMPUTE_COSTS = [100, 200];

test("V12 cloud precompute contains only costs with exact supplied environments", () => {
  assert.deepEqual(METAGAME_V12_PLANNED_PRECOMPUTE_COSTS, PLANNED_PRECOMPUTE_COSTS);
  assert.deepEqual(METAGAME_V12_PRECOMPUTE_COSTS, READY_PRECOMPUTE_COSTS);
  assert.equal(METAGAME_V12_SWEEP_INPUTS.length, READY_PRECOMPUTE_COSTS.length * GROUPS.length);
  assert.equal(new Set(METAGAME_V12_SWEEP_INPUT_IDS).size, READY_PRECOMPUTE_COSTS.length * GROUPS.length);

  for (const cost of READY_PRECOMPUTE_COSTS) {
    const ids = METAGAME_V12_SWEEP_INPUT_IDS.filter((id) => id.endsWith(`:${cost}`));
    assert.deepEqual(ids, GROUPS.map((group) => `${group}:${cost}`));
  }

  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS[0], "fire:100");
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.at(-1), "fire-water-wind:200");
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.some((id) => id.endsWith(":300")), false);
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.some((id) => id.endsWith(":500")), false);
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.includes("water-wind:199"), false);
});

test("arbitrary browser costs may use nearest anchors without entering official cloud precompute", () => {
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

  const c300 = resolveMetagameV12SweepInput("fire:300");
  assert.equal(c300.totalCost, 300);
  assert.equal(c300.syntheticCostInput, true);
  assert.equal(c300.environmentTemplateCost, 200);
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.includes("fire:300"), false);

  const c500 = resolveMetagameV12SweepInput("fire:500");
  assert.equal(c500.totalCost, 500);
  assert.equal(c500.syntheticCostInput, true);
  assert.equal(c500.environmentTemplateCost, 200);
  assert.equal(METAGAME_V12_SWEEP_INPUT_IDS.includes("fire:500"), false);

  const all137 = resolveMetagameV12SweepInput("fire-water-wind:137");
  assert.equal(all137.totalCost, 137);
  assert.deepEqual(all137.allowedAttributes, ["fire", "water", "wind"]);
});

test("legacy METAGAME_V8_INPUTS exposes only ready representative precompute inputs", () => {
  const byId = new Map(METAGAME_V8_INPUTS.map((input) => [input.id, input]));
  for (const id of METAGAME_V12_SWEEP_INPUT_IDS) {
    assert.ok(byId.has(id), `missing ${id}`);
  }
  assert.equal(byId.size, READY_PRECOMPUTE_COSTS.length * GROUPS.length);
  assert.equal(byId.has("fire:300"), false);
  assert.equal(byId.has("fire:500"), false);
  assert.equal(byId.has("water-wind:199"), false);
  assert.equal(resolveMetagameV12SweepInput("water-wind:199").totalCost, 199);
});
