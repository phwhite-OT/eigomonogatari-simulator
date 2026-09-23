function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function rounded(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function deckKey(deck = []) {
  return deck.map((character) => String(character?.id ?? character ?? "")).join("|");
}

function normalizedWeights(values) {
  const sanitized = values.map((value) => Math.max(0, Number(value) || 0));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total > 0) return sanitized.map((value) => value / total);
  const fallback = sanitized.length ? 1 / sanitized.length : 0;
  return sanitized.map(() => fallback);
}

function weightedMean(values, weights) {
  const count = Math.min(values.length, weights.length);
  let total = 0;
  let weight = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Number(values[index]);
    const currentWeight = Math.max(0, Number(weights[index]) || 0);
    if (!Number.isFinite(value) || !currentWeight) continue;
    total += value * currentWeight;
    weight += currentWeight;
  }
  return weight > 0 ? total / weight : 0;
}

function weightedVariance(values, weights, mean = weightedMean(values, weights)) {
  const count = Math.min(values.length, weights.length);
  let weightedSquaredError = 0;
  let weight = 0;
  let squaredWeight = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Number(values[index]);
    const currentWeight = Math.max(0, Number(weights[index]) || 0);
    if (!Number.isFinite(value) || !currentWeight) continue;
    weightedSquaredError += currentWeight * (value - mean) ** 2;
    weight += currentWeight;
    squaredWeight += currentWeight ** 2;
  }
  if (weight <= 0) return 0;
  const normalizedSquaredWeight = squaredWeight / (weight ** 2);
  const denominator = 1 - normalizedSquaredWeight;
  return denominator > 1e-9
    ? (weightedSquaredError / weight) / denominator
    : 0;
}

function effectiveSampleSize(weights) {
  const normalized = normalizedWeights(weights);
  const squared = normalized.reduce((sum, value) => sum + value ** 2, 0);
  return squared > 0 ? 1 / squared : 0;
}

function scenarioBackgroundKeys(scenario) {
  if (Array.isArray(scenario?.backgroundDeckKeys) && scenario.backgroundDeckKeys.length) {
    return scenario.backgroundDeckKeys.map(String);
  }
  return [
    ...(scenario?.allyDecks ?? []),
    ...(scenario?.enemyDecks ?? []),
  ].map(deckKey);
}

export function adaptiveMetagameV12ScenarioWeights(teamScenarios, strategyWeightsByKey, options = {}) {
  const uniformFloor = clampUnit(options.uniformScenarioFloor ?? 0.20);
  if (!teamScenarios?.length) return [];
  const strategyCount = Math.max(1, strategyWeightsByKey?.size ?? 0);
  const epsilon = 1e-12;
  const raw = teamScenarios.map((scenario) => {
    const keys = scenarioBackgroundKeys(scenario);
    if (!keys.length) return 1;
    const meanLogRelativeFrequency = keys.reduce((sum, key) => {
      const frequency = Math.max(epsilon, Number(strategyWeightsByKey?.get(String(key))) || 0);
      return sum + Math.log(Math.max(epsilon, frequency * strategyCount));
    }, 0) / keys.length;
    return Math.exp(Math.max(-30, Math.min(30, meanLogRelativeFrequency)));
  });
  const adaptive = normalizedWeights(raw);
  const uniform = 1 / teamScenarios.length;
  return normalizedWeights(adaptive.map((weight) => (
    uniformFloor * uniform + (1 - uniformFloor) * weight
  )));
}

