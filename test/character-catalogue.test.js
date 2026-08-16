import test from "node:test";
import assert from "node:assert/strict";
import { groupCharactersForCatalogue } from "../src/core/character-catalogue.js";

test("キャラ図鑑は受領データの順番を保ってシートごとに分類する", () => {
  const groups = groupCharactersForCatalogue([
    { id: "a", source: { sheet: "関東" } },
    { id: "b", source: { sheet: "関東" } },
    { id: "c", source: { sheet: "近畿" } },
    { id: "d", region: "手動追加" },
  ]);

  assert.deepEqual(groups.map((group) => group.name), ["関東", "近畿", "手動追加"]);
  assert.deepEqual(groups[0].items.map((item) => item.character.id), ["a", "b"]);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.sourceIndex)), [[0, 1], [2], [3]]);
});
