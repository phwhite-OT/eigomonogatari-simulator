import { parseCharacterPayload } from "./characters.js";

export const CHARACTER_DATABASE_TABLE = "character_catalog_overrides";

function requireDatabaseClient(client) {
  if (!client?.from) throw new TypeError("キャラデータベースへ接続できません。");
  return client;
}

function characterId(character) {
  return String(character?.id ?? "");
}

// Keep workbook order as the baseline, while allowing a manually added character
// to live directly before or after a chosen catalogue entry. Placement anchors are
// IDs, so edits to the anchor's name or stats do not move the added character.
export function mergeCharacterDatabaseIntoCatalogue(baseCharacters, databaseCharacters) {
  const base = Array.isArray(baseCharacters) ? baseCharacters : [];
  const database = Array.isArray(databaseCharacters) ? databaseCharacters : [];
  const databaseById = new Map(database.map((character) => [characterId(character), character]));
  const baseIds = new Set(base.map(characterId));
  const merged = base.map((character) => databaseById.get(characterId(character)) ?? character);
  const pending = database.filter((character) => !baseIds.has(characterId(character)));
  const lastBefore = new Map();
  const lastAfter = new Map();

  while (pending.length) {
    let inserted = false;
    for (let index = 0; index < pending.length; index += 1) {
      const character = pending[index];
      const placement = character.cataloguePlacement;
      if (!placement) continue;
      const anchorIndex = merged.findIndex((entry) => characterId(entry) === placement.anchorId);
      if (anchorIndex < 0) continue;

      const siblingId = placement.position === "before"
        ? lastBefore.get(placement.anchorId)
        : lastAfter.get(placement.anchorId);
      const siblingIndex = siblingId
        ? merged.findIndex((entry) => characterId(entry) === siblingId)
        : -1;
      const insertIndex = siblingIndex >= 0
        ? siblingIndex + 1
        : placement.position === "before"
          ? anchorIndex
          : anchorIndex + 1;
      merged.splice(insertIndex, 0, character);
      if (placement.position === "before") lastBefore.set(placement.anchorId, characterId(character));
      else lastAfter.set(placement.anchorId, characterId(character));
      pending.splice(index, 1);
      inserted = true;
      break;
    }
    if (!inserted) break;
  }

  // A removed or renamed anchor must not make a saved character disappear.
  return [...merged, ...pending];
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
