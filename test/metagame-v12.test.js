import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import { canUseSkill } from "../src/core/skills.js";
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
  assert.equal(METAGAME_V12_MODEL_VERSION, "team-battle-v12.1-opportunity-value");
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
