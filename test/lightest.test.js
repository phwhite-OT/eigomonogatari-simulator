import test from "node:test";
import assert from "node:assert/strict";

import {
  findLightestDeck,
  resolveLightestEnemy,
  simulateLightestStage,
} from "../src/core/lightest.js";
import { findExactLightestDeck, solveExactLightestStage } from "../src/core/lightest-exact.js";
import { createManualCharacter } from "../src/data/characters.js";

function character(id, cost, pow = 100, skill = { type: "none" }) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity: "N",
    cost,
    hp: 100,
    baseHp: 100,
    pow,
    basePow: pow,
    owned: true,
    skillTurn: skill.turn ?? 99,
    maxUses: 2,
    skill: {
      type: skill.type,
      multiplier: skill.multiplier ?? 1,
      amount: skill.amount ?? 0,
      hits: skill.hits ?? 1,
      target: skill.target ?? "self",
      targetCount: skill.target === "ally_all" ? 5 : 1,
      duration: skill.duration ?? 1,
      conditions: skill.conditions ?? [],
      effects: skill.effects ?? [],
    },
    skillName: skill.name ?? "なし",
  };
}

test("限定イベントの敵を1体・2体・3体となるよう固定順で補充する", () => {
  const deck = Array.from({ length: 5 }, (_, index) => character(`ally-${index}`, 1, 100));
  const enemies = Array.from({ length: 4 }, (_, index) => resolveLightestEnemy(
    character(`enemy-${index}`, 0, 0),
    { hp: 50, pow: 0, order: index },
  ));
  const result = simulateLightestStage(deck, enemies, {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 3,
  });
  assert.equal(result.threeStar, true);
  assert.equal(result.turnsCompleted, 3);
  assert.deepEqual(result.history.map((turn) => turn.spawned.length), [1, 2, 1]);
  assert.equal(result.final.defeatedEnemies, 4);
});

test("短縮で同じターンに使用可能になった味方スキルを発動する", () => {
  const reducer = character("reducer", 1, 1, {
    type: "skill_reduction",
    turn: 0,
    amount: 2,
    target: "ally_all",
    name: "味方全員のスキルカウントを2減少させる",
  });
  const buffer = character("buffer", 1, 1, {
    type: "attack_buff",
    turn: 2,
    multiplier: 3,
    target: "ally_all",
    name: "味方全員の攻撃力を200%増加させる",
  });
  const deck = [reducer, buffer, character("a", 1), character("b", 1), character("c", 1)];
  const enemy = resolveLightestEnemy(character("enemy", 0, 0), { hp: 1000, pow: 0 });
  const result = simulateLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
  });
  assert.deepEqual(
    result.history[0].skills.filter((event) => event.side === "allies").map((event) => event.skillType),
    ["skill_reduction", "attack_buff"],
  );
});

test("三冠できるデッキを総コスト優先で返し、同じカードも使用できる", async () => {
  const cheap = character("cheap", 1, 100);
  const expensive = character("expensive", 10, 1000);
  const enemy = resolveLightestEnemy(character("enemy", 0, 0), { hp: 100, pow: 0 });
  const result = await findLightestDeck([cheap, expensive], {
    enemies: [enemy],
    maxCost: 100,
    maxTurns: 1,
    allowedAttributes: ["fire"],
    rarities: [],
    eventBonusIds: [],
  }, {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
  });
  assert.equal(result.foundThreeStar, true);
  assert.equal(result.results[0].totalCost, 5);
  assert.deepEqual(result.results[0].deck.map((entry) => entry.id), ["cheap", "cheap", "cheap", "cheap", "cheap"]);
});

test("イベントボーナス対象のHPとPowerを1.5倍にする", () => {
  const bonus = character("bonus", 1, 100);
  const powerless = Array.from({ length: 4 }, (_, index) => character(`zero-${index}`, 1, 0));
  const powerEnemy = resolveLightestEnemy(character("power-enemy", 0, 0), { hp: 90, pow: 0 });
  const powerResult = simulateLightestStage([bonus, ...powerless], [powerEnemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    eventBonusIds: ["bonus"],
    maxTurns: 1,
  });
  assert.equal(powerResult.cleared, true);

  const hpEnemy = resolveLightestEnemy(character("hp-enemy", 0, 150), { hp: 10000, pow: 150 });
  const hpResult = simulateLightestStage([bonus, ...powerless], [hpEnemy], {
    answerMultiplier: 0,
    enemyAttackMultiplier: 1,
    eventBonusIds: ["bonus"],
    maxTurns: 1,
  });
  assert.equal(hpResult.allSurvived, true);
});

