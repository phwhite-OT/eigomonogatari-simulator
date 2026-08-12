import test from "node:test";
import assert from "node:assert/strict";
import { advanceTurn, createBattleState } from "../src/core/battleState.js";
import { applySkill } from "../src/core/skills.js";
import { simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(name, { pow = 100, hp = 1000, attributes = ["fire"], skill } = {}) {
  return {
    id: name,
    name,
    pow,
    hp,
    attributes,
    roleTags: [],
    skillTurn: 0,
    maxUses: 2,
    skill: skill ?? { type: "single_attack", multiplier: 1, duration: 1, hits: 1 },
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

test("攻撃時に攻撃バフ乗算と防御効果の段階減衰を適用する", () => {
  const state = createBattleState(
    [character("attacker")],
    [character("defender")],
  );
  state.allies[0].buffs = [
    { type: "attack_buff", multiplier: 2, remainingTurns: 1 },
    { type: "attack_buff", multiplier: 3, remainingTurns: 1 },
  ];
  state.enemies[0].buffs = [
    { type: "damage_reduction", multiplier: 0.5, remainingTurns: 1 },
    { type: "guard", multiplier: 0.2, remainingTurns: 1 },
  ];

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 916);
  assert.equal(next.allies[0].skillUses, 1);
  assert.equal(state.enemies[0].currentHp, 1000);
});

test("全体攻撃は生存中の各敵を一度ずつ攻撃する", () => {
  const attacker = character("aoe", {
    skill: { type: "aoe_attack", multiplier: 1, duration: 1, hits: 1 },
  });
  const state = createBattleState(
    [attacker],
    [character("left"), character("right")],
  );

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 900);
  assert.equal(next.enemies[1].currentHp, 900);
});

test("連続攻撃は指定回数だけ同じ計算を適用する", () => {
  const attacker = character("multi", {
    skill: { type: "multi_hit_attack", multiplier: 1, duration: 1, hits: 3 },
  });
  const state = createBattleState([attacker], [character("target")]);

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 700);
});
test("自身・リーダー・味方全員の対象範囲を区別する", () => {
  const selfSkill = { type: "attack_buff", multiplier: 2, duration: 1, target: "self", conditions: [] };
  const leaderSkill = { type: "attack_buff", multiplier: 2, duration: 1, target: "leader", conditions: [] };
  const allSkill = { type: "attack_buff", multiplier: 2, duration: 1, target: "ally_all", conditions: [] };

  const selfState = createBattleState(
    [character("self", { skill: selfSkill }), character("ally")],
    [character("enemy")],
  );
  const selfResult = applySkill(selfState, "allies", 0, simpleRules);
  assert.deepEqual(selfResult.allies.map((combatant) => combatant.buffs.length), [1, 0]);

  const leaderState = createBattleState(
    [character("leader"), character("supporter", { skill: leaderSkill })],
    [character("enemy")],
  );
  const leaderResult = applySkill(leaderState, "allies", 1, simpleRules);
  assert.deepEqual(leaderResult.allies.map((combatant) => combatant.buffs.length), [1, 0]);

  const allState = createBattleState(
    [character("supporter", { skill: allSkill }), character("ally")],
    [character("enemy")],
  );
  const allResult = applySkill(allState, "allies", 0, simpleRules);
  assert.deepEqual(allResult.allies.map((combatant) => combatant.buffs.length), [1, 1]);
});

test("攻撃バフは味方属性と敵属性の両条件を攻撃時に判定する", () => {
  const state = createBattleState(
    [character("attacker", { attributes: ["fire"] })],
    [character("defender", { attributes: ["wind"] })],
  );
  state.allies[0].buffs = [
    {
      type: "attack_buff",
      multiplier: 2,
      remainingTurns: 1,
      conditions: [{ type: "ally_attribute", attribute: "fire" }],
    },
    {
      type: "attack_buff",
      multiplier: 3,
      remainingTurns: 1,
      conditions: [{ type: "enemy_attribute", attribute: "wind" }],
    },
  ];

  const bothMatch = applySkill(state, "allies", 0, simpleRules);
  assert.equal(bothMatch.enemies[0].currentHp, 400);

  state.allies[0].attributes = ["water"];
  const enemyOnly = applySkill(state, "allies", 0, simpleRules);
  assert.equal(enemyOnly.enemies[0].currentHp, 700);

  state.allies[0].attributes = ["fire"];
  state.enemies[0].attributes = ["water"];
  const allyOnly = applySkill(state, "allies", 0, simpleRules);
  assert.equal(allyOnly.enemies[0].currentHp, 800);
});

