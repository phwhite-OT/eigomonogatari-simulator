function positiveWorkerLimit(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 20;
}

function splitEvenly(items, count) {
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((items.length * index) / count);
    const end = Math.floor((items.length * (index + 1)) / count);
    return items.slice(start, end);
  }).filter((items) => items.length);
}

/**
 * Splits only the missing character ratings into independent candidate shards.
 * Each shard still writes a normal checkpoint, so the existing checkpoint
 * merger can union its results without assigning overlapping work.
 */
export function buildMetagameCandidateShardPlan(
  candidateIdsByPosition,
  resultsByPosition = [],
  { maxWorkers = 20 } = {},
) {
  const positions = candidateIdsByPosition.map((candidateIds, index) => {
    const completedIds = new Set((resultsByPosition[index] ?? []).map((rating) => String(rating.id)));
    const missingIndices = candidateIds
      .map((id, candidateIndex) => ({ id: String(id), candidateIndex }))
      .filter(({ id }) => !completedIds.has(id))
      .map(({ candidateIndex }) => candidateIndex);
    return { position: index + 1, missingIndices };
  }).filter(({ missingIndices }) => missingIndices.length);

  const totalMissing = positions.reduce((sum, { missingIndices }) => sum + missingIndices.length, 0);
  if (!totalMissing) return [];

  const workerCount = Math.min(positiveWorkerLimit(maxWorkers), totalMissing);
  const scheduledPositions = [...positions]
    .sort((left, right) => right.missingIndices.length - left.missingIndices.length || left.position - right.position)
    .slice(0, workerCount);
  const allocations = new Map();
  for (const entry of scheduledPositions) allocations.set(entry.position, 1);

  let assignedWorkers = scheduledPositions.length;
  while (assignedWorkers < workerCount) {
    const selected = scheduledPositions.reduce((best, entry) => {
      const currentScore = entry.missingIndices.length / (allocations.get(entry.position) + 1);
      const bestScore = best.missingIndices.length / (allocations.get(best.position) + 1);
      return currentScore > bestScore ? entry : best;
    });
    allocations.set(selected.position, allocations.get(selected.position) + 1);
    assignedWorkers += 1;
  }

  return scheduledPositions.flatMap(({ position, missingIndices }) => (
    splitEvenly(missingIndices, allocations.get(position)).map((candidateIndices, index) => ({
      position,
      shard: `${position}-${index + 1}`,
      candidateIndices,
    }))
  ));
}
