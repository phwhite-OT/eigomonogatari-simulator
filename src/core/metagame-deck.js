import { createBattleState } from "./battleState.js";
import { simulateBattle } from "./simulate.js";
import { DEFAULT_ENVIRONMENT_BATTLE_PROFILES } from "./environment-rating.js";
import { DEFAULT_RULES, resolveAttributeClass } from "../data/rules.js";
import { isSkillTurnAllowedAtPosition } from "./filter.js";

const METAGAME_DECK_PROFILES = DEFAULT_ENVIRONMENT_BATTLE_PROFILES;
export const METAGAME_STAT_BOOST_MULTIPLIER = 1.5;

export function normalizeMetagameBoostedCharacterIds(values) {
  const rawValues = values instanceof Set ? [...values] : values ?? [];
  return new Set((Array.isArray(rawValues) ? rawValues : [rawValues])
    .map((value) => String(value?.id ?? value ?? "").trim())
    .filter(Boolean));
}

/**
 * Returns a non-mutating battle copy for a character affected by the current
 * event bonus.  The base catalog must remain intact because the user may turn
 * the bonus off and rerun the same constraint immediately afterwards.
 */
export function applyMetagameStatBoost(character, boostedCharacterIds, multiplier = METAGAME_STAT_BOOST_MULTIPLIER) {
  if (!character) return character;
  const boostedIds = normalizeMetagameBoostedCharacterIds(boostedCharacterIds);
  if (!boostedIds.has(String(character.id))) return character;
  if (Number(character?.metagameStatBoost?.multiplier) === Number(multiplier)) return character;
  return {
    ...character,
    hp: Math.max(0, Number(character.hp) || 0) * multiplier,
    pow: Math.max(0, Number(character.pow) || 0) * multiplier,
    metagameStatBoost: {
      multiplier,
      hpMultiplier: multiplier,
      powMultiplier: multiplier,
    },
  };
}

function metagameCharactersById(characters, boostedCharacterIds) {
  const boostedIds = normalizeMetagameBoostedCharacterIds(boostedCharacterIds);
  return new Map((characters ?? []).map((character) => [
    String(character.id),
    applyMetagameStatBoost(character, boostedIds),
  ]));
}

function metagameDeckClampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function metagameCandidateScore(rating) {
  const advantage = Math.min(1, Math.max(0, Number(rating.advantageCreation) || 0) / 2);
  const counter = Math.min(1, Math.max(0, Number(rating.counteraction) || 0) / 2);
  const practicalValue = metagameDeckClampUnit(rating.practicalValue ?? rating.practical?.practicalValue);
  const powerPreference = metagameDeckClampUnit(rating.powerPreference ?? rating.practical?.powerPreference);
  const skillReliability = metagameDeckClampUnit(
    rating.practicalSkillReliability ?? rating.practical?.practicalSkillReliability ?? rating.skillActivationRate,
  );
  const enemyPressure = metagameDeckClampUnit(rating.enemyPressureRate);
  const combinationPotential = metagameDeckClampUnit(rating.combinationPotential);
  const continuationWinGain = metagameDeckClampUnit(rating.continuationWinGain);
  const carriedContinuationWinGain = metagameDeckClampUnit(rating.carriedContinuationWinGain);
  const tacticalUpside = metagameDeckClampUnit(rating.tacticalUpside ?? rating.tactical?.tacticalUpside);
  const tacticalRisk = metagameDeckClampUnit(rating.tacticalRisk ?? rating.tactical?.tacticalRisk);
  const lateSkillRisk = metagameDeckClampUnit(rating.roleBreakdown?.lateSkillRisk ?? rating.lateSkillRisk);
  const roleFit = metagameDeckClampUnit(rating.roleFit ?? rating.individualScore);
  const retention = metagameDeckClampUnit(rating.allyRetentionRate);
  const stabilisingRole = ["defense", "revive", "recovery"].includes(rating.role);
  return (
    metagameDeckClampUnit(rating.expectedWinLowerBound) * 0.29 +
    metagameDeckClampUnit(rating.expectedWinRate) * 0.18 +
    practicalValue * 0.15 +
    roleFit * 0.14 +
    metagameDeckClampUnit(rating.balancedContribution) * 0.07 +
    enemyPressure * 0.055 +
    powerPreference * 0.05 +
    advantage * 0.07 +
    counter * 0.035 +
    skillReliability * 0.035 +
    combinationPotential * 0.04 +
    continuationWinGain * 0.02 +
    carriedContinuationWinGain * 0.025 +
    tacticalUpside * 0.035 +
    retention * (stabilisingRole ? 0.055 : 0.02) -
    tacticalRisk * 0.04 -
    lateSkillRisk * 0.08
  );
}

function metagameSkillMatchesTarget(source, target) {
  const skill = source.character.skill ?? {};
  const affectedCharacter = skill.target === "self" ? source.character : target.character;
  return (skill.conditions ?? []).every((condition) => (
    condition.type !== "ally_attribute" || (affectedCharacter.attributes ?? []).includes(condition.attribute)
  ));
}

function metagameDeckTargetEndurance(target) {
  const hp = Math.max(0, Number(target.character.hp) || 0);
  const hpFactor = hp / (hp + 5_000);
  const retention = metagameDeckClampUnit(target.rating.allyRetentionRate);
  return metagameDeckClampUnit(hpFactor * 0.65 + retention * 0.35);
}

function metagamePersistentDefenseCommitment(source) {
  const skill = source.character.skill ?? {};
  const duration = Math.max(0, Number(skill.duration) || 0);
  if (duration < 2 || !["damage_reduction", "guard", "attribute_guard"].includes(skill.type)) return 0;
  const reliability = metagameDeckClampUnit(
    source.rating.practicalSkillReliability ?? source.rating.skillActivationRate,
  );
  const persistence = metagameDeckClampUnit((duration - 1) / 3);
  const reductionStrength = metagameDeckClampUnit(1 - (Number(skill.multiplier) || 1));
  const carriedDefenseRate = metagameDeckClampUnit(Number(source.rating.carriedDefenseRate) || 0);
  const carriedWinGain = metagameDeckClampUnit(source.rating.carriedContinuationWinGain);
  return metagameDeckClampUnit(reliability * (
    0.28 + persistence * 0.24 + reductionStrength * 0.18 +
    Math.max(carriedDefenseRate / 4, carriedWinGain) * 0.08
  ));
}

function metagameDeckHandoffRisk(source, target) {
  const commitment = metagamePersistentDefenseCommitment(source);
  if (!commitment) return 0;
  const endurance = metagameDeckTargetEndurance(target);
  const hp = Math.max(0, Number(target.character.hp) || 0);
  const lowEndurance = metagameDeckClampUnit((0.44 - endurance) / 0.44);
  const lowHp = metagameDeckClampUnit((1_600 - hp) / 1_600);
  return commitment * (lowEndurance * 0.12 + lowHp * 0.10);
}

function metagameDeckPairSynergy(source, target) {
  const skill = source.character.skill ?? {};
  const duration = Math.max(0, Number(skill.duration) || 0);
  const reliability = metagameDeckClampUnit(
    source.rating.practicalSkillReliability ?? source.rating.skillActivationRate,
  );
  if (duration < 2 || reliability === 0 || !metagameSkillMatchesTarget(source, target)) return 0;
  const targetPower = metagameDeckClampUnit(target.rating.powerPreference);
  const targetEndurance = metagameDeckTargetEndurance(target);
  const sourceRetention = metagameDeckClampUnit(source.rating.allyRetentionRate);
  const distance = Math.max(1, Number(target.position) - Number(source.position) || 1);
  // Continuous effects transfer on defeat.  A later slot can use one only if
  // the source is likely to hand off before its remaining duration expires;
  // treating every long effect as an unconditional buff for every successor
  // is what previously inflated attack-buff stacks.
  const handoffChance = 0.15 + (1 - sourceRetention) * 0.85;
  const durationReach = metagameDeckClampUnit((duration - distance) / Math.max(1, duration - 1));
  const allyAllReach = skill.target === "ally_all" ? 0.45 + handoffChance * 0.55 : handoffChance;
  const continuationReach = reliability * durationReach * allyAllReach;
  const targetBoard = metagameDeckClampUnit(target.rating.roleBreakdown?.boardCoverage);
  const targetHardTarget = metagameDeckClampUnit(target.rating.roleBreakdown?.highDurabilityCoverage);
  const targetOffense = Math.max(
    targetBoard,
    targetHardTarget * 0.65,
    metagameDeckClampUnit(target.rating.enemyPressureRate) * 0.8,
    targetPower * 0.45,
  );
  const targetIsSweep = metagameDeckRole(target.rating) === "sweep_attack";
  if (["ally_all", "self", "leader"].includes(skill.target) && skill.type === "attack_buff") {
    const strength = metagameDeckClampUnit((Number(skill.multiplier) - 1) / 3);
    return continuationReach * (0.008 + strength * 0.032) * targetOffense * (targetIsSweep ? 1.18 : 1);
  }
  if (["ally_all", "self", "leader"].includes(skill.target) && skill.type === "attribute_change") {
    return continuationReach * (0.012 + targetOffense * 0.025) * (0.45 + targetEndurance * 0.55);
  }
  if (["aoe_attack", "multi_hit_attack"].includes(skill.type)) {
    const modeStrength = skill.type === "aoe_attack"
      ? 1
      : metagameDeckClampUnit((Math.max(1, Number(skill.hits) || 1) - 1) / 4);
    // A carried attack mode is especially valuable when the successor can
    // remain on board and convert its normal attacks into board pressure.
    return continuationReach * (0.016 + modeStrength * 0.055) * targetOffense * (0.4 + targetEndurance * 0.6);
  }
  if (["damage_reduction", "guard", "attribute_guard"].includes(skill.type)) {
    const reductionStrength = metagameDeckClampUnit(1 - (Number(skill.multiplier) || 1));
    const carriedDefenseHits = Number(
      source.rating.carriedDefenseRate ?? source.rating.continuation?.carriedDefenseHitsPerScenario ?? 0,
    );
    const carriedDefenseRate = metagameDeckClampUnit(carriedDefenseHits / 2);
    const carriedWinEvidence = metagameDeckClampUnit(source.rating.carriedContinuationWinGain);
    const defenseValue = 0.055 + reductionStrength * 0.065 + carriedDefenseRate * 0.02 + carriedWinEvidence * 0.02;
    return continuationReach * defenseValue * (0.15 + targetEndurance * 0.85);
  }
  return 0;
}

