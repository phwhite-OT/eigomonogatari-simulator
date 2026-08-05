import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceTurn,
  applyDamageToCombatant,
  applyHealingToCombatant,
  createBattleState,
  resolveDefeatedCombatants,
} from "../src/core/battleState.js";
import { calculateMinimumDamage } from "../src/core/damage.js";
import { applySkill } from "../src/core/skills.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(name, overrides = {}) {
  return {
    id: name,
    name,
    pow: overrides.pow ?? 100,
    hp: overrides.hp ?? 100,
    attributes: overrides.attributes ?? ["fire"],
    roleTags: [],
    skillTurn: overrides.skillTurn ?? 0,
    maxUses: overrides.maxUses ?? 2,
    skill: overrides.skill ?? { type: "single_attack", multiplier: 1, duration: 1, hits: 1 },
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
    attributeMultipliers: { "fire:fire": 1 },
  },
});

test("各プレイヤーはデッキ先頭の1体だけが場に出る", () => {
  const firstDeck = [character("front"), character("reserve")];
  const secondDeck = [character("teammate")];
  const state = createBattleState([firstDeck, secondDeck], [[character("enemy")]]);

  assert.equal(state.allies.length, 2);
  assert.equal(state.allies[0].character.name, "front");
  assert.equal(state.allies[0].deckIndex, 0);
  assert.equal(state.allies[0].deck.length, 2);
  assert.equal(state.allies[1].character.name, "teammate");
});

test("残り1ターンの効果は次枠へ持ち越さない", () => {
  const state = createBattleState(
    [[character("front", { hp: 50 }), character("reserve", { hp: 120 })]],
    [[character("enemy")]],
  );
  state.allies[0].naturalSkillCharge = 3;
  state.allies[0].skillCounter = 1;
  state.allies[0].survivalTurns = 2;
  state.allies[0].buffs = [{ type: "attack_buff", multiplier: 2, remainingTurns: 1 }];

  const next = applyDamageToCombatant(state, "allies", 0, 50);

  assert.equal(next.allies[0].character.name, "reserve");
  assert.equal(next.allies[0].deckIndex, 1);
  assert.equal(next.allies[0].currentHp, 120);
  assert.equal(next.allies[0].skillCounter, 3);
  assert.equal(next.allies[0].survivalTurns, 0);
  assert.deepEqual(next.allies[0].buffs, []);
});

test("生存ターンごとに攻撃力を1.3倍し、交代時にリセットする", () => {
  let state = createBattleState(
    [[character("front", { hp: 50 }), character("reserve")]],
    [[character("enemy")]],
  );
  state = advanceTurn(advanceTurn(state));
  assert.equal(state.allies[0].survivalTurns, 2);

  const damage = calculateMinimumDamage({
    attacker: { ...state.allies[0].character, survivalTurns: state.allies[0].survivalTurns },
    defender: state.enemies[0].character,
    rules: simpleRules,
  });
  assert.equal(damage.factors.survival, 1.3 ** 2);
  assert.equal(damage.value, 169);

  const replaced = applyDamageToCombatant(state, "allies", 0, 50);
  assert.equal(replaced.allies[0].survivalTurns, 0);
});

test("味方全員スキルは別プレイヤーの現在キャラにだけ作用する", () => {
  const teamBuff = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const state = createBattleState(
    [
      [character("supporter", { skill: teamBuff }), character("reserve")],
      [character("teammate")],
    ],
    [[character("enemy")]],
  );

  const buffed = applySkill(state, "allies", 0, simpleRules);
  assert.equal(buffed.allies[0].buffs.length, 1);
  assert.equal(buffed.allies[1].buffs.length, 1);

  const replaced = applyDamageToCombatant(buffed, "allies", 0, 100);
  assert.equal(replaced.allies[0].character.name, "reserve");
  assert.deepEqual(replaced.allies[0].buffs, []);
  assert.equal(replaced.allies[1].buffs.length, 1);
});