export function buildAdaptiveMetagameV12Equilibrium(
  environmentDecks,
  teamScenarios,
  evaluationCache,
  options = {},
) {
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const iterations = Math.max(1, Math.floor(Number(options.iterations) || 48));
  const burnIn = Math.max(0, Math.min(iterations - 1, Math.floor(Number(options.burnIn) || 12)));
  const learningRate = Math.max(0.1, Number(options.learningRate) || 6);
  const exploration = Math.min(0.25, Math.max(0, Number(options.exploration) || 0.04));
  const uniformScenarioFloor = clampUnit(options.uniformScenarioFloor ?? 0.20);

  const uniqueDecks = new Map();
  for (const deck of environmentDecks ?? []) {
    const key = deckKey(deck);
    if (key && !uniqueDecks.has(key)) uniqueDecks.set(key, deck);
  }
  if (!uniqueDecks.size) throw new Error("Adaptive V12 metagame requires at least one environment deck.");
  if (!teamScenarios?.length) throw new Error("Adaptive V12 metagame requires team scenarios.");

  const entries = [...uniqueDecks.entries()].map(([key, deck]) => {
    const cacheKey = `${turns}:${key}`;
    const result = evaluationCache?.get(cacheKey);
    if (!Array.isArray(result?.scenarioValues) || result.scenarioValues.length !== teamScenarios.length) {
      throw new Error(`Adaptive V12 metagame is missing environment-deck evidence: ${key}`);
    }
    return { key, deck, result };
  });

  let weights = entries.map(() => 1 / entries.length);
  const accumulated = entries.map(() => 0);
  let accumulatedIterations = 0;
  let lastPayoffs = entries.map(() => 0);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const strategyWeightsByKey = new Map(entries.map((entry, index) => [entry.key, weights[index]]));
    const scenarioWeights = adaptiveMetagameV12ScenarioWeights(
      teamScenarios,
      strategyWeightsByKey,
      { uniformScenarioFloor },
    );
    const payoffs = entries.map((entry) => weightedMean(entry.result.scenarioValues, scenarioWeights));
    const populationPayoff = weightedMean(payoffs, weights);
    const proposed = weights.map((weight, index) => (
      Math.max(1e-15, weight) * Math.exp(
        Math.max(-30, Math.min(30, learningRate * (payoffs[index] - populationPayoff))),
      )
    ));
    const normalizedProposal = normalizedWeights(proposed);
    const uniform = 1 / entries.length;
    weights = normalizedWeights(normalizedProposal.map((weight) => (
      (1 - exploration) * weight + exploration * uniform
    )));
    lastPayoffs = payoffs;

    if (iteration >= burnIn) {
      weights.forEach((weight, index) => {
        accumulated[index] += weight;
      });
      accumulatedIterations += 1;
    }
  }

  const averagedWeights = accumulatedIterations
    ? normalizedWeights(accumulated.map((value) => value / accumulatedIterations))
    : normalizedWeights(weights);
  const strategyWeightsByKey = new Map(entries.map((entry, index) => [entry.key, averagedWeights[index]]));
  const scenarioWeights = adaptiveMetagameV12ScenarioWeights(
    teamScenarios,
    strategyWeightsByKey,
    { uniformScenarioFloor },
  );
  const finalPayoffs = entries.map((entry) => weightedMean(entry.result.scenarioValues, scenarioWeights));
  const populationPayoff = weightedMean(finalPayoffs, averagedWeights);
  const maxPayoff = Math.max(...finalPayoffs);
  const maxWeightChange = Math.max(...averagedWeights.map((weight, index) => Math.abs(weight - weights[index])));

  return {
    version: 1,
    method: "time-averaged-multiplicative-weights-on-measured-5v5-scenarios",
    iterations,
    burnIn,
    learningRate,
    exploration,
    uniformScenarioFloor,
    environmentDeckCount: entries.length,
    scenarioCount: teamScenarios.length,
    effectiveScenarioCount: rounded(effectiveSampleSize(scenarioWeights), 4),
    populationExpectedWinRate: rounded(populationPayoff),
    bestResponseGap: rounded(maxPayoff - populationPayoff),
    maxAveragedVsLastWeightDelta: rounded(maxWeightChange),
    scenarioWeights: scenarioWeights.map((weight) => rounded(weight, 10)),
    strategies: entries.map((entry, index) => ({
      key: entry.key,
      ids: entry.deck.map((character) => String(character.id)),
      names: entry.deck.map((character) => character.name),
      weight: rounded(averagedWeights[index], 10),
      expectedWinRate: rounded(finalPayoffs[index]),
      lastIterationExpectedWinRate: rounded(lastPayoffs[index]),
    })).sort((left, right) => (
      right.weight - left.weight ||
      right.expectedWinRate - left.expectedWinRate ||
      left.key.localeCompare(right.key)
    )),
  };
}

