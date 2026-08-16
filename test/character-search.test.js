import test from "node:test";
import assert from "node:assert/strict";
import {
  createCharacterSearchIndex,
  normalizeCharacterSearchText,
  searchCharacters,
} from "../src/core/character-search.js";

function character(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    attributes: overrides.attributes ?? ["fire"],
    cost: overrides.cost ?? 20,
    hp: overrides.hp ?? 4000,
    pow: overrides.pow ?? 4000,
    rarity: overrides.rarity ?? "R",
    region: overrides.region ?? "関東",
    owned: true,
    skillTurn: overrides.skillTurn ?? 3,
    skillName: overrides.skillName ?? "スキルなし",
    skillCategory: overrides.skillCategory ?? "-",
    skill: { type: overrides.skillType ?? "none" },
    roleTags: overrides.roleTags ?? [],
    notes: "",
  };
}

const index = createCharacterSearchIndex([
  character({ id: "fire-aoe-low", name: "火の全体役", cost: 8, skillType: "aoe_attack", skillName: "敵全員へ攻撃する", skillCategory: "自身全体" }),
  character({ id: "fire-aoe-high", name: "重い火の全体役", cost: 28, skillType: "aoe_attack", skillName: "敵全員へ強力な攻撃をする", skillCategory: "自身全体" }),
  character({ id: "water-heal", name: "水の回復役", attributes: ["water"], rarity: "ZR", skillType: "heal", skillName: "味方全員を回復する", skillCategory: "全員回復" }),
  character({ id: "water-guard", name: "水受け守護者", attributes: ["fire", "wind"], skillType: "attribute_guard", skillName: "水属性の攻撃を自身に集中させる", skillCategory: "敵色かばう" }),
  character({ id: "asako", name: "ニートな浅子さん", cost: 4 }),
]);

test("全角・英字大小・カタカナを検索用に正規化する", () => {
  assert.equal(normalizeCharacterSearchText(" ＺＲ アタッカー "), "zr あたっかー");
});

test("属性とスキルのキーワードを組み合わせて絞り込む", () => {
  const result = searchCharacters(index, "火 全体攻撃");
  assert.deepEqual(result.results.map((entry) => entry.character.id), ["fire-aoe-low", "fire-aoe-high"]);
  assert.deepEqual(result.query.interpreted, ["火属性", "全体攻撃"]);
});

test("スキル名・地域・レアリティを通常のキーワードで検索する", () => {
  assert.deepEqual(searchCharacters(index, "回復").results.map((entry) => entry.character.id), ["water-heal"]);
  assert.deepEqual(searchCharacters(index, "関東 ZR").results.map((entry) => entry.character.id), ["water-heal"]);
});

test("低コストは候補を絞らず表示順へ反映する", () => {
  const result = searchCharacters(index, "低コスト 全体攻撃");
  assert.deepEqual(result.results.map((entry) => entry.character.id), ["fire-aoe-low", "fire-aoe-high"]);
});

test("名前の軽い誤字を近似一致で見つける", () => {
  const result = searchCharacters(index, "ニートな麻子さん");
  assert.equal(result.results[0].character.id, "asako");
  assert.ok(result.results[0].reasons.some((reason) => reason.includes("近似一致")));
});

test("データ順を指定した検索は受領順を保つ", () => {
  const result = searchCharacters(index, "火 全体攻撃", { sort: "source" });
  assert.deepEqual(result.results.map((entry) => entry.character.id), ["fire-aoe-low", "fire-aoe-high"]);
});