test("防御効果は防御側属性と攻撃側属性の両条件を判定する", () => {
  const createState = (attackerAttributes, defenderAttributes) => {
    const state = createBattleState(
      [character("attacker", { attributes: attackerAttributes })],
      [character("defender", { attributes: defenderAttributes })],
    );
    state.enemies[0].buffs = [{
      type: "damage_reduction",
      multiplier: 0.5,
      remainingTurns: 1,
      conditions: [
        { type: "ally_attribute", attribute: "water" },
        { type: "enemy_attribute", attribute: "wind" },
      ],
    }];
    return state;
  };

  const bothMatch = applySkill(createState(["wind"], ["water"]), "allies", 0, simpleRules);
  assert.equal(bothMatch.enemies[0].currentHp, 950);

  const wrongAttacker = applySkill(createState(["fire"], ["water"]), "allies", 0, simpleRules);
  assert.equal(wrongAttacker.enemies[0].currentHp, 900);

  const wrongDefender = applySkill(createState(["wind"], ["fire"]), "allies", 0, simpleRules);
  assert.equal(wrongDefender.enemies[0].currentHp, 900);
});
test("かばうは単体攻撃を使用者へリダイレクトする", () => {
  const state = createBattleState(
    [character("attacker")],
    [character("protected"), character("guard")],
  );
  state.enemies[1].buffs = [{
    type: "guard",
    multiplier: 0.5,
    remainingTurns: 1,
    conditions: [],
    activationOrder: 1,
  }];

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 1000);
  assert.equal(next.enemies[1].currentHp, 950);
});

test("色かばうは攻撃側の現在属性が一致するときだけ有効になる", () => {
  const createState = (attributes) => {
    const state = createBattleState(
      [character("attacker", { attributes })],
      [character("protected"), character("color-guard")],
    );
    state.enemies[1].buffs = [{
      type: "attribute_guard",
      multiplier: 0.5,
      remainingTurns: 1,
      conditions: [{ type: "enemy_attribute", attribute: "wind" }],
      activationOrder: 1,
    }];
    return state;
  };

  const matched = applySkill(createState(["wind"]), "allies", 0, simpleRules);
  assert.equal(matched.enemies[0].currentHp, 1000);
  assert.equal(matched.enemies[1].currentHp, 950);

  const unmatched = applySkill(createState(["fire"]), "allies", 0, simpleRules);
  assert.equal(unmatched.enemies[0].currentHp, 900);
  assert.equal(unmatched.enemies[1].currentHp, 1000);
});

test("複数のかばうは後から発動した該当効果を優先する", () => {
  const allGuardSkill = {
    type: "guard",
    multiplier: 0.5,
    duration: 1,
    target: "self",
    conditions: [],
  };
  const fireGuardSkill = {
    type: "attribute_guard",
    multiplier: 0.5,
    duration: 1,
    target: "self",
    conditions: [{ type: "enemy_attribute", attribute: "fire" }],
  };
  const initial = createBattleState(
    [character("fire-attacker")],
    [
      character("all-guard", { skill: allGuardSkill }),
      character("fire-guard", { skill: fireGuardSkill }),
      character("protected"),
    ],
  );

  const allThenColor = applySkill(
    applySkill(initial, "enemies", 0, simpleRules),
    "enemies",
    1,
    simpleRules,
  );
  const colorWins = applySkill(allThenColor, "allies", 0, simpleRules);
  assert.equal(colorWins.enemies[0].currentHp, 1000);
  assert.equal(colorWins.enemies[1].currentHp, 950);

  const colorThenAll = applySkill(
    applySkill(initial, "enemies", 1, simpleRules),
    "enemies",
    0,
    simpleRules,
  );
  const allWins = applySkill(colorThenAll, "allies", 0, simpleRules);
  assert.equal(allWins.enemies[0].currentHp, 950);
  assert.equal(allWins.enemies[1].currentHp, 1000);
});

