export const METAGAME_V12_MAX_MATCHED_SLOT_WEIGHT = 0.4;

function finiteOrNegativeInfinity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -Infinity;
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export function inferMetagameV12BudgetShare(rating, totalCost = null) {
  const explicit = Number(rating?.roleBreakdown?.budgetShare);
  if (Number.isFinite(explicit)) return clampUnit(explicit);

  const resolvedTotalCost = Number(totalCost);
  if (Number.isFinite(resolvedTotalCost) && resolvedTotalCost > 0) {
    return clampUnit((Number(rating?.cost) || 0) / resolvedTotalCost);
  }

  const usedCost = Number(rating?.bestDeck?.totalCost);
  const remainingCost = Number(rating?.bestDeck?.remainingCost);
  const inferredTotal = (Number.isFinite(usedCost) ? usedCost : 0)
    + (Number.isFinite(remainingCost) ? remainingCost : 0);
  if (inferredTotal > 0) return clampUnit((Number(rating?.cost) || 0) / inferredTotal);

  // If the budget is unknown, do not let matched-slot evidence accidentally
  // bypass opportunity cost. Falling back to 100% budget share disables the
  // matched-slot blend while preserving the full-budget result.
  return 1;
}

export function metagameV12ContributionEvidence(rating, options = {}) {
  const robust = finiteOrNegativeInfinity(rating?.robustOpportunityWinGain);
  const mean = finiteOrNegativeInfinity(rating?.opportunityWinGain);
  const slotRobust = finiteOrNegativeInfinity(rating?.counterfactualRobustWinGain);
  const slotMean = finiteOrNegativeInfinity(rating?.counterfactualWinGain);
  const matched = rating?.counterfactualApplied === true
    && Number.isFinite(slotRobust)
    && Number.isFinite(slotMean);
  const budgetShare = inferMetagameV12BudgetShare(rating, options.totalCost);
  const matchedSlotWeight = matched
    ? METAGAME_V12_MAX_MATCHED_SLOT_WEIGHT * (1 - budgetShare)
    : 0;
  const hybridRobust = Number.isFinite(robust)
    ? robust + matchedSlotWeight * (slotRobust - robust)
    : robust;
  const hybridMean = Number.isFinite(mean)
    ? mean + matchedSlotWeight * (slotMean - mean)
    : mean;

  return {
    matched,
    budgetShare,
    matchedSlotWeight,
    robust,
    mean,
    slotRobust,
    slotMean,
    hybridRobust,
    hybridMean,
    positive: Number.isFinite(hybridRobust) && hybridRobust > 0 ? 1 : 0,
  };
}
