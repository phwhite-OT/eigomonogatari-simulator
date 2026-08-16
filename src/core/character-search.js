import { attributeClassLabel, resolveAttributeClass } from "../data/rules.js";

const ATTRIBUTE_KEYWORDS = Object.freeze([
  { keywords: ["火属性", "fire"], attribute: "fire", label: "火属性" },
  { keywords: ["水属性", "water"], attribute: "water", label: "水属性" },
  { keywords: ["風属性", "wind"], attribute: "wind", label: "風属性" },
  { keywords: ["火水", "火水属性"], attribute: "fire_water", label: "火水属性", exact: true },
  { keywords: ["火風", "火風属性"], attribute: "fire_wind", label: "火風属性", exact: true },
  { keywords: ["水風", "水風属性"], attribute: "water_wind", label: "水風属性", exact: true },
  { keywords: ["全属性", "白属性"], attribute: "all", label: "全属性", exact: true },
]);

const SKILL_KEYWORDS = Object.freeze([
  { keywords: ["全体攻撃", "全体", "aoe"], label: "全体攻撃", types: ["aoe_attack"] },
  { keywords: ["連続攻撃", "連撃", "多段"], label: "連続攻撃", types: ["multi_hit_attack"] },
  { keywords: ["攻撃アップ", "攻撃力アップ", "バフ"], label: "攻撃力アップ", types: ["attack_buff"] },
  { keywords: ["回復", "ヒーラー", "heal"], label: "回復", types: ["heal"] },
  { keywords: ["蘇生", "復活"], label: "蘇生", types: ["revive"] },
  { keywords: ["属性かばう", "色かばう"], label: "属性かばう", types: ["attribute_guard"] },
  { keywords: ["かばう", "庇う", "タンク"], label: "かばう", types: ["guard", "attribute_guard"] },
  { keywords: ["防御", "軽減"], label: "防御・軽減", types: ["damage_reduction", "guard", "attribute_guard"] },
  { keywords: ["短縮"], label: "スキル短縮", types: ["skill_reduction"] },
  { keywords: ["遅延"], label: "スキル遅延", types: ["delay"] },
  { keywords: ["属性変更", "色変"], label: "属性変更", types: ["attribute_change"] },
]);

const PREFERENCE_KEYWORDS = Object.freeze([
  { keywords: ["低コスト", "コスト安い", "軽量"], key: "lowCost", label: "低コスト優先" },
  { keywords: ["高火力", "火力高い", "攻撃力高い"], key: "highPower", label: "Powerが高い順を優先" },
  { keywords: ["高hp", "hp高い", "体力高い"], key: "highHp", label: "HPが高い順を優先" },
  { keywords: ["スキル早い", "早いスキル"], key: "fastSkill", label: "スキルが早い順を優先" },
]);

const CHARACTER_SEARCH_SKILL_LABELS = Object.freeze({
  attack_buff: "攻撃力アップ",
  heal: "回復",
  damage_reduction: "防御・軽減",
  multi_hit_attack: "連続攻撃",
  attribute_change: "属性変更",
  guard: "かばう",
  revive: "蘇生",
  attribute_guard: "属性かばう",
  skill_reduction: "スキル短縮",
  delay: "スキル遅延",
  aoe_attack: "全体攻撃",
  none: "スキルなし",
});

const CHARACTER_SEARCH_ROLE_LABELS = Object.freeze({
  single_attacker: "単体攻撃",
  aoe_attacker: "全体攻撃",
  multi_hit_attacker: "連続攻撃",
  tank: "耐久",
  guard: "かばう",
  attribute_guard: "属性かばう",
  heal: "回復",
  revive: "蘇生",
  buff: "強化",
  debuff: "弱体化",
  delay: "遅延",
  skill_reduction: "短縮",
  attribute_change: "属性変更",
  finisher: "フィニッシャー",
  opener: "初手",
  setup: "準備",
  late_game: "終盤",
});

function katakanaToHiragana(value) {
  return value.replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
}

export function normalizeCharacterSearchText(value) {
  return katakanaToHiragana(String(value ?? "").normalize("NFKC").toLowerCase())
    .replace(/[、，,／/・+＋|｜]/g, " ")
    .replace(/[()（）［\]【】「」『』]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return normalizeCharacterSearchText(value).replace(/[\s\-ー_]/g, "");
}

function unique(values) {
  return [...new Set(values)];
}

