import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMetagameV12SharedDeckPool,
  hydrateMetagameV12EvaluationCache,
  reconcileMetagameV12RatingFromSharedPool,
  serializeMetagameV12EvaluationCache,
} from "../src/core/metagame-v12-shared-pool.js";

function result(values) {
  const expectedWinRate = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    expectedWinRate,
    expectedWinLowerBound: expectedWinRate - 0.05,
    decisiveWinRate: values.filter((value) => value === 1).length / values.length,
    scenarioCount: values.length,
    scenarioValues: values,
  };
}

const characters = "abcdefghij".split("").map((id, index) => ({
  id,
  name: id.toUpperCase(),
  cost: index + 1,
}));

test("V12 evaluation cache survives checkpoint serialization", () => {
  const cache = new Map([
    ["12:b|c|d|e|a", result([0.5, 0.5, 0.5, 0.5])],
    ["12:f|g|h|i|a", result([1, 0.5, 1, 0.5])],
  ]);
  const serialized = serializeMetagameV12EvaluationCache(cache);
  const restored = new Map();
  hydrateMetagameV12EvaluationCache(restored, serialized);
  assert.deepEqual([...restored.entries()], [...cache.entries()]);
});

test("V12 shared pool reuses a stronger deck found while rating another card", () => {
  const cache = new Map([
    // Direct A evaluation happened to find only this weaker slot-5 shell.
    ["12:b|c|d|e|a", result([0.5, 0.5, 0.5, 0.5])],
    // Another character's evaluation discovered this stronger slot-5 A shell.
    ["12:f|g|h|i|a", result([1, 0.5, 1, 0.5])],
    // Strongest legal A-free opportunity-cost baseline.
    ["12:f|g|h|i|j", result([0.5, 0.5, 0.5, 0.5])],
    // This deck is stronger but contains A in another slot, so it must never
    // be used as A's exclusion baseline.
    ["12:a|g|h|i|j", result([1, 1, 1, 1])],
  ]);
  const pool = buildMetagameV12SharedDeckPool(cache, characters, 12);
  const rating = {
    id: "a",
    opportunityWinGain: 0,
    robustOpportunityWinGain: -0.1,
    decisiveWinGain: 0,
    roleBreakdown: {},
    bestDeck: {
      ids: ["b", "c", "d", "e", "a"],
      names: ["B", "C", "D", "E", "A"],
      expectedWinRate: 0.5,
    },
    baselineDeck: {
      ids: ["b", "c", "d", "e", "f"],
      names: ["B", "C", "D", "E", "F"],
      expectedWinRate: 0.5,
    },
  };

  const reconciled = reconcileMetagameV12RatingFromSharedPool(rating, 5, pool, { totalCost: 100 });

  assert.equal(reconciled.sharedPoolApplied, true);
  assert.equal(reconciled.sharedPoolImprovedCandidate, true);
  assert.deepEqual(reconciled.bestDeck.ids, ["f", "g", "h", "i", "a"]);
  assert.deepEqual(reconciled.baselineDeck.ids, ["f", "g", "h", "i", "j"]);
  assert.equal(reconciled.candidateExpectedWinRate, 0.75);
  assert.equal(reconciled.benchmarkExpectedWinRate, 0.5);
  assert.equal(reconciled.opportunityWinGain, 0.25);
  assert.ok(reconciled.robustOpportunityWinGain > 0);
});


test("V12 shared-pool individual score uses full-deck budget reallocation, not frozen teammate replacement", () => {
  const localCharacters = [
    { id: "a", name: "A", cost: 70 },
    { id: "b", name: "B", cost: 5 },
    { id: "c", name: "C", cost: 5 },
    { id: "d", name: "D", cost: 5 },
    { id: "e", name: "E", cost: 5 },
    { id: "j", name: "J", cost: 10 },
    { id: "f", name: "F", cost: 20 },
    { id: "g", name: "G", cost: 20 },
    { id: "h", name: "H", cost: 20 },
    { id: "i", name: "I", cost: 20 },
  ];
  const cache = new Map([
    ["12:a|b|c|d|e", result([0.75, 0.7, 0.75, 0.7])],
    // Same four cheap teammates: A looks indispensable.
    ["12:j|b|c|d|e", result([0.3, 0.3, 0.35, 0.3])],
    // But once A's 70 cost is freed and the whole deck is rebuilt, the team is stronger.
    ["12:f|g|h|i|j", result([0.85, 0.8, 0.85, 0.8])],
  ]);
  const pool = buildMetagameV12SharedDeckPool(cache, localCharacters, 12);
  const rating = {
    id: "a",
    opportunityWinGain: 0,
    robustOpportunityWinGain: 0,
    decisiveWinGain: 0,
    roleBreakdown: {},
    bestDeck: { ids: ["a", "b", "c", "d", "e"], names: ["A", "B", "C", "D", "E"], expectedWinRate: 0.725 },
    baselineDeck: { ids: ["j", "b", "c", "d", "e"], names: ["J", "B", "C", "D", "E"], expectedWinRate: 0.3125 },
  };

  const reconciled = reconcileMetagameV12RatingFromSharedPool(rating, 1, pool, { totalCost: 100 });

  assert.equal(reconciled.counterfactualApplied, true);
  assert.ok(reconciled.counterfactualRobustWinGain > 0.3, "frozen-slot diagnostic should still see A as individually strong");
  assert.ok(reconciled.robustOpportunityWinGain < 0, "full-deck rebuild should expose A's poor budget efficiency");
  assert.ok(reconciled.individualScore < 0.5, "cost-aware individual score must follow full-budget opportunity value");
  assert.ok(reconciled.roleBreakdown.counterfactualContributionScore > 0.5);
  assert.ok(reconciled.roleBreakdown.costAwareOpportunityScore < 0.5);
});