export function calculateMetagameDeckSynergy(deck, ratings) {
  return deck.reduce((total, character, targetIndex) => (
    total + deck.slice(0, targetIndex).reduce((pairTotal, sourceCharacter, sourceIndex) => (
      pairTotal + metagameDeckPairSynergy(
        { character: sourceCharacter, rating: ratings[sourceIndex] ?? {} },
        { character, rating: ratings[targetIndex] ?? {} },
      )
    ), 0)
  ), 0);
}

function metagameDeckRole(rating) {
  if (rating?.role) return rating.role;
  switch (rating?.skillType) {
    case "single_attack": return "precision_attack";
    case "aoe_attack":
    case "multi_hit_attack": return "sweep_attack";
    case "damage_reduction":
    case "guard":
    case "attribute_guard": return "defense";
    case "revive": return "revive";
    case "heal": return "recovery";
    case "attack_buff":
    case "attribute_change": return "support";
    default: return "neutral";
  }
}

function metagameDeckRoleCountsAdd(roleCounts, rating) {
  const role = metagameDeckRole(rating);
  return { ...roleCounts, [role]: (roleCounts[role] ?? 0) + 1 };
}

function metagameDeckAttackCommitment(rating) {
  const role = metagameDeckRole(rating);
  if (role === "sweep_attack") return 1;
  if (role === "precision_attack") return 0.8;
  if (rating?.skillType === "attack_buff") {
    return rating?.skillTarget === "ally_all" ? 0.55 : 0.7;
  }
  return 0;
}

function metagameDeckFirepowerSurplus(attackCommitment, roleCounts) {
  const stabilisers = (roleCounts.defense ?? 0) + (roleCounts.revive ?? 0) + (roleCounts.recovery ?? 0);
  const sufficientPressure = stabilisers > 0 ? 1.75 : 1.45;
  return Math.max(0, attackCommitment - sufficientPressure);
}

function metagameDeckRoleBalance(roleCounts, deckLength, attackCommitment = 0) {
  if (deckLength < 2) return 0;
  const precision = roleCounts.precision_attack ?? 0;
  const sweep = roleCounts.sweep_attack ?? 0;
  const attack = precision + sweep > 0 || attackCommitment >= 0.7;
  const defense = roleCounts.defense ?? 0;
  const recovery = (roleCounts.revive ?? 0) + (roleCounts.recovery ?? 0);
  let bonus = attack && defense > 0 ? 0.032 : 0;
  if (attack && recovery > 0) bonus += 0.028;
  if (defense > 0 && recovery > 0) bonus += 0.022;
  if (attack && defense > 0 && recovery > 0) bonus += 0.018;
  if (precision > 0 && sweep > 0) bonus += 0.01;
  const repeatedRolePenalty = Object.values(roleCounts).reduce((total, count) => (
    total + Math.max(0, Number(count) - 2) * 0.01
  ), 0);
  // This is not a ban on attack-heavy decks.  It merely makes the third and
  // later offensive commitment earn its place through the 5v5 simulation
  // instead of receiving another full proxy score by default.
  const surplusPenalty = metagameDeckFirepowerSurplus(attackCommitment, roleCounts) * 0.045;
  return bonus - repeatedRolePenalty - surplusPenalty;
}

function metagameDeckStateScore(state, totalCost) {
  const averageScore = state.proxyTotal / Math.max(1, state.deck.length);
  const legacyRoleBonus = state.advantageCount > 0 && state.counterCount > 0 ? 0.008 : 0;
  const roleBonus = legacyRoleBonus + metagameDeckRoleBalance(
    state.roleCounts ?? {},
    state.deck.length,
    state.attackCommitment ?? 0,
  );
  const deckProgress = state.deck.length / 5;
  const budgetShare = state.totalCost / Math.max(1, totalCost);
  const earlyBudgetPressure = Math.max(0, budgetShare - (deckProgress * 0.95 + 0.07));
  return averageScore + state.synergyScore + roleBonus - state.budgetStrain - state.handoffRisk - earlyBudgetPressure * 0.18;
}

function metagameDeckStrategyKey(state) {
  const roles = state.roleCounts ?? {};
  const attackBand = Math.min(3, Math.floor((state.attackCommitment ?? 0) + 0.35));
  const defenseBand = Math.min(2, Number(roles.defense) || 0);
  const recoveryBand = Math.min(2, (Number(roles.revive) || 0) + (Number(roles.recovery) || 0));
  const supportBand = Math.min(2, Number(roles.support) || 0);
  return `a${attackBand}-d${defenseBand}-r${recoveryBand}-s${supportBand}`;
}

function metagameTrimDeckBeam(states, width, totalCost) {
  const byId = new Map();
  for (const state of states) {
    const key = state.deck.map((entry) => entry.character.id).join("|");
    const current = byId.get(key);
    if (!current || metagameDeckStateScore(state, totalCost) > metagameDeckStateScore(current, totalCost)) {
      byId.set(key, state);
    }
  }
  const unique = [...byId.values()];
  const selected = new Map();
  const primaryCount = Math.max(1, Math.floor(width * 0.6));
  const primary = [...unique].sort((left, right) => (
    metagameDeckStateScore(right, totalCost) - metagameDeckStateScore(left, totalCost) ||
    left.totalCost - right.totalCost
  ));
  primary.slice(0, primaryCount).forEach((state) => selected.set(
    state.deck.map((entry) => entry.character.id).join("|"),
    state,
  ));
  // Preserve competitive role shapes for the full 5v5 evaluation.  This is
  // deliberately a search-diversity rule, not a requirement that every deck
  // contain a defense or a revive: a pressure-only deck can still win, but it
  // must beat the best mixed decks in the actual battle simulation.
  const byStrategy = new Map();
  for (const state of primary) {
    const key = metagameDeckStrategyKey(state);
    const bucket = byStrategy.get(key) ?? [];
    bucket.push(state);
    byStrategy.set(key, bucket);
  }
  const strategyBuckets = [...byStrategy.values()].map((bucket) => [...bucket]);
  let strategyCursor = 0;
  while (selected.size < width && strategyBuckets.some((bucket) => bucket.length)) {
    const bucket = strategyBuckets[strategyCursor % strategyBuckets.length];
    strategyCursor += 1;
    const state = bucket.shift();
    if (!state) continue;
    selected.set(state.deck.map((entry) => entry.character.id).join("|"), state);
  }
  const costAware = [...unique].sort((left, right) => (
    metagameDeckStateScore(right, totalCost) - right.totalCost / Math.max(1, totalCost) * 0.05 -
      (metagameDeckStateScore(left, totalCost) - left.totalCost / Math.max(1, totalCost) * 0.05) ||
    left.totalCost - right.totalCost
  ));
  for (const state of costAware) {
    if (selected.size >= width) break;
    selected.set(state.deck.map((entry) => entry.character.id).join("|"), state);
  }
  for (const state of primary) {
    if (selected.size >= width) break;
    selected.set(state.deck.map((entry) => entry.character.id).join("|"), state);
  }
  return [...selected.values()];
}

function metagameFixedSlots(fixedSlots) {
  const entries = fixedSlots instanceof Map
    ? [...fixedSlots.entries()]
    : Array.isArray(fixedSlots)
      ? fixedSlots.map((value, index) => [index + 1, value])
      : Object.entries(fixedSlots ?? {});
  const fixedByPosition = new Map();
  const fixedIds = new Set();
  for (const [rawPosition, rawValue] of entries) {
    const position = Number(rawPosition);
    const id = String(rawValue?.id ?? rawValue ?? "").trim();
    if (!id) continue;
    if (!Number.isInteger(position) || position < 1 || position > 5) {
      throw new Error("固定できる枠は1〜5枠目です。");
    }
    if (fixedByPosition.has(position)) {
      throw new Error(`${position}枠目の固定キャラが重複しています。`);
    }
    if (fixedIds.has(id)) {
      throw new Error("同じキャラを複数の固定枠には指定できません。");
    }
    fixedByPosition.set(position, id);
    fixedIds.add(id);
  }
  return fixedByPosition;
}

