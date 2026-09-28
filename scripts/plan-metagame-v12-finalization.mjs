import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import { buildMetagameV12CounterfactualReplacementDecks } from "../src/core/metagame-v12.js";
import { createMetagameV12FinalizationState } from "../src/core/metagame-v12-finalization.js";
import {
  buildMetagameV12SharedDeckPool,
  hydrateMetagameV12EvaluationCache,
} from "../src/core/metagame-v12-shared-pool.js";
import {
  METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION,
  buildMetagameV12MeasuredSlotStrength,
  selectMetagameV12DeepReplacementCandidates,
} from "../src/core/metagame-v12-deep-search.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback, minimum = 0) {
  const parsed = Math.floor(Number(readArgument(name, String(fallback))));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function isLegend(character) {
  const rarity = String(character?.rarity ?? "");
  return rarity === "伝" || rarity.toUpperCase() === "LEGEND";
}

function deckDifference(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Number.MAX_SAFE_INTEGER;
  return left.reduce((count, id, index) => count + (String(id) === String(right[index]) ? 0 : 1), 0);
}

function selectDeepSearchSeeds(pool, limit) {
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!boundedLimit) return [];
  const available = [...(pool ?? [])];
  if (available.length <= boundedLimit) return available;

  // Preserve broad recall in the frontier: keep the strongest half, then fill
  // the other half with structurally different measured decks before falling
  // back to the next strongest available entries.
  const strongestCount = Math.max(1, Math.ceil(boundedLimit / 2));
  const selected = available.slice(0, strongestCount);
  for (const entry of available.slice(strongestCount)) {
    if (selected.length >= boundedLimit) break;
    const minimumDifference = Math.min(...selected.map((chosen) => deckDifference(entry.ids, chosen.ids)));
    if (minimumDifference >= 2) selected.push(entry);
  }
  for (const entry of available) {
    if (selected.length >= boundedLimit) break;
    if (!selected.includes(entry)) selected.push(entry);
  }
  return selected;
}

function deckSeedKey(entry) {
  return entry.ids.map(String).join("|");
}

const inputId = readArgument("input", "fire:100");
const inputCheckpointPath = path.resolve(readArgument("input-checkpoint"));
const outputManifestPath = path.resolve(readArgument("output-manifest"));
const requestedShardCount = integerArgument("shard-count", 19, 1);
const parallelRunnerCount = integerArgument("parallel-runner-count", 19, 1);
const compactShardThreshold = integerArgument("compact-shard-threshold", 3800, parallelRunnerCount);
const configuredDeepSeedCount = integerArgument("deep-seed-count", 6, 0);
const configuredDeepFrontierCount = integerArgument("deep-frontier-count", 24, configuredDeepSeedCount);
const configuredDeepReplacementLimit = integerArgument("deep-replacement-limit", 20, 1);
const configuredMaxDeepEvaluations = integerArgument("max-deep-evaluations", 2500, 1);
// Hard wall-clock guard: never hand an accidentally huge wave to the fanout
// runners. The workflow uses more chunks than concurrent runners so GitHub can
// refill freed slots instead of waiting on one expensive tail shard. Any omitted
// work remains absent from the durable cache and is picked
// up deterministically by the next wave.
const maxWorkItems = integerArgument("max-work-items", 9500, requestedShardCount);
const currentAnchorLimit = integerArgument("counterfactual-anchor-limit", 3, 1);

if (!readArgument("input-checkpoint")) throw new Error("--input-checkpoint is required.");
if (!readArgument("output-manifest")) throw new Error("--output-manifest is required.");

const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`Input ${inputId} was not found.`);

const checkpoint = JSON.parse(await fs.readFile(inputCheckpointPath, "utf8"));
if (checkpoint?.context?.inputId !== inputId) {
  throw new Error(`Checkpoint input mismatch: expected ${inputId}, got ${checkpoint?.context?.inputId ?? "missing"}.`);
}
const checkpointFinalizationState = checkpoint?.finalizationState;
if (!checkpointFinalizationState || checkpointFinalizationState.phase !== "counterfactual" || !Array.isArray(checkpointFinalizationState.plan)) {
  throw new Error("Checkpoint does not contain an active frozen V12 counterfactual finalization plan.");
}

