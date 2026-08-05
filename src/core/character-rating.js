import { calculateMinimumDamage, resolveAttributeMultiplier } from "./damage.js";
import { expectedTurnForPosition, isSkillTurnAllowedAtPosition } from "./filter.js";
import {
  ATTRIBUTES,
  ATTRIBUTE_CLASS_ATTRIBUTES,
  ATTRIBUTE_CLASSES,
  DEFAULT_RULES,
  resolveAttributeClass,
} from "../data/rules.js";
import { isExcludedSkill } from "./skills.js";

const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_FRONTIER_BEAM_WIDTH = 60;
const DEFAULT_PER_COST_LIMIT = 8;
const DEFAULT_SHADOW_RADIUS = 8;

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileScores(values, options = {}) {
  const { zeroIsZero = false } = options;
  const comparable = zeroIsZero ? values.filter((value) => value > 0) : values;
  const sorted = [...comparable].sort((left, right) => left - right);
  return values.map((value) => {
    if (zeroIsZero && value <= 0) return 0;
    if (sorted.length <= 1) return sorted.length ? 100 : 0;
    let lower = 0;
    let equal = 0;
    for (const candidate of sorted) {
      if (candidate < value) lower += 1;
      else if (candidate === value) equal += 1;
      else break;
    }
    return 100 * (lower + Math.max(0, equal - 1) / 2) / (sorted.length - 1);
  });
}

function normalizedAttributes(attributes) {
  const selected = [...new Set((attributes ?? []).map(String))].filter((attribute) => ATTRIBUTES.includes(attribute));
  return selected.length ? selected : [...ATTRIBUTES];
}

export function characterMatchesAttributeRestriction(character, allowedAttributes = ATTRIBUTES) {
  const selected = normalizedAttributes(allowedAttributes);
  return Boolean(
    resolveAttributeClass(character?.attributes) &&
    character.attributes.some((attribute) => selected.includes(attribute)),
  );
}

export function buildPositionPool(characters, position, options = {}) {
  const allowedAttributes = normalizedAttributes(options.allowedAttributes);
  return characters.filter((character) => {
    if (!characterMatchesAttributeRestriction(character, allowedAttributes)) return false;
    if (character.pvpTier === "exclude" && !options.includeExcluded) return false;
    if (character.pvpTier === "low" && options.includeLow === false) return false;
    if (!character.allowedPositions?.includes(position)) return false;
    return isSkillTurnAllowedAtPosition(character, position);
  });
}

function conditionCoverage(conditions, conditionType, pool) {
  const relevant = (conditions ?? []).filter((condition) => condition.type === conditionType);
  if (!relevant.length || !pool.length) return 1;
  return pool.filter((character) => relevant.every((condition) => (
    character.attributes.includes(condition.attribute)
  ))).length / pool.length;
}

function selfConditionCoverage(character, conditions) {
  const relevant = (conditions ?? []).filter((condition) => condition.type === "ally_attribute");
  return relevant.every((condition) => character.attributes.includes(condition.attribute)) ? 1 : 0;
}

function discountedDuration(skill, rules) {
  const duration = Math.max(1, Number(skill?.duration) || 1);
  const discounts = rules.continuousEffectDiscounts ?? [1];
  let total = 0;
  for (let index = 0; index < duration; index += 1) {
    total += discounts[index] ?? discounts.at(-1) ?? 1;
  }
  return total;
}

function supportTargetUnits(character, skill, pool) {
  const allyCoverage = skill.target === "self"
    ? selfConditionCoverage(character, skill.conditions)
    : conditionCoverage(skill.conditions, "ally_attribute", pool);
  const targetCount = skill.target === "self" || skill.target === "leader"
    ? 1
    : Math.min(5, Math.max(1, Number(skill.targetCount) || 1));
  return targetCount * allyCoverage;
}

function attributeChangeGain(character, skill, pool, rules) {
  const changedAttributes = (skill.effects ?? [])
    .flatMap((effect) => effect.attribute ? [effect.attribute] : []);
  if (!changedAttributes.length || !pool.length) return 0;
  return average(pool.map((opponent) => {
    const current = resolveAttributeMultiplier(character.attributes, opponent.attributes, rules);
    const changed = resolveAttributeMultiplier(changedAttributes, opponent.attributes, rules);
    return Math.max(0, changed - current);
  }));
}