export function matchesMetagameFixedConstraint(character, constraint) {
  if (!character || !resolveAttributeClass(character.attributes)) return false;
  const allowedAttributes = new Set(constraint?.allowedAttributes ?? []);
  if (allowedAttributes.size && !(character.attributes ?? []).some((attribute) => allowedAttributes.has(attribute))) return false;
  return Math.max(0, Number(character.cost) || 0) <= Math.max(0, Number(constraint?.totalCost) || 0);
}

function metagameAllowedPositions(character) {
  return Array.isArray(character?.allowedPositions) && character.allowedPositions.length
    ? character.allowedPositions.map(Number)
    : [1, 2, 3, 4, 5];
}

function matchesMetagamePositionConstraint(character, constraint, position) {
  return matchesMetagameFixedConstraint(character, constraint)
    && metagameAllowedPositions(character).includes(Number(position))
    && isSkillTurnAllowedAtPosition(character, position);
}

function metagameCostMatchesConstraint(totalCost, constraint) {
  const maximum = Math.max(0, Number(constraint?.totalCost) || 0);
  return totalCost <= maximum && (
    constraint?.costMode !== "exact" || totalCost === maximum
  );
}

function metagameDeckIsLegal(deck, constraint, fixedSlots = new Map()) {
  const totalCost = deck.reduce((sum, character) => sum + Math.max(0, Number(character?.cost) || 0), 0);
  if (deck.length !== 5 || !metagameCostMatchesConstraint(totalCost, constraint)) return false;
  if (new Set(deck.map((character) => String(character?.id))).size !== deck.length) return false;
  if (deck.filter((character) => character?.rarity === "伝").length > 1) return false;
  return deck.every((character, index) => (
    matchesMetagamePositionConstraint(character, constraint, index + 1)
    && (!fixedSlots.has(index + 1) || String(character.id) === String(fixedSlots.get(index + 1)))
  ));
}

function metagameFixedFallbackRating(character) {
  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    skillName: character.skillName ?? "",
    overallRank: Number.MAX_SAFE_INTEGER,
    expectedWinRate: 0,
    expectedWinLowerBound: 0,
    balancedContribution: 0,
    practicalValue: 0,
    practicalSkillReliability: 0,
    powerPreference: 0,
    enemyPressureRate: 0,
    combinationPotential: 0,
    continuationWinGain: 0,
    carriedContinuationWinGain: 0,
    tacticalUpside: 0,
    tacticalRisk: 0,
    advantageCreation: 0,
    counteraction: 0,
    skillActivationRate: 0,
  };
}

function metagamePrecomputedRoleRating(character, compactRating, deckMetrics) {
  const breakdown = compactRating?.b ?? compactRating?.roleBreakdown ?? {};
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;
  return {
    ...metagameFixedFallbackRating(character),
    role: compactRating?.k ?? compactRating?.role,
    individualScore: finite(compactRating?.i ?? compactRating?.individualScore),
    roleFit: finite(compactRating?.f ?? compactRating?.roleFit),
    roleBreakdown: {
      frontline: finite(breakdown.f ?? breakdown.frontline),
      highDurabilityCoverage: finite(breakdown.h ?? breakdown.highDurabilityCoverage),
      boardCoverage: finite(breakdown.a ?? breakdown.boardCoverage),
      defenseMatchup: finite(breakdown.d ?? breakdown.defenseMatchup),
      reviveMatchup: finite(breakdown.v ?? breakdown.reviveMatchup),
      costEfficiency: finite(breakdown.c ?? breakdown.costEfficiency),
      skillReadiness: finite(breakdown.r ?? breakdown.skillReadiness),
      lateSkillRisk: finite(breakdown.l ?? breakdown.lateSkillRisk),
    },
    ...deckMetrics,
    overallRank: "-",
  };
}

function metagameConstraintWithFixedSlots(constraint, characters, options = {}) {
  const fixedByPosition = metagameFixedSlots(options.fixedSlots);
  if (!fixedByPosition.size) return constraint;
  const charactersById = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const ratingsById = new Map();
  for (const slot of constraint?.slots ?? []) {
    for (const rating of slot.candidates ?? []) {
      if (!ratingsById.has(String(rating.id))) ratingsById.set(String(rating.id), rating);
    }
  }
  let fixedCost = 0;
  let fixedLegendCount = 0;
  const slots = (constraint?.slots ?? []).map((slot) => {
    const position = Number(slot.position);
    const fixedId = fixedByPosition.get(position);
    if (!fixedId) return slot;
    const character = charactersById.get(fixedId);
    if (!character) {
      throw new Error(`${position}枠目に指定したキャラが見つかりません。`);
    }
    if (!matchesMetagameFixedConstraint(character, constraint)) {
      throw new Error(`${position}枠目に指定したキャラは、選択中の属性・コスト縛りに合いません。`);
    }
    const rating = slot.candidates.find((candidate) => String(candidate.id) === fixedId)
      ?? ratingsById.get(fixedId)
      ?? metagameFixedFallbackRating(character);
    fixedCost += Math.max(0, Number(character.cost) || 0);
    if (character.rarity === "伝") fixedLegendCount += 1;
    return { ...slot, candidates: [rating] };
  });
  if (fixedCost > (Number(constraint?.totalCost) || 0)) {
    throw new Error("固定キャラの合計コストが上限を超えています。");
  }
  if (fixedLegendCount > 1) {
    throw new Error("伝説キャラは1体まで固定できます。");
  }
  return { ...constraint, slots };
}

function metagameExactCostStillReachable(currentCost, pools, nextPoolIndex, constraint) {
  if (constraint?.costMode !== "exact") return currentCost <= (Number(constraint?.totalCost) || 0);
  let minimumRemaining = 0;
  let maximumRemaining = 0;
  for (let index = nextPoolIndex; index < pools.length; index += 1) {
    const costs = pools[index].map((entry) => Math.max(0, Number(entry.character?.cost) || 0));
    if (!costs.length) return false;
    minimumRemaining += Math.min(...costs);
    maximumRemaining += Math.max(...costs);
  }
  const target = Number(constraint.totalCost) || 0;
  return currentCost + minimumRemaining <= target && currentCost + maximumRemaining >= target;
}

export function buildMetagameDeckCandidates(constraint, characters, options = {}) {
  constraint = metagameConstraintWithFixedSlots(constraint, characters, options);
  const totalCost = Number(constraint?.totalCost) || 0;
  const beamWidth = Math.max(500, Number(options.beamWidth) || 10_000);
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const pools = (constraint?.slots ?? []).map((slot, index) => slot.candidates.map((rating) => ({
    character: charactersById.get(String(rating.id)),
    rating,
    proxy: metagameCandidateScore(rating),
    position: index + 1,
  })).filter((entry) => entry.character));
  if (pools.length !== 5 || pools.some((pool) => !pool.length)) {
    throw new Error("この縛りは5枠分の詳細評価データが揃っていません。");
  }

  let states = [{
    deck: [],
    ids: new Set(),
    totalCost: 0,
    legendCount: 0,
    proxyTotal: 0,
    synergyScore: 0,
    handoffRisk: 0,
    budgetStrain: 0,
    advantageCount: 0,
    counterCount: 0,
    roleCounts: {},
    attackCommitment: 0,
  }];
  for (let poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
    const pool = pools[poolIndex];
    const expanded = [];
    for (const state of states) {
      for (const entry of pool) {
        const id = String(entry.character.id);
        const isLegend = entry.character.rarity === "伝";
        const nextCost = state.totalCost + (Number(entry.character.cost) || 0);
        if (
          state.ids.has(id) ||
          nextCost > totalCost ||
          (isLegend && state.legendCount >= 1) ||
          !metagameExactCostStillReachable(nextCost, pools, poolIndex + 1, constraint)
        ) continue;
        const ids = new Set(state.ids);
        ids.add(id);
        const costShare = (Number(entry.character.cost) || 0) / Math.max(1, totalCost);
        const immediatePredecessor = state.deck.at(-1);
        expanded.push({
          deck: [...state.deck, entry],
          ids,
          totalCost: nextCost,
          legendCount: state.legendCount + (isLegend ? 1 : 0),
          proxyTotal: state.proxyTotal + entry.proxy,
          synergyScore: state.synergyScore + state.deck.reduce((total, source) => (
            total + metagameDeckPairSynergy(source, entry)
          ), 0),
          handoffRisk: state.handoffRisk + (immediatePredecessor
            ? metagameDeckHandoffRisk(immediatePredecessor, entry)
            : 0),
          budgetStrain: state.budgetStrain + (
            Math.max(0, costShare - 0.28) ** 2 * (
              0.2 + (1 - metagameDeckClampUnit(entry.rating.practicalValue ?? entry.rating.expectedWinLowerBound)) * 0.8
            )
          ),
          advantageCount: state.advantageCount + (entry.rating.advantageCreation > 0 ? 1 : 0),
          counterCount: state.counterCount + (entry.rating.counteraction > 0 ? 1 : 0),
          roleCounts: metagameDeckRoleCountsAdd(state.roleCounts, entry.rating),
          attackCommitment: state.attackCommitment + metagameDeckAttackCommitment(entry.rating),
        });
      }
    }
    states = metagameTrimDeckBeam(expanded, beamWidth, totalCost);
    if (!states.length) throw new Error("詳細評価候補から総コスト内の5体を構成できませんでした。");
  }
  const completedStates = states.filter((state) => metagameCostMatchesConstraint(state.totalCost, constraint));
  if (!completedStates.length) throw new Error("No legal deck matches the requested total-cost condition.");
  return completedStates.map((state) => ({
    deck: state.deck.map((entry) => entry.character),
    ratings: state.deck.map((entry) => entry.rating),
    totalCost: state.totalCost,
    proxyScore: metagameDeckStateScore(state, totalCost),
    synergyScore: state.synergyScore,
    handoffRisk: state.handoffRisk,
    budgetStrain: state.budgetStrain,
    advantageCount: state.advantageCount,
    counterCount: state.counterCount,
    roleCounts: state.roleCounts,
    attackCommitment: state.attackCommitment,
    firepowerSurplus: metagameDeckFirepowerSurplus(state.attackCommitment, state.roleCounts),
  })).sort((left, right) => right.proxyScore - left.proxyScore || left.totalCost - right.totalCost);
}

function metagameYieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function buildMetagameDeckCandidatesWithProgress(constraint, characters, options = {}) {
  constraint = metagameConstraintWithFixedSlots(constraint, characters, options);
  const totalCost = Number(constraint?.totalCost) || 0;
  const beamWidth = Math.max(500, Number(options.beamWidth) || 10_000);
  const progressYieldEvery = Math.max(1_000, Number(options.progressYieldEvery) || 20_000);
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const pools = (constraint?.slots ?? []).map((slot, index) => slot.candidates.map((rating) => ({
    character: charactersById.get(String(rating.id)),
    rating,
    proxy: metagameCandidateScore(rating),
    position: index + 1,
  })).filter((entry) => entry.character));
  if (pools.length !== 5 || pools.some((pool) => !pool.length)) {
    throw new Error("Metagame deck candidates require five populated slots.");
  }

  let states = [{
    deck: [],
    ids: new Set(),
    totalCost: 0,
    legendCount: 0,
    proxyTotal: 0,
    synergyScore: 0,
    handoffRisk: 0,
    budgetStrain: 0,
    advantageCount: 0,
    counterCount: 0,
    roleCounts: {},
    attackCommitment: 0,
  }];
  for (let poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
    const pool = pools[poolIndex];
    const stageTotal = Math.max(1, states.length * pool.length);
    const expanded = [];
    let checked = 0;
    options.onProgress?.({
      phase: "candidate",
      completed: poolIndex,
      total: pools.length,
      slot: poolIndex + 1,
      slots: pools.length,
      checked,
      stageTotal,
      retained: states.length,
    });
    await metagameYieldToBrowser();
    for (const state of states) {
      for (const entry of pool) {
        if (options.signal?.aborted) throw metagameAbortError();
        const id = String(entry.character.id);
        const isLegend = entry.character.rarity === "伝";
        const nextCost = state.totalCost + (Number(entry.character.cost) || 0);
        if (
          !state.ids.has(id) &&
          nextCost <= totalCost &&
          (!isLegend || state.legendCount < 1) &&
          metagameExactCostStillReachable(nextCost, pools, poolIndex + 1, constraint)
        ) {
          const ids = new Set(state.ids);
          ids.add(id);
          const costShare = (Number(entry.character.cost) || 0) / Math.max(1, totalCost);
          const immediatePredecessor = state.deck.at(-1);
          expanded.push({
            deck: [...state.deck, entry],
            ids,
            totalCost: nextCost,
            legendCount: state.legendCount + (isLegend ? 1 : 0),
            proxyTotal: state.proxyTotal + entry.proxy,
            synergyScore: state.synergyScore + state.deck.reduce((total, source) => (
              total + metagameDeckPairSynergy(source, entry)
            ), 0),
            handoffRisk: state.handoffRisk + (immediatePredecessor
              ? metagameDeckHandoffRisk(immediatePredecessor, entry)
              : 0),
            budgetStrain: state.budgetStrain + (
              Math.max(0, costShare - 0.28) ** 2 * (
                0.2 + (1 - metagameDeckClampUnit(entry.rating.practicalValue ?? entry.rating.expectedWinLowerBound)) * 0.8
              )
            ),
            advantageCount: state.advantageCount + (entry.rating.advantageCreation > 0 ? 1 : 0),
            counterCount: state.counterCount + (entry.rating.counteraction > 0 ? 1 : 0),
            roleCounts: metagameDeckRoleCountsAdd(state.roleCounts, entry.rating),
            attackCommitment: state.attackCommitment + metagameDeckAttackCommitment(entry.rating),
          });
        }
        checked += 1;
        if (checked % progressYieldEvery !== 0) continue;
        options.onProgress?.({
          phase: "candidate",
          completed: poolIndex + checked / stageTotal,
          total: pools.length,
          slot: poolIndex + 1,
          slots: pools.length,
          checked,
          stageTotal,
          retained: expanded.length,
        });
        await metagameYieldToBrowser();
      }
    }
    states = metagameTrimDeckBeam(expanded, beamWidth, totalCost);
    if (!states.length) throw new Error("No valid complete metagame deck candidates remain.");
    options.onProgress?.({
      phase: "candidate",
      completed: poolIndex + 1,
      total: pools.length,
      slot: poolIndex + 1,
      slots: pools.length,
      checked: stageTotal,
      stageTotal,
      retained: states.length,
      valid: poolIndex + 1 === pools.length ? states.length : undefined,
    });
  }
  const completedStates = states.filter((state) => metagameCostMatchesConstraint(state.totalCost, constraint));
  if (!completedStates.length) throw new Error("No legal deck matches the requested total-cost condition.");
  return completedStates.map((state) => ({
    deck: state.deck.map((entry) => entry.character),
    ratings: state.deck.map((entry) => entry.rating),
    totalCost: state.totalCost,
    proxyScore: metagameDeckStateScore(state, totalCost),
    synergyScore: state.synergyScore,
    handoffRisk: state.handoffRisk,
    budgetStrain: state.budgetStrain,
    advantageCount: state.advantageCount,
    counterCount: state.counterCount,
    roleCounts: state.roleCounts,
    attackCommitment: state.attackCommitment,
    firepowerSurplus: metagameDeckFirepowerSurplus(state.attackCommitment, state.roleCounts),
  })).sort((left, right) => right.proxyScore - left.proxyScore || left.totalCost - right.totalCost);
}

function metagameSelectFinalists(candidates, limit, minimum = 36) {
  const maximum = Math.min(candidates.length, Math.max(minimum, Number(limit) || 40));
  const selected = new Map();
  const add = (candidate) => selected.set(candidate.deck.map((character) => character.id).join("|"), candidate);
  candidates.slice(0, Math.ceil(maximum * 0.4)).forEach(add);
  const bestByStrategy = new Map();
  for (const candidate of candidates) {
    const key = metagameDeckStrategyKey(candidate);
    if (!bestByStrategy.has(key)) bestByStrategy.set(key, candidate);
  }
  [...bestByStrategy.values()]
    .sort((left, right) => right.proxyScore - left.proxyScore)
    .forEach((candidate) => {
      if (selected.size < maximum) add(candidate);
    });
  const ratingTotal = (candidate, key) => candidate.ratings.reduce((sum, rating) => (
    sum + Math.max(0, Number(rating[key]) || 0)
  ), 0);
  const stabilityTotal = (candidate) => {
    const roles = candidate.roleCounts ?? {};
    return (Number(roles.defense) || 0) + (Number(roles.revive) || 0) + (Number(roles.recovery) || 0);
  };
  const selectors = [
    (left, right) => right.advantageCount - left.advantageCount || right.proxyScore - left.proxyScore,
    (left, right) => right.counterCount - left.counterCount || right.proxyScore - left.proxyScore,
    (left, right) => stabilityTotal(right) - stabilityTotal(left) || right.proxyScore - left.proxyScore,
    (left, right) => left.firepowerSurplus - right.firepowerSurplus || right.proxyScore - left.proxyScore,
    (left, right) => right.synergyScore - left.synergyScore || right.proxyScore - left.proxyScore,
    (left, right) => left.handoffRisk - right.handoffRisk || right.proxyScore - left.proxyScore,
    (left, right) => ratingTotal(right, "carriedContinuationWinGain") - ratingTotal(left, "carriedContinuationWinGain") || right.proxyScore - left.proxyScore,
    (left, right) => ratingTotal(right, "combinationPotential") - ratingTotal(left, "combinationPotential") || right.proxyScore - left.proxyScore,
    (left, right) => ratingTotal(right, "tacticalUpside") - ratingTotal(left, "tacticalUpside") || right.proxyScore - left.proxyScore,
    (left, right) => (right.proxyScore - right.budgetStrain) - (left.proxyScore - left.budgetStrain) || left.totalCost - right.totalCost,
  ];
  const selectorQuota = Math.max(1, Math.floor((maximum - selected.size) / selectors.length));
  for (const selector of selectors) {
    let added = 0;
    for (const candidate of [...candidates].sort(selector)) {
      if (selected.size >= maximum || added >= selectorQuota) break;
      const key = candidate.deck.map((character) => character.id).join("|");
      if (selected.has(key)) continue;
      add(candidate);
      added += 1;
    }
  }
  for (const candidate of candidates) {
    if (selected.size >= maximum) break;
    add(candidate);
  }
  return [...selected.values()];
}

