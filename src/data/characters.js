import { ATTRIBUTES, ATTRIBUTE_CLASS_ATTRIBUTES, resolveAttributeClass } from "./rules.js";

export const ROLE_TAGS = [
  "single_attacker",
  "aoe_attacker",
  "multi_hit_attacker",
  "tank",
  "guard",
  "attribute_guard",
  "heal",
  "revive",
  "buff",
  "debuff",
  "delay",
  "skill_reduction",
  "attribute_change",
  "finisher",
  "opener",
  "setup",
  "late_game",
];

export const STAT_GROWTH_STAGES = Object.freeze(["lv1", "max", "max_limit_break"]);

export const STAT_LEVEL_PROFILES = Object.freeze({
  N: Object.freeze({ normalMaxLevel: 30, fullLimitBreakMaxLevel: 54, maxLimitBreak: 4 }),
  R: Object.freeze({ normalMaxLevel: 50, fullLimitBreakMaxLevel: 100, maxLimitBreak: 5 }),
  CR: Object.freeze({ normalMaxLevel: 60, fullLimitBreakMaxLevel: 132, maxLimitBreak: 6 }),
  ZR: Object.freeze({ normalMaxLevel: 99, fullLimitBreakMaxLevel: 237, maxLimitBreak: 7 }),
  MZR: Object.freeze({ normalMaxLevel: 99, fullLimitBreakMaxLevel: 237, maxLimitBreak: 7 }),
  伝: Object.freeze({ normalMaxLevel: 99, fullLimitBreakMaxLevel: 237, maxLimitBreak: 7 }),
});

function isStatGrowthStage(value) {
  return STAT_GROWTH_STAGES.includes(value);
}

function stageStat(value, minimum = 0) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : null;
}

function statPair(hp, pow) {
  const normalizedHp = stageStat(hp, 1);
  const normalizedPow = stageStat(pow, 0);
  return normalizedHp === null || normalizedPow === null ? null : { hp: normalizedHp, pow: normalizedPow };
}

function statsAtLevel(level1Stats, normalMaxLevel, targetLevel) {
  const multiplier = 1 + ((targetLevel - 1) / (normalMaxLevel - 1));
  return {
    hp: Math.floor(level1Stats.hp * multiplier),
    pow: Math.floor(level1Stats.pow * multiplier),
  };
}

export function resolveStatLevelProfile(rarity) {
  const key = String(rarity ?? "").trim().toUpperCase();
  return STAT_LEVEL_PROFILES[key] ?? null;
}

export function calculateCharacterStatStages(level1Hp, level1Pow, options = {}) {
  const lv1 = statPair(level1Hp, level1Pow);
  if (!lv1) return { lv1: null, max: null, max_limit_break: null, profile: null };

  const profile = options.normalMaxLevel && options.fullLimitBreakMaxLevel
    ? {
      normalMaxLevel: Number(options.normalMaxLevel),
      fullLimitBreakMaxLevel: Number(options.fullLimitBreakMaxLevel),
      maxLimitBreak: Number(options.maxLimitBreak ?? 0),
    }
    : resolveStatLevelProfile(options.rarity);
  const nonLimitMax = statPair(options.nonLimitMaxHp, options.nonLimitMaxPow) ?? {
    hp: lv1.hp * 2,
    pow: lv1.pow * 2,
  };
  const exactFullLimit = statPair(options.fullLimitBreakHp, options.fullLimitBreakPow);
  const fullLimitBreak = exactFullLimit ?? (profile
    ? statsAtLevel(lv1, profile.normalMaxLevel, profile.fullLimitBreakMaxLevel)
    : null);

  return { lv1, max: nonLimitMax, max_limit_break: fullLimitBreak, profile };
}

export function calculateCharacterStats(level1Hp, level1Pow, statGrowth = "lv1", options = {}) {
  const stages = calculateCharacterStatStages(level1Hp, level1Pow, options);
  return stages[statGrowth] ?? stages.max ?? stages.lv1;
}

