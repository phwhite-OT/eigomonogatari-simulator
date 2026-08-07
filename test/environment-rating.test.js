import test from "node:test";
import assert from "node:assert/strict";

import { createBattleState } from "../src/core/battleState.js";
import {
  buildCandidatePositionEntryScenarios,
  classifyStrategicAction,
  DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
  createDeckCompletionSolver,
  createFullEnvironmentDecks,
  evaluateCandidateInEnvironment,
  evaluateCandidateMatchOutcome,
  projectedMatchWinValue,
  readinessSummary,
  strategicDeckComposition,
} from "../src/core/environment-rating.js";
import { simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function character(id, overrides = {}) {
  return {
    id,
    name: id,
    attributes: overrides.attributes ?? ["fire"],
    cost: overrides.cost ?? 5,
    hp: overrides.hp ?? 1000,
    pow: overrides.pow ?? 100,
    rarity: overrides.rarity ?? "test",
    region: "test",
    owned: true,
    pvpTier: "normal",
    allowedPositions: [1, 2, 3, 4, 5],
    preferredPositions: [1, 2, 3, 4, 5],
    positionRule: "free",
    skillTurn: overrides.skillTurn ?? 0,
    maxUses: 2,
    skill: overrides.skill ?? { type: "none", multiplier: 1, hits: 1, duration: 1, target: "enemy_one", targetCount: 1, conditions: [], effects: [] },
    roleTags: [],
  };
}

test("対戦開始時の盤面をターンごとに観測できる", () => {
  const starts = [];
  const unit = character("unit");
  simulateBattle(createBattleState([[unit]], [[character("enemy")]]), DEFAULT_RULES, {
    turns: 2,
    onTurnStart: ({ turn, state }) => starts.push({ turn, charge: state.allies[0].skillCounter }),
  });
  assert.deepEqual(starts, [{ turn: 1, charge: 0 }, { turn: 2, charge: 1 }]);
});

test("2枠目の使用可能率は実際に記録した登場カウントから求める", () => {
  const summary = readinessSummary([
    { entryCharge: 1 },
    { entryCharge: 1 },
    { entryCharge: 2 },
    { entryCharge: 3 },
  ], 3);
  assert.equal(summary.usableRates[1], 1);
  assert.equal(summary.usableRates[2], 0.5);
  assert.equal(summary.usableRates[3], 0.25);
});

test("全体攻撃バフは本人の攻撃力でなく盤面全体の追加撃破として評価する", () => {
  const candidate = character("buffer", {
    skill: { type: "attack_buff", multiplier: 10, hits: 1, duration: 1, target: "ally_all", targetCount: 5, conditions: [], effects: [] },
  });
  const allies = [candidate, ...Array.from({ length: 4 }, (_, index) => character(`ally-${index}`))];
  const enemies = Array.from({ length: 5 }, (_, index) => character(`enemy-${index}`, {
    attributes: ["wind"],
    hp: 1000,
    pow: 0,
  }));
  const fillers = Array.from({ length: 10 }, (_, index) => character(`filler-${index}`));
  const positionPools = Array.from({ length: 5 }, () => [candidate, ...allies, ...fillers]);
  const solveCompletion = createDeckCompletionSolver(positionPools, 100);
  const result = evaluateCandidateInEnvironment(candidate, [{
    state: createBattleState(allies.map((unit) => [unit]), enemies.map((unit) => [unit])),
    actorIndex: 0,
    position: 1,
    entryCharge: 0,
  }], { rules: DEFAULT_RULES, solveCompletion });
  assert.equal(result.reproduction.skillActivationRate, 1);
  assert.ok(result.offense.skillAddedDefeatsPerScenario > 0);
  assert.ok(result.offense.allBoardDefeatRate > 0);
});


test("発動再現性は登場ターン別・標的方針別にも分けて確認できる", () => {
  const summary = readinessSummary([
    { entryCharge: 1, entryTurn: 2, battleProfile: "balance" },
    { entryCharge: 1, entryTurn: 2, battleProfile: "kill" },
    { entryCharge: 2, entryTurn: 3, battleProfile: "balance" },
    { entryCharge: 3, entryTurn: 4, battleProfile: "kill" },
  ], 3);

  assert.deepEqual(summary.entryTurnCounts, { 2: 2, 3: 1, 4: 1 });
  assert.equal(summary.byEntryTurn[2].usableRates[2], 0);
  assert.equal(summary.byBattleProfile.balance.usableRates[2], 0.5);
  assert.equal(summary.byBattleProfile.kill.usableRates[2], 0.5);
});


test("伝説キャラは1デッキに2体固定できない", () => {
  const firstLegend = character("legend-1", { rarity: "伝" });
  const secondLegend = character("legend-2", { rarity: "伝" });
  const normals = Array.from({ length: 6 }, (_, index) => character(`normal-${index}`, { rarity: "CR" }));
  const pools = Array.from({ length: 5 }, () => [firstLegend, secondLegend, ...normals]);
  const solveCompletion = createDeckCompletionSolver(pools, 100);

  assert.equal(solveCompletion({ 1: firstLegend, 2: secondLegend }), null);
  const completion = solveCompletion({ 1: firstLegend });
  assert.ok(completion);
  assert.equal(completion.deck.filter((unit) => unit.rarity === "伝").length, 1);
});


test("勝利・引き分け・敗北を1・0.5・0として扱う", () => {
  const snapshot = {
    remainingCharacters: 5,
    remainingHp: 5000,
    totalHp: 5000,
  };
  const base = {
    initial: { allies: snapshot, enemies: snapshot },
    final: { allies: snapshot, enemies: snapshot },
    metrics: { allyLosses: 0, enemyLosses: 0 },
  };
  assert.equal(projectedMatchWinValue({ ...base, outcome: "allies" }), 1);
  assert.equal(projectedMatchWinValue({ ...base, outcome: "draw" }), 0.5);
  assert.equal(projectedMatchWinValue({ ...base, outcome: "enemies" }), 0);
});

test("守備系を有利獲得、攻撃系を対抗行動として分類する", () => {
  assert.equal(classifyStrategicAction(character("shield", {
    skill: { type: "damage_reduction" },
  })), "advantage_creation");
  assert.equal(classifyStrategicAction(character("attacker", {
    skill: { type: "attack_buff" },
  })), "counteraction");
  assert.equal(classifyStrategicAction(character("single-attacker", {
    skill: { type: "single_attack" },
  })), "counteraction");
  assert.equal(classifyStrategicAction(character("delay", {
    skill: { type: "delay" },
  })), "ignored");
});


test("最終枠の高コスト候補も候補専用デッキで同数盤面を確保する", () => {
  const positionCharacters = Array.from({ length: 5 }, (_, index) => character(`position-${index + 1}`, {
    cost: 10,
    hp: 1,
    pow: 10000,
    skillTurn: index,
    skill: index === 4
      ? { type: "attack_buff", multiplier: 2, target: "self", duration: 1, conditions: [] }
      : undefined,
  }));
  const candidate = character("expensive-final", {
    cost: 60,
    hp: 1,
    pow: 10000,
    skillTurn: 8,
  });
  const pools = positionCharacters.map((unit, index) => (index === 4 ? [unit, candidate] : [unit]));
  const environments = positionCharacters.map((unit) => [{ character: unit, weight: 1 }]);
  const solveCompletion = createDeckCompletionSolver(pools, 100);
  const scenarios = buildCandidatePositionEntryScenarios({
    count: 6,
    position: 5,
    character: candidate,
    positionEnvironments: environments,
    solveCompletion,
    rules: DEFAULT_RULES,
    seed: 123,
    turns: 12,
  });

  assert.equal(scenarios.length, 6);
  for (const scenario of scenarios) {
    const deck = [...scenario.prefixCharacters, candidate, ...scenario.suffixCharacters];
    assert.equal(deck.length, 5);
    assert.ok(deck.reduce((sum, unit) => sum + unit.cost, 0) <= 100);
    assert.equal(scenario.candidateConditioned, true);
  }
});

test("候補より後ろのキャラもスキルを保持する", () => {
  const units = Array.from({ length: 5 }, (_, index) => character(`reserve-position-${index + 1}`, {
    cost: 10,
    hp: 1,
    pow: 10000,
    skillTurn: index,
    skill: index === 4
      ? { type: "attack_buff", multiplier: 2, target: "self", duration: 1, conditions: [] }
      : undefined,
  }));
  const candidate = character("fourth-candidate", { cost: 20, hp: 1, pow: 10000, skillTurn: 3 });
  const pools = units.map((unit, index) => (index === 3 ? [unit, candidate] : [unit]));
  const environments = units.map((unit) => [{ character: unit, weight: 1 }]);
  const solveCompletion = createDeckCompletionSolver(pools, 100);
  const [scenario] = buildCandidatePositionEntryScenarios({
    count: 1,
    position: 4,
    character: candidate,
    positionEnvironments: environments,
    solveCompletion,
    rules: DEFAULT_RULES,
    seed: 321,
    turns: 12,
  });

  assert.equal(scenario.state.allies[scenario.actorIndex].deck[1].skill.type, "attack_buff");
});


test("environment deck completion fills positions missing from weighted usage", () => {
  const popular = character("popular");
  const positionPools = Array.from({ length: 5 }, (_, index) => [
    popular,
    character(`position-only-${index + 1}`),
  ]);
  const positionEnvironments = Array.from({ length: 5 }, () => [{
    character: popular,
    weight: 1,
  }]);
  const solveCompletion = createDeckCompletionSolver(positionPools, 100);
  const [deck] = createFullEnvironmentDecks(1, positionEnvironments, solveCompletion, () => 0.5);

  assert.equal(deck.length, 5);
  assert.equal(new Set(deck.map((unit) => unit.id)).size, 5);
});

test("strategic environment decks contain both advantage and counter actions", () => {
  const positionPools = Array.from({ length: 5 }, (_, index) => [
    character(`guard-${index}`, { skill: { type: "guard" } }),
    character(`attack-${index}`, { skill: { type: "single_attack" } }),
    character(`neutral-${index}`),
  ]);
  const positionEnvironments = positionPools.map((pool) => pool.map((unit) => ({
    character: unit,
    weight: 1,
  })));
  const solveCompletion = createDeckCompletionSolver(positionPools, 100);
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const decks = createFullEnvironmentDecks(
    12,
    positionEnvironments,
    solveCompletion,
    random,
    {},
    {
      deckProfiles: [{ id: "balanced", minimumAdvantage: 1, minimumCounter: 1 }],
      strictProfiles: true,
    },
  );

  for (const deck of decks) {
    const composition = strategicDeckComposition(deck);
    assert.ok(composition.advantage >= 1);
    assert.ok(composition.counter >= 1);
  }
});
test("candidate outcomes retain results for each expert tactical profile", () => {
  const candidate = character("candidate", {
    skill: { type: "guard", multiplier: 0.25, hits: 1, duration: 2, target: "self", targetCount: 1, conditions: [], effects: [] },
  });
  const reserves = [2, 3, 4, 5].map((position) => character(`reserve-${position}`, {
    hp: 2000,
    pow: 200,
    skillTurn: position,
  }));
  const positionPools = [[candidate], ...reserves.map((unit) => [unit])];
  const positionEnvironments = positionPools.map((pool) => pool.map((unit) => ({ character: unit, weight: 1 })));
  const solveCompletion = createDeckCompletionSolver(positionPools, 100);
  const scenarios = buildCandidatePositionEntryScenarios({
    count: 6,
    position: 1,
    character: candidate,
    positionEnvironments,
    solveCompletion,
    rules: DEFAULT_RULES,
    seed: 91,
    turns: 3,
  });
  const expectedProfileIds = DEFAULT_ENVIRONMENT_BATTLE_PROFILES.map((profile) => profile.id);
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.battleProfile))], expectedProfileIds);

  const outcome = evaluateCandidateMatchOutcome(candidate, scenarios, {
    rules: DEFAULT_RULES,
    solveCompletion,
    turns: 3,
  });
  assert.deepEqual(Object.keys(outcome.tacticalProfiles), expectedProfileIds);
  for (const profile of Object.values(outcome.tacticalProfiles)) {
    assert.equal(profile.scenarioCount, 2);
    assert.ok(Number.isFinite(profile.skillWinGain));
    assert.ok(Number.isFinite(profile.skillActivationRate));
  }
  assert.ok(Number.isFinite(outcome.continuation.winGainPerScenario));
  assert.ok(Number.isFinite(outcome.continuation.carriedWinGainPerScenario));
});

