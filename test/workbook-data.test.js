import test from "node:test";
import assert from "node:assert/strict";
import { WORKBOOK_CHARACTERS, WORKBOOK_DATA_SUMMARY } from "../src/data/workbook-characters.js";
import { ATTRIBUTES, ATTRIBUTE_CLASSES, DEFAULT_RULES, resolveAttributeClass } from "../src/data/rules.js";
import { validateDeck } from "../src/core/filter.js";
import { searchDecks } from "../src/core/search-fast.js";

function charactersNamed(name) {
  return WORKBOOK_CHARACTERS.filter((character) => character.name === name);
}

test("Book1.xlsx由来の2,216体を収録する", () => {
  assert.equal(WORKBOOK_DATA_SUMMARY.sourceRows, 2217);
  assert.equal(WORKBOOK_DATA_SUMMARY.uniqueCharacters, 2216);
  assert.equal(WORKBOOK_DATA_SUMMARY.mergedExactDuplicates, 1);
  assert.equal(WORKBOOK_CHARACTERS.length, 2216);
  assert.equal(new Set(WORKBOOK_CHARACTERS.map((character) => character.id)).size, 2216);
});

test("単属性・複属性・全属性を背景色から復元する", () => {
  assert.deepEqual(new Set(WORKBOOK_CHARACTERS.map((character) => resolveAttributeClass(character.attributes))), new Set(ATTRIBUTE_CLASSES));
  assert.deepEqual(charactersNamed("ニートな浅子さん")[0].attributes, ["fire"]);
  assert.deepEqual(charactersNamed("あっしゅTHEｷｬｯﾄ")[0].attributes, ["water", "fire"]);
  assert.deepEqual(charactersNamed("いびるん")[0].attributes, ["fire", "water", "wind"]);
});

test("限界突破後の値を優先し、200%増加を3倍にする", () => {
  const festival = charactersNamed("祭りだ浅ちゃん！")[0];
  assert.equal(festival.hp, 800);
  assert.equal(festival.pow, 1603);
  const asako = charactersNamed("ニートな浅子さん")[0];
  assert.equal(asako.skill.type, "attack_buff");
  assert.equal(asako.skill.multiplier, 3);
});

test("同名・同ステータスでも属性やスキルが違えば別キャラにする", () => {
  const princes = charactersNamed("斑鳩の太子くん");
  const forestGods = charactersNamed("森神ブーナッド");
  assert.equal(princes.length, 2);
  assert.equal(forestGods.length, 2);
  assert.deepEqual(princes.map((character) => character.skillTurn).sort(), [2, 4]);
  assert.deepEqual(forestGods.map((character) => character.skill.multiplier).sort(), [1, 1.2]);
});

test("対戦シートで右へずれたキャラを復元する", () => {
  const [rio] = charactersNamed("カニバルズム・リオ子");
  assert.ok(rio);
  assert.deepEqual(rio.attributes, ["wind"]);
  assert.equal(rio.hp, 3428);
  assert.equal(rio.pow, 2109);
  assert.equal(rio.skill.hits, 8);
});

test("収録データから条件適合デッキを探索できる", async () => {
  const constraints = {
    totalCost: 160,
    deckSize: 5,
    allowedAttributes: ATTRIBUTES,
    mode: "fast",
  };
  const result = await searchDecks(WORKBOOK_CHARACTERS, constraints, DEFAULT_RULES, {
    iterations: 500,
    chunkSize: 100,
    topLimit: 30,
    detailedLimit: 10,
    seed: 2026,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.results.length > 0);
  for (const recommendation of result.results) {
    assert.equal(validateDeck(recommendation.deck, constraints).valid, true);
  }
});
test("支援スキルの対象範囲と属性条件を文言から復元する", () => {
  const selfBuff = charactersNamed("ニートな浅子さん")[0].skill;
  assert.equal(selfBuff.target, "self");
  assert.deepEqual(selfBuff.conditions, []);

  const allyColorBuff = charactersNamed("迷菓ぴよ子")[0].skill;
  assert.equal(allyColorBuff.target, "ally_all");
  assert.deepEqual(allyColorBuff.conditions, [{ type: "ally_attribute", attribute: "fire" }]);

  const enemyColorBuff = charactersNamed("川越マン")[0].skill;
  assert.equal(enemyColorBuff.target, "ally_all");
  assert.deepEqual(enemyColorBuff.conditions, [{ type: "enemy_attribute", attribute: "wind" }]);

  const dualShield = charactersNamed("ヴィヒー先生")[0].skill;
  assert.deepEqual(dualShield.conditions, [
    { type: "ally_attribute", attribute: "water" },
    { type: "enemy_attribute", attribute: "wind" },
  ]);

  const leaderGuard = charactersNamed("森豊")[0].skill;
  assert.equal(leaderGuard.target, "leader");
  assert.deepEqual(leaderGuard.conditions, [{ type: "enemy_attribute", attribute: "wind" }]);
});
test("対戦スキルの使用上限を全キャラ2回として収録する", () => {
  assert.ok(WORKBOOK_CHARACTERS.every((character) => character.maxUses === 2));
});
test("回復・蘇生・属性変更の対象範囲と全属性を復元する", () => {
  assert.equal(charactersNamed("白鷺嬢")[0].skill.target, "self");
  assert.equal(charactersNamed("シャフとリサブス")[0].skill.target, "leader");
  assert.equal(charactersNamed("はんばー先輩")[0].skill.target, "leader");
  assert.equal(charactersNamed("怪人エビユルゲ")[0].skill.target, "self");
  assert.deepEqual(charactersNamed("とりころん・ぴー子")[0].skill.effects, [
    { attribute: "fire" },
    { attribute: "water" },
    { attribute: "wind" },
  ]);
});