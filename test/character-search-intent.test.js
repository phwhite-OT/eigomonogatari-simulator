import test from "node:test";
import assert from "node:assert/strict";
import { parseCharacterSearchQuery } from "../src/core/character-search.js";

test("主要な属性とスキルのキーワードを取り出す", () => {
  const parsed = parseCharacterSearchQuery("火属性 全体攻撃");
  assert.deepEqual(parsed.attributes.map((entry) => entry.attribute), ["fire"]);
  assert.deepEqual(parsed.skillKeywords.map((entry) => entry.types), [["aoe_attack"]]);
  assert.deepEqual(parsed.terms, []);
});

test("地域とレアリティは通常の文字列キーワードとして残す", () => {
  const parsed = parseCharacterSearchQuery("関東のZR");
  assert.deepEqual(parsed.terms, ["関東", "zr"]);
});

test("単独の属性キーワードも扱える", () => {
  const parsed = parseCharacterSearchQuery("水 回復");
  assert.deepEqual(parsed.attributes.map((entry) => entry.attribute), ["water"]);
  assert.deepEqual(parsed.skillKeywords.map((entry) => entry.types), [["heal"]]);
});
