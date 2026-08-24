import { buildMetagameDeckCandidates } from "./metagame-deck.js";
import {
  buildMetagameV7DeckCandidates,
  evaluateMetagameV7Deck,
} from "./metagame-v7.js";

export const METAGAME_V12_MODEL_VERSION = "team-battle-v12.1-opportunity-value";

const PARTIAL_SKILL_TYPES = new Set(["delay", "skill_reduction"]);

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function rounded(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function isLegend(character) {
  const rarity = String(character?.rarity ?? "");
  return rarity === "伝" || rarity.toUpperCase() === "LEGEND";
}

function deckKey(deck) {
  return (deck ?? []).map((character) => String(character?.id ?? "")).join("|");
}

function signedOpportunityScore(value) {
  // Zero opportunity gain is neutral (0.5). Positive and negative battle
  // effects remain signed instead of clipping harmful characters to zero.
  return clampUnit(0.5 + 0.5 * Math.tanh((Number(value) || 0) / 0.15));
}

function rotated(values, offset) {
  if (!values.length) return [];
  const normalized = ((offset % values.length) + values.length) % values.length;
  return normalized
    ? [...values.slice(normalized), ...values.slice(0, normalized)]
    : [...values];
}

function buildEnvironmentDeck(resolvedInput, fixedByPosition = new Map(), variant = 0) {
  const deck = Array(5).fill(null);
  const usedIds = new Set();
  let cost = 0;
  let legendCount = 0;

  for (const [position, character] of fixedByPosition.entries()) {
    const index = Number(position);
    if (index < 0 || index > 4 || !character) return null;
    const id = String(character.id);
    if (usedIds.has(id)) return null;
    usedIds.add(id);
    deck[index] = character;
    cost += Number(character.cost) || 0;
    legendCount += isLegend(character) ? 1 : 0;
  }
  if (cost > resolvedInput.totalCost || legendCount > 1) return null;

  const positions = [0, 1, 2, 3, 4]
    .filter((position) => !deck[position])
    .sort((left, right) => resolvedInput.environmentPools[left].length - resolvedInput.environmentPools[right].length);

  const minimumRemainingCost = (startIndex, ids, legends) => {
    let total = 0;
    for (const position of positions.slice(startIndex)) {
      const costs = resolvedInput.environmentPools[position]
        .filter((character) => !ids.has(String(character.id)))
        .filter((character) => legends === 0 || !isLegend(character))
        .map((character) => Number(character.cost) || 0);
      if (!costs.length) return Infinity;
      total += Math.min(...costs);
    }
    return total;
  };

  const visit = (index, currentCost, currentLegends) => {
    if (index >= positions.length) return true;
    const position = positions[index];
    const pool = resolvedInput.environmentPools[position];
    const offset = variant * (position + 3) + index * 5;
    for (const character of rotated(pool, offset)) {
      const id = String(character.id);
      if (usedIds.has(id)) continue;
      const nextLegends = currentLegends + (isLegend(character) ? 1 : 0);
      if (nextLegends > 1) continue;
      const nextCost = currentCost + (Number(character.cost) || 0);
      if (nextCost > resolvedInput.totalCost) continue;
      usedIds.add(id);
      deck[position] = character;
      if (nextCost + minimumRemainingCost(index + 1, usedIds, nextLegends) <= resolvedInput.totalCost &&
          visit(index + 1, nextCost, nextLegends)) {
        return true;
      }
      deck[position] = null;
      usedIds.delete(id);
    }
    return false;
  };

  return visit(0, cost, legendCount) ? [...deck] : null;
}

/**
 * Builds the supplied metagame without the V11 LEGEND/伝 mismatch. Every
 * supplied pivot is represented before extra variants are added. No HP/power
 * proxy is used to pretend that one supplied opponent is more common.
 */
export function createMetagameV12EnvironmentDecks(resolvedInput, options = {}) {
  const variants = Math.max(1, Math.floor(Number(options.environmentVariants) || 2));
  const requestedCount = Math.max(9, Math.floor(Number(options.count) || 72));
  const pivots = resolvedInput.environmentPools.flatMap((pool, position) => (
    pool.map((character) => ({ position, character }))
  ));
  if (!pivots.length) throw new Error("V12 environment pools are empty.");

  const decks = [];
  const keys = new Set();
  const addDeck = (deck) => {
    if (!deck) return false;
    if (deck.length !== 5 || deck.some((character) => !character)) return false;
    if (deck.reduce((sum, character) => sum + (Number(character.cost) || 0), 0) > resolvedInput.totalCost) return false;
    if (new Set(deck.map((character) => String(character.id))).size !== 5) return false;
    if (deck.filter(isLegend).length > 1) return false;
    const key = deckKey(deck);
    if (keys.has(key)) return false;
    keys.add(key);
    decks.push(deck);
    return true;
  };

  for (const [patternIndex, pattern] of (resolvedInput.examplePatterns ?? []).entries()) {
    const fixed = new Map(pattern.map((character, position) => character ? [position, character] : null).filter(Boolean));
    addDeck(buildEnvironmentDeck(resolvedInput, fixed, patternIndex));
  }

  // First pass guarantees coverage of every supplied character in its slot.
  for (const [pivotIndex, pivot] of pivots.entries()) {
    let built = false;
    for (let attempt = 0; attempt < Math.max(variants, 6) && !built; attempt += 1) {
      built = addDeck(buildEnvironmentDeck(
        resolvedInput,
        new Map([[pivot.position, pivot.character]]),
        pivotIndex + attempt * pivots.length,
      ));
    }
    if (!built && !decks.some((deck) => String(deck[pivot.position]?.id) === String(pivot.character.id))) {
      throw new Error(`${pivot.position + 1}枠目の環境キャラ ${pivot.character.name} を含む合法デッキを構成できません。`);
    }
  }

  const target = Math.max(requestedCount, Math.min(pivots.length * variants, requestedCount + pivots.length));
  let cursor = 0;
  let duplicateFallbacks = 0;
  while (decks.length < target && cursor < target * 30) {
    const pivot = pivots[cursor % pivots.length];
    const variant = Math.floor(cursor / pivots.length) + 1;
    const deck = buildEnvironmentDeck(resolvedInput, new Map([[pivot.position, pivot.character]]), variant);
    if (!addDeck(deck) && deck && decks.length < 9) {
      // Degenerate tiny pools may not contain nine unique legal decks. Keep a
      // legal duplicate rather than falling back to an invalid 1v1 scenario.
      decks.push(deck);
      duplicateFallbacks += 1;
    }
    cursor += 1;
  }

  if (decks.length < 9) {
    throw new Error(`5対5環境の作成には9本以上の合法デッキが必要です（${decks.length}本）。`);
  }
  if (duplicateFallbacks) {
    console.warn(`V12 environment required ${duplicateFallbacks} duplicate legal deck(s) because the supplied pools were too small.`);
  }
  return decks;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Math.floor(left));
  let b = Math.abs(Math.floor(right));
  while (b) [a, b] = [b, a % b];
  return a;
}

