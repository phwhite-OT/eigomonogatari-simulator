import { parseCharacterPayload } from "./characters.js";

export const CHARACTER_DATABASE_TABLE = "character_catalog_overrides";

function requireDatabaseClient(client) {
  if (!client?.from) throw new TypeError("キャラデータベースへ接続できません。");
  return client;
}

export function parseCharacterDatabaseRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("キャラデータベースの応答形式が不正です。");
  const characters = parseCharacterPayload(rows.map((row) => row?.payload));
  for (const [index, character] of characters.entries()) {
    if (String(character.id) !== String(rows[index]?.id)) {
      throw new TypeError(`キャラデータベースの${index + 1}件目でIDが一致しません。`);
    }
  }
  return characters;
}

export async function loadCharacterDatabase(client) {
  const { data, error } = await requireDatabaseClient(client)
    .from(CHARACTER_DATABASE_TABLE)
    .select("id, payload, updated_at")
    .order("updated_at", { ascending: true });
  if (error) throw error;
  return parseCharacterDatabaseRows(data ?? []);
}

export async function saveCharacterDatabaseCharacter(client, character) {
  const [normalized] = parseCharacterPayload([character]);
  const row = {
    id: String(normalized.id),
    payload: normalized,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await requireDatabaseClient(client)
    .from(CHARACTER_DATABASE_TABLE)
    .upsert(row, { onConflict: "id" })
    .select("id, payload, updated_at")
    .single();
  if (error) throw error;
  return parseCharacterDatabaseRows([data])[0];
}
