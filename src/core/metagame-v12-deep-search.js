export const METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION = 3;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function ratingSignal(rating, fallback = 0.5) {
  if (!rating) return fallback;
  for (const key of ["individualScore", "costAwareScore", "practicalValue", "expectedWinRate"]) {
    const value = finiteNumber(rating[key]);
    if (value !== null) return value;
  }
  return fallback;
}

function candidateRole(candidate, proxyRatingsById, finalRatingsById) {
  const id = String(candidate?.id ?? "");
  return finalRatingsById?.get?.(id)?.role
    ?? proxyRatingsById?.get?.(id)?.role
    ?? "neutral";
}

export function buildMetagameV12MeasuredSlotStrength(sharedDeckPool) {
  const strengths = [0, 1, 2, 3, 4].map(() => new Map());
  for (const entry of sharedDeckPool ?? []) {
    if (!Array.isArray(entry?.ids) || entry.ids.length !== 5) continue;
    const winRate = finiteNumber(entry.result?.expectedWinRate, 0);
    const lowerBound = finiteNumber(entry.result?.expectedWinLowerBound, winRate);
    const measuredScore = winRate * 0.7 + lowerBound * 0.3;
    entry.ids.forEach((id, index) => {
      const key = String(id);
      const current = strengths[index].get(key);
      if (current === undefined || measuredScore > current) strengths[index].set(key, measuredScore);
    });
  }
  return strengths;
}

/**
 * Bound expensive one-slot deep-search battles without reverting to raw-stat
 * pruning. Half of the allowance follows measured/final ranking evidence; the
 * remainder deliberately preserves tactical-role and cost-band diversity.
 */
export function selectMetagameV12DeepReplacementCandidates(candidates, options = {}) {
  const limit = Math.max(1, Math.floor(Number(options.limit) || 20));
  const finalRatingsById = options.finalRatingsById;
  const proxyRatingsById = options.proxyRatingsById;
  const measuredStrengthById = options.measuredStrengthById;
  const unique = new Map();
  for (const candidate of candidates ?? []) {
    const id = String(candidate?.id ?? "");
    if (id && !unique.has(id)) unique.set(id, candidate);
  }

  const scored = [...unique.values()].map((candidate) => {
    const id = String(candidate.id);
    const finalScore = ratingSignal(finalRatingsById?.get?.(id));
    const proxyScore = ratingSignal(proxyRatingsById?.get?.(id));
    const measuredScore = finiteNumber(measuredStrengthById?.get?.(id));
    const evidenceScore = measuredScore === null
      ? finalScore * 0.75 + proxyScore * 0.25
      : measuredScore * 0.55 + finalScore * 0.35 + proxyScore * 0.10;
    return {
      candidate,
      id,
      role: candidateRole(candidate, proxyRatingsById, finalRatingsById),
      evidenceScore,
      cost: Math.max(0, Number(candidate.cost) || 0),
    };
  }).sort((left, right) => (
    right.evidenceScore - left.evidenceScore ||
    left.id.localeCompare(right.id)
  ));

  if (scored.length <= limit) return scored.map((entry) => entry.candidate);

  const selected = new Map();
  const add = (entry) => {
    if (entry && selected.size < limit) selected.set(entry.id, entry);
  };

  const strongestCount = Math.max(1, Math.ceil(limit * 0.55));
  scored.slice(0, strongestCount).forEach(add);

  const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"];
  for (const role of roles) {
    if (selected.size >= limit) break;
    add(scored.find((entry) => entry.role === role && !selected.has(entry.id)));
  }

  const byCost = [...scored].sort((left, right) => (
    left.cost - right.cost ||
    right.evidenceScore - left.evidenceScore ||
    left.id.localeCompare(right.id)
  ));
  while (selected.size < limit) {
    const remaining = byCost.filter((entry) => !selected.has(entry.id));
    if (!remaining.length) break;
    const slotsLeft = limit - selected.size;
    const take = Math.min(slotsLeft, remaining.length);
    for (let pick = 0; pick < take; pick += 1) {
      const index = Math.min(
        remaining.length - 1,
        Math.floor((pick + 0.5) * remaining.length / take),
      );
      add(remaining[index]);
    }
  }

  scored.forEach(add);
  return [...selected.values()].map((entry) => entry.candidate);
}

export function assessMetagameV12DeepFrontierConvergence(
  previousKeys,
  currentKeys,
  previousBestWinRate,
  currentBestWinRate,
  options = {},
) {
  const overlapThreshold = Math.min(1, Math.max(0, Number(options.overlapThreshold) || 0.875));
  const improvementThreshold = Math.max(0, Number(options.improvementThreshold) || 0.0025);
  const previous = new Set((previousKeys ?? []).map(String));
  const current = [...new Set((currentKeys ?? []).map(String))];
  const overlapCount = current.filter((key) => previous.has(key)).length;
  const overlapRatio = current.length ? overlapCount / current.length : 0;
  const previousBest = finiteNumber(previousBestWinRate);
  const currentBest = finiteNumber(currentBestWinRate);
  const improvement = previousBest === null || currentBest === null
    ? Number.POSITIVE_INFINITY
    : currentBest - previousBest;
  return {
    overlapCount,
    overlapRatio,
    improvement,
    converged: current.length > 0
      && previousBest !== null
      && currentBest !== null
      && overlapRatio >= overlapThreshold
      && improvement <= improvementThreshold,
  };
}