const demoArchetypes = [
  { type: "single_attack", role: "single_attacker", multiplier: 2.2, turn: 2 },
  { type: "aoe_attack", role: "aoe_attacker", multiplier: 1.35, turn: 3 },
  { type: "multi_hit_attack", role: "multi_hit_attacker", multiplier: 0.8, hits: 3, turn: 3 },
  { type: "attack_buff", role: "buff", multiplier: 1.45, duration: 2, turn: 2 },
  { type: "damage_reduction", role: "tank", multiplier: 0.55, duration: 2, turn: 2 },
  { type: "guard", role: "guard", multiplier: 0.65, duration: 2, turn: 2 },
  { type: "heal", role: "heal", multiplier: 0.32, turn: 3 },
  { type: "revive", role: "revive", multiplier: 0.35, turn: 4 },
  { type: "delay", role: "delay", amount: 1, turn: 3 },
  { type: "skill_reduction", role: "skill_reduction", amount: 1, turn: 2 },
  { type: "attribute_change", role: "attribute_change", turn: 3 },
  { type: "attribute_guard", role: "attribute_guard", multiplier: 0.45, duration: 2, turn: 3 },
];

function createDemoCharacter(index) {
  const archetype = demoArchetypes[index % demoArchetypes.length];
  const attribute = ATTRIBUTES[index % ATTRIBUTES.length];
  const positionGroup = index % 3;
  const preferredPositions = positionGroup === 0 ? [1, 2] : positionGroup === 1 ? [2, 3, 4] : [4, 5];
  const rarity = ["CR", "ZR", "MZR", "N", "R"][index % 5];
  const tier = index % 19 === 0 ? "exclude" : index % 7 === 0 ? "low" : index % 4 === 0 ? "priority" : "normal";
  const roleTags = [archetype.role];

  if (preferredPositions.includes(1)) roleTags.push("opener");
  if (preferredPositions.includes(5)) roleTags.push("late_game", "finisher");
  if (["attack_buff", "damage_reduction", "guard"].includes(archetype.type)) roleTags.push("setup");

  return {
    id: 10001 + index,
    name: `デモキャラ ${String(index + 1).padStart(3, "0")}`,
    attributes: [attribute],
    cost: 14 + ((index * 7) % 25),
    hp: 3200 + ((index * 389) % 4800),
    pow: 2600 + ((index * 431) % 5000),
    rarity,
    region: `デモ地域${(index % 6) + 1}`,
    owned: index % 5 !== 0,
    pvpTier: tier,
    allowedPositions: [1, 2, 3, 4, 5],
    preferredPositions,
    positionRule: positionGroup === 0 ? "early" : positionGroup === 1 ? "mid" : "late",
    skillTurn: archetype.turn,
    maxUses: 2,
    skill: {
      type: archetype.type,
      multiplier: archetype.multiplier ?? 1,
      hits: archetype.hits ?? 1,
      amount: archetype.amount ?? 0,
      target: archetype.type === "aoe_attack" ? "enemy_all" : "enemy_one",
      targetCount: archetype.type === "aoe_attack" ? 5 : 1,
      duration: archetype.duration ?? 1,
      priority: tier === "priority" ? "high" : "normal",
      conditions: [],
      effects: [],
    },
    roleTags: [...new Set(roleTags)],
  };
}

export const DEMO_CHARACTERS = Object.freeze(
  Array.from({ length: 84 }, (_, index) => Object.freeze(createDemoCharacter(index))),
);

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCataloguePlacement(value) {
  if (!value || typeof value !== "object") return null;
  const anchorId = String(value.anchorId ?? "").trim();
  const position = String(value.position ?? "");
  if (!anchorId || !["before", "after"].includes(position)) return null;
  return { anchorId, position };
}