function metagameSelectFinalistsWithBoosts(candidates, limit, boostedIds) {
  // Interactive calculations keep a strategy-diverse finalist set usable in
  // the browser. Every explicitly selected character receives a mandatory
  // full 5v5 evaluation, even when it has no published environment rating.
  const selected = new Map(metagameSelectFinalists(candidates, limit, 8).map((candidate) => [
    candidate.deck.map((character) => String(character.id)).join("|"), candidate,
  ]));
  for (const id of boostedIds) {
    const representative = candidates.find((candidate) => (
      candidate.deck.some((character) => String(character.id) === String(id))
    ));
    if (!representative) continue;
    selected.set(representative.deck.map((character) => String(character.id)).join("|"), representative);
  }
  return [...selected.values()];
}

function metagameProjectedWinValue(result) {
  if (result.outcome === "allies") return 1;
  if (result.outcome === "draw") return 0.5;
  if (result.outcome === "enemies") return 0;
  const initialEnemyCount = Math.max(1, result.initial.enemies.remainingCharacters);
  const initialAllyCount = Math.max(1, result.initial.allies.remainingCharacters);
  const enemyProgress = result.metrics.enemyLosses / initialEnemyCount;
  const allyProgress = result.metrics.allyLosses / initialAllyCount;
  const allyHp = result.final.allies.totalHp > 0
    ? result.final.allies.remainingHp / result.final.allies.totalHp
    : 0;
  const enemyHp = result.final.enemies.totalHp > 0
    ? result.final.enemies.remainingHp / result.final.enemies.totalHp
    : 0;
  return metagameDeckClampUnit(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function metagameMeanLowerBound(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return mean;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return metagameDeckClampUnit(mean - 1.96 * Math.sqrt(variance / values.length));
}

function metagameAbortError() {
  const error = new Error("デッキシミュレーションを中止しました。");
  error.name = "AbortError";
  return error;
}

function metagameHydrateEnvironment(constraint, charactersById) {
  return constraint.environmentScenarios.map((scenario) => scenario.map((deck) => deck.map((id) => {
    const character = charactersById.get(String(id));
    if (!character) throw new Error(`環境キャラID ${id} がキャラクターデータにありません。`);
    return character;
  })));
}

function metagameHydrateDeck(ids, charactersById) {
  if (!Array.isArray(ids) || ids.length !== 5) throw new Error("環境プレイヤーデッキが5体ではありません。");
  return ids.map((id) => {
    const character = charactersById.get(String(id));
    if (!character) throw new Error(`環境キャラID ${id} がキャラクターデータにありません。`);
    return character;
  });
}

function metagameV8ReconstructedScenarioCount(constraint) {
  const deckCount = (constraint.environmentScenarios ?? []).reduce((total, scenario) => (
    total + (Array.isArray(scenario) ? scenario.length : 0)
  ), 0);
  if (deckCount < 9) return 0;
  return Math.max(Math.ceil(deckCount / 9), Number(constraint.scenarioCount) || 0);
}

function metagameV8ReconstructScenario(constraint, scenarioIndex) {
  const environmentDecks = (constraint.environmentScenarios ?? []).flat();
  const deckCount = environmentDecks.length;
  const scenarioCount = metagameV8ReconstructedScenarioCount(constraint);
  if (deckCount < 9 || scenarioIndex >= scenarioCount) return null;

  let stride = 17;
  const greatestCommonDivisor = (left, right) => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b) [a, b] = [b, a % b];
    return a;
  };
  while (greatestCommonDivisor(stride, deckCount) !== 1) stride += 2;
  const decks = Array.from({ length: 9 }, (_, offset) => (
    environmentDecks[(scenarioIndex * 9 * stride + offset * stride) % deckCount]
  ));
  return {
    source: "reconstructed-v8-team-scenario",
    allyIds: decks.slice(0, 4),
    enemyIds: decks.slice(4),
  };
}

function metagameEvidenceScenario(constraint, charactersById, scenarioIndex) {
  const exactScenario = constraint.teamScenarios?.[scenarioIndex];
  if (exactScenario) {
    const allyIds = exactScenario.a ?? exactScenario.allyDecks;
    const enemyIds = exactScenario.e ?? exactScenario.enemyDecks;
    if (!Array.isArray(allyIds) || allyIds.length !== 4 || !Array.isArray(enemyIds) || enemyIds.length !== 5) {
      throw new Error("V8の対戦根拠データが壊れています。");
    }
    return {
      source: "cloud-v8-team-scenario",
      allyDecks: allyIds.map((deck) => metagameHydrateDeck(deck, charactersById)),
      enemyDecks: enemyIds.map((deck) => metagameHydrateDeck(deck, charactersById)),
    };
  }
  if (String(constraint.modelVersion ?? "").startsWith("team-battle-v8.")) {
    const reconstructed = metagameV8ReconstructScenario(constraint, scenarioIndex);
    if (reconstructed) {
      return {
        source: reconstructed.source,
        allyDecks: reconstructed.allyIds.map((deck) => metagameHydrateDeck(deck, charactersById)),
        enemyDecks: reconstructed.enemyIds.map((deck) => metagameHydrateDeck(deck, charactersById)),
      };
    }
  }
  const legacyScenario = constraint.environmentScenarios?.[scenarioIndex];
  if (!Array.isArray(legacyScenario) || legacyScenario.length < 9) {
    throw new Error("この評価には再生可能な環境対戦データがありません。");
  }
  const decks = legacyScenario.map((deck) => metagameHydrateDeck(deck, charactersById));
  return {
    source: "legacy-nine-deck-scenario",
    allyDecks: decks.slice(0, 4),
    enemyDecks: decks.slice(4, 9),
  };
}

function metagameBoostedEnvironmentDecks(constraint, charactersById, boostedIds) {
  if (!boostedIds.size) return [];
  const existingIds = new Set((constraint.teamScenarios ?? []).flatMap((scenario) => (
    [...(scenario.a ?? scenario.allyDecks ?? []), ...(scenario.e ?? scenario.enemyDecks ?? [])]
      .flat()
      .map(String)
  )));
  const baseDecks = (constraint.precomputedDecks ?? []).flatMap((raw) => {
    const ids = raw?.i ?? raw?.ids;
    if (!Array.isArray(ids) || ids.length !== 5) return [];
    try {
      return [metagameHydrateDeck(ids, charactersById)];
    } catch {
      return [];
    }
  });
  const added = [];
  for (const id of boostedIds) {
    // Existing environment appearances are already upgraded by the hydrated
    // character map.  Add a representative opponent only for a newly viable
    // boosted character so the supplied environment keeps its original weight.
    if (existingIds.has(String(id))) continue;
    const character = charactersById.get(String(id));
    if (!character) continue;
    let replacement = null;
    for (const base of baseDecks) {
      for (let index = 0; index < base.length; index += 1) {
        const deck = [...base];
        deck[index] = character;
        if (metagameDeckIsLegal(deck, constraint)) {
          replacement = deck;
          break;
        }
      }
      if (replacement) break;
    }
    if (replacement) added.push({ id: String(id), deck: replacement });
  }
  return added;
}

function metagameBattleScenarios(constraint, charactersById, boostedCharacterIds, options = {}) {
  const boostedIds = normalizeMetagameBoostedCharacterIds(boostedCharacterIds);
  const environmentCharacterIds = normalizeMetagameBoostedCharacterIds(
    options.environmentCharacterIds ?? boostedIds,
  );
  const hasTeamScenarios = Array.isArray(constraint.teamScenarios) && constraint.teamScenarios.length > 0;
  const isV8 = hasTeamScenarios || String(constraint.modelVersion ?? "").startsWith("team-battle-v8.");
  const scenarioCount = isV8
    ? (hasTeamScenarios
      ? constraint.teamScenarios.length
      : metagameV8ReconstructedScenarioCount(constraint))
    : constraint.environmentScenarios?.length ?? 0;
  const allScenarios = Array.from({ length: scenarioCount }, (_, scenarioIndex) => {
    const scenario = isV8
      ? metagameEvidenceScenario(constraint, charactersById, scenarioIndex)
      : (() => {
          const decks = metagameHydrateEnvironment({
            ...constraint,
            environmentScenarios: [constraint.environmentScenarios[scenarioIndex]],
          }, charactersById)[0];
          return {
            source: "legacy-nine-deck-scenario",
            allyDecks: decks.slice(0, 4),
            enemyDecks: decks.slice(4, 9),
          };
        })();
    return { ...scenario, scenarioIndex };
  });
  const requestedBaseCount = Math.max(0, Number(options.maxBaseScenarios) || 0);
  const baseCount = requestedBaseCount ? Math.min(requestedBaseCount, allScenarios.length) : allScenarios.length;
  // Evenly sample the supplied scenarios instead of taking an early prefix:
  // adjacent V8 scenarios can share deck components, while a stride preserves
  // the breadth of the presented environment for an interactive calculation.
  const scenarios = baseCount >= allScenarios.length
    ? allScenarios
    : Array.from({ length: baseCount }, (_, index) => (
      allScenarios[Math.floor(index * allScenarios.length / baseCount)]
    ));
  const additions = metagameBoostedEnvironmentDecks(constraint, charactersById, environmentCharacterIds);
  additions.forEach(({ id, deck }, index) => {
    const source = scenarios[index % Math.max(1, scenarios.length)];
    if (!source) return;
    const enemyDecks = [...source.enemyDecks];
    enemyDecks[index % enemyDecks.length] = deck;
    scenarios.push({
      source: "interactive-character-environment",
      scenarioIndex: scenarios.length,
      boostedEnvironmentCharacterId: id,
      allyDecks: source.allyDecks,
      enemyDecks,
    });
  });
  return scenarios;
}

