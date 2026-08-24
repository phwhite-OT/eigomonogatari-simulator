import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import { canUseSkill } from "../src/core/skills.js";
import { evaluateMetagameV12SkillThresholdProxy } from "../src/core/metagame-v7.js";
import { DEFAULT_RULES } from "../src/data/rules.js";
import {
  METAGAME_V12_MODEL_VERSION,
  buildMetagameV12AlternativeDecks,
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
  assert.equal(METAGAME_V12_MODEL_VERSION, "team-battle-v12.2-threshold-proxy");
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
