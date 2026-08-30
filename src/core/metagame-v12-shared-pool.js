export const METAGAME_V12_SHARED_POOL_VERSION = 1;

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

function signedOpportunityScore(value) {
  return clampUnit(0.5 + 0.5 * Math.tanh((Number(value) || 0) / 0.15));
}

function compareEvaluatedDecks(left, right) {
  return (
    (Number(right.result.expectedWinRate) || 0) - (Number(left.result.expectedWinRate) || 0) ||
    (Number(right.result.expectedWinLowerBound) || 0) - (Number(left.result.expectedWinLowerBound) || 0) ||
    (Number(right.result.decisiveWinRate) || 0) - (Number(left.result.decisiveWinRate) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
  );
}

function sameIds(left = [], right = []) {
  return left.length === right.length && left.every((id, index) => String(id) === String(right[index]));
}

function summarizePoolDeck(entry, totalCost, previous) {
  const reusePrevious = previous && sameIds(previous.ids, entry.ids);
  return {
    origin: reusePrevious ? previous.origin : "shared-evaluated",
    totalCost: entry.totalCost,
    remainingCost: Math.max(0, totalCost - entry.totalCost),
    ids: [...entry.ids],
    names: [...entry.names],
    proxyScore: reusePrevious ? previous.proxyScore : null,
    synergyScore: reusePrevious ? previous.synergyScore : null,
    expectedWinRate: rounded(entry.result.expectedWinRate),
    expectedWinLowerBound: rounded(entry.result.expectedWinLowerBound),
    decisiveWinRate: rounded(entry.result.decisiveWinRate),
    scenarioCount: Number(entry.result.scenarioCount) || entry.result.scenarioValues?.length || 0,
  };
}

/**
 * Store only battle results already present in V12's evaluation cache.
 * Replaying this pool never runs a battle; it only lets another character
 * reuse a completed five-card deck that happened to be discovered elsewhere.
 */
export function serializeMetagameV12EvaluationCache(cache) {
  return [...(cache?.entries?.() ?? [])]
    .filter(([key, result]) => typeof key === "string" && Array.isArray(result?.scenarioValues))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, result]) => ({ key, result }));
}

/** Merge compatible shard/checkpoint results into the live evaluation cache. */
export function hydrateMetagameV12EvaluationCache(cache, entries) {
  if (!cache?.set) return cache;
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.result?.scenarioValues)) continue;
    if (!cache.has(entry.key)) cache.set(entry.key, entry.result);
  }
  return cache;
}

/**
 * Convert cache keys (`turns:id1|...|id5`) back to legal deck metadata.
 * Unknown/legacy ids are ignored instead of poisoning the global pool.
 */
export function buildMetagameV12SharedDeckPool(cache, characters, turns) {
  const prefix = `${Math.min(12, Math.max(1, Number(turns) || 12))}:`;
  const charactersById = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const pool = [];
  for (const [key, result] of cache?.entries?.() ?? []) {
    if (typeof key !== "string" || !key.startsWith(prefix) || !Array.isArray(result?.scenarioValues)) continue;
    const ids = key.slice(prefix.length).split("|");
    if (ids.length !== 5) continue;
    const deck = ids.map((id) => charactersById.get(String(id)));
    if (deck.some((character) => !character)) continue;
    pool.push({
      key,
      ids,
      names: deck.map((character) => character.name),
      totalCost: deck.reduce((sum, character) => sum + (Number(character.cost) || 0), 0),
      result,
    });
  }
  return pool.sort(compareEvaluatedDecks);
}

/**
 * Second-pass V12 aggregation.
 *
 * Candidate side: every already-evaluated deck with this character in this
 * exact slot is eligible, even if that deck was originally found while rating
 * another character.
 *
 * Baseline side: every already-evaluated deck that does not contain the
 * candidate anywhere is eligible, matching V12's opportunity-cost definition.
 *
 * Crucially, this function performs zero simulations. Exact 72-scenario values
 * are reused, so the paired robustness correction remains mathematically the
 * same as the normal V12 calculation instead of being approximated.
 */
