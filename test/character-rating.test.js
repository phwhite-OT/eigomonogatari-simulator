import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCharacterRatingReport,
  buildPositionPool,
  characterMatchesAttributeRestriction,
  estimateSkillPotency,
} from "../src/core/character-rating.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function character(id, overrides = {}) {
  return {
    id,
    name: id,
    attributes: overrides.attributes ?? ["fire"],
    cost: overrides.cost ?? 10,
    hp: overrides.hp ?? 1000,
    pow: overrides.pow ?? 1000,
    rarity: "test",
    region: "test",
    owned: true,
    pvpTier: "normal",
    allowedPositions: [1, 2, 3, 4, 5],
    preferredPositions: [1, 2, 3, 4, 5],
    positionRule: "free",
    skillTurn: overrides.skillTurn ?? 1,
    maxUses: 2,
    skill: overrides.skill ?? { type: "none", multiplier: 1, hits: 1, duration: 1, targetCount: 1, conditions: [], effects: [] },
    roleTags: [],
  };
}

test("属性縛りは選択色を含む複属性と全属性も対象にする", () => {
  assert.equal(characterMatchesAttributeRestriction(character("fire"), ["fire"]), true);
  assert.equal(characterMatchesAttributeRestriction(character("dual", { attributes: ["fire", "water"] }), ["fire"]), true);
  assert.equal(characterMatchesAttributeRestriction(character("all", { attributes: ["fire", "water", "wind"] }), ["wind"]), true);
  assert.equal(characterMatchesAttributeRestriction(character("water", { attributes: ["water"] }), ["fire"]), false);
});

test("2枠目はスキルターン1か2だけを候補にする", () => {
  const characters = [
    character("turn-0", { skillTurn: 0 }),
    character("turn-1", { skillTurn: 1 }),
    character("turn-2", { skillTurn: 2 }),
    character("turn-3", { skillTurn: 3 }),
  ];
  assert.deepEqual(buildPositionPool(characters, 2).map(({ id }) => id), ["turn-1", "turn-2"]);
});

test("短縮と遅延は効果だけを0評価にしてキャラは残す", () => {
  const delay = character("delay", {
    skill: { type: "delay", multiplier: 1, amount: 2, duration: 1, targetCount: 5, conditions: [], effects: [] },
  });
  const reduction = character("reduction", {
    skill: { type: "skill_reduction", multiplier: 1, amount: 2, duration: 1, targetCount: 5, conditions: [], effects: [] },
  });
  assert.equal(estimateSkillPotency(delay, [delay, reduction], 2, DEFAULT_RULES), 0);
  assert.equal(estimateSkillPotency(reduction, [delay, reduction], 2, DEFAULT_RULES), 0);
  assert.deepEqual(buildPositionPool([delay, reduction], 2).map(({ id }) => id), ["delay", "reduction"]);
});

test("固定コスト帯を作らずコスト1刻みの評価表を生成する", () => {
  const characters = [];
  for (let position = 1; position <= 5; position += 1) {
    const skillTurns = position === 1 ? [0, 1] : [position - 1, position];
    characters.push(
      character(`cheap-${position}`, {
        cost: 3,
        hp: 600,
        pow: 600,
        skillTurn: skillTurns[0],
      }),
      character(`strong-${position}`, {
        cost: 20,
        hp: 2000,
        pow: 2000,
        skillTurn: skillTurns[1],
      }),
    );
  }
  const report = buildCharacterRatingReport(characters, {
    position: 2,
    totalCost: 40,
    topLimit: 2,
    frontier: { beamWidth: 20, perCostLimit: 5 },
  });
  assert.equal(report.context.eligibleCharacterCount, 4);
  assert.ok(report.topByCost.length > 1);
  for (let index = 1; index < report.topByCost.length; index += 1) {
    assert.equal(report.topByCost[index].totalCost, report.topByCost[index - 1].totalCost + 1);
  }
  assert.ok(report.characters.some((entry) => entry.name === "cheap-2"));
  assert.ok(report.characters.some((entry) => entry.name === "strong-2"));
});