test("かわすは攻撃をリーダーへリダイレクトする", () => {
  const dodgeSkill = {
    type: "guard",
    multiplier: 0.5,
    duration: 1,
    target: "leader",
    conditions: [],
  };
  const state = createBattleState(
    [character("attacker")],
    [character("leader"), character("dodger", { skill: dodgeSkill })],
  );
  const guarded = applySkill(state, "enemies", 1, simpleRules);
  const next = applySkill(guarded, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 950);
  assert.equal(next.enemies[1].currentHp, 1000);
});

test("全体攻撃がかばわれた場合はかばう役へ1体分だけ当てて終了する", () => {
  const aoe = character("aoe", {
    skill: { type: "aoe_attack", multiplier: 1, duration: 1, hits: 1 },
  });
  const createState = (guardHp) => {
    const state = createBattleState(
      [aoe],
      [
        character("guard", { hp: guardHp }),
        character("protected-left"),
        character("protected-right"),
      ],
    );
    state.enemies[0].buffs = [{
      type: "guard",
      multiplier: 0.5,
      remainingTurns: 1,
      conditions: [],
      activationOrder: 1,
    }];
    return state;
  };

  const survived = applySkill(createState(250), "allies", 0, simpleRules);
  assert.equal(survived.enemies[0].currentHp, 200);
  assert.equal(survived.enemies[1].currentHp, 1000);
  assert.equal(survived.enemies[2].currentHp, 1000);

  const defeated = applySkill(createState(80), "allies", 0, simpleRules);
  assert.equal(defeated.enemies[0].currentHp, 30);
  assert.equal(defeated.enemies[1].currentHp, 1000);
  assert.equal(defeated.enemies[2].currentHp, 1000);
});

