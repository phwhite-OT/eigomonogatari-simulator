import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRepresentativeEnemies,
  evaluateDeckDetailed,
  positionFitness,
  scoreDeckLight,
} from "../src/core/evaluate.js";
import { filterCandidates } from "../src/core/filter.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function character(id, skillType, roleTags = []) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    cost: 10,
    hp: 1000,
    pow: 1000,
    rarity: "R",
    region: "test",
    owned: true,
    pvpTier: "normal",
    allowedPositions: [1, 2, 3, 4, 5],
    preferredPositions: [1],
    positionRule: "free",
    skillTurn: 9,
    maxUses: 2,
    skill: { type: skillType, multiplier: 1, amount: 3, duration: 1, hits: 1 },
    roleTags,
  };
}

test("短縮・遅延キャラは候補に残り、初手でスキル待ち減点を受けない", () => {
  const delay = character("delay", "delay", ["delay", "debuff"]);
  const reduction = character("reduction", "skill_reduction", ["skill_reduction", "setup"]);
  const { candidates } = filterCandidates([delay, reduction], { totalCost: 100, deckSize: 5 });

  assert.deepEqual(candidates.map(({ id }) => id), ["delay", "reduction"]);
  assert.equal(positionFitness(delay, 1, DEFAULT_RULES), 100);
  assert.equal(positionFitness(reduction, 1, DEFAULT_RULES), 100);
  assert.ok(positionFitness(character("heal", "heal", ["heal"]), 1, DEFAULT_RULES) < 100);
});

test("短縮・遅延由来の役割タグはデッキ評価へ加点しない", () => {
  const taggedDeck = [
    character("delay", "delay", ["delay", "debuff"]),
    character("multi", "none", ["multi_hit_attacker"]),
    character("reduction", "skill_reduction", ["skill_reduction", "setup"]),
    character("late", "none", ["late_game"]),
    character("attack", "none", ["single_attacker"]),
  ];
  const untaggedDeck = taggedDeck.map((member) => (
    ["delay", "skill_reduction"].includes(member.skill.type)
      ? { ...member, roleTags: [] }
      : member
  ));
  const profiles = buildRepresentativeEnemies(taggedDeck, DEFAULT_RULES);
  const context = {
    constraints: { totalCost: 100 },
    rules: DEFAULT_RULES,
    profiles,
  };

  assert.equal(scoreDeckLight(taggedDeck, context), scoreDeckLight(untaggedDeck, context));
});
test("詳細評価は回復・蘇生の対象人数をスキル効果値へ反映する", () => {
  const deckWithSkill = (skill) => Array.from({ length: 5 }, (_, index) => ({
    ...character(`member-${index}`, index === 0 ? skill.type : "none"),
    id: `member-${index}`,
    name: `member-${index}`,
    skillTurn: 0,
    skill: index === 0 ? skill : { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
  }));
  const scoreImpact = (skill) => {
    const deck = deckWithSkill(skill);
    const profiles = buildRepresentativeEnemies(deck, DEFAULT_RULES);
    return evaluateDeckDetailed(deck, {
      constraints: { totalCost: 100 },
      rules: DEFAULT_RULES,
      profiles,
    }).skillImpacts[0];
  };

  const selfHeal = scoreImpact({ type: "heal", multiplier: 0.5, target: "self", duration: 1, conditions: [] });
  const allHeal = scoreImpact({ type: "heal", multiplier: 0.5, target: "ally_all", duration: 1, conditions: [] });
  const leaderRevive = scoreImpact({ type: "revive", multiplier: 0.5, target: "leader", duration: 1, conditions: [] });
  const allRevive = scoreImpact({ type: "revive", multiplier: 0.5, target: "ally_all", duration: 1, conditions: [] });

  assert.ok(selfHeal > 0);
  assert.ok(allHeal > selfHeal);
  assert.ok(leaderRevive > 0);
  assert.ok(allRevive > leaderRevive);
});
test("詳細評価は代表敵3種の同時攻撃シナリオと処理ログを集計する", () => {
  const deck = Array.from({ length: 5 }, (_, index) => ({
    ...character(`simulation-member-${index}`, "none"),
    id: `simulation-member-${index}`,
    name: `simulation-member-${index}`,
    skillTurn: 99,
    skill: { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
  }));
  const profiles = buildRepresentativeEnemies(deck, DEFAULT_RULES);
  const result = evaluateDeckDetailed(deck, {
    constraints: { totalCost: 100 },
    rules: DEFAULT_RULES,
    profiles,
  });

  assert.ok(result.metrics.simulation >= 0 && result.metrics.simulation <= 100);
  assert.equal(result.simulationScenarios.length, 3);
  assert.deepEqual(new Set(result.simulationScenarios.map(({ profile }) => profile)), new Set(["worst", "standard", "favorable"]));
  assert.deepEqual(new Set(result.simulationScenarios.map(({ attackModel }) => attackModel)), new Set(["simultaneous"]));
  assert.ok(result.simulationScenarios.every(({ turnsCompleted }) => turnsCompleted >= 1 && turnsCompleted <= 8));
  assert.equal(result.simulationTrace.profile, "standard");
  assert.ok(result.simulationTrace.history.every(({ phases }) => phases.some(({ id }) => id === "attack")));
});