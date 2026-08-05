export const ATTRIBUTES = ["fire", "water", "wind"];

export const ATTRIBUTE_CLASS_ATTRIBUTES = Object.freeze({
  fire: ["fire"],
  water: ["water"],
  wind: ["wind"],
  fire_water: ["fire", "water"],
  fire_wind: ["fire", "wind"],
  water_wind: ["water", "wind"],
  all: ["fire", "water", "wind"],
});

export const ATTRIBUTE_CLASSES = Object.freeze(Object.keys(ATTRIBUTE_CLASS_ATTRIBUTES));

export const ATTRIBUTE_CLASS_LABELS = Object.freeze({
  fire: "火",
  water: "水",
  wind: "風",
  fire_water: "火水",
  fire_wind: "火風",
  water_wind: "水風",
  all: "全",
});

export function resolveAttributeClass(attributes) {
  if (!Array.isArray(attributes) || !attributes.length) return "";
  const rawAttributes = attributes.map(String);
  if (rawAttributes.some((attribute) => !ATTRIBUTES.includes(attribute))) return "";
  const uniqueAttributes = [...new Set(rawAttributes)];
  if (uniqueAttributes.length !== rawAttributes.length) return "";
  return ATTRIBUTE_CLASSES.find((attributeClass) => {
    const expected = ATTRIBUTE_CLASS_ATTRIBUTES[attributeClass];
    return expected.length === uniqueAttributes.length && expected.every((attribute) => uniqueAttributes.includes(attribute));
  }) ?? "";
}

export function attributeClassLabel(attributes) {
  const attributeClass = resolveAttributeClass(attributes);
  return ATTRIBUTE_CLASS_LABELS[attributeClass] ?? "属性不明";
}

const attributeMultiplierTable = {
  "fire:fire": 2 / 3,
  "fire:water": 1 / 3,
  "fire:wind": 1,
  "water:fire": 1,
  "water:water": 2 / 3,
  "water:wind": 1 / 3,
  "wind:fire": 1 / 3,
  "wind:water": 1,
  "wind:wind": 2 / 3,
};

export const DEFAULT_RULES = Object.freeze({
  damage: {
    selfMultiplier: 1.2,
    excellentMultiplier: 1.2,
    questionLevelMultiplier: 1.8,
    eventBonusMultiplier: 1.5,
    specialAttackMultiplier: 1,
    randomMinimum: 0.9,
    pvpMultiplier: 0.75,
    survivalBaseMultiplier: 1.3,
    rounding: "floor",
    attributeResolution: "average",
    attributeMultipliers: attributeMultiplierTable,
  },
  position: {
    preferredBonus: 12,
    allowedPenalty: 0,
    expectedSkillChargeByPosition: [0, 1, 2, 3, 4],
    lateSkillPenalty: 9,
  },
  continuousEffectDiscounts: [1, 0.8, 0.6, 0.4],
  representativeEnemyWeights: {
    worst: 0.5,
    standard: 0.3,
    favorable: 0.2,
  },
  simulation: {
    turns: 8,
    ghostPower: 1000,
  },
  scoreWeights: {
    opener: 0.2,
    attack: 0.18,
    defense: 0.15,
    skillConnection: 0.13,
    lateGame: 0.09,
    stability: 0.08,
    simulation: 0.17,
  },
  search: {
    chunkSize: 750,
    topLimit: 300,
    detailedLimit: 120,
    modes: {
      fast: 10000,
      standard: 60000,
      precise: 300000,
    },
  },
  unresolved: [
    "地域・限界突破補正",
    "同時攻撃の厳密な内部順序",
    "連続攻撃で撃破した後の再標的",
  ],
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeRules(baseRules = DEFAULT_RULES, overrides = {}) {
  const merge = (base, next) => {
    if (!isPlainObject(base) || !isPlainObject(next)) {
      return next === undefined ? structuredClone(base) : structuredClone(next);
    }

    const result = structuredClone(base);
    for (const [key, value] of Object.entries(next)) {
      result[key] = key in base ? merge(base[key], value) : structuredClone(value);
    }
    return result;
  };

  return merge(baseRules, overrides);
}

export function validateRules(rules) {
  const errors = [];
  const positiveDamageKeys = [
    "selfMultiplier",
    "excellentMultiplier",
    "questionLevelMultiplier",
    "eventBonusMultiplier",
    "specialAttackMultiplier",
    "randomMinimum",
    "pvpMultiplier",
    "survivalBaseMultiplier",
  ];

  for (const key of positiveDamageKeys) {
    if (!Number.isFinite(rules.damage?.[key]) || rules.damage[key] < 0) {
      errors.push(`damage.${key} は0以上の数値で指定してください。`);
    }
  }

  if (!Number.isFinite(rules.simulation?.turns) || rules.simulation.turns < 1 || rules.simulation.turns > 12) {
    errors.push("simulation.turns は1から12の数値で指定してください。");
  }

  if (!Number.isFinite(rules.simulation?.ghostPower) || rules.simulation.ghostPower < 0) {
    errors.push("simulation.ghostPower は0以上の数値で指定してください。");
  }

  if (!["none", "floor", "round", "ceil"].includes(rules.damage?.rounding)) {
    errors.push("damage.rounding は none / floor / round / ceil のいずれかです。");
  }

  if (!["average", "first", "best", "worst"].includes(rules.damage?.attributeResolution)) {
    errors.push("damage.attributeResolution は average / first / best / worst のいずれかです。");
  }

  return errors;
}
