import test from "node:test";
import assert from "node:assert/strict";

import { rankMetagameV12Characters } from "../src/core/metagame-v12.js";
import {
  buildMetagameV12SharedDeckPool,
  reconcileMetagameV12RatingFromSharedPool,
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

const characters = "abcdefxyz".split("").map((id, index) => ({
  id,
  name: id.toUpperCase(),
  cost: index + 1,
}));

test("V12 counterfactual compares the same four teammates and only swaps the rated slot", () => {
  const cache = new Map([
    ["12:a|b|c|d|e", result([1, 1, 0.5, 1])],
    // Exact slot-1 replacement: b/c/d/e are unchanged.
    ["12:x|b|c|d|e", result([1, 1, 0.5, 1])],
    // Stronger overall deck, but the other four slots differ. It is valid for
    // global opportunity cost, never for the matched one-slot contribution.
    ["12:y|f|c|d|e", result([1, 1, 1, 1])],
  ]);
  const pool = buildMetagameV12SharedDeckPool(cache, characters, 12);
  const rating = {
    id: "a",
    name: "A",
    cost: 1,
    roleBreakdown: {},
    bestDeck: { ids: ["a", "b", "c", "d", "e"], names: ["A", "B", "C", "D", "E"], expectedWinRate: 0.875 },
    baselineDeck: { ids: ["y", "f", "c", "d", "e"], names: ["Y", "F", "C", "D", "E"], expectedWinRate: 1 },
  };

  const reconciled = reconcileMetagameV12RatingFromSharedPool(rating, 1, pool, { totalCost: 100 });

  assert.equal(reconciled.counterfactualApplied, true);
  assert.deepEqual(reconciled.counterfactualReplacementDeck.ids, ["x", "b", "c", "d", "e"]);
  assert.equal(reconciled.counterfactualWinGain, 0);
  assert.equal(reconciled.marginalWinGain, 0);
  assert.equal(reconciled.counterfactualBenchmarkExpectedWinRate, 0.875);
  // Global opportunity cost is intentionally still preserved as a separate diagnostic.
  assert.equal(reconciled.opportunityWinGain, -0.125);
});

test("V12 ranking drops a carried character below a proven contributor even when the carried deck wins more", () => {
  const ranked = rankMetagameV12Characters([
    {
      id: "carried",
      name: "carried",
      cost: 10,
      counterfactualApplied: true,
      counterfactualWinGain: -0.01,
      counterfactualRobustWinGain: -0.03,
      robustOpportunityWinGain: 0.2,
      opportunityWinGain: 0.2,
      bestDeck: {
        ids: ["carried", "b", "c", "d", "e"],
        expectedWinRate: 0.9,
        expectedWinLowerBound: 0.84,
        decisiveWinRate: 0.85,
      },
    },
    {
      id: "contributor",
      name: "contributor",
      cost: 30,
      counterfactualApplied: true,
      counterfactualWinGain: 0.06,
      counterfactualRobustWinGain: 0.025,
      robustOpportunityWinGain: 0.01,
      opportunityWinGain: 0.02,
      bestDeck: {
        ids: ["contributor", "b", "c", "d", "e"],
        expectedWinRate: 0.76,
        expectedWinLowerBound: 0.68,
        decisiveWinRate: 0.7,
      },
    },
  ]);

  assert.deepEqual(ranked.map((entry) => entry.id), ["contributor", "carried"]);
  assert.equal(ranked[0].rankingBasis, "matched-replacement-contribution");
  assert.equal(ranked[0].positiveContributionEvidence, true);
  assert.equal(ranked[1].positiveContributionEvidence, false);
});

test("among characters with positive matched contribution, stronger complete teams still matter", () => {
  const ranked = rankMetagameV12Characters([
    {
      id: "small-gain-strong-team",
      name: "small-gain-strong-team",
      cost: 70,
      counterfactualApplied: true,
      counterfactualWinGain: 0.03,
      counterfactualRobustWinGain: 0.01,
      bestDeck: {
        ids: ["small-gain-strong-team", "b", "c", "d", "e"],
        expectedWinRate: 0.84,
        expectedWinLowerBound: 0.76,
        decisiveWinRate: 0.8,
      },
    },
    {
      id: "large-gain-weaker-team",
      name: "large-gain-weaker-team",
      cost: 20,
      counterfactualApplied: true,
      counterfactualWinGain: 0.09,
      counterfactualRobustWinGain: 0.05,
      bestDeck: {
        ids: ["large-gain-weaker-team", "b", "c", "d", "e"],
        expectedWinRate: 0.72,
        expectedWinLowerBound: 0.64,
        decisiveWinRate: 0.68,
      },
    },
  ]);

  assert.deepEqual(ranked.map((entry) => entry.id), ["small-gain-strong-team", "large-gain-weaker-team"]);
});