test("梅の敵ステータスは無凸Lv最大値の半分を切り捨てる", () => {
  const enemy = resolveLightestEnemy({ ...character("plum", 0, 101), baseHp: 101, basePow: 101 }, {
    difficulty: "plum",
  });
  assert.equal(enemy.hp, 50);
  assert.equal(enemy.pow, 50);
});

test("完全探索は正答・半誤答を分岐し次ターンの最適標的を選べる", () => {
  const buffer = character("buffer", 1, 30, {
    type: "attack_buff",
    turn: 2,
    multiplier: 2,
    target: "ally_all",
    name: "味方全員の攻撃力を100%増加させる",
  });
  const deck = [buffer, ...Array.from({ length: 4 }, (_, index) => character("attacker-" + index, 1, 30))]
    .map((entry) => ({ ...entry, hp: 1000, baseHp: 1000 }));
  const enemies = [
    resolveLightestEnemy(character("enemy-1", 0, 0), { hp: 75, pow: 0, order: 0 }),
    resolveLightestEnemy(character("enemy-2", 0, 90), { hp: 120, pow: 90, order: 1 }),
    resolveLightestEnemy(character("enemy-3", 0, 90), { hp: 120, pow: 90, order: 2 }),
  ];
  const result = solveExactLightestStage(deck, enemies, {
    answerMultiplier: 1,
    enemyAttackMultiplier: 1,
    maxTurns: 3,
    allowHalfAnswer: true,
  });
  assert.equal(result.threeStar, true);
  assert.ok(["full", "half"].includes(result.history[0].answerMode));
  assert.equal(result.history[1].attacks[0].hits[0].targetName, "enemy-2");
  assert.equal(result.history[0].targetAssignments.length, 5);
  assert.deepEqual([...new Set(result.history[0].targetAssignments.map((assignment) => assignment.targetName))], ["enemy-1"]);
  assert.ok(result.exactSearch.battleBranches > 1);
});

test("短縮後に使用可能になるスキルの温存と使用順を完全探索する", () => {
  const reducer = character("exact-reducer", 1, 10, {
    type: "skill_reduction",
    turn: 0,
    amount: 2,
    target: "ally_all",
    name: "味方全員のスキルカウントを2減少させる",
  });
  const buffer = character("exact-buffer", 1, 10, {
    type: "attack_buff",
    turn: 2,
    multiplier: 3,
    target: "ally_all",
    name: "味方全員の攻撃力を200%増加させる",
  });
  const deck = [reducer, buffer, character("x", 1, 10), character("y", 1, 10), character("z", 1, 10)];
  const enemy = resolveLightestEnemy(character("exact-enemy", 0, 0), { hp: 50, pow: 0 });
  const result = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
  });
  assert.equal(result.threeStar, true);
  assert.deepEqual(result.history[0].skills.map((event) => event.skillType), ["skill_reduction", "attack_buff"]);
  assert.deepEqual(result.history[0].skills[0].skill, {
    target: "ally_all",
    multiplier: 1,
    amount: 2,
    hits: 1,
    duration: 1,
    effects: [],
  });
  assert.ok(result.exactSearch.skillBranches >= 2);
});

test("複数ターン回復は発動ターンを含む指定ターン数だけ処理する", () => {
  const healer = character("healer", 1, 20, {
    type: "heal",
    turn: 0,
    multiplier: 1,
    target: "self",
    duration: 3,
    name: "3ターンの間、自身のHPを100%回復する",
  });
  const deck = [healer, ...Array.from({ length: 4 }, (_, index) => character("heal-attacker-" + index, 1, 20))];
  const enemy = resolveLightestEnemy(character("heal-enemy", 0, 180), { hp: 195, pow: 180 });
  const result = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 1,
    maxTurns: 3,
  });
  assert.equal(result.threeStar, true);
  assert.deepEqual(
    result.history.map((turn) => turn.skills.filter((event) => event.skillType === "continuous_heal").length),
    [0, 1, 1],
  );
});

test("幽霊はイベント補正込みPowerの半分で攻撃し敵防御を無視する", () => {
  const ghostSource = character("ghost-source", 1, 100);
  const deck = [ghostSource, ...Array.from({ length: 4 }, (_, index) => character("ghost-zero-" + index, 1, 0))];
  const defender = character("ghost-defender", 0, 225, {
    type: "damage_reduction",
    turn: 0,
    multiplier: 0.1,
    target: "self",
    duration: 3,
    name: "3ターン自身へのダメージを90%カット",
  });
  const enemy = resolveLightestEnemy(defender, { hp: 1000, pow: 225 });
  const result = simulateLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 1,
    eventBonusIds: ["ghost-source"],
    maxTurns: 2,
  });
  const ghostAttack = result.history[1].attacks.find((attack) => attack.actorName === "ghost-source");
  assert.equal(ghostAttack.hits[0].damage, 50);
});


