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



test("残数平準化方針は倒しやすさより残り枚数の多い相手を優先する", () => {
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
  }), 1);
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
  assert.equal(reserveAction.hits[0].damage, 260);
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

test("属性変更後に倒れたキャラは変更後の属性だけで蘇生対象を判定する", () => {
  const changeToFire = {
    type: "attribute_change", multiplier: 1, target: "self", duration: 2, conditions: [],
    effects: [{ attribute: "fire" }],
  };
  const waterRevive = {
    type: "revive", multiplier: 0.5, target: "ally_all", duration: 1,
    conditions: [{ type: "ally_attribute", attribute: "water" }],
  };
  const state = createBattleState(
    [
      character("changed", { attributes: ["water"], hp: 500, pow: 0, skillTurn: 0, skill: changeToFire }),
      character("reviver", { hp: 2_000, pow: 0, skillTurn: 0, skill: waterRevive }),
    ],
    [character("enemy", { hp: 2_000, pow: 1_000 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.state.allies[0].isGhost, true);
  const reviveDecision = result.history[0].phases[0].events.find(({ actorName }) => actorName === "reviver");
  assert.equal(reviveDecision.type, "skill_hold");
  assert.match(reviveDecision.reason, /蘇生対象の撃破予測がない/);
});

test("属性変更後の属性に一致する蘇生を受けても変更属性を維持する", () => {
  const changeToFire = {
    type: "attribute_change", multiplier: 1, target: "self", duration: 2, conditions: [],
    effects: [{ attribute: "fire" }],
  };
  const fireRevive = {
    type: "revive", multiplier: 0.5, target: "ally_all", duration: 1,
    conditions: [{ type: "ally_attribute", attribute: "fire" }],
  };
  const state = createBattleState(
    [
      character("changed", { attributes: ["water"], hp: 500, pow: 0, skillTurn: 0, skill: changeToFire }),
      character("reviver", { hp: 2_000, pow: 0, skillTurn: 0, skill: fireRevive }),
    ],
    [character("enemy", { hp: 2_000, pow: 1_000 })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1 });

  assert.equal(result.state.allies[0].alive, true);
  assert.equal(result.state.allies[0].reviveUsed, true);
  assert.deepEqual(result.state.allies[0].attributes, ["fire"]);
});

test("かばう役は高火力で優先して倒し、瀕死なら十分な低火力を先に使う", () => {
  const state = createBattleState(
    [character("weak", { pow: 100 }), character("strong", { pow: 400 })],
    [character("guard", { hp: 500, pow: 0 }), character("other", { hp: 2_000, pow: 0 })],
  );
  state.enemies[0].buffs.push({ type: "guard", multiplier: 1, conditions: [], activationOrder: 1 });
  const healthy = simulateBattle(state, simpleRules, {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
  });
  assert.equal(healthy.history[0].actions[0].actorName, "strong");
  assert.equal(healthy.history[0].actions[0].targetIndex, 0);

  state.enemies[0].currentHp = 100;
  const nearlyDefeated = simulateBattle(state, simpleRules, {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
  });
  assert.equal(nearlyDefeated.history[0].actions[0].actorName, "weak");
});

test("属性かばうは対象外属性のキャラが先にかばう役を攻撃する", () => {
  const state = createBattleState(
    [
      character("fire-strong", { attributes: ["fire"], pow: 500 }),
      character("water-weak", { attributes: ["water"], pow: 100 }),
    ],
    [character("fire-guard", { hp: 1_000, pow: 0 }), character("other", { hp: 2_000, pow: 0 })],
  );
  state.enemies[0].buffs.push({
    type: "attribute_guard",
    multiplier: 1,
    conditions: [{ type: "enemy_attribute", attribute: "fire" }],
    activationOrder: 1,
  });
  const result = simulateBattle(state, simpleRules, {
    turns: 1,
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
  });

  assert.equal(result.history[0].actions[0].actorName, "water-weak");
  assert.equal(result.history[0].actions[0].targetIndex, 0);
});

test("回復は使用可能な蘇生が自身に成立するターンだけ温存する", () => {
  const heal = { type: "heal", multiplier: 0.5, target: "self", duration: 1, conditions: [] };
  const revive = { type: "revive", multiplier: 0.5, target: "ally_all", duration: 1, conditions: [] };
  const createState = (reviveTurn) => {
    const state = createBattleState(
      [
        character("healer", { hp: 500, pow: 0, skillTurn: 0, skill: heal }),
        character("reviver", { hp: 2_000, pow: 0, skillTurn: reviveTurn, skill: revive }),
      ],
      [character("enemy", { hp: 2_000, pow: 1_000 })],
    );
    state.allies[0].currentHp = 250;
    return state;
  };
  const unavailable = simulateBattle(createState(1), simpleRules, { turns: 1, playStyle: "expert" });
  const available = simulateBattle(createState(0), simpleRules, { turns: 1, playStyle: "expert" });

  assert.equal(unavailable.history[0].phases[0].events.find(({ actorName }) => actorName === "healer").type, "skill_use");
  assert.equal(available.history[0].phases[0].events.find(({ actorName }) => actorName === "healer").type, "skill_hold");
  assert.match(available.history[0].phases[0].events.find(({ actorName }) => actorName === "healer").reason, /自身が蘇生対象/);
});