export function estimateSkillPotency(character, pool, position, rules = DEFAULT_RULES) {
  const skill = character.skill ?? { type: "none" };
  if (isExcludedSkill(skill) || skill.type === "none") return 0;

  const expectedTurn = expectedTurnForPosition(position);
  const skillTurn = Math.max(0, Number(character.skillTurn) || 0);
  const readiness = position === 1
    ? 1 / (1 + skillTurn * 0.25)
    : skillTurn <= expectedTurn
      ? 1
      : 0.8;
  const duration = discountedDuration(skill, rules);
  const multiplier = Math.max(0, Number(skill.multiplier) || 0);
  const targetUnits = supportTargetUnits(character, skill, pool);
  const enemyCoverage = conditionCoverage(skill.conditions, "enemy_attribute", pool);
  let roundEquivalent = 0;

  if (skill.type === "single_attack") {
    roundEquivalent = Math.max(0, multiplier - 1);
  } else if (skill.type === "multi_hit_attack") {
    roundEquivalent = Math.max(0, multiplier * Math.max(1, Number(skill.hits) || 1) - 1) * duration;
  } else if (skill.type === "aoe_attack") {
    const targets = Math.min(5, Math.max(1, Number(skill.targetCount) || 5));
    roundEquivalent = Math.max(0, multiplier * targets - 1) * duration;
  } else if (skill.type === "attack_buff") {
    roundEquivalent = Math.max(0, multiplier - 1) * targetUnits * duration * enemyCoverage;
  } else if (skill.type === "damage_reduction") {
    roundEquivalent = Math.max(0, 1 - multiplier) * targetUnits * duration * enemyCoverage;
  } else if (["guard", "attribute_guard"].includes(skill.type)) {
    roundEquivalent = Math.max(0, 1 - multiplier) * 4 * duration * enemyCoverage;
  } else if (skill.type === "heal") {
    roundEquivalent = Math.min(2, multiplier) * targetUnits;
  } else if (skill.type === "revive") {
    roundEquivalent = Math.min(2, multiplier) * targetUnits * 1.25;
  } else if (skill.type === "attribute_change") {
    roundEquivalent = attributeChangeGain(character, skill, pool, rules) * targetUnits * duration;
  }

  return Math.log1p(Math.max(0, roundEquivalent)) * readiness;
}

function pairwiseRawMetrics(pool, rules) {
  const metrics = pool.map(() => ({
    knockoutTotal: 0,
    damageRatioTotal: 0,
    survivalTotal: 0,
    retainedHpTotal: 0,
  }));
  if (!pool.length) return metrics;

  for (let attackerIndex = 0; attackerIndex < pool.length; attackerIndex += 1) {
    const attacker = pool[attackerIndex];
    for (let defenderIndex = 0; defenderIndex < pool.length; defenderIndex += 1) {
      const defender = pool[defenderIndex];
      const damage = calculateMinimumDamage({ attacker, defender, rules }).value;
      const damageRatio = defender.hp > 0 ? damage / defender.hp : 0;
      metrics[attackerIndex].knockoutTotal += damage >= defender.hp ? 1 : 0;
      metrics[attackerIndex].damageRatioTotal += Math.min(1.5, damageRatio) / 1.5;
      metrics[defenderIndex].survivalTotal += damage < defender.hp ? 1 : 0;
      metrics[defenderIndex].retainedHpTotal += Math.max(0, 1 - damageRatio);
    }
  }

  return metrics.map((metric) => ({
    knockoutRate: metric.knockoutTotal / pool.length,
    damageRatio: metric.damageRatioTotal / pool.length,
    survivalRate: metric.survivalTotal / pool.length,
    retainedHpRate: metric.retainedHpTotal / pool.length,
  }));
}

export function ratePositionCharacters(characters, position, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const pool = buildPositionPool(characters, position, options);
  const pairwise = pairwiseRawMetrics(pool, rules);
  const offenseRaw = pairwise.map((metric) => metric.knockoutRate * 0.35 + metric.damageRatio * 0.65);
  const defenseRaw = pairwise.map((metric) => metric.survivalRate * 0.65 + metric.retainedHpRate * 0.35);
  const skillRaw = pool.map((character) => estimateSkillPotency(character, pool, position, rules));
  const offenseScores = percentileScores(offenseRaw);
  const defenseScores = percentileScores(defenseRaw);
  const skillScores = percentileScores(skillRaw, { zeroIsZero: true });

  return pool.map((character, index) => {
    const components = {
      offense: offenseScores[index],
      defense: defenseScores[index],
      skill: skillScores[index],
    };
    return {
      character,
      position,
      baseScore: rounded(components.offense * 0.4 + components.defense * 0.35 + components.skill * 0.25),
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, rounded(value)])),
      rawMetrics: {
        knockoutRate: rounded(pairwise[index].knockoutRate, 4),
        damageRatio: rounded(pairwise[index].damageRatio, 4),
        survivalRate: rounded(pairwise[index].survivalRate, 4),
        retainedHpRate: rounded(pairwise[index].retainedHpRate, 4),
        skillPotency: rounded(skillRaw[index], 4),
      },
      skillEffectIgnored: isExcludedSkill(character.skill),
    };
  });
}

