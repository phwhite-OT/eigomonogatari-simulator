import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import { canUseSkill } from "../src/core/skills.js";
import { evaluateMetagameV12SkillThresholdProxy } from "../src/core/metagame-v7.js";
import { DEFAULT_RULES } from "../src/data/rules.js";
import {
  METAGAME_V12_MODEL_VERSION,
  buildMetagameV12AlternativeDecks,
  buildMetagameV12GlobalBaselineDecks,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
  rankMetagameV12Characters,
} from "../src/core/metagame-v12.js";

function character(id, position, options = {}) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity: options.rarity ?? "CR",
    cost: options.cost ?? 20,
    hp: options.hp ?? 1000,
    pow: options.pow ?? 1000,
    skillTurn: options.skillTurn ?? Math.max(0, position - 1),
    maxUses: options.maxUses ?? 0,
    allowedPositions: [position],
    skill: options.skill ?? { type: "none", multiplier: 1, duration: 1, target: "self", conditions: [] },
  };
}

function rating(entry, score = 0.5) {
  return {
    id: String(entry.id),
    name: entry.name,
    cost: entry.cost,
    skillTurn: entry.skillTurn,
    costAwareScore: score,
    practicalValue: score,
    roleFit: score,
    role: "neutral",
  };
}

test("V12 model version is separate from V11 checkpoints", () => {
  assert.equal(METAGAME_V12_MODEL_VERSION, "team-battle-v12.5-effective-damage-individual-rank");
});

test("V12 team scenarios do not suppress repeated popular characters across players", () => {
  const shared = character("shared", 1);
  const decks = Array.from({ length: 9 }, (_, team) => [
    shared,
    character(`p2-${team}`, 2),
    character(`p3-${team}`, 3),
    character(`p4-${team}`, 4),
    character(`p5-${team}`, 5),
  ]);
  const scenarios = createMetagameV12TeamScenarios({}, { environmentDecks: decks, count: 1 });
  const field = [...scenarios[0].allyDecks, ...scenarios[0].enemyDecks];
  assert.equal(field.flat().filter((entry) => entry.id === "shared").length, 9);
});

test("V12 environment builder recognizes Japanese legend rarity and keeps at most one per deck", () => {
  const pools = [1, 2, 3, 4, 5].map((position) => [
    character(`normal-${position}`, position, { cost: 10 }),
    character(`legend-${position}`, position, { cost: 10, rarity: "伝" }),
  ]);
  const resolvedInput = {
    totalCost: 100,
    environmentPools: pools,
    examplePatterns: [],
  };
  const decks = createMetagameV12EnvironmentDecks(resolvedInput, { count: 10, environmentVariants: 2 });
  assert.ok(decks.length >= 9);
  assert.ok(decks.every((deck) => deck.filter((entry) => entry.rarity === "伝").length <= 1));
  for (let position = 0; position < 5; position += 1) {
    assert.ok(decks.some((deck) => deck[position].id === `legend-${position + 1}`));
  }
});

test("V12 alternative decks exclude the candidate and can re-optimize every slot", () => {
  const target = character("target", 1, { cost: 60 });
  const replacements = [
    character("alt-1", 1, { cost: 20 }),
    character("cheap-2", 2, { cost: 10 }), character("upgrade-2", 2, { cost: 20 }),
    character("cheap-3", 3, { cost: 10 }), character("upgrade-3", 3, { cost: 20 }),
    character("cheap-4", 4, { cost: 10 }), character("upgrade-4", 4, { cost: 20 }),
    character("cheap-5", 5, { cost: 10 }), character("upgrade-5", 5, { cost: 20 }),
  ];
  const all = [target, ...replacements];
  const ratingsByPosition = [1, 2, 3, 4, 5].map((position) => new Map(
    all.filter((entry) => entry.allowedPositions.includes(position)).map((entry) => [
      entry.id,
      rating(entry, entry.id.startsWith("upgrade") ? 0.9 : entry.id === "alt-1" ? 0.8 : 0.2),
    ]),
  ));
  const candidatePools = {
    ratingsByPosition,
    partnerRatingsByPosition: ratingsByPosition.map((entries) => [...entries.values()]),
    charactersById: new Map(all.map((entry) => [entry.id, entry])),
  };
  const decks = buildMetagameV12AlternativeDecks(target, {
    totalCost: 100,
    allowedAttributes: ["fire"],
  }, candidatePools, { alternativeDeckLimit: 2, beamWidth: 500 });
  assert.ok(decks.length >= 1);
  assert.ok(decks.every((entry) => entry.deck.every((card) => card.id !== target.id)));
  assert.ok(decks.every((entry) => entry.totalCost <= 100));
  assert.ok(decks[0].deck.some((card) => card.id.startsWith("upgrade-")));
});

