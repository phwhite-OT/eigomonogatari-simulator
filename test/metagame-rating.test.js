import test from "node:test";
import assert from "node:assert/strict";

import {
  blendUsageEnvironments,
  buildBootstrapEnvironment,
  buildUsageEnvironment,
  calculateMetagameCombinationPotential,
  calculateMetagameTacticalMetrics,
  calculatePracticalMetagameMetrics,
  estimateOwnershipProbability,
  rankDetailedMetagameResults,
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

test("最終順位と環境使用率は詳細評価済み候補だけから作る", () => {
  const screeningOnly = result("screening-only", { win: 1, lower: 1 });
  screeningOnly.scenarioCount = 12;
  const detailed = result("detailed", { win: 0.65, lower: 0.5 });
  detailed.scenarioCount = 72;

  const rankings = rankDetailedMetagameResults([screeningOnly, detailed], 72);
  const usage = buildUsageEnvironment(rankings);

  assert.deepEqual(rankings.overall.map((entry) => entry.character.id), ["detailed"]);
  assert.deepEqual(usage.map((entry) => entry.character.id), ["detailed"]);
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

  assert.deepEqual(selected.map((entry) => entry.id), ["e", "a", "d"]);
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

test("初手環境の初期候補は耐久より火力を優先する", () => {
  const powerOpener = { ...character("power-opener"), hp: 100, pow: 500, skillTurn: 99 };
  const hpOpener = { ...character("hp-opener"), hp: 500, pow: 100, skillTurn: 99 };

  const environment = buildBootstrapEnvironment([powerOpener, hpOpener], 1);

  assert.equal(environment[0].character.id, "power-opener");
});

test("耐久と全体生存支援は、ほぼ毎回働く場合だけ大きく評価する", () => {
  const unreliable = result("unreliable");
  unreliable.position = 1;
  unreliable.character = {
    ...unreliable.character,
    hp: 1_000,
    pow: 100,
    cost: 20,
    skillTurn: 0,
    skill: { type: "guard", target: "ally_all", duration: 1, multiplier: 0.2 },
  };
  unreliable.matchOutcome.candidateSurvivalRate = 0.7;
  unreliable.strategicActions.allyPreservationNetPerScenario = 0;
  unreliable.reproduction = { skillActivationRate: 1, entryReadyRate: 1, scenarioCoverageRate: 1 };

  const reliable = structuredClone(unreliable);
  reliable.character.id = "reliable";
  reliable.character.name = "reliable";
  reliable.matchOutcome.candidateSurvivalRate = 0.95;
  reliable.strategicActions.allyPreservationNetPerScenario = 1;

  const unreliableMetrics = calculatePracticalMetagameMetrics(unreliable, 100);
  const reliableMetrics = calculatePracticalMetagameMetrics(reliable, 100);

  assert.ok(reliableMetrics.reliableDurability > unreliableMetrics.reliableDurability);
  assert.ok(reliableMetrics.supportReliability > unreliableMetrics.supportReliability);
  assert.ok(reliableMetrics.practicalValue > unreliableMetrics.practicalValue);
});

test("long-duration guard remains a combination specialist despite weak solo results", () => {
  const strong = result("strong", { win: 0.8, lower: 0.7 });
  const runnerUp = result("runner-up", { win: 0.7, lower: 0.6 });
  const guard = result("guard", { win: 0.25, lower: 0.1 });
  guard.position = 3;
  guard.character = {
    ...guard.character,
    skillTurn: 2,
    skill: { type: "guard", target: "self", duration: 4, multiplier: 0.1 },
  };
  guard.reproduction = { skillActivationRate: 1, entryReadyRate: 1, scenarioCoverageRate: 1 };
  guard.continuation = { carriedActionRate: 0.5 };

  assert.ok(calculateMetagameCombinationPotential(guard) > 0.5);
  const selected = selectDetailedCandidates({
    overall: [strong, runnerUp, guard],
    advantage: [strong, runnerUp, guard],
    counter: [runnerUp, strong, guard],
    continuation: [runnerUp, strong, guard],
    combination: [guard, strong, runnerUp],
  }, 2);

  assert.deepEqual(selected.map((entry) => entry.id), ["guard", "strong"]);
});
test("tactical specialists track their upside separately from their average rank", () => {
  const steady = result("steady", { win: 0.8, lower: 0.7 });
  const specialist = result("specialist", { win: 0.35, lower: 0.2 });
  specialist.tacticalProfiles = {
    "stock-balance": {
      scenarioCount: 3,
      skillWinGain: 0,
      skillActivationRate: 1,
      allyPreservationNetPerScenario: 0,
      enemyRemovalNetPerScenario: 0,
    },
    "skill-intercept": {
      scenarioCount: 3,
      skillWinGain: 0.8,
      skillActivationRate: 1,
      allyPreservationNetPerScenario: 0,
      enemyRemovalNetPerScenario: 0,
    },
    "priority-finish": {
      scenarioCount: 3,
      skillWinGain: 0,
      skillActivationRate: 1,
      allyPreservationNetPerScenario: 0,
      enemyRemovalNetPerScenario: 0,
    },
  };

  const metrics = calculateMetagameTacticalMetrics(specialist);
  assert.equal(metrics.tacticalCoverage, 1 / 3);
  assert.equal(metrics.tacticalRisk, 0.8);

  const rankings = rankMetagameResults([steady, specialist]);
  assert.equal(rankings.overall[0].character.id, "steady");
  assert.equal(rankings.tactical[0].character.id, "specialist");
  assert.deepEqual(selectDetailedCandidates(rankings, 2).map((entry) => entry.id), ["specialist", "steady"]);
});
