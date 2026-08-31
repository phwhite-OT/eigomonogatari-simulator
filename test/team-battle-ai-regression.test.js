import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import {
  ATTACK_ORDER_POLICIES,
  PLAY_STYLES,
  simulateBattle,
  TARGET_POLICIES,
} from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(id, overrides = {}) {
  return {
    id,
    name: id,
    attributes: overrides.attributes ?? ["fire"],
    cost: 1,
    rarity: "N",
    hp: overrides.hp ?? 1_000,
    pow: overrides.pow ?? 100,
    skillTurn: overrides.skillTurn ?? 99,
    maxUses: overrides.maxUses ?? 2,
    skill: overrides.skill ?? { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
  };
}

function rules(randomMinimum = 1) {
  return mergeRules(DEFAULT_RULES, {
    damage: {
      selfMultiplier: 1,
      excellentMultiplier: 1,
      questionLevelMultiplier: 1,
      randomMinimum,
      pvpMultiplier: 1,
      survivalBaseMultiplier: 1,
      rounding: "floor",
      attributeMultipliers: Object.fromEntries(
        ["fire", "water", "wind"].flatMap((attack) =>
          ["fire", "water", "wind"].map((defense) => [`${attack}:${defense}`, 1]),
        ),
      ),
    },
  });
}

test("expert team attack order spends low firepower first and keeps high firepower for cleanup", () => {
  const state = createBattleState(
    [
      character("low", { pow: 100 }),
      character("high", { pow: 500 }),
    ],
    [
      character("enemy-a", { hp: 80, pow: 0 }),
      character("enemy-b", { hp: 80, pow: 0 }),
    ],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const allyActions = result.history[0].actions.filter((action) => action.side === "allies");
  assert.deepEqual(allyActions.map((action) => action.actorName), ["low", "high"]);
  assert.equal(allyActions[0].hits[0].defeated, true);
  assert.equal(allyActions[1].hits[0].defeated, true);
  assert.notEqual(allyActions[0].hits[0].targetIndex, allyActions[1].hits[0].targetIndex);
});

test("AOE support attacks only through the declared recipient", () => {
  const leaderAoe = {
    type: "aoe_attack",
    multiplier: 1,
    hits: 1,
    target: "leader",
    targetCount: 1,
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("leader", { pow: 100 }),
      character("source", { pow: 100, skillTurn: 0, skill: leaderAoe }),
    ],
    [
      character("enemy-a", { hp: 1_000, pow: 0 }),
      character("enemy-b", { hp: 1_000, pow: 0 }),
    ],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const sourceDecision = selection.events.find((event) => event.actorName === "source");
  const leaderAction = result.history[0].actions.find((action) => action.actorName === "leader");
  const sourceAction = result.history[0].actions.find((action) => action.actorName === "source");

  assert.equal(sourceDecision.type, "skill_use");
  assert.equal(leaderAction.skillType, "aoe_attack");
  assert.equal(leaderAction.hits.length, 2);
  assert.equal(sourceAction.skillType, "single_attack");
  assert.equal(sourceAction.hits.length, 1);
});

test("simulation always uses minimum damage even if a higher damageMultiplier is passed", () => {
  const state = createBattleState(
    [character("attacker", { pow: 100 })],
    [character("target", { hp: 1_000, pow: 0 })],
  );
  const result = simulateBattle(state, rules(0.9), {
    turns: 1,
    damageMultiplier: 1,
  });
  const hit = result.history[0].actions.find((action) => action.side === "allies").hits[0];
  assert.equal(hit.damage, 90);
  assert.equal(hit.factors.random, 0.9);
});


test("expert evaluates all-team damage reduction by resolved defensive outcome", () => {
  const reduction = {
    type: "damage_reduction",
    multiplier: 0.5,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const state = createBattleState(
    [
      character("reducer", { hp: 80, pow: 0, skillTurn: 0, skill: reduction }),
      character("ally-a", { hp: 80, pow: 0 }),
      character("ally-b", { hp: 80, pow: 0 }),
    ],
    [
      character("enemy-a", { hp: 10_000, pow: 100 }),
      character("enemy-b", { hp: 10_000, pow: 100 }),
      character("enemy-c", { hp: 10_000, pow: 100 }),
    ],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const decision = selection.events.find((event) => event.actorName === "reducer");

  assert.equal(decision.type, "skill_use");
  assert.match(decision.reason, /残りキャラ|残HP|次ターン盤面/);
});

test("expert evaluates attribute guard by the same resolved defensive outcome", () => {
  const colorGuard = {
    type: "attribute_guard",
    multiplier: 1,
    duration: 1,
    target: "self",
    conditions: [{ type: "enemy_attribute", attribute: "fire" }],
  };
  const state = createBattleState(
    [
      character("color-guard", { hp: 500, pow: 0, skillTurn: 0, skill: colorGuard }),
      character("ally-a", { hp: 80, pow: 0 }),
      character("ally-b", { hp: 80, pow: 0 }),
      character("ally-c", { hp: 80, pow: 0 }),
      character("ally-d", { hp: 80, pow: 0 }),
    ],
    [
      character("enemy-a", { attributes: ["fire"], hp: 10_000, pow: 100 }),
      character("enemy-b", { attributes: ["fire"], hp: 10_000, pow: 100 }),
      character("enemy-c", { attributes: ["fire"], hp: 10_000, pow: 100 }),
      character("enemy-d", { attributes: ["fire"], hp: 10_000, pow: 100 }),
      character("enemy-e", { attributes: ["fire"], hp: 10_000, pow: 100 }),
    ],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const decision = selection.events.find((event) => event.actorName === "color-guard");

  assert.equal(decision.type, "skill_use");
});

test("expert treats leader-target guard (dodge) as the same defense family", () => {
  const dodge = {
    type: "guard",
    multiplier: 0.5,
    duration: 1,
    target: "leader",
    conditions: [],
  };
  const state = createBattleState(
    [
      character("leader", { hp: 500, pow: 0 }),
      character("dodger", { hp: 80, pow: 0, skillTurn: 0, skill: dodge }),
      character("ally-a", { hp: 80, pow: 0 }),
    ],
    [
      character("enemy-a", { hp: 10_000, pow: 100 }),
      character("enemy-b", { hp: 10_000, pow: 100 }),
      character("enemy-c", { hp: 10_000, pow: 100 }),
    ],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const decision = selection.events.find((event) => event.actorName === "dodger");

  assert.equal(decision.type, "skill_use");
});

test("expert holds a one-turn defense when resolved attacks gain nothing", () => {
  const reduction = {
    type: "damage_reduction",
    multiplier: 0.5,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const state = createBattleState(
    [character("reducer", { hp: 1_000, pow: 0, skillTurn: 0, skill: reduction })],
    [character("enemy", { hp: 10_000, pow: 0 })],
  );
  const result = simulateBattle(state, rules(), {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  });
  const selection = result.history[0].phases.find((phase) => phase.id === "skill_selection");
  const decision = selection.events.find((event) => event.actorName === "reducer");

  assert.equal(decision.type, "skill_hold");
});