test("梅・竹・松は無凸Lv1値から段階ごとのステータスを使う", () => {
  const source = createManualCharacter({
    name: "難易度ステータス",
    attributeClass: "fire",
    cost: 1,
    hp: 101,
    pow: 99,
    statGrowth: "lv1",
    skillTurn: 0,
  });

  const plum = resolveLightestEnemy(source, { difficulty: "plum" });
  const bamboo = resolveLightestEnemy(source, { difficulty: "bamboo" });
  const pine = resolveLightestEnemy(source, { difficulty: "pine" });

  assert.deepEqual([plum.hp, plum.pow], [101, 99]);
  assert.deepEqual([bamboo.hp, bamboo.pow], [202, 198]);
  assert.deepEqual([pine.hp, pine.pow], [285, 279]);
});


test("指定総コストだけを探索し最初の三冠デッキで終了する", async () => {
  const allies = ["a", "b", "c", "d", "e", "f"].map((id) => character(id, 1, 100));
  const enemy = resolveLightestEnemy(character("target-enemy", 0, 0), { hp: 100, pow: 0 });
  const result = await findLightestDeck(allies, {
    enemies: [enemy],
    targetCost: 5,
    maxCost: 5,
    maxTurns: 1,
    allowedAttributes: ["fire"],
    rarities: [],
    eventBonusIds: [],
  }, {
    allowDuplicates: false,
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
  });

  assert.equal(result.foundThreeStar, true);
  assert.equal(result.targetCost, 5);
  assert.equal(result.searchedThroughCost, 5);
  assert.equal(result.stoppedOnFirstWin, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.simulatedDeckCount, 1);
});

test("指定コストが最大指定コストを超える場合は探索しない", async () => {
  const enemy = resolveLightestEnemy(character("target-enemy", 0, 0), { hp: 100, pow: 0 });
  await assert.rejects(
    findLightestDeck([character("ally", 1, 100)], {
      enemies: [enemy],
      targetCost: 6,
      maxCost: 5,
      maxTurns: 1,
      allowedAttributes: ["fire"],
      rarities: [],
      eventBonusIds: [],
    }),
    /指定コストは最大指定コスト以下/,
  );
});

test("完全探索は味方5人のターゲットを別々に組み合わせる", () => {
  const deck = Array.from({ length: 5 }, (_, index) => character("target-ally-" + index, 1, 15));
  const enemyOne = character("target-enemy-1", 0, 0);
  const enemyTwo = character("target-enemy-2", 0, 0);
  enemyOne.attributes = ["water"];
  enemyTwo.attributes = ["water"];
  const enemies = [
    resolveLightestEnemy(enemyOne, { hp: 42, pow: 0, order: 0 }),
    resolveLightestEnemy(enemyTwo, { hp: 42, pow: 0, order: 1 }),
  ];
  const result = solveExactLightestStage(deck, enemies, {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 2,
  });

  assert.equal(result.threeStar, false);
  assert.ok(result.exactSearch.battleBranches >= 7);
  assert.ok(result.exactSearch.collapsedTargetPlans > 0);
});

test("同時攻撃では先に倒した敵もそのターンの攻撃を行う", () => {
  const deck = [
    character("leader", 1, 100),
    character("reviver", 1, 0, {
      type: "revive",
      turn: 0,
      multiplier: 1,
      target: "leader",
      name: "リーダーを蘇生",
    }),
    ...Array.from({ length: 3 }, (_, index) => character("ally-" + index, 1, 0)),
  ];
  const enemy = resolveLightestEnemy(character("simultaneous-enemy", 0, 150), { hp: 50, pow: 150 });
  const result = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 1,
    maxTurns: 1,
  });

  assert.equal(result.threeStar, true);
  assert.ok(result.history[0].attacks.some((attack) => (
    attack.side === "enemies" && attack.actorName === "simultaneous-enemy"
  )));
  assert.deepEqual(result.history[0].becameGhosts, ["leader"]);
  assert.deepEqual(result.history[0].revives.map((event) => event.targetName), ["leader"]);
});