test("V12.4 global opportunity baseline searches outside the sampled partner pool", () => {
  const sampled = character("sampled-1", 1, { cost: 40 });
  const outside = character("outside-sample", 1, { cost: 10 });
  const fixed = [2, 3, 4, 5].map((position) => character(`fixed-${position}`, position, { cost: 10 }));
  const all = [sampled, outside, ...fixed];
  const ratingsByPosition = [1, 2, 3, 4, 5].map((position) => new Map(
    all.filter((entry) => entry.allowedPositions.includes(position)).map((entry) => [
      entry.id,
      rating(entry, entry.id === "outside-sample" ? 0.98 : entry.id === "sampled-1" ? 0.1 : 0.7),
    ]),
  ));
  const candidatePools = {
    ratingsByPosition,
    partnerRatingsByPosition: ratingsByPosition.map((entries, index) => (
      index === 0 ? [entries.get("sampled-1")] : [...entries.values()]
    )),
    charactersById: new Map(all.map((entry) => [entry.id, entry])),
  };
  const decks = buildMetagameV12GlobalBaselineDecks({
    totalCost: 100,
    allowedAttributes: ["fire"],
  }, candidatePools, { baselineDeckLimit: 8, baselineBeamWidth: 500 });

  assert.ok(decks.length >= 1);
  assert.ok(decks.some((entry) => entry.deck[0].id === "outside-sample"));
});

