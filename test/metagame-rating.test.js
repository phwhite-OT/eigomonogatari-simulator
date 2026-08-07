import test from "node:test";
import assert from "node:assert/strict";

import {
  blendUsageEnvironments,
  buildUsageEnvironment,
  calculatePracticalMetagameMetrics,
  estimateOwnershipProbability,
  rankMetagameResults,
  selectDetailedCandidates,
} from "../src/core/metagame-rating.js";

function character(id, rarity = "CR") {
  return { id, name: id, rarity };
}

function result(id, overrides = {}) {
  return {
    character: character(id, overrides.rarity),
    scenarioCount: 10,
    matchOutcome: {
      expectedWinRate: overrides.win ?? 0.6,
      expectedWinLowerBound: overrides.lower ?? 0.5,
      decisiveWinRate: 0.5,
      decisiveLossRate: 0.3,
      ongoingRate: 0.2,
      baselineExpectedWinRate: 0.5,
      skillWinGain: 0.1,
    },
    teamBalance: {
      allyRetentionRate: 0.6,
      enemyPressureRate: 0.5,
      balancedContribution: overrides.balance ?? 0.55,
    },
    strategicActions: {
      class: overrides.strategicClass,
      advantageCreationPerScenario: overrides.advantage ?? 0,
      counteractionPerScenario: overrides.counter ?? 0,
      allyPreservationNetPerScenario: 0,
      enemyRemovalNetPerScenario: 0,
    },
    reproduction: { skillActivationRate: 1 },
  };
}

test("推定所持率はレア度で下がるが強いキャラほど上限へ近づく", () => {
  const weakMzr = estimateOwnershipProbability(character("weak", "MZR"), 0);
  const strongMzr = estimateOwnershipProbability(character("strong", "MZR"), 1);
  const strongLegend = estimateOwnershipProbability(character("legend", "伝"), 1);

  assert.equal(weakMzr, 0.55);
  assert.equal(strongMzr, 0.92);
  assert.equal(strongLegend, 0.4);
  assert.ok(strongMzr > weakMzr);
});

test("勝率と攻守均衡が同じなら有利獲得を対抗行動より先に評価する", () => {
  const proactive = result("proactive", { advantage: 1, counter: 0 });
  const reactive = result("reactive", { advantage: 0, counter: 2 });
  const rankings = rankMetagameResults([reactive, proactive]);

  assert.equal(rankings.overall[0].character.id, "proactive");
  assert.equal(rankings.advantage[0].character.id, "proactive");
  assert.equal(rankings.counter[0].character.id, "reactive");
});

test("予測使用率は戦闘順位だけでなく推定所持率も反映する", () => {
  const legend = result("legend", { rarity: "伝", win: 0.8, lower: 0.7 });
  const common = result("common", { rarity: "CR", win: 0.7, lower: 0.6 });
  const rankings = rankMetagameResults([legend, common]);
  const usage = buildUsageEnvironment(rankings);

  assert.equal(rankings.overall[0].character.id, "legend");
  assert.equal(usage[0].character.id, "common");
  assert.ok(usage[0].projectedUsageShare > usage[1].projectedUsageShare);
});


test("detailed selection keeps overall and specialist candidates", () => {
  const entries = ["a", "b", "c", "d", "e"].map((id) => ({ character: character(id) }));
  const selected = selectDetailedCandidates({
    overall: entries,
    advantage: [entries[4], ...entries.slice(0, 4)],
    counter: [entries[3], ...entries.slice(0, 3), entries[4]],
  }, 3);

  assert.deepEqual(selected.map((entry) => entry.id), ["e", "d", "a"]);
});

test("旧環境は25%だけ基礎環境へ混ぜる", () => {
  const first = character("first");
  const second = character("second");
  const blended = blendUsageEnvironments(
    [{ character: first, weight: 1 }, { character: second, weight: 1 }],
    [{ character: second, weight: 1 }],
    0.25,
  );
  const byId = new Map(blended.map((entry) => [entry.character.id, entry.weight]));

  assert.equal(byId.get("first"), 0.375);
  assert.equal(byId.get("second"), 0.625);
  assert.equal([...byId.values()].reduce((sum, value) => sum + value, 0), 1);
});

test("counter specialists retain environment usage despite lower overall rank", () => {
  const defenders = Array.from({ length: 40 }, (_, index) => result(`defender-${index}`, {
    win: 0.8 - index * 0.005,
    lower: 0.7 - index * 0.005,
    advantage: 1,
    strategicClass: "advantage_creation",
  }));
  const attacker = result("attacker", {
    win: 0.45,
    lower: 0.3,
    counter: 3,
    strategicClass: "counteraction",
  });
  const usage = buildUsageEnvironment(rankMetagameResults([...defenders, attacker]));
  const usageById = new Map(usage.map((entry) => [entry.character.id, entry.projectedUsageShare]));

  assert.ok(usageById.get("attacker") > usageById.get("defender-39"));
});


test("初手のスキルターン1は実戦上の発動信頼性を大きく下げる", () => {
  const opener = result("opener");
  opener.position = 1;
  opener.character = {
    ...opener.character,
    pow: 100,
    skillTurn: 1,
    skill: { type: "attack_buff" },
  };
  opener.reproduction = { skillActivationRate: 1, entryReadyRate: 1, scenarioCoverageRate: 1 };

  const later = result("later");
  later.position = 4;
  later.character = {
    ...later.character,
    pow: 100,
    skillTurn: 3,
    skill: { type: "attack_buff" },
  };
  later.reproduction = { skillActivationRate: 1, entryReadyRate: 1, scenarioCoverageRate: 1 };

  const openerMetrics = calculatePracticalMetagameMetrics(opener, 100);
  const laterMetrics = calculatePracticalMetagameMetrics(later, 100);
  assert.ok(openerMetrics.practicalSkillReliability < 0.3);
  assert.ok(laterMetrics.practicalSkillReliability > openerMetrics.practicalSkillReliability);
  assert.ok(openerMetrics.earlySkillLiability > laterMetrics.earlySkillLiability);
});
