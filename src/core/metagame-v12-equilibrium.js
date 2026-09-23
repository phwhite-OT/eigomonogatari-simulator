import { createBattleState } from "./battleState.js";
import {
  ATTACK_ORDER_POLICIES,
  PLAY_STYLES,
  TARGET_POLICIES,
  simulateBattleSummary,
} from "./simulate.js";
import { DEFAULT_RULES } from "../data/rules.js";

export const METAGAME_V12_EQUILIBRIUM_VERSION = 1;

const EQUILIBRIUM_PROFILES = Object.freeze([
  Object.freeze({
    id: "stock-balance",
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  }),
  Object.freeze({
    id: "skill-intercept",
    targetPolicy: TARGET_POLICIES.SKILL_THREAT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  }),
  Object.freeze({
    id: "priority-finish",
    targetPolicy: TARGET_POLICIES.KILL_CONFIRM,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
    playStyle: PLAY_STYLES.EXPERT,
  }),
]);

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rounded(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function deckKey(entry) {
  const ids = entry?.ids ?? entry?.deck?.map((character) => character?.id) ?? [];
  return ids.map(String).join("|");
}

function deckDifference(left, right) {
  const leftIds = left?.ids ?? [];
  const rightIds = right?.ids ?? [];
  if (leftIds.length !== rightIds.length) return Math.max(leftIds.length, rightIds.length);
  return leftIds.reduce((count, id, index) => count + (String(id) === String(rightIds[index]) ? 0 : 1), 0);
}

function projectedWinValue(result) {
  if (result.outcome === "allies") return 1;
  if (result.outcome === "draw") return 0.5;
  if (result.outcome === "enemies") return 0;
  const initialEnemyCount = Math.max(1, result.initial.enemies.remainingCharacters);
  const initialAllyCount = Math.max(1, result.initial.allies.remainingCharacters);
  const enemyProgress = result.metrics.enemyLosses / initialEnemyCount;
  const allyProgress = result.metrics.allyLosses / initialAllyCount;
  const allyHp = result.final.allies.totalHp > 0 ? result.final.allies.remainingHp / result.final.allies.totalHp : 0;
  const enemyHp = result.final.enemies.totalHp > 0 ? result.final.enemies.remainingHp / result.final.enemies.totalHp : 0;
  return clampUnit(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function stableHash(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function normalizeWeights(values) {
  const total = values.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return values.map(() => 1 / Math.max(1, values.length));
  return values.map((value) => Math.max(0, Number(value) || 0) / total);
}

/**
 * Select a bounded strategic deck pool from the exact shared battle cache.
 * Generalists are preserved by fixed-environment win rate, while scenario
 * specialists are explicitly retained so a counter deck cannot disappear
 * merely because it is narrow and therefore mediocre on the broad average.
 */
export function selectMetagameV12EquilibriumDecks(sharedPool, options = {}) {
  const limit = Math.max(4, Math.floor(Number(options.limit) || 24));
  const unique = new Map();
  for (const entry of sharedPool ?? []) {
    const key = deckKey(entry);
    if (!key || (entry?.ids?.length ?? 0) !== 5) continue;
    const current = unique.get(key);
    if (!current || Number(entry.result?.expectedWinRate) > Number(current.result?.expectedWinRate)) {
      unique.set(key, entry);
    }
  }
  const available = [...unique.values()].sort((left, right) => (
    (Number(right.result?.expectedWinRate) || 0) - (Number(left.result?.expectedWinRate) || 0) ||
    (Number(right.result?.expectedWinLowerBound) || 0) - (Number(left.result?.expectedWinLowerBound) || 0) ||
    deckKey(left).localeCompare(deckKey(right))
  ));
  if (available.length <= limit) return available;

  const selected = [];
  const selectedKeys = new Set();
  const add = (entry) => {
    const key = deckKey(entry);
    if (!key || selectedKeys.has(key) || selected.length >= limit) return false;
    selected.push(entry);
    selectedKeys.add(key);
    return true;
  };

  const generalistCount = Math.min(limit, Math.max(4, Math.ceil(limit * 0.3)));
  available.slice(0, generalistCount).forEach(add);

  const scenarioCount = Math.max(0, ...available.map((entry) => entry.result?.scenarioValues?.length ?? 0));
  const specialistWins = new Map();
  for (let scenarioIndex = 0; scenarioIndex < scenarioCount; scenarioIndex += 1) {
    let best = null;
    let bestValue = -Infinity;
    for (const entry of available) {
      const value = Number(entry.result?.scenarioValues?.[scenarioIndex]);
      if (!Number.isFinite(value)) continue;
      if (value > bestValue) {
        best = entry;
        bestValue = value;
      }
    }
    if (best) {
      const key = deckKey(best);
      specialistWins.set(key, (specialistWins.get(key) ?? 0) + 1);
    }
  }
  [...available]
    .sort((left, right) => (
      (specialistWins.get(deckKey(right)) ?? 0) - (specialistWins.get(deckKey(left)) ?? 0) ||
      (Number(right.result?.expectedWinRate) || 0) - (Number(left.result?.expectedWinRate) || 0)
    ))
    .slice(0, Math.max(4, Math.ceil(limit * 0.45)))
    .forEach(add);

  const diversityFrontier = available.slice(0, Math.min(160, available.length));
  while (selected.length < limit) {
    let best = null;
    let bestScore = -Infinity;
    for (const entry of diversityFrontier) {
      if (selectedKeys.has(deckKey(entry))) continue;
      const minimumDifference = selected.length
        ? Math.min(...selected.map((chosen) => deckDifference(entry, chosen)))
        : 5;
      const score = (Number(entry.result?.expectedWinRate) || 0)
        + minimumDifference * 0.012
        + (specialistWins.get(deckKey(entry)) ?? 0) * 0.002;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    if (!best) best = available.find((entry) => !selectedKeys.has(deckKey(entry)));
    if (!best) break;
    add(best);
  }
  return selected;
}

export function serializeMetagameV12EquilibriumMatchupCache(cache) {
  return [...(cache?.entries?.() ?? [])]
    .filter(([key, value]) => typeof key === "string" && Number.isFinite(Number(value)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: Number(value) }));
}

export function hydrateMetagameV12EquilibriumMatchupCache(cache, entries) {
  if (!cache?.set) return cache;
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.key !== "string" || !Number.isFinite(Number(entry.value))) continue;
    if (!cache.has(entry.key)) cache.set(entry.key, Number(entry.value));
  }
  return cache;
}

function populationSignature(weights) {
  const normalized = normalizeWeights(weights ?? []);
  return normalized.map((weight) => rounded(weight, 5).toFixed(5)).join(",");
}

function matchupCacheKey(leftKey, rightKey, turns, weights) {
  const [first, second] = [String(leftKey), String(rightKey)].sort();
  const populationHash = stableHash(populationSignature(weights));
  return `eq-v${METAGAME_V12_EQUILIBRIUM_VERSION}:${turns}:p${populationHash}:${first}::${second}`;
}

function deterministicUnit(seed) {
  let value = (Number(seed) || 0) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967296;
}

function weightedDeckIndex(weights, unit) {
  const normalized = normalizeWeights(weights);
  let cursor = clampUnit(unit);
  for (let index = 0; index < normalized.length; index += 1) {
    cursor -= normalized[index];
    if (cursor <= 0 || index === normalized.length - 1) return index;
  }
  return normalized.length - 1;
}

function sampleBackgroundTeams(populationDecks, populationWeights, seedBase, sampleIndex) {
  const weights = populationDecks.length === populationWeights?.length
    ? normalizeWeights(populationWeights)
    : populationDecks.map(() => 1 / Math.max(1, populationDecks.length));
  const sampled = [];
  for (let slot = 0; slot < 8; slot += 1) {
    const unit = deterministicUnit(seedBase + sampleIndex * 101 + slot * 977 + 17);
    sampled.push(populationDecks[weightedDeckIndex(weights, unit)]);
  }
  return {
    allies: sampled.slice(0, 4),
    enemies: sampled.slice(4),
  };
}

function insertFocalDeck(backgroundDecks, focalDeck, position) {
  const team = [...backgroundDecks];
  team.splice(Math.max(0, Math.min(4, position)), 0, focalDeck);
  return team;
}

/**
 * Measure one focal-deck matchup inside a mixed 5v5 population.
 *
 * A and B each occupy one player slot. The other eight players are sampled
 * deterministically from the current metagame population. Across nine contexts
 * we cover every tactical-profile x damage-multiplier combination, and each
 * context is simulated in both side orientations. This retains the project's
 * real "one evaluated player among four teammates" semantics instead of
 * exaggerating an archetype by cloning it across all five players.
 */
export function evaluateMetagameV12EquilibriumMatchup(leftDeck, rightDeck, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const turns = Math.min(12, Math.max(1, Math.floor(Number(options.turns) || 12)));
  const leftKey = leftDeck.map((character) => String(character.id)).join("|");
  const rightKey = rightDeck.map((character) => String(character.id)).join("|");
  if (leftKey === rightKey) return 0.5;

  const populationDecks = Array.isArray(options.populationDecks) && options.populationDecks.length
    ? options.populationDecks
    : [leftDeck, rightDeck];
  const populationWeights = populationDecks.length === options.populationWeights?.length
    ? normalizeWeights(options.populationWeights)
    : populationDecks.map(() => 1 / populationDecks.length);
  const values = [];
  const seedBase = stableHash(`${leftKey}::${rightKey}::${populationSignature(populationWeights)}`);
  const minimumRandomMultiplier = Math.min(1, Math.max(0, Number(rules.damage?.randomMinimum) || 0.9));
  const damageMultipliers = [minimumRandomMultiplier, (minimumRandomMultiplier + 1) / 2, 1];

  for (let contextIndex = 0; contextIndex < 9; contextIndex += 1) {
    const profile = EQUILIBRIUM_PROFILES[contextIndex % EQUILIBRIUM_PROFILES.length];
    const damageMultiplier = damageMultipliers[Math.floor(contextIndex / EQUILIBRIUM_PROFILES.length) % damageMultipliers.length];
    const background = sampleBackgroundTeams(populationDecks, populationWeights, seedBase, contextIndex);
    const allyPosition = contextIndex % 5;
    const enemyPosition = (contextIndex * 2 + 1) % 5;
    const forwardAllies = insertFocalDeck(background.allies, leftDeck, allyPosition);
    const forwardEnemies = insertFocalDeck(background.enemies, rightDeck, enemyPosition);
    const reverseAllies = insertFocalDeck(background.enemies, rightDeck, enemyPosition);
    const reverseEnemies = insertFocalDeck(background.allies, leftDeck, allyPosition);

    const forward = simulateBattleSummary(
      createBattleState(forwardAllies, forwardEnemies),
      rules,
      {
        turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: seedBase + contextIndex * 37,
        damageMultiplier,
      },
    );
    const reverse = simulateBattleSummary(
      createBattleState(reverseAllies, reverseEnemies),
      rules,
      {
        turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: seedBase + contextIndex * 37 + 7,
        damageMultiplier,
      },
    );
    values.push((projectedWinValue(forward) + (1 - projectedWinValue(reverse))) / 2);
  }
  return clampUnit(average(values));
}

function hydrateDeck(entry, charactersById) {
  const deck = (entry?.ids ?? []).map((id) => charactersById.get(String(id)));
  return deck.length === 5 && deck.every(Boolean) ? deck : null;
}

/**
 * Build the strategic payoff matrix incrementally. The cache stores one
 * symmetric archetype matchup, so later deep-search rounds only evaluate pairs
 * involving newly discovered elite decks.
 */
export async function buildMetagameV12EquilibriumMatrix(entries, characters, options = {}) {
  const turns = Math.min(12, Math.max(1, Math.floor(Number(options.turns) || 12)));
  const cache = options.matchupCache ?? new Map();
  const charactersById = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const hydrated = (entries ?? []).map((entry) => ({
    ...entry,
    key: deckKey(entry),
    deck: hydrateDeck(entry, charactersById),
  })).filter((entry) => entry.deck);
  const populationWeights = hydrated.length === options.populationWeights?.length
    ? normalizeWeights(options.populationWeights)
    : hydrated.map(() => 1 / Math.max(1, hydrated.length));
  const populationDecks = hydrated.map((entry) => entry.deck);
  const matrix = Array.from({ length: hydrated.length }, () => Array(hydrated.length).fill(0.5));
  const totalPairs = hydrated.length * (hydrated.length - 1) / 2;
  const checkpointEvery = Math.max(1, Math.floor(Number(options.checkpointEvery) || 20));
  let completedPairs = 0;
  let newMatchups = 0;
  let newSinceCheckpoint = 0;

  for (let leftIndex = 0; leftIndex < hydrated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < hydrated.length; rightIndex += 1) {
      const left = hydrated[leftIndex];
      const right = hydrated[rightIndex];
      const key = matchupCacheKey(left.key, right.key, turns, populationWeights);
      let leftWin;
      if (cache.has(key)) {
        const canonicalLeft = left.key.localeCompare(right.key) <= 0;
        const canonicalValue = Number(cache.get(key));
        leftWin = canonicalLeft ? canonicalValue : 1 - canonicalValue;
      } else {
        leftWin = evaluateMetagameV12EquilibriumMatchup(left.deck, right.deck, {
          ...options,
          turns,
          populationDecks,
          populationWeights,
        });
        const canonicalLeft = left.key.localeCompare(right.key) <= 0;
        cache.set(key, canonicalLeft ? leftWin : 1 - leftWin);
        newMatchups += 1;
        newSinceCheckpoint += 1;
      }
      matrix[leftIndex][rightIndex] = leftWin;
      matrix[rightIndex][leftIndex] = 1 - leftWin;
      completedPairs += 1;

      if (newSinceCheckpoint >= checkpointEvery) {
        await options.onProgress?.({ completedPairs, totalPairs, newMatchups, cache, populationWeights });
        newSinceCheckpoint = 0;
      }
      if (options.shouldStop?.()) {
        await options.onProgress?.({ completedPairs, totalPairs, newMatchups, cache, populationWeights });
        return {
          complete: false,
          entries: hydrated,
          matrix,
          populationWeights,
          completedPairs,
          totalPairs,
          newMatchups,
        };
      }
    }
  }
  if (newSinceCheckpoint > 0) {
    await options.onProgress?.({ completedPairs, totalPairs, newMatchups, cache, populationWeights });
  }
  return {
    complete: true,
    entries: hydrated,
    matrix,
    populationWeights,
    completedPairs,
    totalPairs,
    newMatchups,
  };
}

/**
 * Multiplicative-weights / no-regret equilibrium. The time-averaged strategy is
 * used rather than the final oscillating iterate, which is important for
 * rock-paper-scissors style counter cycles.
 */
export function solveMetagameV12Equilibrium(matrix, options = {}) {
  const size = matrix?.length ?? 0;
  if (!size || matrix.some((row) => !Array.isArray(row) || row.length !== size)) {
    return {
      usage: [],
      expectedWinRates: [],
      equilibriumValue: 0.5,
      exploitability: 0,
      iterations: 0,
      converged: true,
    };
  }

  const iterations = Math.max(100, Math.floor(Number(options.iterations) || 1200));
  const burnIn = Math.min(iterations - 1, Math.max(0, Math.floor(Number(options.burnIn) || 200)));
  const learningRate = Math.max(0.05, Number(options.learningRate) || 1.6);
  const exploration = Math.min(0.05, Math.max(0, Number(options.exploration) || 0.001));
  const targetExploitability = Math.max(0, Number(options.targetExploitability) || 0.006);
  let strategy = Array(size).fill(1 / size);
  const logWeights = Array(size).fill(0);
  const averageStrategy = Array(size).fill(0);
  let averagedIterations = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const payoffs = matrix.map((row) => row.reduce((sum, payoff, index) => sum + payoff * strategy[index], 0));
    const populationValue = strategy.reduce((sum, weight, index) => sum + weight * payoffs[index], 0);
    for (let index = 0; index < size; index += 1) {
      logWeights[index] = Math.max(-30, Math.min(30,
        logWeights[index] + learningRate * (payoffs[index] - populationValue)
      ));
    }
    const maximum = Math.max(...logWeights);
    const exponentials = logWeights.map((value) => Math.exp(value - maximum));
    const softmax = normalizeWeights(exponentials);
    strategy = softmax.map((weight) => (1 - exploration) * weight + exploration / size);
    strategy = normalizeWeights(strategy);

    if (iteration >= burnIn) {
      for (let index = 0; index < size; index += 1) averageStrategy[index] += strategy[index];
      averagedIterations += 1;
    }
  }

  const usage = normalizeWeights(
    averagedIterations
      ? averageStrategy.map((value) => value / averagedIterations)
      : strategy,
  );
  const expectedWinRates = matrix.map((row) => row.reduce((sum, payoff, index) => sum + payoff * usage[index], 0));
  const equilibriumValue = usage.reduce((sum, weight, index) => sum + weight * expectedWinRates[index], 0);
  const exploitability = Math.max(0, Math.max(...expectedWinRates) - equilibriumValue);

  return {
    usage,
    expectedWinRates,
    equilibriumValue,
    exploitability,
    iterations,
    converged: exploitability <= targetExploitability,
  };
}

