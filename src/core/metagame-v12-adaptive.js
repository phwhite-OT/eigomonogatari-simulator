function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function rounded(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
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

function arithmeticMean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + (Number(value) || 0), 0) / values.length
    : 0;
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

function deckDifference(left = [], right = []) {
  if (left.length !== right.length) return Number.MAX_SAFE_INTEGER;
  return left.reduce((count, id, index) => count + (String(id) === String(right[index]) ? 0 : 1), 0);
}

function strategyFromEntry(entry, teamScenarioCount) {
  const ids = Array.isArray(entry?.ids)
    ? entry.ids.map(String)
    : Array.isArray(entry)
      ? entry.map((character) => String(character?.id ?? ""))
      : [];
  const names = Array.isArray(entry?.names)
    ? [...entry.names]
    : Array.isArray(entry)
      ? entry.map((character) => character?.name ?? String(character?.id ?? ""))
      : [];
  const result = entry?.result ?? null;
  if (ids.length !== 5 || !Array.isArray(result?.scenarioValues)) return null;
  if (result.scenarioValues.length !== teamScenarioCount) return null;
  const orderedScenarioValues = [...result.scenarioValues]
    .map((value) => Number(value) || 0)
    .sort((left, right) => right - left);
  const counterTailCount = Math.max(1, Math.ceil(orderedScenarioValues.length * 0.10));
  const counterTailExpectedWinRate = arithmeticMean(orderedScenarioValues.slice(0, counterTailCount));
  const uniformExpectedWinRate = Number.isFinite(Number(result.expectedWinRate))
    ? Number(result.expectedWinRate)
    : arithmeticMean(result.scenarioValues);
  return {
    key: ids.join("|"),
    ids,
    names,
    totalCost: Number(entry?.totalCost) || 0,
    result,
    uniformExpectedWinRate,
    counterTailExpectedWinRate,
    counterUpside: counterTailExpectedWinRate - uniformExpectedWinRate,
  };
}

export function selectAdaptiveMetagameV12Strategies(sharedPool, teamScenarioCount, options = {}) {
  const limit = Math.max(8, Math.floor(Number(options.strategyLimit) || 384));
  const unique = new Map();
  for (const entry of sharedPool ?? []) {
    const strategy = strategyFromEntry(entry, teamScenarioCount);
    if (!strategy) continue;
    const previous = unique.get(strategy.key);
    if (!previous || strategy.uniformExpectedWinRate > previous.uniformExpectedWinRate) {
      unique.set(strategy.key, strategy);
    }
  }
  const ordered = [...unique.values()].sort((left, right) => (
    right.uniformExpectedWinRate - left.uniformExpectedWinRate ||
    left.totalCost - right.totalCost ||
    left.key.localeCompare(right.key)
  ));
  if (ordered.length <= limit) return ordered;

  // Keep three kinds of measured strategies:
  // 1) broad uniform performers,
  // 2) genuine specialists with very high upper-tail scenario results,
  // 3) structurally different strong decks.
  //
  // Without the specialist lane, a narrow but real counter can disappear
  // before the adaptive loop ever gets a chance to raise its adoption.
  const selected = ordered.slice(0, Math.ceil(limit * 0.50));
  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const specialistTarget = Math.min(limit, selected.length + Math.max(1, Math.floor(limit * 0.25)));
  const specialists = [...ordered].sort((left, right) => (
    right.counterTailExpectedWinRate - left.counterTailExpectedWinRate ||
    right.counterUpside - left.counterUpside ||
    right.uniformExpectedWinRate - left.uniformExpectedWinRate ||
    left.key.localeCompare(right.key)
  ));
  for (const entry of specialists) {
    if (selected.length >= specialistTarget) break;
    if (selectedKeys.has(entry.key)) continue;
    selected.push(entry);
    selectedKeys.add(entry.key);
  }

  const searchWindow = ordered.slice(0, Math.min(ordered.length, limit * 8));
  for (const entry of searchWindow) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(entry.key)) continue;
    const minimumDifference = Math.min(...selected.map((chosen) => deckDifference(entry.ids, chosen.ids)));
    if (minimumDifference >= 2) {
      selected.push(entry);
      selectedKeys.add(entry.key);
    }
  }
  for (const entry of ordered) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(entry.key)) continue;
    selected.push(entry);
    selectedKeys.add(entry.key);
  }
  return selected;
}

