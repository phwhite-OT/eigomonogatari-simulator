export const METAGAME_V12_FINALIZATION_STATE_VERSION = 2;

function sameIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => String(value) === String(right[index]));
}

export function selectMetagameV12CounterfactualAnchors(rating, position, pool, limit = 5) {
  const positionIndex = position - 1;
  const candidateId = String(rating?.id ?? "");
  // V12 originally froze only three shells per character. That was enough for
  // a cheap audit, but it let a character look settled while strong partner
  // configurations just outside those three shells were never challenged.
  // Keep at least five genuinely different strong shells before falling back
  // to the next-best available shells.
  const boundedLimit = Math.max(5, Math.floor(Number(limit) || 5));
  const available = (pool ?? []).filter((entry) => (
    Array.isArray(entry?.ids)
    && entry.ids.length === 5
    && String(entry.ids[positionIndex]) === candidateId
  ));
  const selected = [];
  for (const entry of available) {
    if (!selected.length) {
      selected.push(entry);
    } else {
      const minOtherSlotDifference = Math.min(...selected.map((chosen) => (
        entry.ids.reduce((count, id, index) => (
          index === positionIndex || String(id) === String(chosen.ids[index]) ? count : count + 1
        ), 0)
      )));
      if (minOtherSlotDifference >= 2) selected.push(entry);
    }
    if (selected.length >= boundedLimit) break;
  }
  for (const entry of available) {
    if (selected.length >= boundedLimit) break;
    if (!selected.some((chosen) => sameIds(chosen.ids, entry.ids))) selected.push(entry);
  }
  return selected;
}

export function metagameV12FinalizationPolicy(options = {}) {
  return {
    // Five is now the minimum audit depth. Callers may request more, but an
    // older --counterfactual-anchor-limit=3 can no longer silently narrow the
    // search back to the previous shallow policy.
    counterfactualAnchorLimit: Math.max(5, Math.floor(Number(options.counterfactualAnchorLimit) || 5)),
    replacementDeckLimit: Math.max(1, Math.floor(Number(options.replacementDeckLimit) || 24)),
    replacementBeamWidth: Math.max(1, Math.floor(Number(options.replacementBeamWidth) || 4000)),
  };
}

export function createMetagameV12FinalizationState(resultsByPosition, sharedDeckPool, options = {}) {
  const policy = metagameV12FinalizationPolicy(options);
  const plan = [];
  const planned = new Set();
  const addPlanEntry = (position, ratingId, anchorIds) => {
    if (!Array.isArray(anchorIds) || anchorIds.length !== 5) return;
    const normalizedIds = anchorIds.map(String);
    const key = `${position}:${String(ratingId)}:${normalizedIds.join("|")}`;
    if (planned.has(key)) return;
    planned.add(key);
    plan.push({
      position,
      ratingId: String(ratingId),
      anchorIds: normalizedIds,
    });
  };

  for (const [index, ratings] of (resultsByPosition ?? []).entries()) {
    const position = index + 1;
    const ratingValues = ratings instanceof Map ? ratings.values() : ratings ?? [];
    for (const rating of ratingValues) {
      const anchors = selectMetagameV12CounterfactualAnchors(
        rating,
        position,
        sharedDeckPool,
        policy.counterfactualAnchorLimit,
      );
      const fallbackAnchor = rating?.bestDeck?.ids?.length === 5
        ? [{ ids: rating.bestDeck.ids }]
        : [];
      for (const anchor of (anchors.length ? anchors : fallbackAnchor)) {
        addPlanEntry(position, rating.id, anchor.ids);
      }
    }
  }
  return {
    version: METAGAME_V12_FINALIZATION_STATE_VERSION,
    phase: "counterfactual",
    createdAt: new Date().toISOString(),
    policy,
    plan,
    cursor: { planIndex: 0, replacementIndex: 0 },
    processedCandidateDeckCount: 0,
    newEvaluationCount: 0,
    segmentCount: 0,
    lastProgressAt: null,
  };
}

export function isMetagameV12FinalizationStateCompatible(state, options = {}) {
  if (!state || state.version !== METAGAME_V12_FINALIZATION_STATE_VERSION) return false;
  if (state.phase !== "counterfactual" && state.phase !== "complete") return false;
  if (!Array.isArray(state.plan) || !state.cursor) return false;
  const expectedPolicy = metagameV12FinalizationPolicy(options);
  return JSON.stringify(state.policy) === JSON.stringify(expectedPolicy);
}

export function metagameV12FinalizationCursorSignature(state) {
  return `${state?.cursor?.planIndex ?? -1}:${state?.cursor?.replacementIndex ?? -1}`;
}
