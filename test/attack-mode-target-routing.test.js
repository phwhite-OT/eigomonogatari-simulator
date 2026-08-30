import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import { applySupportSkill } from "../src/core/skills.js";
import { simulateBattle } from "../src/core/simulate.js";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

const ATTACK_MODE_TYPES = new Set(["aoe_attack", "multi_hit_attack"]);

function expectedWorkbookTarget(category) {
  const value = String(category ?? "");
  if (value.startsWith("自身")) return "self";
  if (value.startsWith("リーダー")) return "leader";
  if (value.startsWith("味方色") || value.startsWith("全員")) return "ally_all";
  return null;
}

function character(name, options = {}) {
  return {
    id: name,
    name,
    attributes: options.attributes ?? ["fire"],
    hp: options.hp ?? 10_000,
    pow: options.pow ?? 100,
    cost: 1,
    rarity: "N",
    roleTags: [],
    skillTurn: options.skillTurn ?? 99,
    maxUses: 2,
    skill: options.skill ?? { type: "single_attack", multiplier: 1, hits: 1, duration: 1 },
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

test("workbook attack-mode categories normalize to their actual recipients", () => {
  const checked = [];
  for (const entry of CHARACTER_CATALOG) {
    if (!ATTACK_MODE_TYPES.has(entry.skill?.type)) continue;
    const expected = expectedWorkbookTarget(entry.skillCategory);
    if (!expected) continue;
    checked.push(entry.name);
    assert.equal(
      entry.skill.target,
      expected,
      `${entry.name} (${entry.skillCategory}) should target ${expected}`,
    );
    assert.equal(entry.skill.targetCount, expected === "ally_all" ? 5 : 1);
  }
  assert.ok(checked.length >= 300, `expected to audit the workbook attack-mode population, got ${checked.length}`);
});

test("カルボ姉の連撃は自身ではなくリーダーに付与される", () => {
  const kalbo = CHARACTER_CATALOG.find((entry) => entry.name === "カルボ姉（ねえ）");
  assert.ok(kalbo);
  assert.equal(kalbo.skill.type, "multi_hit_attack");
  assert.equal(kalbo.skill.target, "leader");
  assert.equal(kalbo.skill.hits, 2);

  const leader = character("leader", { skillTurn: 99 });
  const supporter = { ...kalbo, skillTurn: 0, hp: 10_000, pow: 100 };
  const state = createBattleState(
    [leader, supporter],
    [character("enemy-a"), character("enemy-b")],
  );

  const supported = applySupportSkill(state, "allies", 1, supporter.skill);
  assert.deepEqual(supported.allies.map((combatant) => (
    combatant.buffs.filter((effect) => effect.type === "multi_hit_attack").length
  )), [1, 0]);

  const result = simulateBattle(state, simpleRules, { turns: 1, randomSeed: "leader-multi-hit" });
  const allyActions = result.history[0].actions.filter((action) => action.side === "allies");
  const leaderAction = allyActions.find((action) => action.actorName === "leader");
  const kalboAction = allyActions.find((action) => action.actorName === "カルボ姉（ねえ）");
  assert.equal(leaderAction.hits.length, 2);
  assert.equal(kalboAction.hits.length, 1);
});

test("全員全体は味方全員、自身全体は使用者だけに付与される", () => {
  const allAoe = CHARACTER_CATALOG.find((entry) => entry.skillCategory === "全員全体");
  const selfAoe = CHARACTER_CATALOG.find((entry) => entry.skillCategory === "自身全体");
  assert.ok(allAoe);
  assert.ok(selfAoe);
  assert.equal(allAoe.skill.target, "ally_all");
  assert.equal(selfAoe.skill.target, "self");

  const allState = createBattleState(
    [character("leader"), { ...allAoe, skillTurn: 0 }, character("ally")],
    [character("enemy")],
  );
  const allApplied = applySupportSkill(allState, "allies", 1, allAoe.skill);
  assert.deepEqual(allApplied.allies.map((combatant) => (
    combatant.buffs.filter((effect) => effect.type === "aoe_attack").length
  )), [1, 1, 1]);

  const selfState = createBattleState(
    [character("leader"), { ...selfAoe, skillTurn: 0 }, character("ally")],
    [character("enemy")],
  );
  const selfApplied = applySupportSkill(selfState, "allies", 1, selfAoe.skill);
  assert.deepEqual(selfApplied.allies.map((combatant) => (
    combatant.buffs.filter((effect) => effect.type === "aoe_attack").length
  )), [0, 1, 0]);
});