function insertFrontierState(bucket, state, limit) {
  let minimum = 0;
  let maximum = bucket.length;
  while (minimum < maximum) {
    const middle = Math.floor((minimum + maximum) / 2);
    if (bucket[middle].score >= state.score) minimum = middle + 1;
    else maximum = middle;
  }
  const index = minimum;
  if (index >= limit) return;
  bucket.splice(index, 0, state);
  if (bucket.length > limit) bucket.length = limit;
}

function reducePositionRatings(ratings, perCostLimit) {
  const byCost = new Map();
  for (const rating of ratings) {
    const cost = Math.max(0, Math.round(Number(rating.character.cost) || 0));
    const bucket = byCost.get(cost) ?? [];
    bucket.push(rating);
    bucket.sort((left, right) => right.baseScore - left.baseScore);
    if (bucket.length > perCostLimit) bucket.length = perCostLimit;
    byCost.set(cost, bucket);
  }
  const frontierCandidates = [];
  const bestAffordable = [];
  for (const cost of [...byCost.keys()].sort((left, right) => left - right)) {
    for (const rating of byCost.get(cost)) {
      let index = bestAffordable.findIndex((candidate) => candidate.baseScore < rating.baseScore);
      if (index < 0) index = bestAffordable.length;
      if (index >= perCostLimit) continue;
      bestAffordable.splice(index, 0, rating);
      if (bestAffordable.length > perCostLimit) bestAffordable.length = perCostLimit;
      frontierCandidates.push(rating);
    }
  }
  return frontierCandidates;
}

export function buildStaticDeckFrontier(positionRatings, options = {}) {
  const beamWidth = options.beamWidth ?? DEFAULT_FRONTIER_BEAM_WIDTH;
  const perCostLimit = options.perCostLimit ?? DEFAULT_PER_COST_LIMIT;
  const maximumCost = options.maximumCost ?? positionRatings.reduce((sum, ratings) => (
    sum + Math.max(0, ...ratings.map((rating) => Number(rating.character.cost) || 0))
  ), 0);
  let states = Array.from({ length: maximumCost + 1 }, () => []);
  states[0] = [{ score: 0, cost: 0, ids: [], slots: [] }];

  for (const ratings of positionRatings) {
    const candidates = reducePositionRatings(ratings, perCostLimit);
    const next = Array.from({ length: maximumCost + 1 }, () => []);
    for (let cost = 0; cost < states.length; cost += 1) {
      for (const state of states[cost]) {
        for (const rating of candidates) {
          const id = String(rating.character.id);
          if (state.ids.includes(id)) continue;
          const candidateCost = Math.max(0, Math.round(Number(rating.character.cost) || 0));
          const nextCost = cost + candidateCost;
          if (nextCost > maximumCost) continue;
          insertFrontierState(next[nextCost], {
            score: state.score + rating.baseScore,
            cost: nextCost,
            ids: [...state.ids, id],
            slots: [...state.slots, rating],
          }, beamWidth);
        }
      }
    }
    states = next;
  }

  const bestByLimit = [];
  let best = null;
  for (let cost = 0; cost <= maximumCost; cost += 1) {
    const exactBest = states[cost][0];
    if (exactBest && (!best || exactBest.score > best.score)) best = exactBest;
    bestByLimit[cost] = best;
  }
  return { states, bestByLimit, maximumCost };
}

function minimumCompletion(character, targetPosition, positionPools) {
  const otherPositions = [1, 2, 3, 4, 5].filter((position) => position !== targetPosition);
  const shortlistSize = otherPositions.length + 1;
  const pools = otherPositions.map((position) => [...positionPools[position - 1]]
    .sort((left, right) => left.character.cost - right.character.cost || right.baseScore - left.baseScore)
    .slice(0, shortlistSize));
  let best = null;

  const visit = (poolIndex, ids, cost, slots) => {
    if (best && cost >= best.cost) return;
    if (poolIndex === pools.length) {
      best = { cost, slots };
      return;
    }
    for (const rating of pools[poolIndex]) {
      const id = String(rating.character.id);
      if (id === String(character.id) || ids.has(id)) continue;
      const nextIds = new Set(ids);
      nextIds.add(id);
      visit(poolIndex + 1, nextIds, cost + rating.character.cost, [...slots, rating]);
    }
  };

  visit(0, new Set(), 0, []);
  return best;
}