test("連続攻撃はかばう役の撃破後に残りの攻撃を続行する", () => {
  const multi = character("multi", {
    skill: { type: "multi_hit_attack", multiplier: 1, duration: 1, hits: 3 },
  });
  const state = createBattleState(
    [multi],
    [character("guard", { hp: 80 }), character("next-target")],
  );
  state.enemies[0].buffs = [{
    type: "guard",
    multiplier: 0.5,
    remainingTurns: 1,
    conditions: [],
    activationOrder: 1,
  }];

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].currentHp, 0);
  assert.equal(next.enemies[1].currentHp, 900);
});
test("全体攻撃をかばって生存した場合は同じキャラが場に残る", () => {
  const aoe = character("aoe", {
    skill: { type: "aoe_attack", multiplier: 1, duration: 1, hits: 1 },
  });
  const state = createBattleState(
    [[aoe]],
    [
      [character("guard", { hp: 80 }), character("guard-reserve", { hp: 200 })],
      [character("protected-left")],
      [character("protected-right")],
    ],
  );
  state.enemies[0].buffs = [{
    type: "guard",
    multiplier: 0.5,
    remainingTurns: 1,
    conditions: [],
    activationOrder: 1,
  }];

  const next = applySkill(state, "allies", 0, simpleRules);

  assert.equal(next.enemies[0].character.name, "guard");
  assert.equal(next.enemies[0].currentHp, 30);
  assert.equal(next.enemies[1].currentHp, 1000);
  assert.equal(next.enemies[2].currentHp, 1000);
});
test("短縮・遅延スキルは効果を適用せず使用回数も消費しない", () => {
  for (const skill of [
    { type: "delay", amount: 3, duration: 1 },
    { type: "skill_reduction", amount: 3, duration: 1 },
  ]) {
    const state = createBattleState(
      [character("supporter", { skill })],
      [character("enemy")],
    );
    state.allies[0].skillCounter = 5;
    state.enemies[0].skillCounter = 5;

    const next = applySkill(state, "allies", 0, simpleRules);

    assert.deepEqual(next, state);
    assert.notEqual(next, state);
  }
});
test("回復は自身・リーダー・味方属性の対象範囲を区別する", () => {
  const selfSkill = { type: "heal", multiplier: 0.5, target: "self", duration: 1, conditions: [] };
  const selfState = createBattleState(
    [character("leader"), character("healer", { skill: selfSkill }), character("ally")],
    [character("enemy")],
  );
  selfState.allies.forEach((combatant) => { combatant.currentHp = 100; });
  const selfResult = applySkill(selfState, "allies", 1, simpleRules);
  assert.deepEqual(selfResult.allies.map(({ currentHp }) => currentHp), [100, 600, 100]);

  const leaderSkill = { type: "heal", multiplier: 0.5, target: "leader", duration: 1, conditions: [] };
  const leaderState = createBattleState(
    [character("leader"), character("healer", { skill: leaderSkill }), character("ally")],
    [character("enemy")],
  );
  leaderState.allies.forEach((combatant) => { combatant.currentHp = 100; });
  const leaderResult = applySkill(leaderState, "allies", 1, simpleRules);
  assert.deepEqual(leaderResult.allies.map(({ currentHp }) => currentHp), [600, 100, 100]);

  const waterSkill = {
    type: "heal",
    multiplier: 0.5,
    target: "ally_all",
    duration: 1,
    conditions: [{ type: "ally_attribute", attribute: "water" }],
  };
  const waterState = createBattleState(
    [
      character("fire", { attributes: ["fire"] }),
      character("healer", { attributes: ["water"], skill: waterSkill }),
      character("wind", { attributes: ["wind"] }),
    ],
    [character("enemy")],
  );
  waterState.allies.forEach((combatant) => { combatant.currentHp = 100; });
  const waterResult = applySkill(waterState, "allies", 1, simpleRules);
  assert.deepEqual(waterResult.allies.map(({ currentHp }) => currentHp), [100, 600, 100]);
});

test("スキル回復の最大HP超過分は半分だけ回復する", () => {
  const heal = { type: "heal", multiplier: 0.5, target: "self", duration: 1, conditions: [] };
  const state = createBattleState(
    [character("healer", { skill: heal })],
    [character("enemy")],
  );
  state.allies[0].currentHp = 800;

  const result = applySkill(state, "allies", 0, simpleRules);
  assert.equal(result.allies[0].currentHp, 1_150);
});

test("蘇生はリーダー指定と味方属性条件を区別し、該当者全員を復帰させる", () => {
  const defeat = (combatant) => {
    combatant.alive = false;
    combatant.currentHp = 0;
    combatant.attributes = [];
  };
  const leaderSkill = { type: "revive", multiplier: 0.4, target: "leader", duration: 1, conditions: [] };
  const leaderState = createBattleState(
    [
      character("leader", { attributes: ["fire"] }),
      character("reviver", { attributes: ["wind"], skill: leaderSkill }),
      character("other", { attributes: ["fire"] }),
    ],
    [character("enemy")],
  );
  defeat(leaderState.allies[0]);
  defeat(leaderState.allies[2]);
  const leaderResult = applySkill(leaderState, "allies", 1, simpleRules);
  assert.equal(leaderResult.allies[0].alive, true);
  assert.equal(leaderResult.allies[0].currentHp, 400);
  assert.equal(leaderResult.allies[2].alive, false);

  const fireSkill = {
    type: "revive",
    multiplier: 0.4,
    target: "ally_all",
    duration: 1,
    conditions: [{ type: "ally_attribute", attribute: "fire" }],
  };
  const fireState = createBattleState(
    [
      character("fire-leader", { attributes: ["fire"] }),
      character("reviver", { attributes: ["wind"], skill: fireSkill }),
      character("fire-ally", { attributes: ["fire"] }),
      character("water-ally", { attributes: ["water"] }),
    ],
    [character("enemy")],
  );
  defeat(fireState.allies[0]);
  defeat(fireState.allies[2]);
  defeat(fireState.allies[3]);
  const fireResult = applySkill(fireState, "allies", 1, simpleRules);
  assert.deepEqual(fireResult.allies.map(({ alive }) => alive), [true, true, true, false]);
  assert.deepEqual(fireResult.allies[0].attributes, ["fire"]);
  assert.deepEqual(fireResult.allies[2].attributes, ["fire"]);
});

