import test from "node:test";
import assert from "node:assert/strict";
import { calculateCharacterStats, createManualCharacter } from "../src/data/characters.js";
import { getSkillDetailConfig } from "../src/ui/character-editor.js";

test("手入力キャラを探索可能な標準形式へ変換する", () => {
  const character = createManualCharacter({
    name: "手入力の火水キャラ",
    attributeClass: "fire_water",
    cost: 32,
    hp: 5400,
    pow: 6200,
    rarity: "ZR",
    region: "限定",
    owned: true,
    skillTurn: 2,
    skillType: "aoe_attack",
    skillName: "敵全員へ攻撃する",
    skillCategory: "自身全体",
    multiplier: 1.5,
    hits: 1,
    duration: 1,
    amount: 0,
    target: "enemy_all",
  });

  assert.match(character.id, /^manual-/u);
  assert.deepEqual(character.attributes, ["fire", "water"]);
  assert.equal(character.skill.type, "aoe_attack");
  assert.equal(character.skill.multiplier, 1.5);
  assert.equal(character.source.sheet, "手入力");
});

test("手入力キャラの必須ステータスを検証する", () => {
  assert.throws(() => createManualCharacter({
    name: "",
    attributeClass: "fire",
    cost: 1,
    hp: 1,
    pow: 1,
    skillTurn: 0,
  }), /キャラ名/u);
  assert.throws(() => createManualCharacter({
    name: "HPなし",
    attributeClass: "fire",
    cost: 1,
    hp: 0,
    pow: 1,
    skillTurn: 0,
  }), /HP/u);
});


test("攻撃スキルの対象を未指定なら種別から補う", () => {
  const character = createManualCharacter({
    name: "自動対象",
    attributeClass: "fire",
    cost: 1,
    hp: 1,
    pow: 1,
    skillTurn: 1,
    skillType: "aoe_attack",
  });
  assert.equal(character.skill.target, "enemy_all");
});


test("手入力キャラの詳細設定を評価データへ保存する", () => {
  const character = createManualCharacter({
    name: "詳細設定キャラ",
    attributeClass: "water_wind",
    cost: 55,
    hp: 7800,
    pow: 6400,
    baseHp: 4600,
    basePow: 3700,
    maxLevel: 237,
    limitBreak: 7,
    rarity: "MZR",
    region: "詳細テスト",
    owned: false,
    pvpTier: "priority",
    allowedPositions: [1, 3, 5],
    preferredPositions: [1, 5],
    positionRule: "late",
    skillTurn: 4,
    maxUses: 1,
    skillType: "attack_buff",
    skillName: "詳細な攻撃力アップ",
    skillCategory: "敵色攻撃力Up",
    multiplier: 2.5,
    hits: 1,
    duration: 3,
    amount: 0,
    target: "ally_all",
    targetCount: 5,
    priority: "high",
    allyAttribute: "water",
    enemyAttribute: "fire",
    effectAttribute: "wind",
    roleTags: ["buff", "setup", "late_game", "unknown"],
    notes: "検索用メモ",
  });

  assert.equal(character.baseHp, 4600);
  assert.equal(character.basePow, 3700);
  assert.equal(character.maxLevel, 237);
  assert.equal(character.limitBreak, 7);
  assert.equal(character.pvpTier, "priority");
  assert.deepEqual(character.allowedPositions, [1, 3, 5]);
  assert.deepEqual(character.preferredPositions, [1, 5]);
  assert.equal(character.positionRule, "late");
  assert.equal(character.maxUses, 1);
  assert.deepEqual(character.roleTags, ["buff", "setup", "late_game"]);
  assert.equal(character.notes, "検索用メモ");
  assert.equal(character.skill.target, "ally_all");
  assert.equal(character.skill.targetCount, 5);
  assert.equal(character.skill.priority, "high");
  assert.deepEqual(character.skill.conditions, [
    { type: "ally_attribute", attribute: "water" },
    { type: "enemy_attribute", attribute: "fire" },
  ]);
  assert.deepEqual(character.skill.effects, [{ attribute: "wind" }]);
});

test("手入力キャラは配置可能枠を必須にする", () => {
  assert.throws(() => createManualCharacter({
    name: "配置なし",
    attributeClass: "fire",
    cost: 1,
    hp: 1,
    pow: 1,
    skillTurn: 0,
    allowedPositions: [],
  }), /配置可能枠/u);
});


test("全体攻撃の対象数は未指定なら5体にする", () => {
  const character = createManualCharacter({
    name: "全体攻撃",
    attributeClass: "fire",
    cost: 1,
    hp: 1,
    pow: 1,
    skillTurn: 1,
    skillType: "aoe_attack",
  });
  assert.equal(character.skill.targetCount, 5);
});


