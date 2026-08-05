import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";
import {
  calculateMinimumDamage,
  resolveAttack,
  resolveAttackBuffMultiplier,
  resolveAttributeMultiplier,
  resolveDefenseMultiplier,
} from "../src/core/damage.js";

const attacker = { pow: 3000, attributes: ["fire"] };
const defender = { hp: 2000, attributes: ["water"] };

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("対戦の基礎倍率と最低乱数を掛けて最終結果を切り捨てる", () => {
  const damage = calculateMinimumDamage({
    attacker: { pow: 7497, attributes: ["fire"] },
    defender: { hp: 12000, attributes: ["fire"] },
    rules: DEFAULT_RULES,
  });
  assertClose(damage.raw, 8744.5008);
  assert.equal(damage.value, 8744);
  assert.equal(damage.factors.self, 1.2);
  assert.equal(damage.factors.excellent, 1.2);
  assert.equal(damage.factors.questionLevel, 1.8);
  assert.equal(damage.factors.random, 0.9);
  assert.equal(damage.factors.pvp, 0.75);
  assert.equal(damage.factors.attribute, 2 / 3);
});

test("単属性の有利・同属性・不利倍率を解決する", () => {
  assert.equal(resolveAttributeMultiplier(["fire"], ["wind"], DEFAULT_RULES), 1);
  assert.equal(resolveAttributeMultiplier(["fire"], ["fire"], DEFAULT_RULES), 2 / 3);
  assert.equal(resolveAttributeMultiplier(["fire"], ["water"], DEFAULT_RULES), 1 / 3);
});

test("複属性は攻撃側と防御側の全組み合わせを平均する", () => {
  const multiplier = resolveAttributeMultiplier(
    ["fire", "wind"],
    ["water", "wind"],
    DEFAULT_RULES,
  );
  assertClose(multiplier, 3 / 4);
});

test("白属性は三属性の平均により相手を問わず2/3になる", () => {
  const allAttributes = ["fire", "water", "wind"];
  assertClose(resolveAttributeMultiplier(allAttributes, ["fire"], DEFAULT_RULES), 2 / 3);
  assertClose(resolveAttributeMultiplier(["water"], allAttributes, DEFAULT_RULES), 2 / 3);
  assertClose(resolveAttributeMultiplier(allAttributes, allAttributes, DEFAULT_RULES), 2 / 3);
});

test("計算ルールは設定で差し替えられる", () => {
  const rules = mergeRules(DEFAULT_RULES, {
    damage: { selfMultiplier: 1, excellentMultiplier: 1, questionLevelMultiplier: 1 },
  });
  const damage = calculateMinimumDamage({ attacker, defender, skillMultiplier: 1.25, rules });
  assert.equal(damage.value, 843);
});

test("確定撃破と残HPを同じ計算結果から返す", () => {
  const result = resolveAttack({ attacker, defender: { ...defender, hp: 800 }, rules: DEFAULT_RULES });
  assert.equal(result.guaranteedDefeat, true);
  assert.equal(result.remainingHp, 0);
});
test("複数の攻撃バフは各倍率を乗算する", () => {
  const multiplier = resolveAttackBuffMultiplier([
    { multiplier: 5 },
    { multiplier: 3 },
  ]);
  assert.equal(multiplier, 15);
});

test("複数の防御効果は軽減率順に段階減衰する", () => {
  const multiplier = resolveDefenseMultiplier([
    { multiplier: 0.5 },
    { multiplier: 0.2 },
    { multiplier: 0.7 },
  ]);
  assertClose(multiplier, 0.122);
});

test("防御効果の入力順にかかわらず高軽減率から適用する", () => {
  const forward = resolveDefenseMultiplier([0.2, 0.5, 0.7]);
  const reverse = resolveDefenseMultiplier([0.7, 0.5, 0.2]);
  assertClose(forward, reverse);
  assertClose(resolveDefenseMultiplier([0]), 0);
});