export function normalizeCharacter(rawCharacter, index = 0) {
  const attributes = Array.isArray(rawCharacter.attributes)
    ? rawCharacter.attributes.map(String).filter(Boolean)
    : rawCharacter.attribute
      ? [String(rawCharacter.attribute)]
      : [];
  const allowedPositions = Array.isArray(rawCharacter.allowedPositions)
    ? rawCharacter.allowedPositions.map(Number).filter((position) => position >= 1 && position <= 5)
    : [1, 2, 3, 4, 5];
  const preferredPositions = Array.isArray(rawCharacter.preferredPositions)
    ? rawCharacter.preferredPositions.map(Number).filter((position) => allowedPositions.includes(position))
    : allowedPositions;
  const normalizedRarity = String(rawCharacter.rarity ?? "unknown").trim() || "unknown";
  const rawStatGrowth = String(rawCharacter.statGrowth ?? "final");
  const directLevel1Hp = Number(rawCharacter.level1Hp);
  const directLevel1Pow = Number(rawCharacter.level1Pow);
  const hasDirectLevel1Stats = rawCharacter.level1Hp !== undefined &&
    rawCharacter.level1Hp !== null &&
    rawCharacter.level1Pow !== undefined &&
    rawCharacter.level1Pow !== null &&
    Number.isFinite(directLevel1Hp) &&
    directLevel1Hp > 0 &&
    Number.isFinite(directLevel1Pow) &&
    directLevel1Pow >= 0;
  const isLegacyManualTraining = !hasDirectLevel1Stats &&
    rawCharacter.source?.sheet === "手入力" &&
    isStatGrowthStage(rawStatGrowth);
  const level1Hp = hasDirectLevel1Stats
    ? directLevel1Hp
    : isLegacyManualTraining
      ? asFiniteNumber(rawCharacter.baseHp, rawCharacter.hp)
      : null;
  const level1Pow = hasDirectLevel1Stats
    ? directLevel1Pow
    : isLegacyManualTraining
      ? asFiniteNumber(rawCharacter.basePow, rawCharacter.pow)
      : null;
  const hasLevel1Stats = level1Hp !== null && level1Hp > 0 && level1Pow !== null && level1Pow >= 0;
  const statGrowth = hasLevel1Stats && isStatGrowthStage(rawStatGrowth) ? rawStatGrowth : "final";
  const hasRegisteredManualStages = rawCharacter.manualStageStats === true;
  const calculatedStages = hasLevel1Stats
    ? calculateCharacterStatStages(level1Hp, level1Pow, {
      rarity: normalizedRarity,
      nonLimitMaxHp: hasRegisteredManualStages ? rawCharacter.baseHp : undefined,
      nonLimitMaxPow: hasRegisteredManualStages ? rawCharacter.basePow : undefined,
      fullLimitBreakHp: hasRegisteredManualStages ? rawCharacter.fullLimitBreakHp : undefined,
      fullLimitBreakPow: hasRegisteredManualStages ? rawCharacter.fullLimitBreakPow : undefined,
      normalMaxLevel: hasRegisteredManualStages ? rawCharacter.normalMaxLevel : undefined,
      fullLimitBreakMaxLevel: hasRegisteredManualStages ? rawCharacter.fullLimitBreakMaxLevel : undefined,
      maxLimitBreak: hasRegisteredManualStages ? rawCharacter.limitBreak : undefined,
    })
    : null;
  const baseHp = calculatedStages?.max?.hp ?? asFiniteNumber(rawCharacter.baseHp, rawCharacter.hp);
  const basePow = calculatedStages?.max?.pow ?? asFiniteNumber(rawCharacter.basePow, rawCharacter.pow);
  const fullLimitBreakHp = calculatedStages?.max_limit_break?.hp ?? null;
  const fullLimitBreakPow = calculatedStages?.max_limit_break?.pow ?? null;
  const calculatedStats = statGrowth === "final"
    ? null
    : calculatedStages?.[statGrowth] ?? calculatedStages?.max ?? null;

  return {
    id: rawCharacter.id ?? `imported-${index + 1}`,
    name: String(rawCharacter.name ?? `名称未設定 ${index + 1}`),
    attributes,
    cost: asFiniteNumber(rawCharacter.cost),
    hp: calculatedStats?.hp ?? asFiniteNumber(rawCharacter.hp),
    pow: calculatedStats?.pow ?? asFiniteNumber(rawCharacter.pow),
    baseHp,
    basePow,
    level1Hp,
    level1Pow,
    fullLimitBreakHp,
    fullLimitBreakPow,
    normalMaxLevel: calculatedStages?.profile?.normalMaxLevel ?? null,
    fullLimitBreakMaxLevel: calculatedStages?.profile?.fullLimitBreakMaxLevel ?? null,
    manualStageStats: hasRegisteredManualStages,
    statGrowth,
    maxLevel: asFiniteNumber(rawCharacter.maxLevel),
    limitBreak: asFiniteNumber(rawCharacter.limitBreak),
    rarity: normalizedRarity,
    region: String(rawCharacter.region ?? "unknown"),
    owned: rawCharacter.owned !== false,
    pvpTier: ["exclude", "low", "normal", "priority"].includes(rawCharacter.pvpTier)
      ? rawCharacter.pvpTier
      : "normal",
    allowedPositions: [...new Set(allowedPositions)],
    preferredPositions: [...new Set(preferredPositions)],
    positionRule: ["early", "mid", "late", "free"].includes(rawCharacter.positionRule)
      ? rawCharacter.positionRule
      : "free",
    skillTurn: Math.max(0, asFiniteNumber(rawCharacter.skillTurn)),
    maxUses: Math.min(2, Math.max(0, asFiniteNumber(rawCharacter.maxUses, 2))),
    source: rawCharacter.source ?? null,
    cataloguePlacement: normalizeCataloguePlacement(rawCharacter.cataloguePlacement),
    skill: {
      type: String(rawCharacter.skill?.type ?? "none"),
      multiplier: asFiniteNumber(rawCharacter.skill?.multiplier, 1),
      hits: Math.max(1, asFiniteNumber(rawCharacter.skill?.hits, 1)),
      amount: asFiniteNumber(rawCharacter.skill?.amount),
      target: String(rawCharacter.skill?.target ?? "enemy_one"),
      targetCount: Math.max(1, asFiniteNumber(rawCharacter.skill?.targetCount, 1)),
      duration: Math.max(1, asFiniteNumber(rawCharacter.skill?.duration, 1)),
      priority: String(rawCharacter.skill?.priority ?? "normal"),
      conditions: Array.isArray(rawCharacter.skill?.conditions) ? rawCharacter.skill.conditions : [],
      effects: Array.isArray(rawCharacter.skill?.effects) ? rawCharacter.skill.effects : [],
    },
    skillName: String(rawCharacter.skillName ?? ""),
    skillCategory: String(rawCharacter.skillCategory ?? ""),
    notes: String(rawCharacter.notes ?? ""),
    roleTags: Array.isArray(rawCharacter.roleTags)
      ? [...new Set(rawCharacter.roleTags.map(String).filter(Boolean))]
      : [],
  };
}