test("短縮と遅延のスキル設定を手入力データへ保存する", () => {
  const base = {
    attributeClass: "fire",
    cost: 1,
    hp: 1,
    pow: 1,
    skillTurn: 2,
  };
  const reduction = createManualCharacter({
    ...base,
    name: "短縮",
    skillType: "skill_reduction",
    amount: 2,
    target: "ally_all",
    allyAttribute: "water",
  });
  const delay = createManualCharacter({
    ...base,
    name: "遅延",
    skillType: "delay",
    amount: 3,
    target: "enemy_all",
    enemyAttribute: "wind",
  });

  assert.equal(reduction.skill.amount, 2);
  assert.equal(reduction.skill.target, "ally_all");
  assert.deepEqual(reduction.skill.conditions, [{ type: "ally_attribute", attribute: "water" }]);
  assert.equal(delay.skill.amount, 3);
  assert.equal(delay.skill.target, "enemy_all");
  assert.deepEqual(delay.skill.conditions, [{ type: "enemy_attribute", attribute: "wind" }]);
});


test("追加フォームはスクリプトが参照する入力欄をすべて持つ", async () => {
  const [editorSource, templateSource] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/ui/character-editor.js", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/index.template.html", import.meta.url), "utf8")),
  ]);
  const names = [...new Set([...editorSource.matchAll(/form\.elements\.(manual[A-Za-z]+)/g)].map((match) => match[1]))];
  for (const name of names) {
    assert.match(templateSource, new RegExp('name="' + name + '"'));
  }
});


test("追加フォームは収録データの全スキル種別を選べる", async () => {
  const { readFile } = await import("node:fs/promises");
  const templateSource = await readFile(new URL("../src/index.template.html", import.meta.url), "utf8");
  const types = [
    "aoe_attack",
    "multi_hit_attack",
    "attack_buff",
    "damage_reduction",
    "guard",
    "attribute_guard",
    "heal",
    "revive",
    "attribute_change",
    "skill_reduction",
    "delay",
  ];
  for (const type of types) {
    assert.match(templateSource, new RegExp('<option value="' + type + '">'));
  }
});


test("無凸Lv1値と育成状態から探索用ステータスを統一して計算する", () => {
  assert.deepEqual(calculateCharacterStats(101, 99, "lv1", { rarity: "N" }), { hp: 101, pow: 99 });
  assert.deepEqual(calculateCharacterStats(101, 99, "max", { rarity: "N" }), { hp: 202, pow: 198 });
  assert.deepEqual(calculateCharacterStats(101, 99, "max_limit_break", { rarity: "N" }), { hp: 285, pow: 279 });
  assert.deepEqual(calculateCharacterStats(101, 99, "max_limit_break", { rarity: "MZR" }), { hp: 344, pow: 337 });

  const character = createManualCharacter({
    name: "育成状態テスト",
    attributeClass: "fire",
    cost: 1,
    hp: 101,
    pow: 99,
    statGrowth: "max_limit_break",
    skillTurn: 0,
  });

  assert.equal(character.baseHp, 202);
  assert.equal(character.basePow, 198);
  assert.equal(character.statGrowth, "max_limit_break");
  assert.equal(character.hp, 285);
  assert.equal(character.pow, 279);
  assert.equal(character.fullLimitBreakHp, 285);
  assert.equal(character.fullLimitBreakPow, 279);
});


test("手入力の個別の竹・松ステータスを優先する", () => {
  const character = createManualCharacter({
    name: "例外ステータス",
    attributeClass: "fire",
    cost: 1,
    hp: 101,
    pow: 99,
    rarity: "CR",
    statGrowth: "max_limit_break",
    baseHp: 207,
    basePow: 203,
    fullLimitBreakHp: 333,
    fullLimitBreakPow: 327,
    skillTurn: 0,
  });

  assert.equal(character.baseHp, 207);
  assert.equal(character.basePow, 203);
  assert.equal(character.fullLimitBreakHp, 333);
  assert.equal(character.fullLimitBreakPow, 327);
  assert.equal(character.hp, 333);
  assert.equal(character.pow, 327);
});


test("スキル種別ごとに必要な詳細設定だけを選ぶ", () => {
  assert.deepEqual(getSkillDetailConfig("skill_reduction").fields, ["amount", "allyAttribute", "enemyAttribute"]);
  assert.deepEqual(getSkillDetailConfig("delay").fields, ["amount", "allyAttribute", "enemyAttribute"]);
  assert.deepEqual(getSkillDetailConfig("multi_hit_attack").fields, ["hits", "duration", "allyAttribute", "enemyAttribute"]);
  assert.equal(getSkillDetailConfig("attribute_change").fields.includes("effectAttribute"), true);
  assert.equal(getSkillDetailConfig("none").fields.includes("multiplier"), false);
});