test("安全な枝刈りは残ターンに収まらない盤面とダメージ不足を打ち切る", () => {
  const deck = Array.from({ length: 5 }, (_, index) => character("prune-ally-" + index, 1, 0));
  const enemy = resolveLightestEnemy(character("prune-enemy", 0, 0), { hp: 1, pow: 0 });
  const damageLimited = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
  });
  const capacityLimited = solveExactLightestStage(deck, [enemy, enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
  });

  assert.equal(damageLimited.threeStar, false);
  assert.equal(damageLimited.exactSearch.battleBranches, 0);
  assert.equal(damageLimited.exactSearch.prunedStates.damageUpperBound, 1);
  assert.equal(capacityLimited.threeStar, false);
  assert.equal(capacityLimited.exactSearch.battleBranches, 0);
  assert.equal(capacityLimited.exactSearch.prunedStates.enemyCapacity, 1);
});


test("並び替え前の安全な火力上限で不可能な組合せを除外する", async () => {
  const attacker = character("upper-bound-attacker", 1, 0);
  const reviver = character("upper-bound-reviver", 1, 0, {
    type: "revive",
    multiplier: 0.5,
    target: "ally_all",
  });
  const enemy = resolveLightestEnemy(character("upper-bound-enemy", 0, 0), { hp: 100 });

  const result = await findExactLightestDeck([attacker, reviver], {
    enemies: [enemy],
    maxCost: 2,
    targetCost: 2,
    deckSize: 2,
    requiredLastSkillType: "revive",
  });

  assert.equal(result.foundThreeStar, false);
  assert.equal(result.simulatedDeckCount, 0);
  assert.ok(result.generatedCombinationCount > 0);
  assert.equal(result.prePrunedCombinationCount, result.generatedCombinationCount);
});

test("standard lightest search skips half answers unless explicitly enabled", () => {
  const deck = Array.from({ length: 5 }, (_, index) => character("answer-ally-" + index, 1, 10));
  const enemy = resolveLightestEnemy(character("answer-enemy", 0, 0), { hp: 40, pow: 0 });
  const standard = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
  });
  const withHalfAnswer = solveExactLightestStage(deck, [enemy], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 1,
    allowHalfAnswer: true,
  });

  assert.equal(standard.threeStar, false);
  assert.equal(standard.exactSearch.battleBranches, 1);
  assert.equal(withHalfAnswer.exactSearch.battleBranches, 2);
});


test("equivalent attacker target collapsing keeps the split-target winning plan", () => {
  const deck = Array.from({ length: 5 }, (_, index) => character("equivalent-ally-" + index, 1, 15));
  const firstEnemy = character("equivalent-enemy-1", 0, 0);
  const secondEnemy = character("equivalent-enemy-2", 0, 0);
  firstEnemy.attributes = ["water"];
  secondEnemy.attributes = ["water"];
  const result = solveExactLightestStage(deck, [
    resolveLightestEnemy(firstEnemy, { hp: 30, pow: 0, order: 0 }),
    resolveLightestEnemy(secondEnemy, { hp: 20, pow: 0, order: 1 }),
  ], {
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    maxTurns: 2,
  });

  assert.equal(result.threeStar, true);
  assert.ok(result.exactSearch.collapsedTargetPlans > 0);
  assert.deepEqual(
    result.history[1].attacks
      .filter((attack) => attack.side === "allies")
      .flatMap((attack) => attack.hits.map((hit) => hit.targetName)),
    ["equivalent-enemy-1", "equivalent-enemy-2", "equivalent-enemy-2", "equivalent-enemy-2", "equivalent-enemy-2"],
  );
});


test("最軽装は指定人数の最後の枠を蘇生に固定し、HP順を適用できる", async () => {
  const highestHp = { ...character("highest-hp", 1, 100), hp: 400, baseHp: 400 };
  const middleHp = { ...character("middle-hp", 1, 100), hp: 300, baseHp: 300 };
  const reviver = { ...character("last-reviver", 1, 0, { type: "revive", turn: 99 }), hp: 50, baseHp: 50 };
  const enemy = resolveLightestEnemy(character("last-revive-enemy", 0, 0), { hp: 100, pow: 0 });
  const result = await findLightestDeck([highestHp, middleHp, reviver], {
    enemies: [enemy],
    deckSize: 3,
    maxCost: 3,
    targetCost: 3,
    maxTurns: 1,
    requiredLastSkillType: "revive",
    orderByHpDescending: true,
  }, { allowDuplicates: false, answerMultiplier: 1, enemyAttackMultiplier: 0 });

  assert.equal(result.foundThreeStar, true);
  assert.equal(result.results[0].deck.length, 3);
  assert.equal(result.results[0].deck.at(-1).skill.type, "revive");
  assert.deepEqual(result.results[0].deck.map((entry) => entry.hp), [400, 300, 50]);
});


