import test from "node:test";
import assert from "node:assert/strict";

import { calculateMinimumDamage } from "../src/core/damage.js";
import { createBattleState } from "../src/core/battleState.js";
import { canUseSkill } from "../src/core/skills.js";
import { simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function rules() {
  return {
    ...structuredClone(DEFAULT_RULES),
    damage: {
      ...structuredClone(DEFAULT_RULES.damage),
      selfMultiplier: 1, excellentMultiplier: 1, questionLevelMultiplier: 1,
      eventBonusMultiplier: 1, specialAttackMultiplier: 1, randomMinimum: 0.9,
      pvpMultiplier: 1, survivalBaseMultiplier: 1, rounding: "floor",
    },
  };
}

function card(id, { hp = 100, pow = 60, skill = null, skillTurn = 99, maxUses = 0 } = {}) {
  return {
    id, name: id, attributes: [], hp, pow, skillTurn, maxUses, allowedPositions: [1,2,3,4,5],
    roleTags: [],
    skill: skill ?? { type: "none", multiplier: 1, hits: 1, duration: 1, target: "self", conditions: [], effects: [] },
  };
}

test("minimum damage remains default while sampled actual damage can be higher", () => {
  const r = rules();
  const attacker = card("a", { pow: 100 });
  const defender = card("d", { hp: 1000 });
  assert.equal(calculateMinimumDamage({ attacker, defender, rules: r }).value, 90);
  assert.equal(calculateMinimumDamage({ attacker, defender, randomMultiplier: 1, rules: r }).value, 100);
});

test("maxUses above two is respected", () => {
  const reusable = card("reusable", {
    skillTurn: 0, maxUses: 3,
    skill: { type: "attack_buff", multiplier: 2, hits: 1, duration: 1, target: "self", conditions: [], effects: [] },
  });
  const state = createBattleState([[reusable]], [[card("enemy")]]);
  state.allies[0].skillUses = 2;
  assert.equal(canUseSkill(state, "allies", 0), true);
});

test("revive reacts to cumulative guaranteed damage from multiple attackers", () => {
  const r = rules();
  const target = card("target", { hp: 100, pow: 1 });
  const reviver = card("reviver", {
    hp: 1000, pow: 1, skillTurn: 0, maxUses: 1,
    skill: { type: "revive", multiplier: 1, hits: 1, duration: 1, target: "ally_all", conditions: [], effects: [] },
  });
  const result = simulateBattle(
    createBattleState([[target], [reviver]], [[card("enemy-a")], [card("enemy-b")]]),
    r,
    { turns: 1 },
  );
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const event = selection.events.find((entry) => entry.actorName === "reviver");
  assert.equal(event?.type, "skill_use");
});
