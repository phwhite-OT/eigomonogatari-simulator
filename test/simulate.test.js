import test from "node:test";
import assert from "node:assert/strict";
import { createBattleState } from "../src/core/battleState.js";
import {
  ATTACK_ORDER_POLICIES,
  scoreSimulationResult,
  selectPriorityTarget,
  simulateBattle,
  TARGET_POLICIES,
} from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(id, overrides = {}) {
  return {
    id,
    name: id,
    attributes: overrides.attributes ?? ["fire"],
    cost: 1,
    hp: overrides.hp ?? 1000,
    pow: overrides.pow ?? 100,
    skillTurn: overrides.skillTurn ?? 99,
    maxUses: overrides.maxUses ?? 2,
    skill: overrides.skill ?? { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
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
        ["fire", "water", "wind"].map((defense) => [`${attack}:${defense}`, 1]),
      ),
    ),
  },
});

test("3ターン対戦は通常攻撃と生存補正を順番に適用する", () => {
  const state = createBattleState(
    [character("ally")],
    [character("enemy")],
  );
  const result = simulateBattle(state, simpleRules, { turns: 3 });

  assert.equal(result.turnsCompleted, 3);
  assert.equal(result.state.turn, 4);
  assert.equal(result.state.allies[0].currentHp, 601);
  assert.equal(result.state.enemies[0].currentHp, 601);
  assert.equal(result.history.flatMap(({ actions }) => actions).length, 6);
  assert.deepEqual(
    result.history[0].phases.map(({ id }) => id),
    ["skill_selection", "attribute_change", "healing", "attack_support", "defense", "attack", "revive", "replacement"],
  );
});