test("continuation value compares the full duration against the same skill limited to one turn", () => {
  const candidate = character("front-buffer", {
    hp: 50,
    pow: 100,
    skill: { type: "attack_buff", multiplier: 2, hits: 1, duration: 2, target: "self", targetCount: 1, conditions: [], effects: [] },
  });
  const reserves = [2, 3, 4, 5].map((position) => character(`reserve-${position}`, {
    hp: 1_000,
    pow: 100,
    skillTurn: 99,
  }));
  const positionPools = [[candidate], ...reserves.map((unit) => [unit])];
  const solveCompletion = createDeckCompletionSolver(positionPools, 100);
  const scenario = {
    state: createBattleState([[candidate]], [[character("enemy", { hp: 2_000, pow: 100 })]]),
    actorIndex: 0,
    position: 1,
    entryCharge: 0,
    battleProfile: "stock-balance",
    targetPolicy: DEFAULT_ENVIRONMENT_BATTLE_PROFILES[0].targetPolicy,
    attackOrderPolicy: DEFAULT_ENVIRONMENT_BATTLE_PROFILES[0].attackOrderPolicy,
    playStyle: DEFAULT_ENVIRONMENT_BATTLE_PROFILES[0].playStyle,
  };
  const outcome = evaluateCandidateMatchOutcome(candidate, [scenario], {
    rules: DEFAULT_RULES,
    solveCompletion,
    turns: 2,
  });

  assert.ok(outcome.continuation.continuedActionRate > 0);
  assert.ok(outcome.continuation.carriedActionRate > 0);
  assert.ok(outcome.continuation.winGainPerScenario > 0);
  assert.ok(outcome.continuation.carriedWinGainPerScenario > 0);
});
