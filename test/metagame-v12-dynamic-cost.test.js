import test from "node:test";
import assert from "node:assert/strict";
import { buildMetagameDeckCandidates } from "../src/core/metagame-deck.js";

function character(id, cost, position) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity: "R",
    cost,
    hp: 1000,
    pow: 1000,
    skillTurn: Math.max(0, position - 1),
    maxUses: 0,
    roleTags: [],
    skillName: "",
    skill: { type: "none", multiplier: 1, hits: 1, amount: 0, target: "self", targetCount: 1, duration: 1, conditions: [], effects: [] },
  };
}

function rating(entry, costAwareScore) {
  return {
    id: entry.id,
    name: entry.name,
    attributes: entry.attributes,
    rarity: entry.rarity,
    cost: entry.cost,
    skillTurn: entry.skillTurn,
    skillType: "none",
    role: "neutral",
    costAwareScore,
    practicalValue: 1,
    individualScore: 0.5,
    roleFit: 0.5,
    marginalWinGainLowerBound: 0.02,
    marginalWinGain: 0.03,
    expectedWinRate: 0.6,
    expectedWinLowerBound: 0.5,
    balancedContribution: 0.5,
    roleBreakdown: {},
  };
}

function makeFixture(totalCost) {
  const expensive = character("expensive", 75, 1);
  const efficient = character("efficient", 20, 1);
  const fillers = [2, 3, 4, 5].map((position) => character(`filler-${position}`, 5, position));
  return {
    constraint: {
      id: `fire:${totalCost}`,
      allowedAttributes: ["fire"],
      totalCost,
      slots: [
        { position: 1, candidates: [rating(expensive, 0.75), rating(efficient, 0.50)] },
        ...fillers.map((entry, index) => ({ position: index + 2, candidates: [rating(entry, 0.45)] })),
      ],
    },
    characters: [expensive, efficient, ...fillers],
  };
}

test("V12 published scores are repriced against the current deck budget", () => {
  const lowBudget = makeFixture(100);
  const lowDecks = buildMetagameDeckCandidates(lowBudget.constraint, lowBudget.characters, { beamWidth: 500 });
  assert.equal(lowDecks[0].deck[0].id, "efficient", "75-cost card must not dominate a 100-cost deck on stale published score alone");

  const middleBudget = makeFixture(146);
  const middleDecks = buildMetagameDeckCandidates(middleBudget.constraint, middleBudget.characters, { beamWidth: 500 });
  assert.ok(middleDecks.every((deck) => deck.totalCost <= 146), "arbitrary cost caps must remain exact legal search constraints");

  const highBudget = makeFixture(300);
  const highDecks = buildMetagameDeckCandidates(highBudget.constraint, highBudget.characters, { beamWidth: 500 });
  assert.equal(highDecks[0].deck[0].id, "expensive", "the same card may become worthwhile when the current budget can actually support it");
});