/**
 * Replays the same team configurations and play profiles used by the rating.
 * Only three representative full logs are returned, while the summary is
 * calculated across every available scenario.
 */
export async function inspectMetagameDeckEvidence(deck, constraint, characters, options = {}) {
  if (!Array.isArray(deck) || deck.length !== 5) throw new Error("再生する候補デッキは5体必要です。");
  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const additionalIds = normalizeMetagameBoostedCharacterIds(options.additionalCharacterIds);
  const charactersById = metagameCharactersById(characters, boostedIds);
  const interactiveIds = new Set([
    ...boostedIds,
    ...additionalIds,
    ...normalizeMetagameBoostedCharacterIds(options.interactiveCharacterIds),
  ]);
  const boostedDeck = deck.map((character) => applyMetagameStatBoost(character, boostedIds));
  const scenarios = metagameBattleScenarios(constraint, charactersById, boostedIds, {
    maxBaseScenarios: options.interactiveScenarioCount ?? options.boostedScenarioCount,
    environmentCharacterIds: options.includeAdditionalInEnvironment === false ? boostedIds : interactiveIds,
  });
  const scenarioCount = scenarios.length;
  if (!scenarioCount) throw new Error("この評価には再生可能な環境対戦データがありません。");

  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  const entries = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarioCount; scenarioIndex += 1) {
    if (options.signal?.aborted) throw metagameAbortError();
    const scenario = scenarios[scenarioIndex];
    const actorIndex = scenarioIndex % 5;
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(actorIndex, 0, boostedDeck);
    const profile = METAGAME_DECK_PROFILES[scenarioIndex % METAGAME_DECK_PROFILES.length];
    const result = simulateBattle(
      createBattleState(allyDecks, scenario.enemyDecks),
      options.rules ?? DEFAULT_RULES,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: scenarioIndex,
      },
    );
    const value = metagameProjectedWinValue(result);
    values.push(value);
    outcomes[result.outcome] += 1;
    entries.push({
      scenarioIndex,
      source: scenario.source,
      actorIndex,
      profile,
      value,
      result,
      allyDecks,
      enemyDecks: scenario.enemyDecks,
    });
    options.onScenarioCompleted?.({ completed: scenarioIndex + 1, total: scenarioCount });
    if ((scenarioIndex + 1) % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const ordered = [...entries].sort((left, right) => left.value - right.value || left.scenarioIndex - right.scenarioIndex);
  const representativeIndexes = [...new Set([0, Math.floor((ordered.length - 1) / 2), ordered.length - 1])];
  const labels = ["厳しい対戦例", "中央値の対戦例", "有利な対戦例"];
  const total = Math.max(1, entries.length);
  return {
    source: entries[0]?.source ?? "unknown",
    scenarioCount: entries.length,
    expectedWinRate: values.reduce((sum, value) => sum + value, 0) / total,
    expectedWinLowerBound: metagameMeanLowerBound(values),
    decisiveWinRate: outcomes.allies / total,
    decisiveDrawRate: outcomes.draw / total,
    decisiveLossRate: outcomes.enemies / total,
    ongoingRate: outcomes.ongoing / total,
    boostedCharacterIds: [...boostedIds],
    samples: representativeIndexes.map((index, labelIndex) => ({
      ...ordered[index],
      label: labels[labelIndex] ?? "対戦例",
    })),
  };
}

async function metagameEvaluateDeck(candidate, scenarios, constraint, rules, options) {
  const winValues = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    if (options.signal?.aborted) throw metagameAbortError();
    const scenario = scenarios[scenarioIndex];
    const actorIndex = scenarioIndex % 5;
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(actorIndex, 0, candidate.deck);
    const profile = METAGAME_DECK_PROFILES[scenarioIndex % METAGAME_DECK_PROFILES.length];
    const result = simulateBattle(
      createBattleState(allyDecks, scenario.enemyDecks),
      rules,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: scenarioIndex,
      },
    );
    winValues.push(metagameProjectedWinValue(result));
    outcomes[result.outcome] += 1;
    options.onScenarioCompleted?.();
    if ((scenarioIndex + 1) % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const expectedWinRate = winValues.reduce((sum, value) => sum + value, 0) / Math.max(1, winValues.length);
  return {
    ...candidate,
    expectedWinRate,
    expectedWinLowerBound: metagameMeanLowerBound(winValues),
    scenarioCount: winValues.length,
    decisiveWinRate: outcomes.allies / Math.max(1, winValues.length),
    decisiveDrawRate: outcomes.draw / Math.max(1, winValues.length),
    decisiveLossRate: outcomes.enemies / Math.max(1, winValues.length),
    ongoingRate: outcomes.ongoing / Math.max(1, winValues.length),
  };
}

function metagameV8PrecomputedResults(constraint, characters, fixedSlots) {
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const ratingsByPosition = (constraint.slots ?? []).map((slot) => (
    new Map((slot.candidates ?? []).map((rating) => [String(rating.id), rating]))
  ));
  const unique = new Map();
  const precomputedDecks = Array.isArray(constraint.precomputedDecks)
    ? constraint.precomputedDecks
    : (constraint.slots ?? []).flatMap((slot) => (
      (slot.candidates ?? []).map((rating) => rating.v8BestDeck ?? rating.v7BestDeck)
    ));
  for (const rawPrecomputed of precomputedDecks) {
      const ids = rawPrecomputed?.i ?? rawPrecomputed?.ids;
      if (!Array.isArray(ids) || ids.length !== 5) continue;
      if ([...fixedSlots.entries()].some(([position, id]) => (
        String(ids[position - 1]) !== String(id)
      ))) continue;
      const deck = ids.map((id) => charactersById.get(String(id)));
      if (deck.some((character) => !character)) continue;
      if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) continue;
      const key = ids.map(String).join("|");
      const expectedWinRate = Number(rawPrecomputed.w ?? rawPrecomputed.expectedWinRate) || 0;
      const expectedWinLowerBound = Number(rawPrecomputed.l ?? rawPrecomputed.expectedWinLowerBound) || 0;
      const scenarioCount = Number(rawPrecomputed.s ?? rawPrecomputed.scenarioCount) || 0;
      const compactRatings = rawPrecomputed.r ?? rawPrecomputed.ratings ?? [];
      const deckMetrics = { expectedWinRate, expectedWinLowerBound, scenarioCount };
      const candidate = {
        deck,
        ratings: deck.map((character, index) => (
          ratingsByPosition[index].get(String(character.id)) ?? {
            ...metagamePrecomputedRoleRating(character, compactRatings[index], deckMetrics),
          }
        )),
        totalCost: Number(rawPrecomputed.c ?? rawPrecomputed.totalCost) || deck.reduce((sum, character) => sum + (Number(character.cost) || 0), 0),
        proxyScore: Number(rawPrecomputed.p ?? rawPrecomputed.proxyScore) || 0,
        synergyScore: Number(rawPrecomputed.y ?? rawPrecomputed.synergyScore) || 0,
        handoffRisk: 0,
        expectedWinRate,
        expectedWinLowerBound,
        scenarioCount,
        decisiveWinRate: Number(rawPrecomputed.a ?? rawPrecomputed.decisiveWinRate) || 0,
        decisiveDrawRate: Number(rawPrecomputed.d ?? rawPrecomputed.decisiveDrawRate) || 0,
        decisiveLossRate: Number(rawPrecomputed.e ?? rawPrecomputed.decisiveLossRate) || 0,
        ongoingRate: Number(rawPrecomputed.o ?? rawPrecomputed.ongoingRate) || 0,
      };
      const current = unique.get(key);
      if (!current || candidate.expectedWinLowerBound > current.expectedWinLowerBound) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => (
    right.expectedWinLowerBound - left.expectedWinLowerBound ||
    right.expectedWinRate - left.expectedWinRate ||
    left.totalCost - right.totalCost
  ));
}