function removeKeywords(value, entries) {
  let remainder = value;
  const found = [];
  for (const entry of entries) {
    const keyword = entry.keywords
      .map(normalizeCharacterSearchText)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => candidate && remainder.includes(candidate));
    if (!keyword) continue;
    found.push(entry);
    remainder = remainder.replaceAll(keyword, " ");
  }
  return { found, remainder };
}

export function parseCharacterSearchQuery(rawQuery) {
  const normalized = normalizeCharacterSearchText(rawQuery);
  const attributeResult = removeKeywords(normalized, ATTRIBUTE_KEYWORDS);
  const skillResult = removeKeywords(attributeResult.remainder, SKILL_KEYWORDS);
  const preferenceResult = removeKeywords(skillResult.remainder, PREFERENCE_KEYWORDS);
  let keywordRemainder = preferenceResult.remainder
    .replace(/([一-龠々]+)の(?=\s|[a-z0-9])/gu, "$1 ")
    .replace(/(?:^|\s)[のをがはでにへと](?=\s|$)/gu, " ");
  const plainAttributeKeywords = [
    { keyword: "火", attribute: "fire", label: "火属性" },
    { keyword: "水", attribute: "water", label: "水属性" },
    { keyword: "風", attribute: "wind", label: "風属性" },
  ];
  const plainAttributes = plainAttributeKeywords.filter((entry) => new RegExp("(?:^|\\s)" + entry.keyword + "(?=\\s|$)", "u").test(keywordRemainder));
  for (const entry of plainAttributes) keywordRemainder = keywordRemainder.replace(new RegExp("(?:^|\\s)" + entry.keyword + "(?=\\s|$)", "u"), " ");
  const terms = unique(keywordRemainder
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean));
  return {
    raw: String(rawQuery ?? ""),
    normalized,
    attributes: [...attributeResult.found, ...plainAttributes],
    skillKeywords: skillResult.found,
    preferences: preferenceResult.found,
    terms,
    interpreted: unique([
      ...attributeResult.found.map((entry) => entry.label),
      ...plainAttributes.map((entry) => entry.label),
      ...skillResult.found.map((entry) => entry.label),
      ...preferenceResult.found.map((entry) => entry.label),
      ...terms.map((term) => "キーワード「" + term + "」"),
    ]),
  };
}

function createDocument(character, sourceIndex) {
  const attributeLabel = attributeClassLabel(character.attributes);
  const roles = (character.roleTags ?? []).map((tag) => CHARACTER_SEARCH_ROLE_LABELS[tag] ?? tag).join(" ");
  const fields = {
    name: normalizeCharacterSearchText(character.name),
    id: normalizeCharacterSearchText(character.id),
    attribute: normalizeCharacterSearchText(attributeLabel + " " + attributeLabel + "属性 " + (character.attributes ?? []).join(" ")),
    skill: normalizeCharacterSearchText((character.skillName ?? "") + " " + (character.skillCategory ?? "") + " " + (CHARACTER_SEARCH_SKILL_LABELS[character.skill?.type] ?? "")),
    region: normalizeCharacterSearchText(character.region),
    rarity: normalizeCharacterSearchText(character.rarity),
    roles: normalizeCharacterSearchText(roles),
    stats: normalizeCharacterSearchText("コスト " + (character.cost ?? "") + " hp " + (character.hp ?? "") + " power " + (character.pow ?? "") + " スキル " + (character.skillTurn ?? "") + "ターン"),
    notes: normalizeCharacterSearchText(character.notes),
  };
  return {
    character,
    sourceIndex,
    attributeClass: resolveAttributeClass(character.attributes),
    attributeLabel,
    fields,
  };
}

export function createCharacterSearchIndex(characters) {
  const list = Array.isArray(characters) ? characters : [];
  return Object.freeze({
    documents: list.map(createDocument),
  });
}

function createNgrams(value) {
  const compact = compactText(value);
  if (compact.length < 2) return compact ? [compact] : [];
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) grams.push(compact.slice(index, index + 2));
  return unique(grams);
}

function nameSimilarity(left, right) {
  const leftGrams = createNgrams(left);
  const rightGrams = createNgrams(right);
  if (!leftGrams.length || !rightGrams.length) return 0;
  const rightSet = new Set(rightGrams);
  const shared = leftGrams.filter((gram) => rightSet.has(gram)).length;
  return (2 * shared) / (leftGrams.length + rightGrams.length);
}