test("属性変更は対象範囲を守り、継続終了後に元の属性へ戻る", () => {
  const selfSkill = {
    type: "attribute_change",
    multiplier: 1,
    target: "self",
    duration: 1,
    conditions: [],
    effects: [{ attribute: "fire" }],
  };
  const selfState = createBattleState(
    [
      character("leader", { attributes: ["water"] }),
      character("changer", { attributes: ["wind"], skill: selfSkill }),
    ],
    [character("enemy")],
  );
  const selfResult = applySkill(selfState, "allies", 1, simpleRules);
  assert.deepEqual(selfResult.allies.map(({ attributes }) => attributes), [["water"], ["fire"]]);

  const allSkill = {
    type: "attribute_change",
    multiplier: 1,
    target: "ally_all",
    duration: 2,
    conditions: [],
    effects: [{ attribute: "fire" }, { attribute: "water" }, { attribute: "wind" }],
  };
  const allState = createBattleState(
    [
      character("changer", { attributes: ["water"], skill: allSkill }),
      character("ally", { attributes: ["wind"] }),
    ],
    [character("enemy")],
  );
  const changed = applySkill(allState, "allies", 0, simpleRules);
  assert.deepEqual(changed.allies.map(({ attributes }) => attributes), [
    ["fire", "water", "wind"],
    ["fire", "water", "wind"],
  ]);
  const continuing = advanceTurn(changed);
  assert.deepEqual(continuing.allies.map(({ attributes }) => attributes), [
    ["fire", "water", "wind"],
    ["fire", "water", "wind"],
  ]);
  const expired = advanceTurn(continuing);
  assert.deepEqual(expired.allies.map(({ attributes }) => attributes), [["water"], ["wind"]]);
});
test("継続バフの味方属性条件は属性変更後の攻撃時点で判定する", () => {
  const buffSkill = {
    type: "attack_buff",
    multiplier: 2,
    target: "ally_all",
    duration: 2,
    conditions: [{ type: "ally_attribute", attribute: "fire" }],
  };
  const state = createBattleState(
    [
      character("supporter", { attributes: ["water"], skill: buffSkill }),
      character("attacker", { attributes: ["water"] }),
    ],
    [character("enemy")],
  );
  const buffed = applySkill(state, "allies", 0, simpleRules);
  assert.deepEqual(buffed.allies.map(({ buffs }) => buffs.length), [1, 1]);

  buffed.allies[1].attributes = ["fire"];
  const attacked = applySkill(buffed, "allies", 1, simpleRules);
  assert.equal(attacked.enemies[0].currentHp, 800);
});

test("5対5では全プレイヤーが同じターンに攻撃し、選んだ攻撃スキルを使う", () => {
  const attackSkill = { type: "single_attack", multiplier: 3, target: "self", duration: 1, conditions: [] };
  const allies = [0, 1, 2, 3, 4].map((index) => [character(`ally-${index}`, {
    pow: index === 0 ? 200 : 100,
    skill: index === 0 ? attackSkill : { type: "none" },
  })]);
  const enemies = [0, 1, 2, 3, 4].map((index) => [character(`enemy-${index}`, {
    hp: 10_000,
    pow: 0,
    skill: { type: "none" },
  })]);
  const state = createBattleState(allies, enemies);
  const result = simulateBattle(state, simpleRules, { turns: 1 });
  const attacks = result.history[0].actions.filter((action) => action.side === "allies");
  const skilled = attacks.find((action) => action.actorName === "ally-0");

  assert.equal(attacks.length, 5);
  assert.equal(skilled.skillType, "single_attack");
  assert.equal(skilled.hits[0].damage, 600);
});
