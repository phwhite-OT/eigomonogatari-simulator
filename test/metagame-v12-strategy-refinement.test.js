import test from "node:test";
import assert from "node:assert/strict";
import { createBattleState } from "../src/core/battleState.js";
import { simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(id, overrides = {}) {
  return {
    id,
    name: id,
    attributes: overrides.attributes ?? ["fire"],
    cost: overrides.cost ?? 1,
    hp: overrides.hp ?? 1000,
    pow: overrides.pow ?? 100,
    skillTurn: overrides.skillTurn ?? 99,
    maxUses: overrides.maxUses ?? 2,
    allowedPositions: [1, 2, 3, 4, 5],
    skill: overrides.skill ?? { type: "none", multiplier: 1, duration: 1, hits: 1, target: "self", conditions: [] },
    roleTags: [],
  };
}

const simpleRules = mergeRules(DEFAULT_RULES, {
  damage: {
    selfMultiplier: 1,
    excellentMultiplier: 1,
    questionLevelMultiplier: 1,
    randomMinimum: 1,
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

test("通常攻撃で既に倒せる相手への単体スキルはオーバーキルだけなら温存する", () => {
  const skill = { type: "single_attack", multiplier: 3, duration: 1, hits: 1, target: "self", conditions: [] };
  const state = createBattleState(
    [character("attacker", { pow: 100, skillTurn: 0, skill })],
    [character("target", { hp: 50, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const event = result.history[0].phases[0].events.find(({ actorName }) => actorName === "attacker");

  assert.equal(event.type, "skill_hold");
  assert.match(event.reason, /撃破|有効削り/);
  assert.equal(result.state.allies[0].skillUses, 0);
});

test("通常攻撃では倒せず単体スキルなら倒せる場合は使用する", () => {
  const skill = { type: "single_attack", multiplier: 3, duration: 1, hits: 1, target: "self", conditions: [] };
  const state = createBattleState(
    [character("attacker", { pow: 100, skillTurn: 0, skill })],
    [character("target", { hp: 250, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const event = result.history[0].phases[0].events.find(({ actorName }) => actorName === "attacker");

  assert.equal(event.type, "skill_use");
  assert.equal(result.state.allies[0].skillUses, 1);
});

test("かばう突破が必要なら低火力固定ではなく倒せる高火力を先行させる", () => {
  const state = createBattleState(
    [
      character("low", { pow: 100 }),
      character("high", { pow: 400 }),
    ],
    [
      character("guard", { hp: 300, pow: 0 }),
      character("other", { hp: 1000, pow: 0 }),
    ],
  );
  state.enemies[0].buffs.push({
    type: "guard",
    multiplier: 1,
    remainingTurns: 1,
    duration: 1,
    sourceCharacterId: "guard",
    conditions: [],
    activationOrder: 1,
  });

  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const allyActions = result.history[0].actions.filter(({ side }) => side === "allies");

  assert.equal(allyActions[0].actorName, "high");
  assert.equal(allyActions[0].hits[0].targetName, "guard");
  assert.equal(allyActions[0].hits[0].defeated, true);
  assert.equal(allyActions[1].actorName, "low");
});

test("蘇生判断は敵の同ターン攻撃バフまで反映して死亡を予測する", () => {
  const revive = { type: "revive", multiplier: 0.5, duration: 1, hits: 1, target: "leader", conditions: [] };
  const attackBuff = { type: "attack_buff", multiplier: 2, duration: 1, hits: 1, target: "ally_all", conditions: [] };
  const state = createBattleState(
    [
      character("leader", { hp: 500, pow: 0 }),
      character("reviver", { hp: 1000, pow: 0, skillTurn: 0, skill: revive }),
    ],
    [
      character("buffer", { hp: 1000, pow: 0, skillTurn: 0, skill: attackBuff }),
      character("enemy-attacker", { hp: 1000, pow: 300 }),
    ],
  );

  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const selection = result.history[0].phases[0].events;
  const enemyBuff = selection.find(({ actorName }) => actorName === "buffer");
  const reviveEvent = selection.find(({ actorName }) => actorName === "reviver");

  assert.equal(enemyBuff.type, "skill_use");
  assert.equal(reviveEvent.type, "skill_use");
  assert.match(reviveEvent.reason, /発動予定スキル/);
  assert.equal(result.state.allies[0].character.name, "leader");
  assert.equal(result.state.allies[0].reviveUsed, true);
});