function matchTerm(document, term) {
  const compactTerm = compactText(term);
  const weights = { name: 20, id: 18, skill: 11, region: 9, rarity: 9, roles: 7, attribute: 7, stats: 4, notes: 3 };
  let best = null;
  for (const [field, value] of Object.entries(document.fields)) {
    const compactValue = compactText(value);
    if (!compactValue) continue;
    if (compactValue === compactTerm || compactValue.includes(compactTerm)) {
      const candidate = { field, score: weights[field], exact: true };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  if (best || compactTerm.length < 4) return best;
  const similarity = nameSimilarity(compactTerm, document.fields.name);
  return similarity >= 0.43 ? { field: "name", score: 13 * similarity, exact: false } : null;
}

function matchesAttributes(document, entries) {
  return entries.every((entry) => entry.exact
    ? document.attributeClass === entry.attribute
    : document.character.attributes.includes(entry.attribute));
}

function matchesSkills(document, entries) {
  return entries.every((entry) => entry.types.includes(document.character.skill?.type));
}

function preferenceScore(character, entries, ranges) {
  return entries.reduce((score, entry) => {
    if (entry.key === "lowCost") return score + 4 * (1 - Number(character.cost ?? 0) / ranges.maxCost);
    if (entry.key === "highPower") return score + 4 * Number(character.pow ?? 0) / ranges.maxPow;
    if (entry.key === "highHp") return score + 4 * Number(character.hp ?? 0) / ranges.maxHp;
    if (entry.key === "fastSkill") return score + 4 * (1 - Number(character.skillTurn ?? 0) / ranges.maxSkillTurn);
    return score;
  }, 0);
}

function sortResults(results, sort) {
  const tie = (left, right) => left.sourceIndex - right.sourceIndex;
  if (sort === "source") return results.sort(tie);
  if (sort === "cost") return results.sort((left, right) => left.character.cost - right.character.cost || right.score - left.score || tie(left, right));
  if (sort === "hp") return results.sort((left, right) => right.character.hp - left.character.hp || right.score - left.score || tie(left, right));
  if (sort === "pow") return results.sort((left, right) => right.character.pow - left.character.pow || right.score - left.score || tie(left, right));
  if (sort === "skillTurn") return results.sort((left, right) => left.character.skillTurn - right.character.skillTurn || right.score - left.score || tie(left, right));
  return results.sort((left, right) => right.score - left.score || left.character.cost - right.character.cost || tie(left, right));
}

export function searchCharacters(indexOrCharacters, query, options = {}) {
  const index = Array.isArray(indexOrCharacters) ? createCharacterSearchIndex(indexOrCharacters) : indexOrCharacters;
  if (!index?.documents) throw new TypeError("キャラクター配列または検索インデックスを指定してください。");
  const parsed = parseCharacterSearchQuery(query);
  if (!parsed.normalized) return { query: parsed, total: 0, results: [] };
  const ranges = index.documents.reduce((current, document) => ({
    maxCost: Math.max(current.maxCost, Number(document.character.cost ?? 0)),
    maxHp: Math.max(current.maxHp, Number(document.character.hp ?? 0)),
    maxPow: Math.max(current.maxPow, Number(document.character.pow ?? 0)),
    maxSkillTurn: Math.max(current.maxSkillTurn, Number(document.character.skillTurn ?? 0)),
  }), { maxCost: 1, maxHp: 1, maxPow: 1, maxSkillTurn: 1 });
  const results = [];
  for (const document of index.documents) {
    if (!matchesAttributes(document, parsed.attributes) || !matchesSkills(document, parsed.skillKeywords)) continue;
    const reasons = [];
    let score = 0;
    if (parsed.attributes.length) {
      score += parsed.attributes.length * 8;
      reasons.push("属性: " + document.attributeLabel);
    }
    if (parsed.skillKeywords.length) {
      score += parsed.skillKeywords.length * 10;
      reasons.push("スキル: " + parsed.skillKeywords.map((entry) => entry.label).join("・"));
    }
    let missingTerm = false;
    for (const term of parsed.terms) {
      const match = matchTerm(document, term);
      if (!match) {
        missingTerm = true;
        break;
      }
      score += match.score;
      reasons.push((match.exact ? "一致" : "名前の近似一致") + ": " + term);
    }
    if (missingTerm) continue;
    score += preferenceScore(document.character, parsed.preferences, ranges);
    if (parsed.preferences.length) reasons.push(parsed.preferences.map((entry) => entry.label).join("・"));
    results.push({ character: document.character, attributeLabel: document.attributeLabel, reasons, score, sourceIndex: document.sourceIndex });
  }
  sortResults(results, options.sort ?? "relevance");
  const limit = Math.max(1, Number(options.limit) || 50);
  return { query: parsed, total: results.length, results: results.slice(0, limit) };
}