function shadowPrice(frontier, totalCost, radius = DEFAULT_SHADOW_RADIUS) {
  const minimum = frontier.bestByLimit.findIndex(Boolean);
  if (minimum < 0) return 0;
  const left = Math.max(minimum, totalCost - radius);
  const right = Math.min(frontier.maximumCost, totalCost + radius);
  const leftScore = frontier.bestByLimit[left]?.score;
  const rightScore = frontier.bestByLimit[right]?.score;
  if (!Number.isFinite(leftScore) || !Number.isFinite(rightScore) || right <= left) return 0;
  return Math.max(0, (rightScore - leftScore) / (right - left));
}

function rankAtCost(targetRatings, totalCost, prices, minimumDeckCosts) {
  const price = prices[totalCost] ?? 0;
  const ranked = targetRatings
    .filter((rating) => minimumDeckCosts.get(String(rating.character.id)) <= totalCost)
    .map((rating) => ({
      rating,
      utility: rating.baseScore - price * rating.character.cost,
      opportunityCost: price * rating.character.cost,
    }))
    .sort((left, right) => (
      right.utility - left.utility ||
      right.rating.baseScore - left.rating.baseScore ||
      left.rating.character.cost - right.rating.character.cost
    ));
  return ranked.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    percentile: ranked.length <= 1 ? 100 : 100 * (ranked.length - index - 1) / (ranked.length - 1),
  }));
}

function serializeTopEntry(entry) {
  return {
    id: String(entry.rating.character.id),
    name: entry.rating.character.name,
    cost: entry.rating.character.cost,
    baseScore: entry.rating.baseScore,
    utility: rounded(entry.utility),
    opportunityCost: rounded(entry.opportunityCost),
    rank: entry.rank,
    percentile: rounded(entry.percentile),
  };
}

