import test from "node:test";
import assert from "node:assert/strict";
import { createBattleState } from "../src/core/battleState.js";
import { applySkill } from "../src/core/skills.js";
import { PLAY_STYLES, simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(name, { pow = 100, hp = 1000, attributes = ["fire"], skill, environmentPosition } = {}) {
  return {
    id: name,
    name,
    pow,
    hp,
    attributes,
    roleTags: [],
    skillTurn: 0,
    maxUses: 2,
    environmentPosition,
    skill: skill ?? { type: "single_attack", multiplier: 1, duration: 1, hits: 1 },
  };
}

const simpleRules = mergeRules(DEFAULT_RULES, {
  damage: {
    selfMultiplier: 1,
    excellentMultiplier: 1,
    questionLevelMultiplier: 1,
    randomMinimum: 1,
    pvpMultiplier: 1,
    rounding: "floor",
    attributeMultipliers: Object.fromEntries(
      ["fire", "water", "wind"].flatMap((attack) =>
        ["fire", "water", "wind"].map((defense) => [attack + ":" + defense, 1]),
      ),
    ),
  },
  simulation: { turns: 1, ghostPower: 1000 },
});

function selectionEvent(result, side, actorName) {
  return result.history[0].phases
    .find((phase) => phase.id === "skill_selection")
    .events.find((event) => event.side === side && event.actorName === actorName);
}

test("対象属性が盤面にいない直接攻撃スキルは使用しない", () => {
  const conditionalAttack = {
    type: "single_attack",
    multiplier: 2,
    hits: 1,
    duration: 1,
    conditions: [{ type: "enemy_attribute", attribute: "wind" }],
  };
  const state = createBattleState(
    [character("conditional-attacker", { skill: conditionalAttack })],
    [character("fire-target", { attributes: ["fire"] })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: PLAY_STYLES.EXPERT });

  const event = selectionEvent(result, "allies", "conditional-attacker");
  assert.equal(event.type, "skill_hold");
  assert.match(event.reason, /条件を満たす対象がいない/);
  assert.equal(result.history[0].actions[0].hits[0].damage, 100);
});

test("複数の対象属性条件は同種条件内ではORとして扱う", () => {
  const buff = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "ally_all",
    conditions: [
      { type: "ally_attribute", attribute: "fire" },
      { type: "ally_attribute", attribute: "water" },
    ],
  };
  const state = createBattleState(
    [
      character("supporter", { skill: buff, attributes: ["wind"] }),
      character("fire-ally", { attributes: ["fire"] }),
      character("water-ally", { attributes: ["water"] }),
      character("wind-ally", { attributes: ["wind"] }),
    ],
    [character("enemy")],
  );
  const buffed = applySkill(state, "allies", 0, simpleRules);
  const fireHit = applySkill(structuredClone(buffed), "allies", 1, simpleRules);
  const waterHit = applySkill(structuredClone(buffed), "allies", 2, simpleRules);
  const windHit = applySkill(structuredClone(buffed), "allies", 3, simpleRules);

  assert.equal(fireHit.enemies[0].currentHp, 800);
  assert.equal(waterHit.enemies[0].currentHp, 800);
  assert.equal(windHit.enemies[0].currentHp, 900);
});

test("同ターンの攻撃バフ込みで最終ストックの死亡を予測して蘇生を使う", () => {
  const revive = {
    type: "revive",
    multiplier: 1,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const attackBuff = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const state = createBattleState(
    [
      character("final-stock", { hp: 150 }),
      character("reviver", { hp: 1000, skill: revive }),
    ],
    [
      character("buffer", { pow: 0, skill: attackBuff }),
      character("attacker", { pow: 100 }),
    ],
  );

  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: PLAY_STYLES.EXPERT });
  const reviveEvent = selectionEvent(result, "allies", "reviver");

  assert.equal(reviveEvent.type, "skill_use");
  assert.match(reviveEvent.reason, /予行/);
  assert.equal(result.state.allies[0].alive, true);
  assert.equal(result.state.allies[0].reviveUsed, true);
});