function metagameV8AdaptiveSeedResults(constraint, characters, fixedSlots) {
  let states = [{ deck: [] }];
  for (let position = 1; position <= 5; position += 1) {
    const fixedId = fixedSlots.get(position);
    const options = (characters ?? [])
      .filter((character) => matchesMetagamePositionConstraint(character, constraint, position))
      .filter((character) => !fixedId || String(character.id) === String(fixedId))
      .sort((left, right) => (
        metagameAdaptiveCandidateScore(right, position, constraint) - metagameAdaptiveCandidateScore(left, position, constraint)
      ))
      .slice(0, fixedId ? 1 : 24);
    states = states.flatMap((state) => options.flatMap((character) => {
      if (state.deck.some((entry) => String(entry.id) === String(character.id))) return [];
      const deck = [...state.deck, character];
      const totalCost = deck.reduce((sum, entry) => sum + Math.max(0, Number(entry.cost) || 0), 0);
      return totalCost <= Math.max(0, Number(constraint.totalCost) || 0) ? [{ deck }] : [];
    }));
    states.sort((left, right) => (
      right.deck.reduce((sum, character, index) => sum + metagameAdaptiveCandidateScore(character, index + 1, constraint), 0) -
      left.deck.reduce((sum, character, index) => sum + metagameAdaptiveCandidateScore(character, index + 1, constraint), 0)
    ));
    states = states.slice(0, 96);
  }
  return states.filter((state) => metagameDeckIsLegal(state.deck, constraint, fixedSlots)).map(({ deck }) => {
    const ratings = deck.map((character, index) => metagameAdaptiveRoleRating(character, index + 1, constraint));
    const roleCounts = ratings.reduce((counts, rating) => metagameDeckRoleCountsAdd(counts, rating), {});
    const attackCommitment = ratings.reduce((total, rating) => total + metagameDeckAttackCommitment(rating), 0);
    const synergyScore = calculateMetagameDeckSynergy(deck, ratings);
    return {
      deck,
      ratings,
      totalCost: deck.reduce((sum, character) => sum + Math.max(0, Number(character.cost) || 0), 0),
      proxyScore: ratings.reduce((sum, rating) => sum + metagameCandidateScore(rating), 0) + synergyScore,
      synergyScore,
      handoffRisk: 0,
      budgetStrain: 0,
      advantageCount: ratings.filter((rating) => Number(rating.advantageCreation) > 0).length,
      counterCount: ratings.filter((rating) => Number(rating.counteraction) > 0).length,
      roleCounts,
      attackCommitment,
      firepowerSurplus: metagameDeckFirepowerSurplus(attackCommitment, roleCounts),
    };
  });
}

function metagameBoostedFallbackRating(character) {
  return {
    ...metagameFixedFallbackRating(character),
    role: metagameDeckRole({ skillType: character.skill?.type, skillTarget: character.skill?.target }),
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    powerPreference: 0.55,
    practicalValue: 0.5,
    practicalSkillReliability: 0.5,
    roleFit: 0.5,
  };
}

// Published V8 ratings are retained where they exist.  Characters added in
// the browser or through the catalogue database have no such row, so this
// bounded, cost-aware estimate lets them enter the same finalist simulation.
function metagameAdaptiveRoleRating(character, position, constraint) {
  const cost = Math.max(1, Number(character.cost) || 0);
  const pow = Math.max(0, Number(character.pow) || 0);
  const hp = Math.max(0, Number(character.hp) || 0);
  const skill = character.skill ?? {};
  const skillType = skill.type ?? "none";
  const skillTurn = Math.max(0, Number(character.skillTurn) || 0);
  const turns = Math.max(1, Number(constraint.turns) || 1);
  const readiness = skillTurn <= position - 1
    ? 1
    : Math.max(0, 1 - (skillTurn - (position - 1)) / turns);
  const attackWeight = skillType === "aoe_attack"
    ? 0.35 * Math.max(1, Number(skill.hits) || 1) * Math.max(0, Number(skill.multiplier) || 1)
    : skillType === "multi_hit_attack"
      ? 0.22 * Math.max(1, Number(skill.hits) || 1) * Math.max(0, Number(skill.multiplier) || 1)
      : skillType === "single_attack"
        ? 0.28 * Math.max(0, Number(skill.multiplier) || 1)
        : 0;
  const supportWeight = ["attack_buff", "damage_reduction", "guard", "attribute_guard", "heal", "revive"].includes(skillType)
    ? 0.24
    : 0;
  const individualScore = metagameDeckClampUnit(
    (pow / (pow + 700)) * 0.42 +
    (hp / (hp + 2_000)) * 0.30 +
    Math.min(0.22, attackWeight + supportWeight) * readiness +
    (1 / cost) * 0.06,
  );
  const role = metagameDeckRole({ skillType, skillTarget: skill.target });
  return {
    ...metagameBoostedFallbackRating(character),
    role,
    individualScore,
    roleFit: metagameDeckClampUnit(individualScore * (role === "neutral" ? 0.9 : 1)),
    practicalValue: individualScore,
    practicalSkillReliability: readiness,
    powerPreference: metagameDeckClampUnit(pow / (pow + hp * 0.28 + 1)),
    enemyPressureRate: metagameDeckClampUnit((pow * (1 + attackWeight)) / (pow * (1 + attackWeight) + 600)),
    balancedContribution: metagameDeckClampUnit((pow / (pow + 700) + hp / (hp + 2_000)) / 2),
    roleBreakdown: {
      skillReadiness: readiness,
      lateSkillRisk: 1 - readiness,
      costEfficiency: metagameDeckClampUnit((pow + hp * 0.25) / ((pow + hp * 0.25) + cost * 180)),
    },
  };
}

function metagameAdaptiveCandidateScore(character, position, constraint) {
  return metagameCandidateScore(metagameAdaptiveRoleRating(character, position, constraint));
}

function metagameCandidateFromBoostedV8Deck(base, deck, interactiveIds, constraint) {
  const ratings = deck.map((character, index) => (
    String(character.id) === String(base.deck[index]?.id)
      ? base.ratings[index] ?? metagameBoostedFallbackRating(character)
      : metagameAdaptiveRoleRating(character, index + 1, constraint)
  ));
  const roleCounts = ratings.reduce((counts, rating) => metagameDeckRoleCountsAdd(counts, rating), {});
  const attackCommitment = ratings.reduce((total, rating) => total + metagameDeckAttackCommitment(rating), 0);
  const baseStats = base.deck.reduce((total, character) => (
    total + Math.max(0, Number(character.hp) || 0) + Math.max(0, Number(character.pow) || 0)
  ), 0);
  const boostedStats = deck.reduce((total, character) => (
    total + Math.max(0, Number(character.hp) || 0) + Math.max(0, Number(character.pow) || 0)
  ), 0);
  const boostedCount = deck.filter((character) => interactiveIds.has(String(character.id))).length;
  const statGain = Math.max(0, boostedStats / Math.max(1, baseStats) - 1);
  const synergyScore = calculateMetagameDeckSynergy(deck, ratings);
  return {
    deck,
    ratings,
    totalCost: deck.reduce((total, character) => total + Math.max(0, Number(character.cost) || 0), 0),
    // This score is used only to narrow the on-demand search.  The actual
    // order is decided by the 5v5 battle results below, so every selected
    // boosted character is also reserved a finalist slot.
    proxyScore: (Number(base.proxyScore) || 0) + boostedCount * 0.035 + statGain * 0.09 + synergyScore,
    synergyScore,
    handoffRisk: 0,
    budgetStrain: 0,
    advantageCount: ratings.filter((rating) => Number(rating.advantageCreation) > 0).length,
    counterCount: ratings.filter((rating) => Number(rating.counteraction) > 0).length,
    roleCounts,
    attackCommitment,
    firepowerSurplus: metagameDeckFirepowerSurplus(attackCommitment, roleCounts),
    interactiveCharacterIds: [...interactiveIds],
  };
}