export function buildAdaptiveMetagameV12Equilibrium(sharedPool, teamScenarios, options = {}) {
  const scenarioCount = teamScenarios?.length ?? 0;
  if (!scenarioCount) throw new Error("Adaptive V12 metagame requires measured team scenarios.");
  const strategies = selectAdaptiveMetagameV12Strategies(sharedPool, scenarioCount, options);
  if (!strategies.length) throw new Error("Adaptive V12 metagame requires measured complete-deck strategies.");

  const iterations = Math.max(1, Math.floor(Number(options.iterations) || 64));
  const burnIn = Math.max(0, Math.min(iterations - 1, Math.floor(Number(options.burnIn) || 16)));
  const strategyLearningRate = Math.max(0.1, Number(options.strategyLearningRate) || 6);
  const counterLearningRate = Math.max(0.1, Number(options.counterLearningRate) || 5);
  const strategyExploration = Math.min(0.20, Math.max(0, Number(options.strategyExploration) || 0.03));
  const uniformScenarioFloor = Math.min(0.60, Math.max(0, Number(options.uniformScenarioFloor) || 0.25));

  let strategyWeights = strategies.map(() => 1 / strategies.length);
  let scenarioWeights = Array.from({ length: scenarioCount }, () => 1 / scenarioCount);
  const accumulatedStrategyWeights = strategies.map(() => 0);
  const accumulatedScenarioWeights = scenarioWeights.map(() => 0);
  let accumulatedIterations = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const strategyPayoffs = strategies.map((strategy) => (
      weightedMean(strategy.result.scenarioValues, scenarioWeights)
    ));
    const populationPayoff = weightedMean(strategyPayoffs, strategyWeights);

    const strategyProposal = strategyWeights.map((weight, index) => (
      Math.max(1e-15, weight) * Math.exp(Math.max(
        -30,
        Math.min(30, strategyLearningRate * (strategyPayoffs[index] - populationPayoff)),
      ))
    ));
    const normalizedStrategyProposal = normalizedWeights(strategyProposal);
    const uniformStrategy = 1 / strategies.length;
    strategyWeights = normalizedWeights(normalizedStrategyProposal.map((weight) => (
      (1 - strategyExploration) * weight + strategyExploration * uniformStrategy
    )));

    // The opponent/environment side adapts in the other direction. A scenario
    // where the currently popular complete decks underperform represents
    // counter-pressure entering the field, so its share rises. Conversely a
    // narrow counter that becomes popular exposes its own weak scenarios and
    // those start rising next. This is measured entirely from battle outputs.
    const scenarioPopulationValues = Array.from({ length: scenarioCount }, (_, scenarioIndex) => (
      strategies.reduce((sum, strategy, strategyIndex) => (
        sum + strategyWeights[strategyIndex] * (Number(strategy.result.scenarioValues[scenarioIndex]) || 0)
      ), 0)
    ));
    const updatedPopulationPayoff = weightedMean(scenarioPopulationValues, scenarioWeights);
    const scenarioProposal = scenarioWeights.map((weight, index) => (
      Math.max(1e-15, weight) * Math.exp(Math.max(
        -30,
        Math.min(30, counterLearningRate * (updatedPopulationPayoff - scenarioPopulationValues[index])),
      ))
    ));
    const normalizedScenarioProposal = normalizedWeights(scenarioProposal);
    const uniformScenario = 1 / scenarioCount;
    scenarioWeights = normalizedWeights(normalizedScenarioProposal.map((weight) => (
      (1 - uniformScenarioFloor) * weight + uniformScenarioFloor * uniformScenario
    )));

    if (iteration >= burnIn) {
      strategyWeights.forEach((weight, index) => {
        accumulatedStrategyWeights[index] += weight;
      });
      scenarioWeights.forEach((weight, index) => {
        accumulatedScenarioWeights[index] += weight;
      });
      accumulatedIterations += 1;
    }
  }

  const averagedStrategyWeights = accumulatedIterations
    ? normalizedWeights(accumulatedStrategyWeights.map((value) => value / accumulatedIterations))
    : normalizedWeights(strategyWeights);
  const averagedScenarioWeights = accumulatedIterations
    ? normalizedWeights(accumulatedScenarioWeights.map((value) => value / accumulatedIterations))
    : normalizedWeights(scenarioWeights);
  const finalStrategyPayoffs = strategies.map((strategy) => (
    weightedMean(strategy.result.scenarioValues, averagedScenarioWeights)
  ));
  const finalScenarioPopulationValues = Array.from({ length: scenarioCount }, (_, scenarioIndex) => (
    strategies.reduce((sum, strategy, strategyIndex) => (
      sum + averagedStrategyWeights[strategyIndex] * (Number(strategy.result.scenarioValues[scenarioIndex]) || 0)
    ), 0)
  ));
  const populationPayoff = weightedMean(finalStrategyPayoffs, averagedStrategyWeights);
  const bestResponseGap = Math.max(...finalStrategyPayoffs) - populationPayoff;
  const counterPressureGap = populationPayoff - Math.min(...finalScenarioPopulationValues);
  const reportStrategyLimit = Math.max(8, Math.floor(Number(options.reportStrategyLimit) || 64));

  return {
    version: 2,
    method: "time-averaged-coevolution-of-measured-decks-and-counter-scenarios",
    iterations,
    burnIn,
    strategyLearningRate,
    counterLearningRate,
    strategyExploration,
    uniformScenarioFloor,
    strategyCount: strategies.length,
    scenarioCount,
    effectiveScenarioCount: rounded(effectiveSampleSize(averagedScenarioWeights), 4),
    populationExpectedWinRate: rounded(populationPayoff),
    bestResponseGap: rounded(bestResponseGap),
    counterPressureGap: rounded(counterPressureGap),
    scenarioWeights: averagedScenarioWeights.map((weight) => rounded(weight, 10)),
    strategies: strategies.map((strategy, index) => ({
      key: strategy.key,
      ids: strategy.ids,
      names: strategy.names,
      weight: rounded(averagedStrategyWeights[index], 10),
      expectedWinRate: rounded(finalStrategyPayoffs[index]),
      uniformExpectedWinRate: rounded(strategy.uniformExpectedWinRate),
      counterTailExpectedWinRate: rounded(strategy.counterTailExpectedWinRate),
      counterUpside: rounded(strategy.counterUpside),
    })).sort((left, right) => (
      right.weight - left.weight ||
      right.expectedWinRate - left.expectedWinRate ||
      left.key.localeCompare(right.key)
    )).slice(0, reportStrategyLimit),
  };
}