function coprimeStride(length, preferred) {
  if (length <= 1) return 1;
  let stride = Math.max(1, Math.min(length - 1, preferred));
  while (stride > 1 && greatestCommonDivisor(stride, length) !== 1) stride -= 1;
  return stride;
}

/**
 * V11 deliberately minimized repeated characters among the ten players. V12
 * samples environment decks without looking at their character overlap, so a
 * common card is allowed to appear on multiple players in the same 5v5 match.
 */
export function createMetagameV12TeamScenarios(resolvedInput, options = {}) {
  const environmentDecks = options.environmentDecks ?? createMetagameV12EnvironmentDecks(resolvedInput, options);
  if (environmentDecks.length < 9) throw new Error("V12 5v5 scenarios require at least nine environment decks.");
  const count = Math.max(1, Math.floor(Number(options.count) || 72));
  const deckCount = environmentDecks.length;
  const withinScenarioStride = coprimeStride(deckCount, 17);
  const betweenScenarioStride = coprimeStride(deckCount, 11);
  const scenarios = [];

  for (let scenarioIndex = 0; scenarioIndex < count; scenarioIndex += 1) {
    const start = (scenarioIndex * betweenScenarioStride) % deckCount;
    const indexes = [];
    const used = new Set();
    let cursor = 0;
    while (indexes.length < 9 && cursor < deckCount * 2) {
      const index = (start + cursor * withinScenarioStride) % deckCount;
      if (!used.has(index)) {
        used.add(index);
        indexes.push(index);
      }
      cursor += 1;
    }
    if (indexes.length < 9) throw new Error("V12 could not select nine distinct environment deck indexes.");
    const decks = indexes.map((index) => environmentDecks[index]);
    scenarios.push({
      id: `v12-team-${scenarioIndex + 1}`,
      allyDecks: decks.slice(0, 4),
      enemyDecks: decks.slice(4),
    });
  }
  return scenarios;
}

