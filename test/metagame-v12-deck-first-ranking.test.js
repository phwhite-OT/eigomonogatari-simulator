import test from "node:test";
import assert from "node:assert/strict";

import { rankMetagameV12Characters } from "../src/core/metagame-v12.js";

function rating(id, cost, options = {}) {
  return {
    id,
    name: id,
    cost,
    opportunityWinGain: options.opportunityWinGain ?? 0,
    robustOpportunityWinGain: options.robustOpportunityWinGain ?? 0,
    decisiveWinGain: options.decisiveWinGain ?? 0,
    bestDeck: options.bestDeck ?? null,
  };
}

function completeDeck(expectedWinRate, expectedWinLowerBound, decisiveWinRate = expectedWinRate) {
  return {
    ids: ["p1", "p2", "p3", "p4", "p5"],
    names: ["p1", "p2", "p3", "p4", "p5"],
    expectedWinRate,
    expectedWinLowerBound,
    decisiveWinRate,
    totalCost: 100,
    remainingCost: 0,
  };
}

test("V12 slot ranking is derived from the strength of legal complete decks, not standalone opportunity gain", () => {
  const ranked = rankMetagameV12Characters([
    rating("expensive-standalone", 75, {
      opportunityWinGain: 0.20,
      robustOpportunityWinGain: 0.18,
      decisiveWinGain: 0.15,
      bestDeck: completeDeck(0.58, 0.49, 0.52),
    }),
    rating("efficient-team-piece", 20, {
      opportunityWinGain: 0.03,
      robustOpportunityWinGain: 0.02,
      decisiveWinGain: 0.01,
      bestDeck: completeDeck(0.76, 0.68, 0.71),
    }),
  ]);

  assert.deepEqual(ranked.map((entry) => entry.id), ["efficient-team-piece", "expensive-standalone"]);
  assert.equal(ranked[0].rankingBasis, "complete-deck-performance");
});

test("V12 deck-first ranking does not blindly punish cost when an expensive card really forms the stronger full team", () => {
  const ranked = rankMetagameV12Characters([
    rating("expensive-but-worth-it", 75, {
      opportunityWinGain: 0.01,
      robustOpportunityWinGain: 0.01,
      bestDeck: completeDeck(0.82, 0.73, 0.78),
    }),
    rating("cheap-but-weaker-team", 20, {
      opportunityWinGain: 0.15,
      robustOpportunityWinGain: 0.14,
      bestDeck: completeDeck(0.70, 0.62, 0.66),
    }),
  ]);

  assert.deepEqual(ranked.map((entry) => entry.id), ["expensive-but-worth-it", "cheap-but-weaker-team"]);
});

test("V12 ranking falls back to opportunity evidence for legacy rows without a complete deck", () => {
  const ranked = rankMetagameV12Characters([
    rating("weak", 10, { opportunityWinGain: -0.1, robustOpportunityWinGain: -0.1 }),
    rating("strong", 10, { opportunityWinGain: 0.1, robustOpportunityWinGain: 0.1 }),
  ]);

  assert.deepEqual(ranked.map((entry) => entry.id), ["strong", "weak"]);
  assert.equal(ranked[0].rankingBasis, "opportunity-fallback");
});