function adaptiveResult(result, scenarioWeights) {
  const values = result?.scenarioValues ?? [];
  if (!values.length || values.length !== scenarioWeights.length) {
    return {
      expectedWinRate: Number(result?.expectedWinRate) || 0,
      expectedWinLowerBound: Number(result?.expectedWinLowerBound) || 0,
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

function sameIds(left = [], right = []) {
  return left.length === right.length && left.every((id, index) => String(id) === String(right[index]));
}

function summarizeAdaptiveDeck(entry, totalCost, previous) {
  return {
    origin: sameIds(previous?.ids ?? [], entry.ids)
      ? previous.origin
      : "adaptive-shared-evaluated",
    totalCost: entry.totalCost,
    remainingCost: Math.max(0, totalCost - entry.totalCost),
    ids: [...entry.ids],
    names: [...entry.names],
    proxyScore: sameIds(previous?.ids ?? [], entry.ids) ? previous.proxyScore : null,
    synergyScore: sameIds(previous?.ids ?? [], entry.ids) ? previous.synergyScore : null,
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

  return {
    ...rating,
    uniformOpportunityWinGain: rating.opportunityWinGain,
    uniformRobustOpportunityWinGain: rating.robustOpportunityWinGain,
    uniformCandidateExpectedWinRate: rating.candidateExpectedWinRate,
    uniformBenchmarkExpectedWinRate: rating.benchmarkExpectedWinRate,
    uniformCounterfactualWinGain: rating.counterfactualWinGain,
    uniformCounterfactualRobustWinGain: rating.counterfactualRobustWinGain,
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