const context = checkpoint.context;
const turns = Math.min(12, Math.max(1, Number(context.turns) || 12));
const partnerLimit = Math.max(32, Number(context.partnerLimit) || 48);
const replacementDeckLimit = Math.max(1, Number(checkpointFinalizationState.policy?.replacementDeckLimit) || 24);
const replacementBeamWidth = Math.max(1, Number(checkpointFinalizationState.policy?.replacementBeamWidth) || 4000);
const checkpointDeepSearchRound = Math.max(1, Number(checkpointFinalizationState.deepSearchRound) || 1);
const visitedDeepSeedKeys = new Set(
  (checkpointFinalizationState.deepSearchVisitedSeedKeys ?? []).map(String),
);
const checkpointDeepSearchPolicyVersion = Number(checkpointFinalizationState.deepSearchPolicyVersion) || 0;
const legacyDeepSearch = checkpointDeepSearchPolicyVersion < METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION
  && (checkpointDeepSearchRound > 1 || visitedDeepSeedKeys.size > 0);
const deepSearchPolicyVersion = legacyDeepSearch ? 2 : METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION;
const deepSeedCount = legacyDeepSearch ? 12 : configuredDeepSeedCount;
const deepFrontierCount = legacyDeepSearch ? 48 : configuredDeepFrontierCount;
const deepReplacementLimit = legacyDeepSearch ? Number.POSITIVE_INFINITY : configuredDeepReplacementLimit;
const maxDeepEvaluations = legacyDeepSearch ? Number.POSITIVE_INFINITY : configuredMaxDeepEvaluations;
const previousDeepEvaluationCount = legacyDeepSearch
  ? 0
  : Math.max(0, Number(checkpointFinalizationState.deepSearchEvaluationCount) || 0);
const remainingDeepEvaluationBudget = legacyDeepSearch
  ? Number.POSITIVE_INFINITY
  : Math.max(0, maxDeepEvaluations - previousDeepEvaluationCount);

const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));
const baseEvaluationCache = new Map();
hydrateMetagameV12EvaluationCache(baseEvaluationCache, checkpoint?.evaluatedDeckPool);
const sharedDeckPool = buildMetagameV12SharedDeckPool(baseEvaluationCache, CHARACTER_CATALOG, turns);
const measuredStrengthByPosition = buildMetagameV12MeasuredSlotStrength(sharedDeckPool);

// Source changes can alter the finalization policy while a durable checkpoint
// still contains an older frozen plan. Do not spend a whole wave evaluating
// that obsolete plan. Rebuild the planning view immediately while retaining
// every exact battle already present in the durable evaluation cache.
let finalizationState = checkpointFinalizationState;
let normalizedStalePolicy = false;
if (Number(checkpointFinalizationState.policy?.counterfactualAnchorLimit) !== currentAnchorLimit) {
  finalizationState = createMetagameV12FinalizationState(resultsByPosition, sharedDeckPool, {
    counterfactualAnchorLimit: currentAnchorLimit,
    replacementDeckLimit,
    replacementBeamWidth,
  });
  finalizationState.deepSearchRound = checkpointDeepSearchRound;
  finalizationState.deepSearchVisitedSeedKeys = [...visitedDeepSeedKeys];
  finalizationState.deepSearchPolicyVersion = deepSearchPolicyVersion;
  finalizationState.deepSearchEvaluationCount = previousDeepEvaluationCount;
  normalizedStalePolicy = true;
  console.log(
    `V12 finalization planner normalized stale anchor policy `
    + `${checkpointFinalizationState.policy?.counterfactualAnchorLimit ?? "missing"} -> ${currentAnchorLimit}; `
    + `reusing ${baseEvaluationCache.size} cached exact deck evaluations.`,
  );
}

const startPlanIndex = normalizedStalePolicy ? 0 : Math.max(0, Number(finalizationState.cursor?.planIndex) || 0);
const startReplacementIndex = normalizedStalePolicy ? 0 : Math.max(0, Number(finalizationState.cursor?.replacementIndex) || 0);
const deepSearchRound = Math.max(1, Number(finalizationState.deepSearchRound) || checkpointDeepSearchRound);

const missingByKey = new Map();
let scannedAnchorCount = 0;
let replacementReferenceCount = 0;
let boundedWorkTruncated = false;

function tryAddMissingDeck(ids) {
  const normalizedIds = ids.map(String);
  const key = `${turns}:${normalizedIds.join("|")}`;
  if (baseEvaluationCache.has(key) || missingByKey.has(key)) return "existing";
  if (missingByKey.size >= maxWorkItems) return "full";
  missingByKey.set(key, normalizedIds);
  return "added";
}