test("支援スキルを攻撃前に発動し、選択理由と攻撃を別々に記録する", () => {
  const buffSkill = {
    type: "attack_buff",
    multiplier: 2,
    target: "self",
    duration: 2,
    conditions: [],
  };
  const state = createBattleState(
    [character("buffer", { skillTurn: 0, skill: buffSkill })],
    [character("enemy", { pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.state.enemies[0].currentHp, 800);
  assert.equal(result.state.allies[0].skillUses, 1);
  assert.equal(result.history[0].actions[0].action, "basic_attack");
  assert.equal(result.history[0].phases[0].events[0].type, "skill_use");
  assert.equal(result.history[0].phases[3].events[0].skillType, "attack_buff");
  const hit = result.history[0].actions[0].hits[0];
  assert.equal(hit.damageRaw, 200);
  assert.equal(hit.rounding, "floor");
  assert.equal(hit.factors.pow, 100);
  assert.equal(hit.factors.attack, 2);
  assert.equal(hit.survivalTurns, 0);
  assert.equal(hit.attribute.multiplier, 1);
});

test("ターン開始後に交代した控えキャラは同じターンに行動しない", () => {
  const state = createBattleState(
    [character("attacker", { pow: 1000 })],
    [[
      character("first", { hp: 500, pow: 500 }),
      character("reserve", { hp: 500, pow: 500 }),
    ]],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.state.enemies[0].deckIndex, 1);
  assert.equal(result.state.enemies[0].currentHp, 500);
  assert.equal(result.state.allies[0].currentHp, 500);
  assert.equal(result.history[0].actions.length, 2);
  assert.equal(result.history[0].actions[1].actorName, "first");
});

test("両チームの攻撃者は途中で倒されても攻撃し、相打ちは引き分けになる", () => {
  const state = createBattleState(
    [character("ally", { hp: 500, pow: 1000 })],
    [character("enemy", { hp: 500, pow: 1000 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.outcome, "draw");
  assert.equal(result.state.allies[0].isGhost, true);
  assert.equal(result.state.enemies[0].isGhost, true);
  assert.equal(result.history[0].actions.length, 2);
  assert.equal(scoreSimulationResult(result), 57.5);
});

test("後ろの味方が使う全員バフも全員の攻撃前に適用する", () => {
  const teamBuff = {
    type: "attack_buff",
    multiplier: 2,
    target: "ally_all",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("first-attacker", { pow: 100 }),
      character("later-buffer", { pow: 0, skillTurn: 0, skill: teamBuff }),
    ],
    [character("enemy", { hp: 1000, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });
  const firstAttack = result.history[0].actions.find(({ actorName }) => actorName === "first-attacker");

  assert.equal(firstAttack.hits[0].damage, 200);
  assert.equal(result.state.enemies[0].currentHp, 800);
});

test("控えは登場した直後の攻撃で生存補正を受けない", () => {
  const state = createBattleState(
    [[
      character("front", { hp: 50, pow: 0 }),
      character("reserve", { hp: 1_000, pow: 100 }),
    ]],
    [character("enemy", { hp: 10_000, pow: 100 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 2 });
  const reserveAttack = result.history[1].actions.find(({ actorName }) => actorName === "reserve");

  assert.equal(reserveAttack.hits[0].factors.survival, 1);
  assert.equal(reserveAttack.hits[0].survivalTurns, 0);
});

test("連撃スキルの発動ターンは指定ヒット数だけ攻撃する", () => {
  const multiHit = {
    type: "multi_hit_attack",
    multiplier: 1,
    hits: 6,
    target: "self",
    duration: 2,
    conditions: [],
  };
  const state = createBattleState(
    [character("six-hit", { pow: 100, skillTurn: 0, maxUses: 2, skill: multiHit })],
    [character("target", { hp: 10_000, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 2 });
  const attacks = result.history.flatMap(({ actions }) => actions).filter(({ actorName }) => actorName === "six-hit");

  assert.deepEqual(attacks.map(({ hits }) => hits.length), [6, 6]);
});

test("同じシナリオ種なら連撃のランダムな余剰ヒット先を再現する", () => {
  const multiHit = {
    type: "multi_hit_attack",
    multiplier: 1,
    hits: 3,
    target: "self",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [character("multi", { pow: 100, skillTurn: 0, skill: multiHit })],
    [
      character("primary", { hp: 50, pow: 0 }),
      character("second", { hp: 1_000, pow: 0 }),
      character("third", { hp: 1_000, pow: 0 }),
    ],
  );
  const first = simulateBattle(state, simpleRules, { turns: 1, randomSeed: "team-7" });
  const second = simulateBattle(state, simpleRules, { turns: 1, randomSeed: "team-7" });
  const hitIndexes = (result) => result.history[0].actions.find(({ actorName }) => actorName === "multi").hits.map(({ targetIndex }) => targetIndex);

  assert.deepEqual(hitIndexes(first), hitIndexes(second));
  assert.equal(hitIndexes(first)[0], 0);
  assert.equal(first.history[0].actions.find(({ actorName }) => actorName === "multi").hits[1].targetMode, "random_after_defeat");
});

test("蘇生は攻撃後・交代前に解決し、同じキャラへ一度だけ適用する", () => {
  const revive = {
    type: "revive",
    multiplier: 0.5,
    target: "leader",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("leader", { hp: 500, pow: 0 }),
      character("reviver", { hp: 100, pow: 0, skillTurn: 0, skill: revive }),
    ],
    [character("enemy", { hp: 1000, pow: 1000 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });
  const revived = result.state.allies[0];
  const revivePhase = result.history[0].phases.find(({ id }) => id === "revive");

  assert.equal(revived.character.name, "leader");
  assert.equal(revived.currentHp, 250);
  assert.equal(revived.reviveUsed, true);
  assert.equal(revivePhase.events[0].changes.some(({ revived: value }) => value), true);
  assert.equal(result.history[0].phases.at(-1).events.length, 0);
});

test("回復は他の味方が蘇生対象でも温存しない", () => {
  const heal = {
    type: "heal",
    multiplier: 0.5,
    target: "leader",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("revive-target", { hp: 500, pow: 0 }),
      character("healer", { hp: 1_000, pow: 0, skillTurn: 0, skill: heal }),
    ],
    [character("lethal-enemy", { hp: 10_000, pow: 1_000 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const selection = result.history[0].phases.find(({ id }) => id === "skill_selection");
  const event = selection.events.find(({ actorName }) => actorName === "healer");

  assert.equal(event.type, "skill_use");
  assert.equal(event.reason, "現在ターンの実回復量があるため使用");
});

test("回復が蘇生対象を生存圏へ戻せる場合は使用する", () => {
  const heal = {
    type: "heal",
    multiplier: 0.8,
    target: "leader",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("saved-target", { hp: 1_000, pow: 0 }),
      character("healer", { hp: 1_000, pow: 0, skillTurn: 0, skill: heal }),
    ],
    [character("enemy", { hp: 10_000, pow: 900 })],
  );
  state.allies[0].currentHp = 200;
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });
  const selection = result.history[0].phases.find(({ id }) => id === "skill_selection");
  const event = selection.events.find(({ actorName }) => actorName === "healer");

  assert.equal(event.type, "skill_use");
  assert.equal(event.reason, "現在ターンの実回復量があるため使用");
  assert.equal(result.state.allies[1].skillUses, 1);
});



test("全方針で倒しやすさより残り枚数の多い相手を優先する", () => {
  const state = createBattleState(
    [character("attacker", { pow: 100 })],
    [
      [character("many", { hp: 1000 }), ...Array.from({ length: 4 }, (_, index) => character(`many-reserve-${index}`))],
      [character("killable", { hp: 50 }), character("one-reserve")],
    ],
  );

  assert.equal(selectPriorityTarget(state, "allies", {
    actorIndex: 0,
    rules: simpleRules,
    targetPolicy: TARGET_POLICIES.BALANCE,
  }), 0);
  assert.equal(selectPriorityTarget(state, "allies", {
    actorIndex: 0,
    rules: simpleRules,
    targetPolicy: TARGET_POLICIES.KILL_CONFIRM,
  }), 0);
});

test("スキル脅威方針は残数が同じなら発動の近い相手を優先する", () => {
  const state = createBattleState(
    [character("attacker", { pow: 100 })],
    [
      character("late-skill", { hp: 1000, skillTurn: 5 }),
      character("soon-skill", { hp: 1000, skillTurn: 1 }),
    ],
  );

  assert.equal(selectPriorityTarget(state, "allies", {
    actorIndex: 0,
    rules: simpleRules,
    targetPolicy: TARGET_POLICIES.SKILL_THREAT,
  }), 1);
});

test("火力順方針では推定ダメージが高い味方から攻撃する", () => {
  const state = createBattleState(
    [character("weak", { pow: 100 }), character("strong", { pow: 300 })],
    [character("enemy", { hp: 2000, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
  });

  assert.equal(result.history[0].actions[0].actorName, "strong");
  assert.equal(result.history[0].actions[1].actorName, "weak");
});


test("火力順方針は連続攻撃の合計ダメージで攻撃順を決める", () => {
  const multiHit = {
    type: "multi_hit_attack",
    multiplier: 1,
    hits: 4,
    duration: 1,
  };
  const state = createBattleState(
    [
      character("multi", { pow: 100, skillTurn: 0, skill: multiHit }),
      character("single", { pow: 300 }),
    ],
    [character("enemy", { hp: 3000, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
  });

  assert.equal(result.history[0].actions[0].actorName, "multi");
  assert.equal(result.history[0].actions[1].actorName, "single");
});


test("2枠目以降は使用可能な攻撃スキルを原則すぐ使う", () => {
  const neutralMultiHit = {
    type: "multi_hit_attack",
    multiplier: 1,
    hits: 1,
    target: "enemy_one",
    duration: 1,
    conditions: [],
  };
  const firstState = createBattleState(
    [character("first", { skillTurn: 0, skill: neutralMultiHit })],
    [character("enemy-first", { pow: 0 })],
  );
  const laterState = createBattleState(
    [character("later", { skillTurn: 0, skill: neutralMultiHit })],
    [character("enemy-later", { pow: 0 })],
  );
  laterState.allies[0].environmentPosition = 2;

  const first = simulateBattle(firstState, simpleRules, { turns: 1 });
  const later = simulateBattle(laterState, simpleRules, { turns: 1 });

  assert.equal(first.state.allies[0].skillUses, 0);
  assert.equal(later.state.allies[0].skillUses, 1);
  assert.match(later.history[0].phases[0].events[0].reason, /2枠目以降/);
});


test("環境対戦は継続バフを次枠へ渡して次ターンの攻撃へ適用する", () => {
  const continuousBuff = {
    type: "attack_buff",
    multiplier: 2,
    target: "self",
    duration: 2,
    conditions: [],
  };
  const state = createBattleState(
    [[
      character("front-buffer", { hp: 50, pow: 100, skillTurn: 0, skill: continuousBuff }),
      character("reserve-attacker", { hp: 100, pow: 100 }),
    ]],
    [[character("enemy", { hp: 1_000, pow: 100 })]],
  );
  const result = simulateBattle(state, simpleRules, { turns: 2 });
  const reserveAction = result.history[1].actions.find((action) => (
    action.side === "allies" && action.actorName === "reserve-attacker"
  ));

  assert.equal(result.history[0].phases.at(-1).events[0].type, "replacement");
  assert.equal(reserveAction.hits[0].damage, 200);
  assert.equal(reserveAction.hits[0].survivalTurns, 0);
  assert.deepEqual(result.metrics.continuation.bySource["front-buffer"], {
    attackHits: 1,
    carriedAttackHits: 1,
    defenseHits: 0,
    carriedDefenseHits: 0,
  });
});


test("expert target policy prioritizes stock balancing over a killable short stack", () => {
  const state = createBattleState(
    [character("attacker", { pow: 100 })],
    [
      [character("many", { hp: 1_000 }), ...Array.from({ length: 4 }, (_, index) => character(`many-${index}`))],
      [character("killable", { hp: 50 }), character("reserve")],
    ],
  );

  assert.equal(selectPriorityTarget(state, "allies", {
    actorIndex: 0,
    rules: simpleRules,
    targetPolicy: TARGET_POLICIES.EXPERT,
  }), 0);
});

test("expert play holds a continuous buff with no matching attribute target", () => {
  const conditionalBuff = {
    type: "attack_buff",
    multiplier: 2,
    target: "self",
    duration: 2,
    conditions: [{ type: "enemy_attribute", attribute: "water" }],
  };
  const state = createBattleState(
    [character("buffer", { skillTurn: 0, skill: conditionalBuff })],
    [character("fire-enemy", { attributes: ["fire"], pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: "expert",
  });

  assert.equal(result.state.allies[0].skillUses, 0);
  assert.equal(result.history[0].phases[0].events[0].type, "skill_hold");
});


test("継続全体攻撃は次ターンも全敵へ適用され、継続実績として記録する", () => {
  const continuousAoe = {
    type: "aoe_attack",
    multiplier: 1,
    target: "enemy_all",
    targetCount: 5,
    duration: 2,
    hits: 1,
    conditions: [],
  };
  const state = createBattleState(
    [character("aoe", { skillTurn: 0, skill: continuousAoe })],
    [character("enemy-a", { hp: 1_000, pow: 0 }), character("enemy-b", { hp: 1_000, pow: 0 })],
  );
  const result = simulateBattle(state, simpleRules, {
    turns: 2,
    skillPolicy: ({ state: turnState }) => ({ use: turnState.turn === 1, reason: "test" }),
  });

  assert.equal(result.history[0].actions[0].hits.length, 2);
  assert.equal(result.history[1].actions[0].hits.length, 2);
  assert.deepEqual(result.metrics.continuation.bySource.aoe, {
    attackHits: 2,
    carriedAttackHits: 0,
    defenseHits: 0,
    carriedDefenseHits: 0,
  });
});

test("同じターンの色変更後も、色蘇生の対象は現在属性で判定する", () => {
  const changeToFire = {
    type: "attribute_change",
    multiplier: 1,
    target: "leader",
    duration: 1,
    conditions: [],
    effects: [{ attribute: "fire" }],
  };
  const waterRevive = {
    type: "revive",
    multiplier: 1,
    target: "leader",
    duration: 1,
    conditions: [{ type: "ally_attribute", attribute: "water" }],
  };
  const state = createBattleState(
    [
      character("water-leader", { hp: 100, attributes: ["water"], pow: 0 }),
      character("changer", { skillTurn: 0, skill: changeToFire, pow: 0 }),
      character("water-reviver", { skillTurn: 0, skill: waterRevive, pow: 0 }),
    ],
    [character("enemy", { pow: 200 })],
  );

  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.state.allies[2].skillUses, 0);
  assert.equal(result.history[0].phases[0].events.find(({ actorName }) => actorName === "water-reviver")?.type, "skill_hold");
});

test("回復は自身がこのターンに蘇生されるときだけ温存する", () => {
  const heal = {
    type: "heal",
    multiplier: 0.5,
    target: "self",
    duration: 1,
    conditions: [],
  };
  const revive = {
    type: "revive",
    multiplier: 1,
    target: "leader",
    duration: 1,
    conditions: [],
  };
  const state = createBattleState(
    [
      character("healer", { hp: 100, skillTurn: 0, skill: heal, pow: 0 }),
      character("ready-reviver", { skillTurn: 0, skill: revive, pow: 0 }),
    ],
    [character("enemy", { pow: 200 })],
  );

  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: "expert" });

  assert.equal(result.state.allies[0].skillUses, 0);
  assert.equal(result.state.allies[1].skillUses, 1);
  assert.match(result.history[0].phases[0].events.find(({ actorName }) => actorName === "healer")?.reason, /自身が蘇生対象/);
});

test("かばう役には高火力の攻撃者を先に当てる", () => {
  const state = createBattleState(
    [character("weak", { pow: 100 }), character("strong", { pow: 300 })],
    [character("protected", { pow: 0 }), character("guard", { hp: 1_000, pow: 0 })],
  );
  state.enemies[1].buffs = [{ type: "guard", multiplier: 1, remainingTurns: 1, conditions: [], activationOrder: 1 }];

  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: "expert",
  });

  assert.equal(result.history[0].actions[0].actorName, "strong");
  assert.equal(result.history[0].actions[0].hits[0].targetName, "guard");
});

test("瀕死のかばう役は必要十分な火力で先に倒す", () => {
  const state = createBattleState(
    [character("weak", { pow: 100 }), character("strong", { pow: 300 })],
    [character("protected", { pow: 0 }), character("guard", { hp: 1_000, pow: 0 })],
  );
  state.enemies[1].currentHp = 50;
  state.enemies[1].buffs = [{ type: "guard", multiplier: 1, remainingTurns: 1, conditions: [], activationOrder: 1 }];

  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: "expert",
  });

  assert.equal(result.history[0].actions[0].actorName, "weak");
  assert.equal(result.history[0].actions[0].hits[0].targetName, "guard");
});

test("色かばうの対象外の攻撃者は、直接かばう役を狙う", () => {
  const state = createBattleState(
    [character("water-attacker", { pow: 300, attributes: ["water"] }), character("fire-attacker", { pow: 100, attributes: ["fire"] })],
    [character("protected", { pow: 0 }), character("water-guard", { hp: 1_000, pow: 0 })],
  );
  state.enemies[1].buffs = [{
    type: "attribute_guard",
    multiplier: 1,
    remainingTurns: 1,
    conditions: [{ type: "enemy_attribute", attribute: "water" }],
    activationOrder: 1,
  }];

  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: "expert",
  });

  assert.equal(result.history[0].actions[0].actorName, "fire-attacker");
  assert.equal(result.history[0].actions[0].targetIndex, 1);
  assert.equal(result.history[0].actions[0].hits[0].targetName, "water-guard");
});
