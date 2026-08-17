import test from "node:test";
import assert from "node:assert/strict";
import { createManualCharacter, updateManualCharacter } from "../src/data/characters.js";
import {
  CHARACTER_DATABASE_TABLE,
  loadCharacterDatabase,
  mergeCharacterDatabaseIntoCatalogue,
  parseCharacterDatabaseRows,
  saveCharacterDatabaseCharacter,
} from "../src/data/character-database.js";

function sampleCharacter() {
  return createManualCharacter({
    name: "DBテストキャラ",
    attributeClass: "fire_water",
    cost: 20,
    hp: 1200,
    pow: 900,
    rarity: "R",
    region: "テスト",
    skillTurn: 2,
    skillType: "aoe_attack",
  });
}

test("キャラデータベース行は正規化されたキャラとして読み出す", () => {
  const character = {
    ...sampleCharacter(),
    cataloguePlacement: { anchorId: "catalogue-20", position: "before" },
  };
  const [loaded] = parseCharacterDatabaseRows([{ id: character.id, payload: character }]);
  assert.equal(loaded.id, character.id);
  assert.equal(loaded.name, "DBテストキャラ");
  assert.deepEqual(loaded.cataloguePlacement, { anchorId: "catalogue-20", position: "before" });
});

test("キャラデータベース行のIDとpayloadのIDが異なる場合は拒否する", () => {
  const character = sampleCharacter();
  assert.throws(
    () => parseCharacterDatabaseRows([{ id: "different-id", payload: character }]),
    /IDが一致しません/u,
  );
});

test("キャラデータベースはSupabaseの同一IDへupsertする", async () => {
  const character = sampleCharacter();
  let table;
  let savedRow;
  const client = {
    from(value) {
      table = value;
      return {
        upsert(row) {
          savedRow = row;
          return {
            select() {
              return { single: async () => ({ data: row, error: null }) };
            },
          };
        },
      };
    },
  };
  const saved = await saveCharacterDatabaseCharacter(client, character);
  assert.equal(table, CHARACTER_DATABASE_TABLE);
  assert.equal(savedRow.id, character.id);
  assert.equal(saved.id, character.id);
});

test("キャラデータベースは更新日時順に差分を読み出す", async () => {
  const character = sampleCharacter();
  let orderedBy;
  const client = {
    from() {
      return {
        select() {
          return {
            order(field) {
              orderedBy = field;
              return Promise.resolve({ data: [{ id: character.id, payload: character }], error: null });
            },
          };
        },
      };
    },
  };
  const [loaded] = await loadCharacterDatabase(client);
  assert.equal(orderedBy, "updated_at");
  assert.equal(loaded.id, character.id);
});

test("追加キャラは指定したキャラの前後へ図鑑順で挿入できる", () => {
  const base = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const database = [
    { id: "before-b", name: "前", cataloguePlacement: { anchorId: "b", position: "before" } },
    { id: "after-b", name: "後", cataloguePlacement: { anchorId: "b", position: "after" } },
    { id: "after-after-b", name: "さらに後", cataloguePlacement: { anchorId: "after-b", position: "after" } },
    { id: "last", name: "末尾" },
  ];

  assert.deepEqual(
    mergeCharacterDatabaseIntoCatalogue(base, database).map((character) => character.id),
    ["a", "before-b", "b", "after-b", "after-after-b", "c", "last"],
  );
});

test("編集ではキャラIDと詳細な評価設定を維持する", () => {
  const original = {
    ...sampleCharacter(),
    id: "catalogue-1",
    pvpTier: "priority",
    roleTags: ["guard"],
    skill: { ...sampleCharacter().skill, priority: "high" },
  };
  const updated = updateManualCharacter({
    name: "更新後キャラ",
    attributeClass: "water",
    cost: 25,
    hp: 1300,
    pow: 1000,
    statGrowth: "final",
    rarity: "ZR",
    region: "更新地域",
    skillTurn: 3,
    skillType: "heal",
    multiplier: 1.2,
    hits: 1,
    duration: 1,
    amount: 0,
    target: "ally_all",
    targetCount: 5,
  }, original);
  assert.equal(updated.id, "catalogue-1");
  assert.equal(updated.name, "更新後キャラ");
  assert.equal(updated.pvpTier, "priority");
  assert.deepEqual(updated.roleTags, ["guard"]);
  assert.equal(updated.skill.priority, "high");
});

test("編集しても指定済みの図鑑位置を維持する", () => {
  const original = {
    ...sampleCharacter(),
    cataloguePlacement: { anchorId: "catalogue-20", position: "after" },
  };
  const updated = updateManualCharacter({
    name: "更新後キャラ",
    attributeClass: "fire",
    cost: 20,
    hp: 1200,
    pow: 900,
    rarity: "R",
    region: "テスト",
    skillTurn: 2,
    skillType: "aoe_attack",
  }, original);
  assert.deepEqual(updated.cataloguePlacement, { anchorId: "catalogue-20", position: "after" });
});