boundedPlan:
for (let planIndex = startPlanIndex; planIndex < finalizationState.plan.length; planIndex += 1) {
  const planEntry = finalizationState.plan[planIndex];
  const position = Number(planEntry.position);
  const rating = resultsByPosition[position - 1]?.get(String(planEntry.ratingId));
  if (!rating) {
    throw new Error(`Frozen finalization plan references missing rating ${planEntry.ratingId} at position ${position}.`);
  }
  const anchorRating = {
    ...rating,
    bestDeck: {
      ...(rating.bestDeck ?? {}),
      ids: [...planEntry.anchorIds],
    },
  };
  const replacements = buildMetagameV12CounterfactualReplacementDecks(
    anchorRating,
    position,
    resolvedInput,
    candidatePools,
    { replacementDeckLimit, replacementBeamWidth },
  );
  const replacementStart = planIndex === startPlanIndex ? startReplacementIndex : 0;
  if (replacementStart > replacements.length) {
    throw new Error(`Finalization cursor is invalid for plan ${planIndex}: ${replacementStart} > ${replacements.length}.`);
  }

  for (let replacementIndex = replacementStart; replacementIndex < replacements.length; replacementIndex += 1) {
    const entry = replacements[replacementIndex];
    replacementReferenceCount += 1;
    const addResult = tryAddMissingDeck(entry.deck.map((character) => String(character.id)));
    if (addResult === "full") {
      boundedWorkTruncated = true;
      break boundedPlan;
    }
  }
  scannedAnchorCount += 1;
  if (scannedAnchorCount % 500 === 0) {
    console.log(`V12 finalization planner: ${scannedAnchorCount} anchors scanned, ${missingByKey.size} unique missing evaluations.`);
  }
}

// Keep the broad 48-deck exploration frontier, but consume it in wider
// twelve-seed waves. This preserves the same search space while cutting the
// number of orchestration rounds dramatically. The 9,500-item wave cap still
// bounds runner wall-clock; any overflow is retried deterministically from the
// durable cache on the next wave. The frontier is rebuilt from measured battle
// results after every completed wave, so newly discovered elite/diverse shells can enter.
const deepFrontier = selectDeepSearchSeeds(sharedDeckPool, deepFrontierCount);
const deepFrontierKeys = deepFrontier.map(deckSeedKey);
const deepSeeds = remainingDeepEvaluationBudget > 0
  ? deepFrontier
    .filter((entry) => !visitedDeepSeedKeys.has(deckSeedKey(entry)))
    .slice(0, deepSeedCount)
  : [];
const deepSeedKeys = deepSeeds.map(deckSeedKey).sort();
const charactersById = candidatePools.charactersById ?? new Map(
  CHARACTER_CATALOG.map((character) => [String(character.id), character]),
);
let deepReplacementReferenceCount = 0;
let deepLegalReplacementReferenceCount = 0;
let deepNewEvaluationCount = 0;
let deepWorkTruncated = boundedWorkTruncated;
let deepBudgetExhausted = !legacyDeepSearch && remainingDeepEvaluationBudget <= 0;

if (!boundedWorkTruncated && !deepBudgetExhausted) {
  deepSearch:
  for (const seed of deepSeeds) {
    const seedCharacters = seed.ids.map((id) => charactersById.get(String(id)));
    if (seedCharacters.some((character) => !character)) continue;
    for (let positionIndex = 0; positionIndex < 5; positionIndex += 1) {
      const currentCharacter = seedCharacters[positionIndex];
      const fixedIds = new Set(seed.ids.filter((_, index) => index !== positionIndex).map(String));
      const fixedCost = seedCharacters.reduce((sum, character, index) => (
        index === positionIndex ? sum : sum + (Number(character.cost) || 0)
      ), 0);
      const fixedLegendCount = seedCharacters.reduce((sum, character, index) => (
        index === positionIndex ? sum : sum + (isLegend(character) ? 1 : 0)
      ), 0);
      const legalCandidates = (candidatePools.allByPosition?.[positionIndex] ?? []).filter((candidate) => {
        const candidateId = String(candidate.id);
        if (candidateId === String(currentCharacter.id) || fixedIds.has(candidateId)) return false;
        const totalCost = fixedCost + (Number(candidate.cost) || 0);
        if (totalCost > Number(resolvedInput.totalCost)) return false;
        if (fixedLegendCount + (isLegend(candidate) ? 1 : 0) > 1) return false;
        return true;
      });
      deepLegalReplacementReferenceCount += legalCandidates.length;
      const positionCandidates = legacyDeepSearch
        ? legalCandidates
        : selectMetagameV12DeepReplacementCandidates(legalCandidates, {
          limit: deepReplacementLimit,
          finalRatingsById: resultsByPosition[positionIndex],
          proxyRatingsById: candidatePools.ratingsByPosition?.[positionIndex],
          measuredStrengthById: measuredStrengthByPosition[positionIndex],
        });

      for (const candidate of positionCandidates) {
        const ids = [...seed.ids];
        ids[positionIndex] = String(candidate.id);
        deepReplacementReferenceCount += 1;
        const addResult = tryAddMissingDeck(ids);
        if (addResult === "added") {
          deepNewEvaluationCount += 1;
          if (!legacyDeepSearch && deepNewEvaluationCount >= remainingDeepEvaluationBudget) {
            deepBudgetExhausted = true;
            break deepSearch;
          }
        }
        if (addResult === "full") {
          deepWorkTruncated = true;
          break deepSearch;
        }
      }
    }
  }
}

