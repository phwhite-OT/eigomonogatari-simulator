import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptiveMetagameV12ScenarioWeights,
  buildAdaptiveMetagameV12Equilibrium,
  reconcileAdaptiveMetagameV12Rating,
} from "../src/core/metagame-v12-adaptive.js";

function character(id, name = id) {
  return { id, name, cost: 10 };
}

function deck(id) {
  return [0, 1, 2, 3, 4].map((index) => character(`${id}-${index}`, `${id}${index}`));
}

function result(values) {
  return {
    scenarioValues: values,
    expectedWinRate: values.reduce((sum, value) => sum + value, 0) / values.length,
    expectedWinLowerBound: 0,
    decisiveWinRate: 0,
  };
}

test("adaptive scenario weights are uniform when strategy adoption is uniform", () => {
  const a = deck("a");
  const b = deck("b");
  const aKey = a.map((entry) => entry.id).join("|");
  const bKey = b.map((entry) => entry.id).join("|");
  const scenarios = [
    { backgroundDeckKeys: [aKey] },
    { backgroundDeckKeys: [bKey] },
  ];
  const weights = adaptiveMetagameV12ScenarioWeights(
    scenarios,
    new Map([[aKey, 0.5], [bKey, 0.5]]),
    { uniformScenarioFloor: 0.2 },
  );
  assert.deepEqual(weights.map((value) => Number(value.toFixed(8))), [0.5, 0.5]);
});

test("adaptive equilibrium rewards broad strength over a narrow counter that only matters into one shell", () => {
  const broad = deck("broad");
  const wall = deck("wall");
  const counter = deck("counter");
  const decks = [broad, wall, counter];
  const keys = decks.map((entry) => entry.map((character) => character.id).join("|"));
  const scenarios = [
    { backgroundDeckKeys: [keys[0]] },
    { backgroundDeckKeys: [keys[1]] },
    { backgroundDeckKeys: [keys[2]] },
  ];
  const cache = new Map([
    [`12:${keys[0]}`, result([0.68, 0.62, 0.66])],
    [`12:${keys[1]}`, result([0.48, 0.60, 0.58])],
    [`12:${keys[2]}`, result([0.35, 0.90, 0.30])],
  ]);
  const equilibrium = buildAdaptiveMetagameV12Equilibrium(decks, scenarios, cache, {
    turns: 12,
    iterations: 64,
    burnIn: 16,
    learningRate: 6,
    exploration: 0.04,
    uniformScenarioFloor: 0.2,
  });
  const byKey = new Map(equilibrium.strategies.map((entry) => [entry.key, entry]));
  assert.ok(byKey.get(keys[0]).weight > byKey.get(keys[2]).weight);
  assert.ok(byKey.get(keys[0]).expectedWinRate > byKey.get(keys[2]).expectedWinRate);
  assert.ok(byKey.get(keys[2]).weight > 0, "counter strategies must remain represented instead of being deleted");
});

test("time-averaging preserves all sides of a cyclic counter metagame", () => {
  const a = deck("a");
  const b = deck("b");
  const c = deck("c");
  const decks = [a, b, c];
  const keys = decks.map((entry) => entry.map((character) => character.id).join("|"));
  const scenarios = [
    { backgroundDeckKeys: [keys[0]] },
    { backgroundDeckKeys: [keys[1]] },
    { backgroundDeckKeys: [keys[2]] },
  ];
  const cache = new Map([
    [`12:${keys[0]}`, result([0.50, 0.80, 0.20])],
    [`12:${keys[1]}`, result([0.20, 0.50, 0.80])],
    [`12:${keys[2]}`, result([0.80, 0.20, 0.50])],
  ]);
  const equilibrium = buildAdaptiveMetagameV12Equilibrium(decks, scenarios, cache, {
    iterations: 72,
    burnIn: 12,
    exploration: 0.03,
    uniformScenarioFloor: 0.15,
  });
  const weights = equilibrium.strategies.map((entry) => entry.weight);
  assert.ok(weights.every((weight) => weight > 0.15));
  assert.ok(weights.every((weight) => weight < 0.50));
});

test("adaptive reconciliation can change the selected best complete deck using measured scenario values", () => {
  const scenarioWeights = [0.8, 0.2];
  const rating = {
    id: "target",
    opportunityWinGain: 0.05,
    robustOpportunityWinGain: 0.04,
    candidateExpectedWinRate: 0.55,
    benchmarkExpectedWinRate: 0.50,
    bestDeck: { ids: ["target", "a", "b", "c", "d"], names: [], totalCost: 50, remainingCost: 50 },
    baselineDeck: { ids: ["x", "a", "b", "c", "d"], names: [], totalCost: 50, remainingCost: 50 },
    roleBreakdown: {},
  };
  const sharedPool = [
    {
      ids: ["target", "a", "b", "c", "d"],
      names: ["target", "a", "b", "c", "d"],
      totalCost: 50,
      result: result([0.90, 0.10]),
    },
    {
      ids: ["target", "e", "f", "g", "h"],
      names: ["target", "e", "f", "g", "h"],
      totalCost: 50,
      result: result([0.55, 0.75]),
    },
    {
      ids: ["x", "a", "b", "c", "d"],
      names: ["x", "a", "b", "c", "d"],
      totalCost: 45,
      result: result([0.45, 0.45]),
    },
    {
      ids: ["y", "e", "f", "g", "h"],
      names: ["y", "e", "f", "g", "h"],
      totalCost: 45,
      result: result([0.50, 0.50]),
    },
  ];
  const reconciled = reconcileAdaptiveMetagameV12Rating(
    rating,
    1,
    sharedPool,
    { version: 1, scenarioWeights },
    { totalCost: 100 },
  );
  assert.equal(reconciled.adaptiveMetagameApplied, true);
  assert.deepEqual(reconciled.bestDeck.ids, ["target", "a", "b", "c", "d"]);
  assert.equal(reconciled.uniformOpportunityWinGain, 0.05);
  assert.ok(reconciled.opportunityWinGain > 0.20);
});