test("lightest search automatically compares deck sizes and keeps the cheapest win", async () => {
  const attacker = character("auto-size-attacker", 1, 1_000);
  const reviver = character("auto-size-reviver", 1, 0, { type: "revive", turn: 99 });
  const enemy = resolveLightestEnemy(character("auto-size-enemy", 0, 0), { hp: 50, pow: 0 });
  const result = await findLightestDeck([attacker, reviver], {
    enemies: [enemy],
    deckSizes: [1, 2],
    maxCost: 5,
    maxTurns: 1,
    requiredLastSkillType: "revive",
  }, { allowDuplicates: false, answerMultiplier: 1, enemyAttackMultiplier: 0 });

  assert.equal(result.foundThreeStar, true);
  assert.equal(result.results[0].totalCost, 2);
  assert.equal(result.results[0].deck.length, 2);
  assert.equal(result.results[0].deck.at(-1).skill.type, "revive");
  assert.deepEqual(result.searchedDeckSizes, [1, 2]);
});


test("敵の継続攻撃は倒された後も同じ枠の後続敵へ継承される", () => {
  const ally = character("continuation-ally", 1, 1_000);
  const opener = character("continuation-opener", 0, 10, {
    type: "multi_hit_attack",
    turn: 0,
    hits: 2,
    duration: 3,
    target: "self",
  });
  const replacement = character("continuation-replacement", 0, 10);
  const makeEnemies = () => [
    resolveLightestEnemy(opener, { hp: 30, pow: 10, order: 0 }),
    resolveLightestEnemy(replacement, { hp: 30, pow: 10, order: 1 }),
  ];
  const options = { maxTurns: 2, answerMultiplier: 1, enemyAttackMultiplier: 1 };
  const legacy = simulateLightestStage([ally], makeEnemies(), options);
  const exact = solveExactLightestStage([ally], makeEnemies(), options);
  const replacementAttackType = (result) => result.history[1].attacks.find((action) => (
    action.side === "enemies" && action.actorName === "continuation-replacement"
  ))?.attackType;

  assert.equal(replacementAttackType(legacy), "multi_hit_attack");
  assert.equal(replacementAttackType(exact), "multi_hit_attack");
});

test("最軽装の全人数探索は総コストの低い順に進める", async () => {
  const expensiveReviver = character("cost-order-expensive-reviver", 5, 1_000, { type: "revive", turn: 99 });
  const cheapAttacker = character("cost-order-attacker", 1, 1_000);
  const cheapReviver = character("cost-order-reviver", 1, 0, { type: "revive", turn: 99 });
  const enemy = resolveLightestEnemy(character("cost-order-enemy", 0, 0), { hp: 50, pow: 0 });
  const observedCosts = [];
  const result = await findLightestDeck([expensiveReviver, cheapAttacker, cheapReviver], {
    enemies: [enemy],
    deckSizes: [1, 2],
    maxCost: 6,
    maxTurns: 1,
    requiredLastSkillType: "revive",
  }, {
    allowDuplicates: false,
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    onProgress: (progress) => {
      if (progress.completed === 0 && progress.combinations === 0) observedCosts.push(progress.cost);
    },
  });

  assert.equal(result.foundThreeStar, true);
  assert.equal(result.results[0].totalCost, 2);
  assert.equal(result.results[0].deck.length, 2);
  assert.ok(observedCosts.indexOf(2) >= 0);
  assert.ok(observedCosts.indexOf(5) === -1 || observedCosts.indexOf(2) < observedCosts.indexOf(5));
});

test("lightest progress reports the exact valid combination count", async () => {
  const attackerOne = character("progress-attacker-one", 1, 1_000);
  const attackerTwo = character("progress-attacker-two", 1, 1_000);
  const reviver = character("progress-reviver", 1, 0, { type: "revive", turn: 99 });
  const enemy = resolveLightestEnemy(character("progress-enemy", 0, 0), { hp: 100_000, pow: 0 });
  const progressEvents = [];

  await findLightestDeck([attackerOne, attackerTwo, reviver], {
    enemies: [enemy],
    deckSizes: [2],
    maxCost: 2,
    targetCost: 2,
    maxTurns: 1,
    requiredLastSkillType: "revive",
  }, {
    allowDuplicates: false,
    answerMultiplier: 1,
    enemyAttackMultiplier: 0,
    onProgress: (progress) => progressEvents.push(progress),
  });

  const initialProgress = progressEvents.find((progress) => (
    progress.cost === 2 && progress.combinations === 0 && !progress.taskCompleted
  ));
  assert.equal(initialProgress.totalCombinations, 2);
});
