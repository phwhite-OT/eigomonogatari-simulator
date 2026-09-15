import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  METAGAME_V12_MODEL_VERSION,
  rankMetagameV12Characters,
} from "../src/core/metagame-v12.js";

function completeDeck(expectedWinRate, expectedWinLowerBound, decisiveWinRate = expectedWinRate) {
  return { ids: ["p1", "p2", "p3", "p4", "p5"], expectedWinRate, expectedWinLowerBound, decisiveWinRate };
}

test("V12 keeps practical rank and exposes separate individual contribution rank", () => {
  const ranked = rankMetagameV12Characters([
    { id: "strong-team-small-marginal", cost: 20, opportunityWinGain: 0.03, robustOpportunityWinGain: 0.02, decisiveWinGain: 0.01, bestDeck: completeDeck(0.80, 0.72, 0.76) },
    { id: "weaker-team-large-marginal", cost: 20, opportunityWinGain: 0.20, robustOpportunityWinGain: 0.18, decisiveWinGain: 0.15, bestDeck: completeDeck(0.66, 0.58, 0.61) },
  ]);
  assert.equal(ranked[0].id, "strong-team-small-marginal");
  assert.equal(ranked[0].practicalRank, 1);
  assert.equal(ranked[0].individualRank, 2);
  assert.equal(ranked[1].individualRank, 1);
});

test("V12 individual rank uses matched same-four evidence when available", () => {
  const ranked = rankMetagameV12Characters([
    { id: "matched", cost: 20, opportunityWinGain: -0.2, robustOpportunityWinGain: -0.2, counterfactualApplied: true, counterfactualWinGain: 0.12, counterfactualRobustWinGain: 0.10, counterfactualDecisiveWinGain: 0.08, bestDeck: completeDeck(0.70, 0.62) },
    { id: "fallback", cost: 20, opportunityWinGain: 0.09, robustOpportunityWinGain: 0.08, decisiveWinGain: 0.07, bestDeck: completeDeck(0.72, 0.64) },
  ]);
  const matched = ranked.find((entry) => entry.id === "matched");
  assert.equal(matched.individualRank, 1);
  assert.equal(matched.individualRankingBasis, "matched-replacement-contribution");
});

test("V12.5 resolved attack benefit uses effective HP removed", () => {
  assert.match(METAGAME_V12_MODEL_VERSION, /v12\.5/);
  const source = fs.readFileSync(new URL("../src/core/simulate.js", import.meta.url), "utf8");
  assert.match(source, /hit\.hpBefore - hit\.hpAfter/);
  assert.doesNotMatch(source, /return action\.hits\.reduce\(\(sum, hit\) => sum \+ hit\.damage, 0\);/);
});