export function reconcileMetagameV12RatingFromSharedPool(rating, position, sharedPool, options = {}) {
  if (!rating || !Number.isInteger(position) || position < 1 || position > 5) return rating;
  const candidateId = String(rating.id);
  const totalCost = Math.max(0, Number(options.totalCost) || 0);
  const includeEvaluated = (sharedPool ?? [])
    .filter((entry) => String(entry.ids?.[position - 1]) === candidateId)
    .sort(compareEvaluatedDecks);
  const alternativeEvaluated = (sharedPool ?? [])
    .filter((entry) => !(entry.ids ?? []).some((id) => String(id) === candidateId))
    .sort(compareEvaluatedDecks);

  if (!includeEvaluated.length || !alternativeEvaluated.length) {
    return {
      ...rating,
      sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
      sharedPoolApplied: false,
      sharedPoolCandidateDeckCount: includeEvaluated.length,
      sharedPoolAlternativeDeckCount: alternativeEvaluated.length,
    };
  }

  const best = includeEvaluated[0];
  const baseline = alternativeEvaluated[0];
  const pairedDeltas = (best.result.scenarioValues ?? []).map((value, index) => (
    Number(value) - Number(baseline.result.scenarioValues?.[index])
  )).filter(Number.isFinite);
  const opportunityWinGain = pairedDeltas.length
    ? average(pairedDeltas)
    : (Number(best.result.expectedWinRate) || 0) - (Number(baseline.result.expectedWinRate) || 0);
  const pairedStdDev = standardDeviation(pairedDeltas);
  const pairedStandardError = pairedDeltas.length > 1 ? pairedStdDev / Math.sqrt(pairedDeltas.length) : 0;
  const robustOpportunityWinGain = opportunityWinGain - 1.28 * pairedStandardError;
  const decisiveWinGain = (Number(best.result.decisiveWinRate) || 0) - (Number(baseline.result.decisiveWinRate) || 0);
  const score = signedOpportunityScore(robustOpportunityWinGain);
  const includeValues = includeEvaluated.map((entry) => Number(entry.result.expectedWinRate) || 0);
  const previousBest = rating.bestDeck ?? {};
  const previousBaseline = rating.baselineDeck ?? {};

  return {
    ...rating,
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
    roleBreakdown: {
      ...(rating.roleBreakdown ?? {}),
      opportunityCostScore: rounded(score),
      includeDeckStdDev: rounded(standardDeviation(includeValues)),
      pairedScenarioStdDev: rounded(pairedStdDev),
      pairedScenarioStandardError: rounded(pairedStandardError),
      pairedScenarioCount: pairedDeltas.length,
    },
    // Keep direct-evaluation counters intact. These fields describe how much
    // zero-cost evidence was additionally considered in the second pass.
    sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
    sharedPoolApplied: true,
    sharedPoolCandidateDeckCount: includeEvaluated.length,
    sharedPoolAlternativeDeckCount: alternativeEvaluated.length,
    sharedPoolImprovedCandidate: !sameIds(previousBest.ids ?? [], best.ids),
    sharedPoolImprovedBaseline: !sameIds(previousBaseline.ids ?? [], baseline.ids),
    sharedPoolCandidateWinDelta: rounded((Number(best.result.expectedWinRate) || 0) - (Number(previousBest.expectedWinRate) || 0)),
    sharedPoolBaselineWinDelta: rounded((Number(baseline.result.expectedWinRate) || 0) - (Number(previousBaseline.expectedWinRate) || 0)),
    bestDeck: summarizePoolDeck(best, totalCost, previousBest),
    baselineDeck: summarizePoolDeck(baseline, totalCost, previousBaseline),
    v7Score: rounded(score),
  };
}

export function reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedPool, options = {}) {
  return (resultsByPosition ?? []).map((ratings, index) => {
    const entries = ratings instanceof Map ? [...ratings.values()] : [...(ratings ?? [])];
    return entries.map((rating) => reconcileMetagameV12RatingFromSharedPool(
      rating,
      index + 1,
      sharedPool,
      options,
    ));
  });
}