export function parseCharacterPayload(payload) {
  const rawCharacters = Array.isArray(payload) ? payload : payload?.characters;
  if (!Array.isArray(rawCharacters)) {
    throw new TypeError("JSONはキャラクター配列、または characters 配列を持つオブジェクトにしてください。");
  }

  const characters = rawCharacters.map(normalizeCharacter);
  const ids = new Set();
  const errors = [];
  for (const [index, character] of characters.entries()) {
    if (ids.has(String(character.id))) errors.push(`${index + 1}件目: id ${character.id} が重複しています。`);
    ids.add(String(character.id));
    if (!resolveAttributeClass(character.attributes)) errors.push(`${index + 1}件目: attributes は火・水・風・火水・火風・水風・全のいずれかで指定してください。`);
    if (character.hp <= 0) errors.push(`${index + 1}件目: hp は0より大きい必要があります。`);
    if (character.pow < 0) errors.push(`${index + 1}件目: pow は0以上で指定してください。`);
    if (character.cost < 0) errors.push(`${index + 1}件目: cost は0以上で指定してください。`);
    if (!character.allowedPositions.length) errors.push(`${index + 1}件目: 配置可能な枠がありません。`);
  }

  if (errors.length) {
    throw new TypeError(`キャラクターデータを読み込めません。\n${errors.slice(0, 20).join("\n")}`);
  }
  return characters;
}