function initialPopulationWeights(entries) {
  if (!(entries?.length > 0)) return [];
  const broadScores = entries.map((entry) => {
    const value = Number(entry.result?.expectedWinRate);
    return Number.isFinite(value) ? value : 0.5;
  });
  const maximum = Math.max(...broadScores);
  // Start the feedback loop from the surveyed environment's measured strength
  // rather than an artificial uniform field. The softmax is deliberately mild
  // so narrow specialists still retain enough mass to prove a counter relation.
  return normalizeWeights(broadScores.map((value) => Math.exp((value - maximum) * 8)));
}

function populationDistance(left, right) {
  if (left.length !== right.length) return 1;
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / 2;
}

/**
 * Close the team-population feedback loop.
 *
 * Pair payoffs are not measured in five identical copies. Each focal pair is
 * embedded in eight background players sampled from the current population.
 * After solving that payoff matrix, the resulting usage distribution becomes
 * the next round's background population. Damping prevents one noisy round
 * from replacing the whole field at once.
 */
export async function solveMetagameV12PopulationFeedback(entries, characters, options = {}) {
  const feedbackRounds = Math.max(1, Math.floor(Number(options.feedbackRounds) || 5));
  const feedbackDamping = Math.min(1, Math.max(0.1, Number(options.feedbackDamping) || 0.65));
  const targetPopulationDrift = Math.max(0, Number(options.targetPopulationDrift) || 0.025);
  let populationWeights = entries.length === options.initialPopulationWeights?.length
    ? normalizeWeights(options.initialPopulationWeights)
    : initialPopulationWeights(entries);
  let lastMatrixResult = null;
  let lastSolution = null;
  let populationDrift = 1;

  for (let roundIndex = 0; roundIndex < feedbackRounds; roundIndex += 1) {
    const matrixResult = await buildMetagameV12EquilibriumMatrix(entries, characters, {
      ...options,
      populationWeights,
      onProgress: async (progress) => {
        await options.onProgress?.({
          ...progress,
          feedbackRound: roundIndex + 1,
          feedbackRounds,
          populationDrift,
        });
      },
    });
    if (!matrixResult.complete) {
      return {
        complete: false,
        feedbackRound: roundIndex + 1,
        feedbackRounds,
        populationWeights,
        populationDrift,
        matrixResult,
        solution: lastSolution,
      };
    }

    const solution = solveMetagameV12Equilibrium(matrixResult.matrix, options);
    populationDrift = populationDistance(populationWeights, solution.usage);
    lastMatrixResult = matrixResult;
    lastSolution = solution;
    await options.onRoundComplete?.({
      feedbackRound: roundIndex + 1,
      feedbackRounds,
      populationWeights,
      populationDrift,
      matrixResult,
      solution,
    });

    if (populationDrift <= targetPopulationDrift) {
      return {
        complete: true,
        feedbackRound: roundIndex + 1,
        feedbackRounds,
        populationWeights,
        populationDrift,
        matrixResult,
        solution: {
          ...solution,
          converged: solution.converged && populationDrift <= targetPopulationDrift,
        },
      };
    }

    populationWeights = normalizeWeights(populationWeights.map((weight, index) => (
      (1 - feedbackDamping) * weight + feedbackDamping * (Number(solution.usage[index]) || 0)
    )));
  }

  return {
    complete: true,
    feedbackRound: feedbackRounds,
    feedbackRounds,
    populationWeights,
    populationDrift,
    matrixResult: lastMatrixResult,
    solution: {
      ...lastSolution,
      converged: Boolean(lastSolution?.converged) && populationDrift <= targetPopulationDrift,
    },
  };
}