function metagameV8BoostedCandidates(constraint, characters, boostedIds, fixedSlots, additionalIds = new Set()) {
  const charactersById = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const interactiveIds = new Set([
    ...boostedIds,
    ...additionalIds,
    ...(characters ?? []).filter((character) => String(character.id).startsWith("manual-")).map((character) => String(character.id)),
  ]);
  const boostedCharacters = [...interactiveIds].map((id) => charactersById.get(id)).filter(Boolean);
  if (boostedCharacters.length !== interactiveIds.size) {
    throw new Error("指定した補正キャラの一部がキャラクターデータにありません。");
  }
  for (const character of boostedCharacters) {
    if (!matchesMetagameFixedConstraint(character, constraint)) {
      throw new Error(`${character.name} は選択中の属性・コスト縛りに合わないため補正できません。`);
    }
    if (![1, 2, 3, 4, 5].some((position) => matchesMetagamePositionConstraint(character, constraint, position))) {
      throw new Error(`${character.name} はスキルターン・配置制限により、どの枠にも配置できません。`);
    }
  }

  const precomputedBases = metagameV8PrecomputedResults(constraint, characters, fixedSlots);
  const bases = (precomputedBases.length ? precomputedBases : metagameV8AdaptiveSeedResults(
    constraint,
    characters,
    fixedSlots,
  )).slice(0, 24);
  const adaptiveByPosition = new Map();
  for (let position = 1; position <= 5; position += 1) {
    const fixedId = fixedSlots.get(position);
    const topCandidates = (characters ?? [])
      .filter((character) => matchesMetagamePositionConstraint(character, constraint, position))
      .sort((left, right) => (
        metagameAdaptiveCandidateScore(right, position, constraint) - metagameAdaptiveCandidateScore(left, position, constraint)
      ))
      // Keep the on-demand browser search bounded. Explicitly selected and
      // manually added characters are appended below and are never cut here.
      .slice(0, 16);
    const selectedCandidates = boostedCharacters.filter((character) => (
      matchesMetagamePositionConstraint(character, constraint, position)
      && (!fixedId || String(character.id) === String(fixedId))
    ));
    const fixedCandidate = fixedId ? [charactersById.get(String(fixedId))].filter(Boolean) : [];
    adaptiveByPosition.set(position, [...topCandidates, ...selectedCandidates, ...fixedCandidate].filter((character, index, entries) => (
      entries.findIndex((entry) => String(entry.id) === String(character.id)) === index
    )));
  }
  const candidates = new Map();
  const addCandidate = (base, deck) => {
    if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) return;
    const candidate = metagameCandidateFromBoostedV8Deck(base, deck, interactiveIds, constraint);
    const key = deck.map((character) => String(character.id)).join("|");
    const current = candidates.get(key);
    if (!current || candidate.proxyScore > current.proxyScore) candidates.set(key, candidate);
  };

  for (const base of bases) {
    const baseDeck = base.deck;
    addCandidate(base, baseDeck);
    let states = [{ deck: [] }];
    for (let index = 0; index < 5; index += 1) {
      const position = index + 1;
      const fixedId = fixedSlots.get(position);
      const options = [baseDeck[index], ...(adaptiveByPosition.get(position) ?? [])]
        .filter((character, optionIndex, entries) => (
          matchesMetagamePositionConstraint(character, constraint, position)
          && (!fixedId || String(character.id) === String(fixedId))
          && entries.findIndex((entry) => String(entry.id) === String(character.id)) === optionIndex
        ));
      states = states.flatMap((state) => options.flatMap((character) => {
        const deck = [...state.deck, character];
        const duplicate = deck.some((entry, entryIndex) => (
          entryIndex < deck.length - 1 && String(entry.id) === String(character.id)
        ));
        const cost = deck.reduce((total, entry) => total + Math.max(0, Number(entry.cost) || 0), 0);
        const legends = deck.filter((entry) => entry.rarity === "伝").length;
        return !duplicate && cost <= (Number(constraint.totalCost) || 0) && legends <= 1 ? [{ deck }] : [];
      }));
      // Keep the published environment decks as anchors, while making room
      // for strong unlisted catalogue entries and every explicit addition.
      states.sort((left, right) => {
        const leftBoosted = left.deck.filter((character) => interactiveIds.has(String(character.id))).length;
        const rightBoosted = right.deck.filter((character) => interactiveIds.has(String(character.id))).length;
        const leftCost = left.deck.reduce((total, character) => total + (Number(character.cost) || 0), 0);
        const rightCost = right.deck.reduce((total, character) => total + (Number(character.cost) || 0), 0);
        const leftScore = left.deck.reduce((total, character, index) => (
          total + metagameAdaptiveCandidateScore(character, index + 1, constraint)
        ), 0);
        const rightScore = right.deck.reduce((total, character, index) => (
          total + metagameAdaptiveCandidateScore(character, index + 1, constraint)
        ), 0);
        return rightBoosted - leftBoosted || rightScore - leftScore || leftCost - rightCost;
      });
      states = states.slice(0, 96);
    }
    states.forEach((state) => addCandidate(base, state.deck));
  }
  if (!candidates.size) {
    throw new Error("補正キャラを含めて総コスト・スキルターン条件を満たすデッキを構成できませんでした。");
  }
  return [...candidates.values()].sort((left, right) => (
    right.proxyScore - left.proxyScore || left.totalCost - right.totalCost
  ));
}

export async function findBestMetagameDeck(data, constraintId, characters, options = {}) {
  const sourceConstraint = data?.constraints?.find((entry) => entry.id === constraintId);
  if (!sourceConstraint) throw new Error("選択した縛りの調査データがありません。");
  const requestedTotalCost = Number(options.totalCost);
  const costMode = options.costMode === "exact" ? "exact" : "at_most";
  const constraint = Number.isFinite(requestedTotalCost) && requestedTotalCost >= 1
    ? { ...sourceConstraint, totalCost: Math.floor(requestedTotalCost), costMode }
    : { ...sourceConstraint, costMode };
  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const additionalIds = normalizeMetagameBoostedCharacterIds(options.additionalCharacterIds);
  const charactersById = metagameCharactersById(characters, boostedIds);
  options.onProgress?.({
    phase: "candidate",
    completed: 0,
    total: 5,
    slot: 1,
    slots: 5,
    checked: 0,
    stageTotal: 0,
    retained: 0,
  });
  if (String(constraint.modelVersion ?? "").startsWith("team-battle-v8")) {
    const fixedSlots = metagameFixedSlots(options.fixedSlots);
    if (options.usePublishedV8Cache === true && !boostedIds.size && !additionalIds.size) {
      const precomputed = metagameV8PrecomputedResults(constraint, characters, fixedSlots);
      if (!precomputed.length) {
        throw new Error("選択した固定キャラを同時に含むV8事前評価済みデッキがありません。");
      }
      return {
        constraint,
        generatedAt: data.generatedAt,
        candidateDeckCount: precomputed.length,
        simulatedDeckCount: 0,
        scenarioCount: Number(constraint.scenarioCount) || 0,
        results: precomputed.slice(0, 3),
      };
    }

    const interactiveCharacters = [...charactersById.values()];
    const interactiveIds = new Set([
      ...boostedIds,
      ...additionalIds,
      ...interactiveCharacters.filter((character) => String(character.id).startsWith("manual-")).map((character) => String(character.id)),
    ]);
    const candidates = metagameV8BoostedCandidates(
      constraint,
      interactiveCharacters,
      boostedIds,
      fixedSlots,
      additionalIds,
    );
    const finalists = metagameSelectFinalistsWithBoosts(candidates, options.finalistCount ?? 8, interactiveIds);
    const requestedScenarioCount = Number(options.interactiveScenarioCount ?? options.boostedScenarioCount);
    const boostedScenarioCount = requestedScenarioCount === 0
      ? undefined
      : Math.max(1, requestedScenarioCount || 8);
    const scenarios = metagameBattleScenarios(constraint, charactersById, boostedIds, {
      maxBaseScenarios: boostedScenarioCount,
      environmentCharacterIds: options.includeAdditionalInEnvironment === false ? boostedIds : interactiveIds,
    });
    const evaluated = [];
    let completedSimulations = 0;
    const totalSimulations = finalists.length * scenarios.length;
    for (let index = 0; index < finalists.length; index += 1) {
      evaluated.push(await metagameEvaluateDeck(
        finalists[index],
        scenarios,
        constraint,
        options.rules ?? DEFAULT_RULES,
        {
          ...options,
          onScenarioCompleted: () => {
            completedSimulations += 1;
            options.onProgress?.({
              phase: "simulation",
              completed: completedSimulations,
              total: totalSimulations,
              valid: candidates.length,
              deck: index + 1,
              decks: finalists.length,
              scenarios: scenarios.length,
            });
          },
        },
      ));
    }
    evaluated.sort((left, right) => (
      right.expectedWinLowerBound - left.expectedWinLowerBound ||
      right.expectedWinRate - left.expectedWinRate ||
      left.totalCost - right.totalCost
    ));
    return {
      constraint,
      generatedAt: data.generatedAt,
      candidateDeckCount: candidates.length,
      simulatedDeckCount: finalists.length,
      scenarioCount: scenarios.length,
      boostedCharacterIds: [...boostedIds],
      additionalCharacterIds: [...additionalIds],
      interactiveCharacterIds: [...interactiveIds],
      includeAdditionalInEnvironment: options.includeAdditionalInEnvironment !== false,
      boostedScenarioCount,
      interactiveScenarioCount: requestedScenarioCount,
      results: evaluated.slice(0, 3).map((candidate) => ({
        ...candidate,
        boostedCharacterIds: [...boostedIds],
        additionalCharacterIds: [...additionalIds],
        interactiveCharacterIds: [...interactiveIds],
        includeAdditionalInEnvironment: options.includeAdditionalInEnvironment !== false,
        boostedScenarioCount,
        interactiveScenarioCount: requestedScenarioCount,
      })),
    };
  }
  const boostedCharacters = characters.map((character) => applyMetagameStatBoost(character, boostedIds));
  const candidates = await buildMetagameDeckCandidatesWithProgress(constraint, boostedCharacters, options);
  const finalists = metagameSelectFinalists(candidates, options.finalistCount);
  const scenarios = metagameBattleScenarios(constraint, charactersById, boostedIds, {
    maxBaseScenarios: boostedIds.size ? Math.max(1, Number(options.boostedScenarioCount) || 18) : undefined,
  });
  const evaluated = [];
  let completedSimulations = 0;
  const totalSimulations = finalists.length * scenarios.length;
  for (let index = 0; index < finalists.length; index += 1) {
    evaluated.push(await metagameEvaluateDeck(
      finalists[index],
      scenarios,
      constraint,
      options.rules ?? DEFAULT_RULES,
      {
        ...options,
        onScenarioCompleted: () => {
          completedSimulations += 1;
          options.onProgress?.({
            phase: "simulation",
            completed: completedSimulations,
            total: totalSimulations,
            valid: candidates.length,
            deck: index + 1,
            decks: finalists.length,
            scenarios: scenarios.length,
          });
        },
      },
    ));
  }
  evaluated.sort((left, right) => (
    right.expectedWinLowerBound - left.expectedWinLowerBound ||
    right.expectedWinRate - left.expectedWinRate ||
    left.handoffRisk - right.handoffRisk ||
    right.proxyScore - left.proxyScore ||
    left.totalCost - right.totalCost
  ));
  return {
    constraint,
    generatedAt: data.generatedAt,
    candidateDeckCount: candidates.length,
    simulatedDeckCount: finalists.length,
    scenarioCount: scenarios.length,
    boostedCharacterIds: [...boostedIds],
    boostedScenarioCount: boostedIds.size ? Math.max(1, Number(options.boostedScenarioCount) || 18) : undefined,
    results: evaluated.slice(0, 3),
  };
}