function manualNumber(value, label, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    throw new TypeError(label + "は" + minimum + "以上の数値を入力してください。");
  }
  return number;
}

function optionalManualNumber(value, label, minimum, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return manualNumber(value, label, minimum);
}

function manualPositions(values, label) {
  const positions = Array.isArray(values) ? values : [];
  const normalized = [...new Set(positions.map(Number).filter((position) => position >= 1 && position <= 5))];
  if (!normalized.length) throw new TypeError(label + "を1つ以上選択してください。");
  return normalized;
}

function manualConditions(values) {
  const conditions = [];
  const allyAttribute = String(values.allyAttribute ?? "");
  const enemyAttribute = String(values.enemyAttribute ?? "");
  if (ATTRIBUTES.includes(allyAttribute)) conditions.push({ type: "ally_attribute", attribute: allyAttribute });
  if (ATTRIBUTES.includes(enemyAttribute)) conditions.push({ type: "enemy_attribute", attribute: enemyAttribute });
  return conditions;
}

function manualEffects(values) {
  const effectAttribute = String(values.effectAttribute ?? "");
  if (effectAttribute === "all") return ATTRIBUTES.map((attribute) => ({ attribute }));
  return ATTRIBUTES.includes(effectAttribute) ? [{ attribute: effectAttribute }] : [];
}