export function buildCharacterRatingReport(characters, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const allowedAttributes = normalizedAttributes(options.allowedAttributes);
  const position = Math.min(5, Math.max(1, Number(options.position) || 2));
  const selectedCost = Math.max(0, Math.round(Number(options.totalCost) || 150));
  const positionRatings = [1, 2, 3, 4, 5].map((slot) => ratePositionCharacters(characters, slot, {
    ...options,
    allowedAttributes,
    rules,
  }));
  const frontier = buildStaticDeckFrontier(positionRatings, options.frontier);
  const targetRatings = positionRatings[position - 1];
  const minimumDeckCosts = new Map(targetRatings.map((rating) => {
    const completion = minimumCompletion(rating.character, position, positionRatings);
    return [String(rating.character.id), completion ? completion.cost + rating.character.cost : Number.POSITIVE_INFINITY];
  }));
  const minimumCost = Math.min(...minimumDeckCosts.values());
  const maximumCost = frontier.maximumCost;
  const prices = Array.from({ length: maximumCost + 1 }, (_, cost) => shadowPrice(
    frontier,
    cost,
    options.shadowRadius,
  ));
  const summaries = new Map(targetRatings.map((rating) => [String(rating.character.id), {
    bestRank: Number.POSITIVE_INFINITY,
    top20CostCount: 0,
    top50CostCount: 0,
  }]));
  const topByCost = [];
  const topLimit = Math.max(1, Number(options.topLimit) || DEFAULT_TOP_LIMIT);

  for (let totalCost = minimumCost; totalCost <= maximumCost; totalCost += 1) {
    const ranked = rankAtCost(targetRatings, totalCost, prices, minimumDeckCosts);
    for (const entry of ranked) {
      const summary = summaries.get(String(entry.rating.character.id));
      summary.bestRank = Math.min(summary.bestRank, entry.rank);
      if (entry.rank <= 20) summary.top20CostCount += 1;
      if (entry.rank <= 50) summary.top50CostCount += 1;
    }
    topByCost.push({
      totalCost,
      shadowPrice: rounded(prices[totalCost], 4),
      bestStaticDeckScore: rounded(frontier.bestByLimit[totalCost]?.score ?? 0),
      top: ranked.slice(0, topLimit).map(serializeTopEntry),
    });
  }

  const selectedRanking = rankAtCost(targetRatings, selectedCost, prices, minimumDeckCosts);
  const selectedById = new Map(selectedRanking.map((entry) => [String(entry.rating.character.id), entry]));
  const ratedCharacters = targetRatings.map((rating) => {
    const character = rating.character;
    const selected = selectedById.get(String(character.id));
    const summary = summaries.get(String(character.id));
    return {
      id: String(character.id),
      name: character.name,
      attributes: character.attributes,
      attributeClass: resolveAttributeClass(character.attributes),
      cost: character.cost,
      hp: character.hp,
      pow: character.pow,
      rarity: character.rarity,
      region: character.region,
      skillTurn: character.skillTurn,
      skillType: character.skill?.type ?? "none",
      skillName: character.skillName ?? "",
      skillEffectIgnored: rating.skillEffectIgnored,
      baseScore: rating.baseScore,
      components: rating.components,
      rawMetrics: rating.rawMetrics,
      minimumDeckCost: minimumDeckCosts.get(String(character.id)),
      selectedCost: selected ? {
        feasible: true,
        rank: selected.rank,
        percentile: rounded(selected.percentile),
        utility: rounded(selected.utility),
        opportunityCost: rounded(selected.opportunityCost),
      } : { feasible: false },
      acrossCosts: {
        bestRank: Number.isFinite(summary.bestRank) ? summary.bestRank : null,
        top20CostCount: summary.top20CostCount,
        top50CostCount: summary.top50CostCount,
      },
    };
  }).sort((left, right) => (
    (left.selectedCost.rank ?? Number.POSITIVE_INFINITY) - (right.selectedCost.rank ?? Number.POSITIVE_INFINITY) ||
    right.baseScore - left.baseScore
  ));

  const selectedFrontier = frontier.bestByLimit[Math.min(selectedCost, maximumCost)];
  return {
    generatedAt: new Date().toISOString(),
    model: {
      version: "character-rating-v1",
      description: "固定コスト帯を使わず、各総コスト上限の静的デッキ限界からコスト1点の機会損失を算出する。",
      baseScoreWeights: { offense: 0.4, defense: 0.35, skill: 0.25 },
      ignoredSkillTypes: ["delay", "skill_reduction"],
      attributeRestriction: "選択した火・水・風のいずれかを含むキャラ",
      costAxis: { minimum: minimumCost, maximum: maximumCost, step: 1 },
      shadowRadius: options.shadowRadius ?? DEFAULT_SHADOW_RADIUS,
    },
    context: {
      allowedAttributes,
      position,
      selectedCost,
      eligibleCharacterCount: targetRatings.length,
    },
    selectedCostSummary: {
      shadowPrice: rounded(prices[Math.min(selectedCost, maximumCost)] ?? 0, 4),
      feasibleCharacterCount: selectedRanking.length,
      bestStaticDeckScore: rounded(selectedFrontier?.score ?? 0),
      bestStaticDeck: selectedFrontier?.slots.map((rating) => ({
        position: rating.position,
        id: String(rating.character.id),
        name: rating.character.name,
        cost: rating.character.cost,
        baseScore: rating.baseScore,
      })) ?? [],
    },
    characters: ratedCharacters,
    topByCost,
  };
}

export function ratingReportToCsv(report) {
  const headers = [
    "順位", "キャラID", "名前", "属性", "コスト", "HP", "Power", "スキルターン", "スキル種類",
    "スキル名", "基礎点", "攻撃点", "耐久点", "スキル点", "最低総コスト", "指定コスト評価値",
    "コスト機会損失", "全コスト中の最高順位", "短縮・遅延効果を無視",
  ];
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = report.characters.map((character) => [
    character.selectedCost.rank ?? "",
    character.id,
    character.name,
    character.attributeClass,
    character.cost,
    character.hp,
    character.pow,
    character.skillTurn,
    character.skillType,
    character.skillName,
    character.baseScore,
    character.components.offense,
    character.components.defense,
    character.components.skill,
    character.minimumDeckCost,
    character.selectedCost.utility ?? "",
    character.selectedCost.opportunityCost ?? "",
    character.acrossCosts.bestRank ?? "",
    character.skillEffectIgnored ? "はい" : "いいえ",
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

export const CHARACTER_RATING_ATTRIBUTE_CLASSES = Object.freeze(
  ATTRIBUTE_CLASSES.map((attributeClass) => ({
    attributeClass,
    attributes: ATTRIBUTE_CLASS_ATTRIBUTES[attributeClass],
  })),
);
