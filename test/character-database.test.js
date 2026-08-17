import test from "node:test";
import assert from "node:assert/strict";
import { createManualCharacter, updateManualCharacter } from "../src/data/characters.js";
import {
  CHARACTER_DATABASE_TABLE,
  loadCharacterDatabase,
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
  const character = sampleCharacter();
  const [loaded] = parseCharacterDatabaseRows([{ id: character.id, payload: character }]);
  assert.equal(loaded.id, character.id);
  assert.equal(loaded.name, "DBテストキャラ");
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