export function createManualCharacter(values, existingIds = []) {
  const name = String(values?.name ?? "").trim();
  if (!name) throw new TypeError("キャラ名を入力してください。");
  const attributeClass = String(values?.attributeClass ?? "");
  const attributes = ATTRIBUTE_CLASS_ATTRIBUTES[attributeClass];
  if (!attributes) throw new TypeError("属性を選択してください。");
  const existing = new Set([...existingIds].map(String));
  const idPrefix = "manual-" + Date.now().toString(36);
  let sequence = 1;
  let id = idPrefix + "-" + sequence;
  while (existing.has(id)) {
    sequence += 1;
    id = idPrefix + "-" + sequence;
  }
  const cost = manualNumber(values.cost, "コスト", 0);
  const hp = manualNumber(values.hp, "HP", 1);
  const pow = manualNumber(values.pow, "Power", 0);
  const rarity = String(values.rarity ?? "N").trim() || "N";
  const skillTurn = manualNumber(values.skillTurn, "スキルターン", 0);
  const multiplier = manualNumber(values.multiplier ?? 1, "スキル倍率", 0);
  const hits = manualNumber(values.hits ?? 1, "ヒット数", 1);
  const duration = manualNumber(values.duration ?? 1, "継続ターン", 1);
  const amount = manualNumber(values.amount ?? 0, "効果量", 0);
  const requestedStatGrowth = String(values.statGrowth ?? "final");
  const statGrowth = isStatGrowthStage(requestedStatGrowth) ? requestedStatGrowth : "final";
  const generatedStages = statGrowth === "final"
    ? null
    : calculateCharacterStatStages(hp, pow, {
      rarity,
      nonLimitMaxHp: values.baseHp,
      nonLimitMaxPow: values.basePow,
      fullLimitBreakHp: values.fullLimitBreakHp,
      fullLimitBreakPow: values.fullLimitBreakPow,
    });
  if (statGrowth !== "final" && !generatedStages?.max_limit_break) {
    throw new TypeError("最軽装でも使う松の数値は、標準レア度または個別の松ステータスを指定してください。");
  }
  const level1Hp = statGrowth === "final" ? null : hp;
  const level1Pow = statGrowth === "final" ? null : pow;
  const baseHp = generatedStages?.max?.hp ?? optionalManualNumber(values.baseHp, "基礎HP", 1, hp);
  const basePow = generatedStages?.max?.pow ?? optionalManualNumber(values.basePow, "基礎Power", 0, pow);
  const fullLimitBreakHp = generatedStages?.max_limit_break?.hp ?? null;
  const fullLimitBreakPow = generatedStages?.max_limit_break?.pow ?? null;
  const maxLevel = optionalManualNumber(
    values.maxLevel,
    "最大レベル",
    0,
    generatedStages?.profile?.fullLimitBreakMaxLevel ?? 0,
  );
  const limitBreak = optionalManualNumber(
    values.limitBreak,
    "限界突破",
    0,
    generatedStages?.profile?.maxLimitBreak ?? 0,
  );
  const allowedPositions = manualPositions(values.allowedPositions ?? [1, 2, 3, 4, 5], "配置可能枠");
  const preferredInput = Array.isArray(values.preferredPositions) ? values.preferredPositions : allowedPositions;
  const preferredPositions = [...new Set(preferredInput.map(Number).filter((position) => allowedPositions.includes(position)))];
  const maxUses = Math.min(2, manualNumber(values.maxUses ?? 2, "スキル使用回数", 0));
  const skillType = String(values.skillType ?? "none");
  const targetCount = manualNumber(values.targetCount ?? (skillType === "aoe_attack" ? 5 : 1), "対象数", 1);
  const defaultTarget = skillType === "aoe_attack" ? "enemy_all" : skillType.includes("attack") ? "enemy_one" : "self";
  const pvpTier = ["exclude", "low", "normal", "priority"].includes(values.pvpTier)
    ? values.pvpTier
    : "normal";
  return normalizeCharacter({
    id,
    source: { sheet: "手入力", row: "" },
    name,
    attributes,
    cost,
    hp,
    pow,
    baseHp,
    basePow,
    level1Hp,
    level1Pow,
    fullLimitBreakHp,
    fullLimitBreakPow,
    normalMaxLevel: generatedStages?.profile?.normalMaxLevel ?? null,
    fullLimitBreakMaxLevel: generatedStages?.profile?.fullLimitBreakMaxLevel ?? null,
    manualStageStats: statGrowth !== "final",
    statGrowth,
    maxLevel,
    limitBreak,
    rarity,
    region: String(values.region ?? "手入力").trim() || "手入力",
    owned: values.owned !== false,
    pvpTier,
    allowedPositions,
    preferredPositions: preferredPositions.length ? preferredPositions : allowedPositions,
    positionRule: ["early", "mid", "late", "free"].includes(values.positionRule)
      ? values.positionRule
      : "free",
    skillTurn,
    maxUses,
    skillName: String(values.skillName ?? "").trim(),
    skillCategory: String(values.skillCategory ?? "").trim(),
    notes: String(values.notes ?? "手入力").trim(),
    roleTags: Array.isArray(values.roleTags)
      ? [...new Set(values.roleTags.map(String).filter((tag) => ROLE_TAGS.includes(tag)))]
      : [],
    skill: {
      type: skillType,
      multiplier,
      hits,
      amount,
      target: String(values.target ?? "").trim() || defaultTarget,
      targetCount,
      duration,
      priority: ["low", "normal", "high"].includes(values.priority) ? values.priority : "normal",
      conditions: manualConditions(values),
      effects: manualEffects(values),
    },
  });
}

export function updateManualCharacter(values, existingCharacter) {
  if (!existingCharacter || typeof existingCharacter !== "object") {
    throw new TypeError("編集するキャラデータを指定してください。");
  }

  const draft = createManualCharacter(values, [existingCharacter.id]);
  return normalizeCharacter({
    ...existingCharacter,
    ...draft,
    id: String(existingCharacter.id),
    source: existingCharacter.source,
    cataloguePlacement: existingCharacter.cataloguePlacement,
    pvpTier: existingCharacter.pvpTier,
    allowedPositions: existingCharacter.allowedPositions,
    preferredPositions: existingCharacter.preferredPositions,
    positionRule: existingCharacter.positionRule,
    maxUses: existingCharacter.maxUses,
    notes: existingCharacter.notes,
    roleTags: existingCharacter.roleTags,
    skill: {
      ...existingCharacter.skill,
      ...draft.skill,
      priority: existingCharacter.skill?.priority ?? draft.skill.priority,
    },
  });
}