function dependencyAgainstRemovedTarget(matrix, usage, deckIndex, targetIndex, currentWinRate) {
  const remaining = 1 - usage[targetIndex];
  if (targetIndex === deckIndex || remaining <= 1e-9) return 0;
  let noTarget = 0;
  for (let index = 0; index < usage.length; index += 1) {
    if (index === targetIndex) continue;
    noTarget += matrix[deckIndex][index] * usage[index] / remaining;
  }
  return currentWinRate - noTarget;
}

export function summarizeMetagameV12Equilibrium(entries, matrix, solution, options = {}) {
  const minimumTargetShare = Math.max(0, Number(options.minimumTargetShare) || 0.02);
  const decks = entries.map((entry, index) => {
    const usageRate = Number(solution.usage[index]) || 0;
    const expectedWinRate = Number(solution.expectedWinRates[index]) || 0;
    let metaDependency = 0;
    let dependencyTargetIndex = null;
    for (let targetIndex = 0; targetIndex < entries.length; targetIndex += 1) {
      if (targetIndex === index || (Number(solution.usage[targetIndex]) || 0) < minimumTargetShare) continue;
      const dependency = dependencyAgainstRemovedTarget(
        matrix,
        solution.usage,
        index,
        targetIndex,
        expectedWinRate,
      );
      if (dependency > metaDependency) {
        metaDependency = dependency;
        dependencyTargetIndex = targetIndex;
      }
    }
    return {
      key: entry.key ?? deckKey(entry),
      ids: [...(entry.ids ?? [])].map(String),
      names: [...(entry.names ?? [])],
      totalCost: Number(entry.totalCost) || 0,
      broadExpectedWinRate: rounded(entry.result?.expectedWinRate),
      usageRate: rounded(usageRate),
      expectedWinRate: rounded(expectedWinRate),
      metaDependency: rounded(Math.max(0, metaDependency)),
      dependencyTargetKey: dependencyTargetIndex === null ? null : (entries[dependencyTargetIndex].key ?? deckKey(entries[dependencyTargetIndex])),
      dependencyTargetNames: dependencyTargetIndex === null ? null : [...(entries[dependencyTargetIndex].names ?? [])],
      dependencyTargetUsageRate: dependencyTargetIndex === null ? 0 : rounded(solution.usage[dependencyTargetIndex]),
    };
  });

  const sorted = [...decks].sort((left, right) => (
    right.usageRate - left.usageRate ||
    right.expectedWinRate - left.expectedWinRate ||
    left.metaDependency - right.metaDependency ||
    left.key.localeCompare(right.key)
  ));
  const rankByKey = new Map(sorted.map((entry, index) => [entry.key, index + 1]));
  for (const entry of decks) entry.rank = rankByKey.get(entry.key);

  return {
    version: METAGAME_V12_EQUILIBRIUM_VERSION,
    model: "mixed-5v5-population-feedback-no-regret",
    candidateDeckCount: entries.length,
    equilibriumValue: rounded(solution.equilibriumValue),
    exploitability: rounded(solution.exploitability),
    iterations: solution.iterations,
    feedbackRound: Number(options.feedbackRound) || null,
    feedbackRounds: Number(options.feedbackRounds) || null,
    populationDrift: rounded(options.populationDrift),
    converged: solution.converged,
    decks: decks.sort((left, right) => left.rank - right.rank),
  };
}

