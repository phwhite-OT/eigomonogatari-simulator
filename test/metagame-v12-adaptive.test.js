import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdaptiveMetagameV12Equilibrium,
  reconcileAdaptiveMetagameV12Rating,
  selectAdaptiveMetagameV12Strategies,
} from "../src/core/metagame-v12-adaptive.js";

function result(values) {
  return {
    scenarioValues: values,
    expectedWinRate: values.reduce((sum, value) => sum + value, 0) / values.length,
    expectedWinLowerBound: 0,
    decisiveWinRate: 0,
  };
}

function strategy(id, values, ids = null) {
  const deckIds = ids ?? [0, 1, 2, 3, 4].map((index) => `${id}-${index}`);
  return {
    ids: deckIds,
    names: deckIds,
    totalCost: 50,
    result: result(values),
  };
}

test("adaptive strategy selection keeps structurally different measured decks", () => {
  const pool = [
    strategy("a1", [0.80, 0.80], ["a", "b", "c", "d", "e"]),
    strategy("a2", [0.79, 0.79], ["a", "b", "c", "d", "f"]),
    strategy("a3", [0.78, 0.78], ["a", "b", "c", "d", "g"]),
    strategy("counter", [0.77, 0.77], ["u", "v", "w", "x", "y"]),
    strategy("other", [0.76, 0.76], ["u", "v", "w", "q", "r"]),
    strategy("last", [0.75, 0.75], ["1", "2", "3", "4", "5"]),
    strategy("z1", [0.74, 0.74]),
    strategy("z2", [0.73, 0.73]),
    strategy("z3", [0.72, 0.72]),
  ];
  const selected = selectAdaptiveMetagameV12Strategies(pool, 2, { strategyLimit: 8 });
  assert.equal(selected.length, 8);
  assert.ok(selected.some((entry) => entry.key === "u|v|w|x|y"));
});

test("adaptive equilibrium rewards broad strength over a narrow counter", () => {
  const pool = [
    strategy("broad", [0.68, 0.62, 0.66]),
    strategy("wall", [0.48, 0.60, 0.58]),
    strategy("counter", [0.35, 0.90, 0.30]),
  ];
  const equilibrium = buildAdaptiveMetagameV12Equilibrium(
    pool,
    [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    {
      iterations: 80,
      burnIn: 20,
      strategyLearningRate: 6,
      counterLearningRate: 5,
      strategyExploration: 0.03,
      uniformScenarioFloor: 0.25,
      strategyLimit: 8,
    },
  );
  const byKey = new Map(equilibrium.strategies.map((entry) => [entry.key, entry]));
  const broadKey = pool[0].ids.join("|");
  const counterKey = pool[2].ids.join("|");
  assert.ok(byKey.get(broadKey).weight > byKey.get(counterKey).weight);
  assert.ok(byKey.get(broadKey).expectedWinRate > byKey.get(counterKey).expectedWinRate);
  assert.ok(byKey.get(counterKey).weight > 0, "narrow counters remain represented rather than being deleted");
  assert.ok(equilibrium.effectiveScenarioCount > 1);
});

test("time-averaging preserves all sides of a cyclic counter metagame", () => {
  const pool = [
    strategy("a", [0.50, 0.80, 0.20]),
    strategy("b", [0.20, 0.50, 0.80]),
    strategy("c", [0.80, 0.20, 0.50]),
  ];
  const equilibrium = buildAdaptiveMetagameV12Equilibrium(
    pool,
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    {
      iterations: 96,
      burnIn: 16,
      strategyExploration: 0.03,
      uniformScenarioFloor: 0.20,
      strategyLimit: 8,
    },
  );
  const weights = equilibrium.strategies.map((entry) => entry.weight);
  assert.ok(weights.every((weight) => weight > 0.15));
  assert.ok(weights.every((weight) => weight < 0.50));
  assert.ok(Math.max(...equilibrium.scenarioWeights) - Math.min(...equilibrium.scenarioWeights) < 0.20);
});

test("adaptive reconciliation can change the selected best complete deck using measured counter pressure", () => {
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
    strategy("candidate-a", [0.90, 0.10], ["target", "a", "b", "c", "d"]),
    strategy("candidate-b", [0.55, 0.75], ["target", "e", "f", "g", "h"]),
    strategy("baseline-a", [0.45, 0.45], ["x", "a", "b", "c", "d"]),
    strategy("baseline-b", [0.50, 0.50], ["y", "e", "f", "g", "h"]),
  ];
  const reconciled = reconcileAdaptiveMetagameV12Rating(
    rating,
    1,
    sharedPool,
    { version: 2, scenarioWeights },
    { totalCost: 100 },
  );
  assert.equal(reconciled.adaptiveMetagameApplied, true);
  assert.deepEqual(reconciled.bestDeck.ids, ["target", "a", "b", "c", "d"]);
  assert.equal(reconciled.uniformOpportunityWinGain, 0.05);
  assert.ok(reconciled.opportunityWinGain > 0.20);
});