test("スキルは必要ターン経過後に使用でき、最大2回まで", () => {
  const skill = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "self",
    conditions: [],
  };
  let state = createBattleState(
    [[character("supporter", { skillTurn: 2, maxUses: 2, skill })]],
    [[character("enemy")]],
  );

  state = applySkill(state, "allies", 0, simpleRules);
  assert.equal(state.allies[0].skillUses, 0);

  state = advanceTurn(advanceTurn(state));
  state = applySkill(state, "allies", 0, simpleRules);
  assert.equal(state.allies[0].skillUses, 1);
  assert.equal(state.allies[0].skillCounter, 0);

  state = advanceTurn(advanceTurn(state));
  state = applySkill(state, "allies", 0, simpleRules);
  assert.equal(state.allies[0].skillUses, 2);

  state = advanceTurn(advanceTurn(state));
  const blocked = applySkill(state, "allies", 0, simpleRules);
  assert.equal(blocked.allies[0].skillUses, 2);
});
test("攻撃スキルで撃破した場合も相手の次枠へ交代する", () => {
  const state = createBattleState(
    [[character("attacker")]],
    [[character("front", { hp: 50 }), character("reserve", { hp: 140 })]],
  );

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].character.name, "reserve");
  assert.equal(next.enemies[0].deckIndex, 1);
  assert.equal(next.enemies[0].currentHp, 140);
});


test("対戦フェーズでは死亡を保留し、蘇生判定後に次キャラへ交代する", () => {
  const state = createBattleState(
    [[character("front", { hp: 50 }), character("reserve", { hp: 120 })]],
    [[character("enemy")]],
  );
  const defeated = applyDamageToCombatant(state, "allies", 0, 50, { deferReplacement: true });
  assert.equal(defeated.allies[0].character.name, "front");
  assert.equal(defeated.allies[0].alive, false);

  const replacement = resolveDefeatedCombatants(defeated);
  assert.equal(replacement.state.allies[0].character.name, "reserve");
  assert.equal(replacement.transitions[0].type, "replacement");
});

test("控えがない敗北キャラは幽霊になり、回復対象から除外する", () => {
  const state = createBattleState([[character("last", { hp: 50 })]], [[character("enemy")]]);
  const defeated = applyDamageToCombatant(state, "allies", 0, 50, { deferReplacement: true });
  const replacement = resolveDefeatedCombatants(defeated, { ghostPower: 1000 });
  const ghost = replacement.state.allies[0];

  assert.equal(ghost.isGhost, true);
  assert.equal(ghost.character.pow, 1000);
  assert.deepEqual(ghost.attributes, ["fire", "water", "wind"]);
  const healed = applyHealingToCombatant(replacement.state, "allies", 0, 1000);
  assert.equal(healed.allies[0].currentHp, 1);
});

test("回復後HPは最大HPの200パーセントまで増える", () => {
  const state = createBattleState([[character("target", { hp: 100 })]], [[character("enemy")]]);
  const healed = applyHealingToCombatant(state, "allies", 0, 500);
  assert.equal(healed.allies[0].currentHp, 200);
});


test("継続中の効果は次枠へ継承し、属性変更も維持する", () => {
  const state = createBattleState(
    [[character("front", { hp: 50 }), character("reserve", { hp: 120, attributes: ["wind"] })]],
    [[character("enemy")]],
  );
  state.allies[0].buffs = [
    { type: "attack_buff", multiplier: 2, remainingTurns: 2 },
    { type: "attribute_change", attributes: ["water"], remainingTurns: 2 },
  ];
  state.allies[0].debuffs = [{ type: "sample_debuff", amount: 1, remainingTurns: 2 }];

  const replacement = applyDamageToCombatant(state, "allies", 0, 50).allies[0];
  assert.equal(replacement.character.name, "reserve");
  assert.equal(replacement.buffs.length, 2);
  assert.equal(replacement.debuffs.length, 1);
  assert.deepEqual(replacement.attributes, ["water"]);

  const nextTurn = advanceTurn({ ...state, allies: [replacement] }).allies[0];
  assert.equal(nextTurn.buffs[0].remainingTurns, 1);
  assert.equal(nextTurn.debuffs[0].remainingTurns, 1);
});