export function annotateMetagameV12RatingsWithEquilibrium(resultsByPosition, equilibrium) {
  const decks = equilibrium?.decks ?? [];
  return (resultsByPosition ?? []).map((ratings, positionIndex) => {
    const entries = ratings instanceof Map ? [...ratings.values()] : [...(ratings ?? [])];
    const annotated = entries.map((rating) => {
      const matching = decks.filter((deck) => String(deck.ids?.[positionIndex]) === String(rating.id));
      const usageRate = matching.reduce((sum, deck) => sum + (Number(deck.usageRate) || 0), 0);
      const weightedWin = usageRate > 0
        ? matching.reduce((sum, deck) => sum + (Number(deck.usageRate) || 0) * (Number(deck.expectedWinRate) || 0), 0) / usageRate
        : 0;
      const weightedDependency = usageRate > 0
        ? matching.reduce((sum, deck) => sum + (Number(deck.usageRate) || 0) * (Number(deck.metaDependency) || 0), 0) / usageRate
        : 0;
      const dependencyDeck = [...matching].sort((left, right) => (
        (Number(right.usageRate) || 0) * (Number(right.metaDependency) || 0)
        - (Number(left.usageRate) || 0) * (Number(left.metaDependency) || 0)
      ))[0];
      return {
        ...rating,
        equilibriumUsageRate: rounded(usageRate),
        equilibriumExpectedWinRate: rounded(weightedWin),
        equilibriumMetaDependency: rounded(weightedDependency),
        equilibriumDependencyTarget: dependencyDeck?.dependencyTargetNames ?? null,
        equilibriumDeckCount: matching.length,
        equilibriumModelVersion: equilibrium?.version ?? null,
      };
    });

    const positive = annotated.filter((entry) => entry.equilibriumUsageRate > 0).sort((left, right) => (
      right.equilibriumUsageRate - left.equilibriumUsageRate ||
      right.equilibriumExpectedWinRate - left.equilibriumExpectedWinRate ||
      left.equilibriumMetaDependency - right.equilibriumMetaDependency ||
      String(left.id).localeCompare(String(right.id))
    ));
    const rankById = new Map(positive.map((entry, index) => [String(entry.id), index + 1]));
    return annotated.map((entry) => ({
      ...entry,
      equilibriumRank: rankById.get(String(entry.id)) ?? null,
    }));
  });
}
