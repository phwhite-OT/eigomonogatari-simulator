import { ATTRIBUTES, resolveAttributeClass } from "../data/rules.js";

function toStringSet(values) {
  return new Set((values ?? []).map(String));
}

export function expectedTurnForPosition(position) {
  return Math.max(0, Number(position) - 1);
}

export function isSkillTurnAllowedAtPosition(character, position) {
  const normalizedPosition = Number(position);
  if (normalizedPosition === 1) return true;
  const expectedTurn = expectedTurnForPosition(normalizedPosition);
  const skillTurn = Number(character?.skillTurn);
  if (!Number.isFinite(skillTurn)) return false;
  if (normalizedPosition === 5) return skillTurn >= expectedTurn;
  return skillTurn === expectedTurn || skillTurn === expectedTurn + 1;
}

export function skillTurnRangeForPosition(position) {
  if (Number(position) === 1) return null;
  const expectedTurn = expectedTurnForPosition(position);
  return [expectedTurn, Number(position) === 5 ? Number.POSITIVE_INFINITY : expectedTurn + 1];
}

export function normalizeConstraints(raw = {}) {
  const fixedPositions = {};
  for (const [position, id] of Object.entries(raw.fixedPositions ?? {})) {
    if (id !== "" && id !== null && id !== undefined) fixedPositions[Number(position)] = String(id);
  }

  return {
    totalCost: Math.max(0, Number(raw.totalCost) || 0),
    deckSize: Math.min(5, Math.max(1, Number(raw.deckSize) || 5)),
    allowedAttributes: [...toStringSet(raw.allowedAttributes)].filter((attribute) => ATTRIBUTES.includes(attribute)),
    forbiddenAttributes: [...toStringSet(raw.forbiddenAttributes)].filter((attribute) => ATTRIBUTES.includes(attribute)),
    allowDuplicates: Boolean(raw.allowDuplicates),
    ownedOnly: Boolean(raw.ownedOnly),
    requiredIds: [...toStringSet(raw.requiredIds)],
    forbiddenIds: [...toStringSet(raw.forbiddenIds)],
    fixedPositions,
    requiredRole: raw.requiredRole ? String(raw.requiredRole) : "",
    rarities: [...toStringSet(raw.rarities)],
    regions: [...toStringSet(raw.regions)],
    mode: ["fast", "standard", "precise"].includes(raw.mode) ? raw.mode : "standard",
    includeLow: Boolean(raw.includeLow),
    debugIncludeExcluded: Boolean(raw.debugIncludeExcluded),
  };
}

export function filterCandidates(characters, rawConstraints) {
  const constraints = normalizeConstraints(rawConstraints);
  const allowed = toStringSet(constraints.allowedAttributes);
  const forbidden = toStringSet(constraints.forbiddenAttributes);
  const rarities = toStringSet(constraints.rarities);
  const regions = toStringSet(constraints.regions);
  const forbiddenIds = toStringSet(constraints.forbiddenIds);
  const excludedCounts = {};

  const reject = (reason) => {
    excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
    return false;
  };

  const candidates = characters.filter((character) => {
    if (character.pvpTier === "exclude" && !constraints.debugIncludeExcluded) return reject("対戦候補外");
    if (character.pvpTier === "low" && !constraints.includeLow) return reject("低優先");
    const attributeClass = resolveAttributeClass(character.attributes);
    if (!attributeClass) return reject("属性形式不正");
    if (allowed.size && !character.attributes.some((attribute) => allowed.has(attribute))) return reject("使用可能属性外");
    if (forbidden.size && character.attributes.some((attribute) => forbidden.has(attribute))) return reject("使用禁止属性");
    if (character.cost > constraints.totalCost) return reject("単体コスト超過");
    if (rarities.size && !rarities.has(String(character.rarity))) return reject("レアリティ");
    if (regions.size && !regions.has(String(character.region))) return reject("地域");
    if (constraints.ownedOnly && !character.owned) return reject("未所持");
    if (forbiddenIds.has(String(character.id))) return reject("禁止キャラ");
    if (!character.allowedPositions.some((position) => position <= constraints.deckSize)) return reject("配置不可");
    return true;
  });

  return { candidates, constraints, excludedCounts };
}

export function validateDeck(deck, rawConstraints) {
  const constraints = normalizeConstraints(rawConstraints);
  const errors = [];
  const ids = deck.map((character) => String(character.id));
  const totalCost = deck.reduce((sum, character) => sum + character.cost, 0);

  if (deck.length !== constraints.deckSize) errors.push(`デッキ枚数が${constraints.deckSize}体ではありません。`);
  if (!constraints.allowDuplicates && new Set(ids).size !== ids.length) errors.push("同一キャラが重複しています。");
  if (totalCost > constraints.totalCost) errors.push(`総コストが上限を${totalCost - constraints.totalCost}超過しています。`);

  for (const requiredId of constraints.requiredIds) {
    if (!ids.includes(requiredId)) errors.push(`必須キャラ ${requiredId} が含まれていません。`);
  }
  for (const forbiddenId of constraints.forbiddenIds) {
    if (ids.includes(forbiddenId)) errors.push(`禁止キャラ ${forbiddenId} が含まれています。`);
  }
  for (const [rawPosition, fixedId] of Object.entries(constraints.fixedPositions)) {
    const position = Number(rawPosition);
    if (String(deck[position - 1]?.id) !== fixedId) errors.push(`${position}枠目が固定キャラ ${fixedId} ではありません。`);
  }
  for (const [index, character] of deck.entries()) {
    const position = index + 1;
    if (!resolveAttributeClass(character.attributes)) errors.push(`${character.name}の属性は火・水・風・火水・火風・水風・全のいずれでもありません。`);
    if (!character.allowedPositions.includes(position)) errors.push(`${character.name} は${position}枠目に配置できません。`);
    if (!isSkillTurnAllowedAtPosition(character, position)) {
      const [minimum, maximum] = skillTurnRangeForPosition(position);
      const rangeLabel = Number.isFinite(maximum) ? `${minimum}〜${maximum}` : `${minimum}以上`;
      errors.push(`${character.name}のスキルターン${character.skillTurn}は${position}枠目の許容範囲${rangeLabel}ではありません。`);
    }
  }
  if (constraints.requiredRole && !deck.some((character) => character.roleTags.includes(constraints.requiredRole))) {
    errors.push(`必須役割 ${constraints.requiredRole} が含まれていません。`);
  }

  return { valid: errors.length === 0, errors, totalCost };
}