function stableWorkHash(key) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const uniqueItems = [...missingByKey.entries()]
  .map(([key, ids]) => ({ key, ids }))
  // Lexical round-robin accidentally kept similarly shaped decks on the same
  // runners. A stable hash changes only scheduling, never the evaluated set or
  // exact battle result, and makes expensive deck families much less likely to
  // create one long-tail shard.
  .sort((left, right) => stableWorkHash(left.key) - stableWorkHash(right.key) || left.key.localeCompare(right.key));
const shardCount = uniqueItems.length <= compactShardThreshold
  ? Math.min(parallelRunnerCount, Math.max(1, uniqueItems.length))
  : requestedShardCount;
const shards = Array.from({ length: shardCount }, () => []);
for (let index = 0; index < uniqueItems.length; index += 1) {
  shards[index % shardCount].push(uniqueItems[index]);
}

const shardSizes = shards.map((items) => items.length);
await writeJsonAtomic(outputManifestPath, {
  version: 2,
  inputId,
  contextVersion: context.version,
  battleSemantics: context.battleSemantics,
  turns,
  shardCount,
  requestedShardCount,
  parallelRunnerCount,
  compactShardThreshold,
  evaluationContext: {
    context: {
      version: context.version,
      battleSemantics: context.battleSemantics,
      inputId: context.inputId,
      environmentCount: context.environmentCount,
      environmentVariants: context.environmentVariants,
      teamScenarioCount: context.teamScenarioCount,
      turns,
    },
    sharedPoolVersion: checkpoint.sharedPoolVersion,
  },
  maxWorkItems,
  normalizedStalePolicy,
  counterfactualAnchorLimit: currentAnchorLimit,
  sourcePlanIndex: startPlanIndex,
  sourceReplacementIndex: startReplacementIndex,
  planLength: finalizationState.plan.length,
  scannedAnchorCount,
  replacementReferenceCount,
  boundedWorkTruncated,
  deepSearch: {
    policyVersion: deepSearchPolicyVersion,
    legacyMode: legacyDeepSearch,
    round: deepSearchRound,
    seedLimit: deepSeedCount,
    frontierLimit: deepFrontierCount,
    replacementLimit: Number.isFinite(deepReplacementLimit) ? deepReplacementLimit : null,
    maxEvaluationBudget: Number.isFinite(maxDeepEvaluations) ? maxDeepEvaluations : null,
    evaluationCountBefore: previousDeepEvaluationCount,
    evaluationCountPlanned: deepNewEvaluationCount,
    budgetExhausted: deepBudgetExhausted,
    frontierBestWinRate: Number(deepFrontier[0]?.result?.expectedWinRate) || 0,
    frontierCount: deepFrontier.length,
    frontierKeys: deepFrontierKeys,
    visitedSeedCount: visitedDeepSeedKeys.size,
    visitedSeedKeys: [...visitedDeepSeedKeys].sort(),
    seedCount: deepSeeds.length,
    seedKeys: deepSeedKeys,
    legalReplacementReferenceCount: deepLegalReplacementReferenceCount,
    replacementReferenceCount: deepReplacementReferenceCount,
    newEvaluationCount: deepNewEvaluationCount,
    truncated: deepWorkTruncated,
  },
  baseEvaluationCount: baseEvaluationCache.size,
  totalMissingEvaluationCount: uniqueItems.length,
  shardSizes,
  shards,
});

console.log(
  `V12 deep neighbourhood search round ${deepSearchRound}: ${deepSeeds.length}/${deepFrontier.length} active/frontier seeds `
  + `(${visitedDeepSeedKeys.size} previously visited), ${deepLegalReplacementReferenceCount} legal replacements -> `
  + `${deepReplacementReferenceCount} selected, ${deepNewEvaluationCount} newly missing evaluations`
  + `${deepBudgetExhausted ? " (condition budget reached)" : ""}${deepWorkTruncated ? " (wave-capped)" : ""}.`,
);
console.log(
  `V12 finalization work plan: ${uniqueItems.length}/${maxWorkItems} max unique missing evaluations `
  + `from ${replacementReferenceCount} bounded counterfactual references across ${scannedAnchorCount} fully scanned anchors `
  + `plus staged elite neighbourhoods; plan=${finalizationState.plan.length}, boundedTruncated=${boundedWorkTruncated}; `
  + `shards min=${shardSizes.length ? Math.min(...shardSizes) : 0}, `
  + `max=${shardSizes.length ? Math.max(...shardSizes) : 0}.`,
);