function selectDiverseDecks(entries, limit) {
  const unique = new Map();
  for (const entry of entries ?? []) {
    const key = deckKey(entry.deck);
    const current = unique.get(key);
    if (!current || Number(entry.proxyScore) > Number(current.proxyScore)) unique.set(key, entry);
  }
  const sorted = [...unique.values()].sort((left, right) => (
    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||
    (Number(right.synergyScore) || 0) - (Number(left.synergyScore) || 0) ||
    (Number(right.totalCost) || 0) - (Number(left.totalCost) || 0)
  ));
  if (sorted.length <= limit) return sorted;
  const selected = sorted.slice(0, Math.min(limit, 2));
  while (selected.length < limit) {
    let best = null;
    let bestScore = -Infinity;
    for (const entry of sorted.slice(2, 34)) {
      if (selected.includes(entry)) continue;
      const ids = new Set(entry.deck.map((character) => String(character.id)));
      const minimumDifference = Math.min(...selected.map((chosen) => (
        chosen.deck.reduce((difference, character) => difference + (ids.has(String(character.id)) ? 0 : 1), 0)
      )));
      // Max diversity bonus is only 0.025; unlike V12's x10 term it
      // cannot make a clearly weaker proxy deck replace a near-best one.
      const score = (Number(entry.proxyScore) || 0) + minimumDifference * 0.005;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    if (!best) best = sorted.find((entry) => !selected.includes(entry));
    if (!best) break;
    selected.push(best);
  }
  return selected;
}

/**
 * Re-optimizes all five slots while excluding the candidate. This is the key
 * V12 opportunity-cost baseline: freed cost can be spent anywhere in the deck
 * instead of being replaced by the V11 HP1 empty slot.
 */
export function buildMetagameV12AlternativeDecks(character, resolvedInput, candidatePools, options = {}) {
  const excludedId = String(character.id);
  const alternativeDeckLimit = Math.max(1, Math.floor(Number(options.alternativeDeckLimit) || 3));
  const constraint = {
    totalCost: resolvedInput.totalCost,
    allowedAttributes: resolvedInput.allowedAttributes,
    slots: candidatePools.partnerRatingsByPosition.map((ratings, index) => ({
      position: index + 1,
      candidates: ratings.filter((rating) => String(rating.id) !== excludedId),
    })),
  };
  if (constraint.slots.some((slot) => !slot.candidates.length)) return [];
  try {
    const candidates = buildMetagameDeckCandidates(
      constraint,
      [...candidatePools.charactersById.values()],
      { beamWidth: options.beamWidth ?? 500 },
    );
    return selectDiverseDecks(candidates, alternativeDeckLimit);
  } catch (error) {
    if (error instanceof Error && /cost|総コスト|valid complete/i.test(error.message)) return [];
    throw error;
  }
}

function evaluateCached(deck, teamScenarios, options) {
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const cache = options.evaluationCache;
  const key = `${turns}:${deckKey(deck)}`;
  if (cache?.has(key)) return cache.get(key);
  const result = evaluateMetagameV7Deck(deck, teamScenarios, { turns, rules: options.rules });
  cache?.set(key, result);
  return result;
}

function evaluateDeckEntry(entry, teamScenarios, options, origin) {
  const result = evaluateCached(entry.deck, teamScenarios, options);
  const totalCost = entry.deck.reduce((sum, character) => sum + (Number(character.cost) || 0), 0);
  return {
    ...entry,
    origin: entry.origin ?? origin,
    totalCost,
    result,
  };
}

function compareEvaluatedDecks(left, right) {
  return (
    (Number(right.result.expectedWinRate) || 0) - (Number(left.result.expectedWinRate) || 0) ||
    (Number(right.result.expectedWinLowerBound) || 0) - (Number(left.result.expectedWinLowerBound) || 0) ||
    (Number(right.result.decisiveWinRate) || 0) - (Number(left.result.decisiveWinRate) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
  );
}

export function rateMetagameV12Character(character, position, resolvedInput, candidatePools, teamScenarios, options = {}) {
  const autoDeckLimit = Math.max(1, Math.floor(Number(options.autoDeckLimit) || 3));
  const rawIncludeCandidates = buildMetagameV7DeckCandidates(
    character,
    position,
    resolvedInput,
    candidatePools,
    { ...options, autoDeckLimit },
  );
  const exampleCandidate = rawIncludeCandidates.find((entry) => entry.origin === "example");
  const automaticCandidates = selectDiverseDecks(
    rawIncludeCandidates.filter((entry) => entry !== exampleCandidate),
    Math.max(0, autoDeckLimit - (exampleCandidate ? 1 : 0)),
  );
  const includeCandidates = exampleCandidate
    ? [exampleCandidate, ...automaticCandidates]
    : selectDiverseDecks(rawIncludeCandidates, autoDeckLimit);
  const alternativeCandidates = buildMetagameV12AlternativeDecks(character, resolvedInput, candidatePools, options);
  const staticRating = candidatePools.ratingsByPosition[position - 1]?.get(String(character.id)) ?? {};

  if (!includeCandidates.length || !alternativeCandidates.length) {
    return {
      id: String(character.id),
      name: character.name,
      attributes: character.attributes,
      rarity: character.rarity,
      cost: character.cost,
      hp: character.hp,
      pow: character.pow,
      skillTurn: character.skillTurn,
      skillType: character.skill?.type ?? "none",
      role: staticRating.role ?? "neutral",
      evaluationStatus: !includeCandidates.length ? "no-include-deck" : "no-alternative-deck",
      opportunityWinGain: -1,
      robustOpportunityWinGain: -1,
      marginalWinGain: -1,
      marginalWinGainLowerBound: -1,
      costAwareScore: 0,
      v7Score: 0,
      evaluatedDeckCount: 0,
      alternativeDeckCount: 0,
      bestDeck: { ids: [], names: [], expectedWinRate: 0, expectedWinLowerBound: 0, totalCost: 0, remainingCost: resolvedInput.totalCost },
      baselineDeck: { ids: [], names: [], expectedWinRate: 1, expectedWinLowerBound: 1, totalCost: 0, remainingCost: resolvedInput.totalCost },
    };
  }

  const includeEvaluated = includeCandidates
    .map((entry) => evaluateDeckEntry(entry, teamScenarios, options, "include"))
    .sort(compareEvaluatedDecks);
  const alternativeEvaluated = alternativeCandidates
    .map((entry) => evaluateDeckEntry(entry, teamScenarios, options, "exclude"))
    .sort(compareEvaluatedDecks);
  const best = includeEvaluated[0];
  const baseline = alternativeEvaluated[0];

  const pairedDeltas = (best.result.scenarioValues ?? []).map((value, index) => (
    Number(value) - Number(baseline.result.scenarioValues?.[index])
  )).filter(Number.isFinite);
  const opportunityWinGain = pairedDeltas.length
    ? average(pairedDeltas)
    : (Number(best.result.expectedWinRate) || 0) - (Number(baseline.result.expectedWinRate) || 0);
  const includeValues = includeEvaluated.map((entry) => Number(entry.result.expectedWinRate) || 0);
  const pairedStdDev = standardDeviation(pairedDeltas);
  const pairedStandardError = pairedDeltas.length > 1 ? pairedStdDev / Math.sqrt(pairedDeltas.length) : 0;
  const robustOpportunityWinGain = opportunityWinGain - 1.28 * pairedStandardError;
  const decisiveWinGain = (Number(best.result.decisiveWinRate) || 0) - (Number(baseline.result.decisiveWinRate) || 0);
  const score = signedOpportunityScore(robustOpportunityWinGain);
  const partialSkill = PARTIAL_SKILL_TYPES.has(character.skill?.type);

  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    hp: character.hp,
    pow: character.pow,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    role: staticRating.role ?? "neutral",
    evaluationStatus: partialSkill ? "partial-skill-support" : "complete",
    evaluationWarning: partialSkill ? "delay / skill_reduction は現戦闘エンジンで未実装のため、スキル分を過小評価する。" : null,
    opportunityWinGain: rounded(opportunityWinGain),
    robustOpportunityWinGain: rounded(robustOpportunityWinGain),
    decisiveWinGain: rounded(decisiveWinGain),
    marginalWinGain: rounded(opportunityWinGain),
    marginalWinGainLowerBound: rounded(robustOpportunityWinGain),
    candidateExpectedWinRate: rounded(best.result.expectedWinRate),
    benchmarkExpectedWinRate: rounded(baseline.result.expectedWinRate),
    expectedWinRate: rounded(best.result.expectedWinRate),
    expectedWinLowerBound: rounded(best.result.expectedWinLowerBound),
    costAwareScore: rounded(score),
    practicalValue: rounded(score),
    individualScore: rounded(score),
    roleFit: rounded(staticRating.roleFit ?? 0),
    roleBreakdown: {
      opportunityCostScore: rounded(score),
      staticRoleFitDiagnostic: rounded(staticRating.roleFit ?? 0),
      staticPracticalValueDiagnostic: rounded(staticRating.practicalValue ?? 0),
      includeDeckStdDev: rounded(standardDeviation(includeValues)),
      pairedScenarioStdDev: rounded(pairedStdDev),
      pairedScenarioStandardError: rounded(pairedStandardError),
      pairedScenarioCount: pairedDeltas.length,
      partialSkillSupport: partialSkill ? 1 : 0,
    },
    evaluatedDeckCount: includeEvaluated.length,
    alternativeDeckCount: alternativeEvaluated.length,
    battleEvaluationCount: includeEvaluated.length + alternativeEvaluated.length,
    bestDeck: {
      origin: best.origin,
      totalCost: best.totalCost,
      remainingCost: Math.max(0, resolvedInput.totalCost - best.totalCost),
      ids: best.deck.map((entry) => String(entry.id)),
      names: best.deck.map((entry) => entry.name),
      proxyScore: rounded(best.proxyScore ?? 0),
      synergyScore: rounded(best.synergyScore ?? 0),
      expectedWinRate: rounded(best.result.expectedWinRate),
      expectedWinLowerBound: rounded(best.result.expectedWinLowerBound),
      decisiveWinRate: rounded(best.result.decisiveWinRate),
      scenarioCount: best.result.scenarioCount,
    },
    baselineDeck: {
      origin: baseline.origin,
      totalCost: baseline.totalCost,
      remainingCost: Math.max(0, resolvedInput.totalCost - baseline.totalCost),
      ids: baseline.deck.map((entry) => String(entry.id)),
      names: baseline.deck.map((entry) => entry.name),
      proxyScore: rounded(baseline.proxyScore ?? 0),
      synergyScore: rounded(baseline.synergyScore ?? 0),
      expectedWinRate: rounded(baseline.result.expectedWinRate),
      expectedWinLowerBound: rounded(baseline.result.expectedWinLowerBound),
      decisiveWinRate: rounded(baseline.result.decisiveWinRate),
      scenarioCount: baseline.result.scenarioCount,
    },
    v7Score: rounded(score),
  };
}

function finiteOrNegativeInfinity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -Infinity;
}

export function rankMetagameV12Characters(ratings) {
  return [...ratings]
    .sort((left, right) => (
      finiteOrNegativeInfinity(right.robustOpportunityWinGain) - finiteOrNegativeInfinity(left.robustOpportunityWinGain) ||
      finiteOrNegativeInfinity(right.opportunityWinGain) - finiteOrNegativeInfinity(left.opportunityWinGain) ||
      finiteOrNegativeInfinity(right.decisiveWinGain) - finiteOrNegativeInfinity(left.decisiveWinGain) ||
      Number(left.cost) - Number(right.cost) ||
      String(left.id).localeCompare(String(right.id))
    ))
    .map((rating, index) => ({ ...rating, rank: index + 1 }));
}