function adaptiveResult(result, scenarioWeights) {
  const values = result?.scenarioValues ?? [];
  if (!values.length || values.length !== scenarioWeights.length) {
    return {
      expectedWinRate: Number(result?.expectedWinRate) || 0,
      expectedWinLowerBound: Number(result?.expectedWinLowerBound) || 0,
      decisiveWinRate: Number(result?.decisiveWinRate) || 0,
      standardError: 0,
      effectiveScenarioCount: 0,
    };
  }
  const mean = weightedMean(values, scenarioWeights);
  const variance = weightedVariance(values, scenarioWeights, mean);
  const effectiveCount = effectiveSampleSize(scenarioWeights);
  const standardError = effectiveCount > 1 ? Math.sqrt(Math.max(0, variance) / effectiveCount) : 0;
  return {
    expectedWinRate: mean,
    expectedWinLowerBound: clampUnit(mean - 1.96 * standardError),
    decisiveWinRate: Number(result?.decisiveWinRate) || 0,
    standardError,
    effectiveScenarioCount: effectiveCount,
  };
}

function compareAdaptiveDecks(left, right) {
  return (
    right.adaptive.expectedWinRate - left.adaptive.expectedWinRate ||
    right.adaptive.expectedWinLowerBound - left.adaptive.expectedWinLowerBound ||
    (Number(right.result?.expectedWinRate) || 0) - (Number(left.result?.expectedWinRate) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
  );
}

function sameOtherSlots(left = [], right = [], positionIndex) {
  return left.length === 5 && right.length === 5 && left.every((id, index) => (
    index === positionIndex || String(id) === String(right[index])
  ));
}

function summarizeAdaptiveDeck(entry, totalCost, previous) {
  return {
    origin: previous?.ids?.join("|") === entry.ids.join("|")
      ? previous.origin
      : "adaptive-shared-evaluated",
    totalCost: entry.totalCost,
    remainingCost: Math.max(0, totalCost - entry.totalCost),
    ids: [...entry.ids],
    names: [...entry.names],
    proxyScore: previous?.ids?.join("|") === entry.ids.join("|") ? previous.proxyScore : null,
    synergyScore: previous?.ids?.join("|") === entry.ids.join("|") ? previous.synergyScore : null,
    expectedWinRate: rounded(entry.adaptive.expectedWinRate),
    expectedWinLowerBound: rounded(entry.adaptive.expectedWinLowerBound),
    decisiveWinRate: rounded(entry.result?.decisiveWinRate ?? 0),
    scenarioCount: entry.result?.scenarioValues?.length ?? 0,
  };
}

function signedOpportunityScore(value) {
  return clampUnit(0.5 + 0.5 * Math.tanh((Number(value) || 0) / 0.15));
}

export function reconcileAdaptiveMetagameV12Rating(
  rating,
  position,
  sharedPool,
  equilibrium,
  options = {},
) {
  if (!rating || !Number.isInteger(position) || position < 1 || position > 5) return rating;
  const scenarioWeights = equilibrium?.scenarioWeights ?? [];
  if (!scenarioWeights.length) return rating;
  const candidateId = String(rating.id);
  const totalCost = Math.max(0, Number(options.totalCost) || 0);
  const adaptivePool = (sharedPool ?? []).map((entry) => ({
    ...entry,
    adaptive: adaptiveResult(entry.result, scenarioWeights),
  }));
  const includeEvaluated = adaptivePool
    .filter((entry) => String(entry.ids?.[position - 1]) === candidateId)
    .sort(compareAdaptiveDecks);
  const alternativeEvaluated = adaptivePool
    .filter((entry) => !(entry.ids ?? []).some((id) => String(id) === candidateId))
    .sort(compareAdaptiveDecks);
  if (!includeEvaluated.length || !alternativeEvaluated.length) {
    return {
      ...rating,
      adaptiveMetagameApplied: false,
    };
  }

  const best = includeEvaluated[0];
  const baseline = alternativeEvaluated[0];
  const deltas = (best.result.scenarioValues ?? []).map((value, index) => (
    Number(value) - Number(baseline.result.scenarioValues?.[index])
  ));
  const opportunityWinGain = weightedMean(deltas, scenarioWeights);
  const opportunityVariance = weightedVariance(deltas, scenarioWeights, opportunityWinGain);
  const effectiveCount = effectiveSampleSize(scenarioWeights);
  const opportunityStandardError = effectiveCount > 1
    ? Math.sqrt(Math.max(0, opportunityVariance) / effectiveCount)
    : 0;
  const robustOpportunityWinGain = opportunityWinGain - 1.28 * opportunityStandardError;

  const positionIndex = position - 1;
  const matchedAlternatives = alternativeEvaluated
    .filter((entry) => sameOtherSlots(best.ids, entry.ids, positionIndex))
    .sort(compareAdaptiveDecks);
  const matched = matchedAlternatives[0] ?? null;
  const matchedDeltas = matched
    ? (best.result.scenarioValues ?? []).map((value, index) => (
      Number(value) - Number(matched.result.scenarioValues?.[index])
    ))
    : [];
  const counterfactualWinGain = matched ? weightedMean(matchedDeltas, scenarioWeights) : null;
  const counterfactualVariance = matched
    ? weightedVariance(matchedDeltas, scenarioWeights, counterfactualWinGain)
    : null;
  const counterfactualStandardError = matched && effectiveCount > 1
    ? Math.sqrt(Math.max(0, counterfactualVariance) / effectiveCount)
    : 0;
  const counterfactualRobustWinGain = matched
    ? counterfactualWinGain - 1.28 * counterfactualStandardError
    : null;

  const score = signedOpportunityScore(robustOpportunityWinGain);
  const previousBest = rating.bestDeck ?? {};
  const previousBaseline = rating.baselineDeck ?? {};
  const uniformFields = {
    uniformOpportunityWinGain: rating.opportunityWinGain,
    uniformRobustOpportunityWinGain: rating.robustOpportunityWinGain,
    uniformCandidateExpectedWinRate: rating.candidateExpectedWinRate,
    uniformBenchmarkExpectedWinRate: rating.benchmarkExpectedWinRate,
    uniformCounterfactualWinGain: rating.counterfactualWinGain,
    uniformCounterfactualRobustWinGain: rating.counterfactualRobustWinGain,
  };

  return {
    ...rating,
    ...uniformFields,
    adaptiveMetagameApplied: true,
    adaptiveMetagameVersion: equilibrium.version,
    adaptiveMetagameEffectiveScenarioCount: rounded(effectiveCount, 4),
    opportunityWinGain: rounded(opportunityWinGain),
    robustOpportunityWinGain: rounded(robustOpportunityWinGain),
    marginalWinGain: rounded(opportunityWinGain),
    marginalWinGainLowerBound: rounded(robustOpportunityWinGain),
    candidateExpectedWinRate: rounded(best.adaptive.expectedWinRate),
    benchmarkExpectedWinRate: rounded(baseline.adaptive.expectedWinRate),
    expectedWinRate: rounded(best.adaptive.expectedWinRate),
    expectedWinLowerBound: rounded(best.adaptive.expectedWinLowerBound),
    counterfactualApplied: Boolean(matched),
    counterfactualWinGain: matched ? rounded(counterfactualWinGain) : null,
    counterfactualRobustWinGain: matched ? rounded(counterfactualRobustWinGain) : null,
    counterfactualBenchmarkExpectedWinRate: matched ? rounded(matched.adaptive.expectedWinRate) : null,
    counterfactualReplacementDeckCount: matchedAlternatives.length,
    counterfactualReplacementDeck: matched
      ? summarizeAdaptiveDeck(matched, totalCost, rating.counterfactualReplacementDeck)
      : null,
    costAwareScore: rounded(score),
    practicalValue: rounded(score),
    individualScore: rounded(score),
    roleBreakdown: {
      ...(rating.roleBreakdown ?? {}),
      adaptiveMetagameOpportunityScore: rounded(score),
      adaptiveMetagameScenarioStandardError: rounded(opportunityStandardError),
      adaptiveMetagameEffectiveScenarioCount: rounded(effectiveCount, 4),
      adaptiveCounterfactualStandardError: matched ? rounded(counterfactualStandardError) : null,
    },
    bestDeck: summarizeAdaptiveDeck(best, totalCost, previousBest),
    baselineDeck: summarizeAdaptiveDeck(baseline, totalCost, previousBaseline),
    v7Score: rounded(score),
  };
}

export function reconcileAdaptiveMetagameV12RatingsByPosition(
  resultsByPosition,
  sharedPool,
  equilibrium,
  options = {},
) {
  return (resultsByPosition ?? []).map((ratings, index) => {
    const values = ratings instanceof Map ? [...ratings.values()] : [...(ratings ?? [])];
    return values.map((rating) => reconcileAdaptiveMetagameV12Rating(
      rating,
      index + 1,
      sharedPool,
      equilibrium,
      options,
    ));
  });
}