test("V12 ranking keeps harmful team contribution below neutral instead of clipping it", () => {
  const ranked = rankMetagameV12Characters([
    { id: "harmful", opportunityWinGain: -0.1, robustOpportunityWinGain: -0.1, decisiveWinGain: -0.1, cost: 10 },
    { id: "neutral", opportunityWinGain: 0, robustOpportunityWinGain: 0, decisiveWinGain: 0, cost: 10 },
    { id: "helpful", opportunityWinGain: 0.1, robustOpportunityWinGain: 0.1, decisiveWinGain: 0.1, cost: 10 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.id), ["helpful", "neutral", "harmful"]);
});

test("V12.1 ranking prefers paired-stable evidence when raw means are close", () => {
  const ranked = rankMetagameV12Characters([
    { id: "risky", opportunityWinGain: 0.11, robustOpportunityWinGain: 0.01, decisiveWinGain: 0, cost: 10 },
    { id: "stable", opportunityWinGain: 0.10, robustOpportunityWinGain: 0.08, decisiveWinGain: 0, cost: 10 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.id), ["stable", "risky"]);
});

test("V12 hybrid preserves full-budget evidence when matched-slot data is unavailable", () => {
  const ranked = rankMetagameV12Characters([
    { id: "helpful-unmatched", opportunityWinGain: 0.08, robustOpportunityWinGain: 0.06, decisiveWinGain: 0.03, cost: 25 },
    { id: "neutral-unmatched", opportunityWinGain: 0, robustOpportunityWinGain: 0, decisiveWinGain: 0, cost: 25 },
  ]);

  const helpful = ranked.find((entry) => entry.id === "helpful-unmatched");
  assert.equal(helpful.individualRank, 1);
  assert.equal(helpful.matchedSlotEvidenceCorrection, 0);
  assert.equal(helpful.matchedSlotCorrectionCap, 0);
  assert.equal(helpful.rankingContributionRobust, 0.06);
  assert.equal(helpful.rankingContributionMean, 0.08);
});

test("V12 matched-slot evidence resolves uncertainty without using cost as a weight", () => {
  const ranked = rankMetagameV12Characters([
    {
      id: "passenger",
      cost: 17,
      opportunityWinGain: 0,
      robustOpportunityWinGain: -0.0335,
      decisiveWinGain: 0,
      counterfactualApplied: true,
      counterfactualWinGain: 0,
      counterfactualRobustWinGain: -0.0335,
      roleBreakdown: { budgetShare: 0.17 },
      bestDeck: { ids: ["a", "b", "c", "passenger", "e"], expectedWinRate: 0.8819, expectedWinLowerBound: 0.82, decisiveWinRate: 0.79 },
    },
    {
      id: "real-slot-contributor",
      cost: 26,
      opportunityWinGain: 0,
      robustOpportunityWinGain: -0.049,
      decisiveWinGain: 0,
      counterfactualApplied: true,
      counterfactualWinGain: 0.0417,
      counterfactualRobustWinGain: 0.0088,
      roleBreakdown: { budgetShare: 0.26 },
      bestDeck: { ids: ["a", "b", "c", "real-slot-contributor", "e"], expectedWinRate: 0.8819, expectedWinLowerBound: 0.82, decisiveWinRate: 0.79 },
    },
    {
      id: "expensive-slot-star",
      cost: 75,
      opportunityWinGain: 0,
      robustOpportunityWinGain: -0.06,
      decisiveWinGain: 0,
      counterfactualApplied: true,
      counterfactualWinGain: 0.25,
      counterfactualRobustWinGain: 0.20,
      roleBreakdown: { budgetShare: 0.75 },
      bestDeck: { ids: ["a", "b", "c", "expensive-slot-star", "e"], expectedWinRate: 0.8819, expectedWinLowerBound: 0.82, decisiveWinRate: 0.79 },
    },
  ]);

  assert.deepEqual(
    ranked.slice().sort((a, b) => a.individualRank - b.individualRank).map((entry) => entry.id),
    ["real-slot-contributor", "expensive-slot-star", "passenger"],
  );
  const contributor = ranked.find((entry) => entry.id === "real-slot-contributor");
  assert.equal(contributor.individualRank, 1);
  assert.equal(contributor.matchedSlotEvidenceCorrection, 0.049);
  assert.equal(contributor.matchedSlotCorrectionCap, 0.049);
  assert.equal(
    contributor.individualRankingBasis,
    "full-deck-budget-reallocation-with-uncertainty-bounded-slot-evidence",
  );
});

test("V12 matched-slot correction is identical for equal battle evidence regardless of cost share", () => {
  const ranked = rankMetagameV12Characters([
    {
      id: "cheap",
      cost: 15,
      opportunityWinGain: 0,
      robustOpportunityWinGain: -0.04,
      counterfactualApplied: true,
      counterfactualWinGain: 0.03,
      counterfactualRobustWinGain: 0.02,
      roleBreakdown: { budgetShare: 0.15 },
    },
    {
      id: "expensive",
      cost: 75,
      opportunityWinGain: 0,
      robustOpportunityWinGain: -0.04,
      counterfactualApplied: true,
      counterfactualWinGain: 0.03,
      counterfactualRobustWinGain: 0.02,
      roleBreakdown: { budgetShare: 0.75 },
    },
  ]);

  const cheap = ranked.find((entry) => entry.id === "cheap");
  const expensive = ranked.find((entry) => entry.id === "expensive");
  assert.equal(cheap.rankingContributionRobust, expensive.rankingContributionRobust);
  assert.equal(cheap.matchedSlotEvidenceCorrection, expensive.matchedSlotEvidenceCorrection);
  assert.equal(cheap.matchedSlotEvidenceCorrection, 0.04);
});

test("V12 individual value penalizes a costly card when freed budget can improve all five slots", () => {
  const ranked = rankMetagameV12Characters([
    {
      id: "expensive-slot-star",
      cost: 75,
      opportunityWinGain: -0.06,
      robustOpportunityWinGain: -0.08,
      decisiveWinGain: -0.04,
      counterfactualApplied: true,
      counterfactualWinGain: 0.28,
      counterfactualRobustWinGain: 0.24,
      counterfactualDecisiveWinGain: 0.2,
      bestDeck: { ids: ["expensive-slot-star", "c2", "c3", "c4", "c5"], expectedWinRate: 0.72, expectedWinLowerBound: 0.66 },
    },
    {
      id: "efficient",
      cost: 20,
      opportunityWinGain: 0.07,
      robustOpportunityWinGain: 0.05,
      decisiveWinGain: 0.03,
      counterfactualApplied: true,
      counterfactualWinGain: 0.04,
      counterfactualRobustWinGain: 0.03,
      counterfactualDecisiveWinGain: 0.02,
      bestDeck: { ids: ["efficient", "u2", "u3", "u4", "u5"], expectedWinRate: 0.69, expectedWinLowerBound: 0.64 },
    },
  ]);

  assert.equal(ranked[0].id, "efficient");
  assert.equal(ranked.find((entry) => entry.id === "efficient").individualRank, 1);
  assert.equal(ranked.find((entry) => entry.id === "expensive-slot-star").individualRank, 2);
  assert.equal(
    ranked.find((entry) => entry.id === "expensive-slot-star").individualRankingBasis,
    "full-deck-budget-reallocation-with-uncertainty-bounded-slot-evidence",
  );
});

test("V12.1 caps skill usage at two even if card data says three", () => {
  const reusable = character("reusable", 1, {
    skillTurn: 0,
    maxUses: 3,
    skill: { type: "attack_buff", multiplier: 2, duration: 1, target: "self", conditions: [] },
  });
  const enemy = character("enemy", 1);
  const state = createBattleState([[reusable]], [[enemy]]);
  state.allies[0].skillUses = 1;
  assert.equal(canUseSkill(state, "allies", 0), true);
  state.allies[0].skillUses = 2;
  assert.equal(canUseSkill(state, "allies", 0), false);
});


function thresholdRules() {
  const rules = structuredClone(DEFAULT_RULES);
  Object.assign(rules.damage, {
    selfMultiplier: 1,
    excellentMultiplier: 1,
    questionLevelMultiplier: 1,
    eventBonusMultiplier: 1,
    specialAttackMultiplier: 1,
    randomMinimum: 1,
    pvpMultiplier: 1,
    survivalBaseMultiplier: 1,
    attributeMultipliers: Object.fromEntries(Object.keys(rules.damage.attributeMultipliers).map((key) => [key, 1])),
  });
  return rules;
}

test("V12.2 team attack buff values added team elimination reach over the same self buff", () => {
  const rules = thresholdRules();
  const enemies = [character("enemy-a", 1, { hp: 150, pow: 80 })];
  const allies = [1, 2, 3, 4, 5].map((position) => character(`ally-${position}`, position, { hp: 500, pow: 100 }));
  const selfBuff = character("self-buff", 1, { hp: 500, pow: 100, skill: { type: "attack_buff", multiplier: 2, duration: 1, target: "self", conditions: [] } });
  const teamBuff = { ...selfBuff, id: "team-buff", skill: { ...selfBuff.skill, target: "ally_all" } };
  const selfValue = evaluateMetagameV12SkillThresholdProxy(selfBuff, enemies, allies, rules);
  const teamValue = evaluateMetagameV12SkillThresholdProxy(teamBuff, enemies, allies, rules);
  assert.ok(teamValue.guaranteedEliminationGain > selfValue.guaranteedEliminationGain);
  assert.ok(teamValue.attackImpact > selfValue.attackImpact);
});

test("V12.2 self super-buff can beat a weak team buff by breaking a frequent wall", () => {
  const rules = thresholdRules();
  const wallSkill = { type: "guard", multiplier: 0.2, duration: 1, target: "self", conditions: [] };
  const wall = character("wall", 1, { hp: 350, pow: 80, skill: wallSkill });
  const enemies = [wall, { ...wall }, { ...wall }, character("ordinary", 1, { hp: 80, pow: 80 })];
  const allies = [1, 2, 3, 4, 5].map((position) => character(`ally-wall-${position}`, position, { hp: 500, pow: 100 }));
  const breaker = character("breaker", 1, { hp: 500, pow: 100, skill: { type: "attack_buff", multiplier: 4, duration: 1, target: "self", conditions: [] } });
  const weakTeam = character("weak-team", 1, { hp: 500, pow: 100, skill: { type: "attack_buff", multiplier: 1.2, duration: 1, target: "ally_all", conditions: [] } });
  const breakerValue = evaluateMetagameV12SkillThresholdProxy(breaker, enemies, allies, rules);
  const weakTeamValue = evaluateMetagameV12SkillThresholdProxy(weakTeam, enemies, allies, rules);
  assert.ok(breakerValue.wallBreakerImpact > 0);
  assert.ok(breakerValue.attackImpact > weakTeamValue.attackImpact);
});

test("V12.2 team defense values prevented allied deaths over equal self-only reduction", () => {
  const rules = thresholdRules();
  const enemies = [character("pressure", 1, { hp: 500, pow: 150 })];
  const allies = [1, 2, 3, 4, 5].map((position) => character(`fragile-${position}`, position, { hp: 100, pow: 50 }));
  const selfDefense = character("self-defense", 1, { hp: 100, pow: 50, skill: { type: "damage_reduction", multiplier: 0.5, duration: 1, target: "self", conditions: [] } });
  const teamDefense = { ...selfDefense, id: "team-defense", skill: { ...selfDefense.skill, target: "ally_all" } };
  const selfValue = evaluateMetagameV12SkillThresholdProxy(selfDefense, enemies, allies, rules);
  const teamValue = evaluateMetagameV12SkillThresholdProxy(teamDefense, enemies, allies, rules);
  assert.ok(teamValue.preventedDeathGain > selfValue.preventedDeathGain);
  assert.ok(teamValue.defenseImpact > selfValue.defenseImpact);
});
