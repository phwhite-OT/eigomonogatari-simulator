import { createBattleState } from "./battleState.js";
import { simulateBattle } from "./simulate.js";
import { DEFAULT_ENVIRONMENT_BATTLE_PROFILES } from "./environment-rating.js";
import { DEFAULT_RULES, resolveAttributeClass } from "../data/rules.js";

const METAGAME_DECK_PROFILES = DEFAULT_ENVIRONMENT_BATTLE_PROFILES;

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
  return (
    metagameDeckClampUnit(rating.expectedWinLowerBound) * 0.36 +
    metagameDeckClampUnit(rating.expectedWinRate) * 0.22 +
    practicalValue * 0.13 +
    metagameDeckClampUnit(rating.balancedContribution) * 0.05 +
    enemyPressure * 0.12 +
    powerPreference * 0.07 +
    advantage * 0.045 +
    counter * 0.045 +
    skillReliability * 0.035 +
    combinationPotential * 0.10 +
    continuationWinGain * 0.035 +
    carriedContinuationWinGain * 0.045 +
    tacticalUpside * 0.04 -
    tacticalRisk * 0.04
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
  const persistence = metagameDeckClampUnit((duration - 1) / 3);
  const continuationWinGain = metagameDeckClampUnit(source.rating.continuationWinGain);
  const carriedContinuationWinGain = metagameDeckClampUnit(source.rating.carriedContinuationWinGain);
  const handoffValue = continuationWinGain * 0.04 + carriedContinuationWinGain * 0.06;
  if (["ally_all", "self"].includes(skill.target) && skill.type === "attack_buff") {
    const strength = metagameDeckClampUnit((Number(skill.multiplier) - 1) / 3);
    return reliability * (0.02 + strength * 0.055 + handoffValue) * (0.6 + targetPower * 0.4);
  }
  if (["ally_all", "self"].includes(skill.target) && skill.type === "attribute_change") {
    return reliability * (0.015 + targetPower * 0.02 + handoffValue) * (0.55 + targetEndurance * 0.45);
  }
  if (["damage_reduction", "guard", "attribute_guard"].includes(skill.type)) {
    const reductionStrength = metagameDeckClampUnit(1 - (Number(skill.multiplier) || 1));
    const carriedDefenseHits = Number(
      source.rating.carriedDefenseRate ?? source.rating.continuation?.carriedDefenseHitsPerScenario ?? 0,
    );
    const carriedDefenseRate = metagameDeckClampUnit(carriedDefenseHits / 2);
    const defenseValue = 0.035 + reductionStrength * 0.075 + persistence * 0.025 + carriedDefenseRate * 0.02 + handoffValue;
    return reliability * defenseValue * (0.12 + targetEndurance * 0.88);
  }
  if (["aoe_attack", "multi_hit_attack"].includes(skill.type)) {
    const followUpPressure = metagameDeckClampUnit(target.rating.counteraction / 2);
    return reliability * (0.01 + followUpPressure * 0.015 + targetPower * 0.015 + handoffValue * 0.5);
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

function metagameDeckStateScore(state, totalCost) {
  const averageScore = state.proxyTotal / Math.max(1, state.deck.length);
  const roleBonus = state.advantageCount > 0 && state.counterCount > 0 ? 0.012 : 0;
  const deckProgress = state.deck.length / 5;
  const budgetShare = state.totalCost / Math.max(1, totalCost);
  const earlyBudgetPressure = Math.max(0, budgetShare - (deckProgress * 0.95 + 0.07));
  return averageScore + state.synergyScore + roleBonus - state.budgetStrain - state.handoffRisk - earlyBudgetPressure * 0.18;
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
  const primaryCount = Math.max(1, Math.floor(width * 0.8));
  const primary = [...unique].sort((left, right) => (
    metagameDeckStateScore(right, totalCost) - metagameDeckStateScore(left, totalCost) ||
    left.totalCost - right.totalCost
  ));
  primary.slice(0, primaryCount).forEach((state) => selected.set(
    state.deck.map((entry) => entry.character.id).join("|"),
    state,
  ));
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

function metagameFixedFallbackRating(character) {
  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
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

export function buildMetagameDeckCandidates(constraint, characters, options = {}) {
  constraint = metagameConstraintWithFixedSlots(constraint, characters, options);
  const totalCost = Number(constraint?.totalCost) || 0;
  const beamWidth = Math.max(500, Number(options.beamWidth) || 10_000);
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const pools = (constraint?.slots ?? []).map((slot) => slot.candidates.map((rating) => ({
    character: charactersById.get(String(rating.id)),
    rating,
    proxy: metagameCandidateScore(rating),
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
  }];
  for (const pool of pools) {
    const expanded = [];
    for (const state of states) {
      for (const entry of pool) {
        const id = String(entry.character.id);
        const isLegend = entry.character.rarity === "伝";
        const nextCost = state.totalCost + (Number(entry.character.cost) || 0);
        if (state.ids.has(id) || nextCost > totalCost || (isLegend && state.legendCount >= 1)) continue;
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
        });
      }
    }
    states = metagameTrimDeckBeam(expanded, beamWidth, totalCost);
    if (!states.length) throw new Error("詳細評価候補から総コスト内の5体を構成できませんでした。");
  }
  return states.map((state) => ({
    deck: state.deck.map((entry) => entry.character),
    ratings: state.deck.map((entry) => entry.rating),
    totalCost: state.totalCost,
    proxyScore: metagameDeckStateScore(state, totalCost),
    synergyScore: state.synergyScore,
    handoffRisk: state.handoffRisk,
    budgetStrain: state.budgetStrain,
    advantageCount: state.advantageCount,
    counterCount: state.counterCount,
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
  const pools = (constraint?.slots ?? []).map((slot) => slot.candidates.map((rating) => ({
    character: charactersById.get(String(rating.id)),
    rating,
    proxy: metagameCandidateScore(rating),
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
        if (!state.ids.has(id) && nextCost <= totalCost && (!isLegend || state.legendCount < 1)) {
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
  return states.map((state) => ({
    deck: state.deck.map((entry) => entry.character),
    ratings: state.deck.map((entry) => entry.rating),
    totalCost: state.totalCost,
    proxyScore: metagameDeckStateScore(state, totalCost),
    synergyScore: state.synergyScore,
    handoffRisk: state.handoffRisk,
    budgetStrain: state.budgetStrain,
    advantageCount: state.advantageCount,
    counterCount: state.counterCount,
  })).sort((left, right) => right.proxyScore - left.proxyScore || left.totalCost - right.totalCost);
}

function metagameSelectFinalists(candidates, limit) {
  const maximum = Math.min(candidates.length, Math.max(36, Number(limit) || 40));
  const selected = new Map();
  const add = (candidate) => selected.set(candidate.deck.map((character) => character.id).join("|"), candidate);
  candidates.slice(0, Math.ceil(maximum * 0.55)).forEach(add);
  const ratingTotal = (candidate, key) => candidate.ratings.reduce((sum, rating) => (
    sum + Math.max(0, Number(rating[key]) || 0)
  ), 0);
  const selectors = [
    (left, right) => right.advantageCount - left.advantageCount || right.proxyScore - left.proxyScore,
    (left, right) => right.counterCount - left.counterCount || right.proxyScore - left.proxyScore,
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

/**
 * Replays the same team configurations and play profiles used by the rating.
 * Only three representative full logs are returned, while the summary is
 * calculated across every available scenario.
 */
export async function inspectMetagameDeckEvidence(deck, constraint, characters, options = {}) {
  if (!Array.isArray(deck) || deck.length !== 5) throw new Error("再生する候補デッキは5体必要です。");
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const scenarioCount = Array.isArray(constraint.teamScenarios) && constraint.teamScenarios.length
    ? constraint.teamScenarios.length
    : String(constraint.modelVersion ?? "").startsWith("team-battle-v8.")
      ? metagameV8ReconstructedScenarioCount(constraint)
      : constraint.environmentScenarios?.length ?? 0;
  if (!scenarioCount) throw new Error("この評価には再生可能な環境対戦データがありません。");

  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  const entries = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarioCount; scenarioIndex += 1) {
    if (options.signal?.aborted) throw metagameAbortError();
    const scenario = metagameEvidenceScenario(constraint, charactersById, scenarioIndex);
    const actorIndex = scenarioIndex % 5;
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(actorIndex, 0, deck);
    const profile = METAGAME_DECK_PROFILES[scenarioIndex % METAGAME_DECK_PROFILES.length];
    const result = simulateBattle(
      createBattleState(allyDecks, scenario.enemyDecks),
      options.rules ?? DEFAULT_RULES,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
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
    const environmentDecks = scenarios[scenarioIndex];
    const actorIndex = scenarioIndex % 5;
    const allyDecks = environmentDecks.slice(0, 4);
    allyDecks.splice(actorIndex, 0, candidate.deck);
    const profile = METAGAME_DECK_PROFILES[scenarioIndex % METAGAME_DECK_PROFILES.length];
    const result = simulateBattle(
      createBattleState(allyDecks, environmentDecks.slice(4)),
      rules,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
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
      const key = ids.map(String).join("|");
      const expectedWinRate = Number(rawPrecomputed.w ?? rawPrecomputed.expectedWinRate) || 0;
      const expectedWinLowerBound = Number(rawPrecomputed.l ?? rawPrecomputed.expectedWinLowerBound) || 0;
      const scenarioCount = Number(rawPrecomputed.s ?? rawPrecomputed.scenarioCount) || 0;
      const candidate = {
        deck,
        ratings: deck.map((character, index) => (
          ratingsByPosition[index].get(String(character.id)) ?? {
            ...metagameFixedFallbackRating(character),
            expectedWinRate,
            expectedWinLowerBound,
            scenarioCount,
            overallRank: "-",
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

export async function findBestMetagameDeck(data, constraintId, characters, options = {}) {
  const constraint = data?.constraints?.find((entry) => entry.id === constraintId);
  if (!constraint) throw new Error("選択した縛りの調査データがありません。");
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
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
  const candidates = await buildMetagameDeckCandidatesWithProgress(constraint, characters, options);
  const finalists = metagameSelectFinalists(candidates, options.finalistCount);
  const scenarios = metagameHydrateEnvironment(constraint, charactersById);
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
    results: evaluated.slice(0, 3),
  };
}
