import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import { buildMetagameV12CounterfactualReplacementDecks } from "../src/core/metagame-v12.js";
import {
  buildMetagameV12SharedDeckPool,
  hydrateMetagameV12EvaluationCache,
} from "../src/core/metagame-v12-shared-pool.js";

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

  // Keep the very strongest half unconditionally, then spend the other half
  // on structurally different strong decks. This avoids wasting exhaustive
  // one-slot probes on dozens of nearly identical shells.
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

const inputId = readArgument("input", "fire:100");
const inputCheckpointPath = path.resolve(readArgument("input-checkpoint"));
const outputManifestPath = path.resolve(readArgument("output-manifest"));
const shardCount = integerArgument("shard-count", 19, 1);
const deepSeedCount = integerArgument("deep-seed-count", 48, 0);

if (!readArgument("input-checkpoint")) throw new Error("--input-checkpoint is required.");
if (!readArgument("output-manifest")) throw new Error("--output-manifest is required.");

const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`Input ${inputId} was not found.`);

const checkpoint = JSON.parse(await fs.readFile(inputCheckpointPath, "utf8"));
if (checkpoint?.context?.inputId !== inputId) {
  throw new Error(`Checkpoint input mismatch: expected ${inputId}, got ${checkpoint?.context?.inputId ?? "missing"}.`);
}
const finalizationState = checkpoint?.finalizationState;
if (!finalizationState || finalizationState.phase !== "counterfactual" || !Array.isArray(finalizationState.plan)) {
  throw new Error("Checkpoint does not contain an active frozen V12 counterfactual finalization plan.");
}

const context = checkpoint.context;
const turns = Math.min(12, Math.max(1, Number(context.turns) || 12));
const partnerLimit = Math.max(32, Number(context.partnerLimit) || 48);
const replacementDeckLimit = Math.max(1, Number(finalizationState.policy?.replacementDeckLimit) || 24);
const replacementBeamWidth = Math.max(1, Number(finalizationState.policy?.replacementBeamWidth) || 4000);
const startPlanIndex = Math.max(0, Number(finalizationState.cursor?.planIndex) || 0);
const startReplacementIndex = Math.max(0, Number(finalizationState.cursor?.replacementIndex) || 0);
const deepSearchRound = Math.max(1, Number(finalizationState.deepSearchRound) || 1);

const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));
const baseEvaluationCache = new Map();
hydrateMetagameV12EvaluationCache(baseEvaluationCache, checkpoint?.evaluatedDeckPool);

const missingByKey = new Map();
let scannedAnchorCount = 0;
let replacementReferenceCount = 0;

function addMissingDeck(ids) {
  const normalizedIds = ids.map(String);
  const key = `${turns}:${normalizedIds.join("|")}`;
  if (baseEvaluationCache.has(key) || missingByKey.has(key)) return false;
  missingByKey.set(key, normalizedIds);
  return true;
}

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
    addMissingDeck(entry.deck.map((character) => String(character.id)));
  }
  scannedAnchorCount += 1;
  if (scannedAnchorCount % 500 === 0) {
    console.log(`V12 finalization planner: ${scannedAnchorCount} anchors scanned, ${missingByKey.size} unique missing evaluations.`);
  }
}

// The normal counterfactual pass deliberately samples a bounded set of
// replacements for every rated character. Separately, deeply search the local
// neighbourhood of the strongest *complete* decks: freeze four slots and try
// every legal candidate in the fifth slot. No character is privileged; the
// seed is selected solely by measured complete-deck battle performance.
const sharedDeckPool = buildMetagameV12SharedDeckPool(baseEvaluationCache, CHARACTER_CATALOG, turns);
const deepSeeds = selectDeepSearchSeeds(sharedDeckPool, deepSeedCount);
const deepSeedKeys = deepSeeds.map((entry) => entry.ids.map(String).join("|")).sort();
const charactersById = candidatePools.charactersById ?? new Map(
  CHARACTER_CATALOG.map((character) => [String(character.id), character]),
);
let deepReplacementReferenceCount = 0;
let deepNewEvaluationCount = 0;

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
    const positionCandidates = candidatePools.allByPosition?.[positionIndex] ?? [];

    for (const candidate of positionCandidates) {
      const candidateId = String(candidate.id);
      if (candidateId === String(currentCharacter.id) || fixedIds.has(candidateId)) continue;
      const totalCost = fixedCost + (Number(candidate.cost) || 0);
      if (totalCost > Number(resolvedInput.totalCost)) continue;
      if (fixedLegendCount + (isLegend(candidate) ? 1 : 0) > 1) continue;

      const ids = [...seed.ids];
      ids[positionIndex] = candidateId;
      deepReplacementReferenceCount += 1;
      if (addMissingDeck(ids)) deepNewEvaluationCount += 1;
    }
  }
}

// Stable sorting plus round-robin distribution gives every runner essentially the
// same number of expensive deck evaluations while guaranteeing that each unique
// cache key belongs to exactly one runner.
const uniqueItems = [...missingByKey.entries()]
  .map(([key, ids]) => ({ key, ids }))
  .sort((left, right) => left.key.localeCompare(right.key));
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
  sourcePlanIndex: startPlanIndex,
  sourceReplacementIndex: startReplacementIndex,
  planLength: finalizationState.plan.length,
  scannedAnchorCount,
  replacementReferenceCount,
  deepSearch: {
    round: deepSearchRound,
    seedLimit: deepSeedCount,
    seedCount: deepSeeds.length,
    seedKeys: deepSeedKeys,
    replacementReferenceCount: deepReplacementReferenceCount,
    newEvaluationCount: deepNewEvaluationCount,
  },
  baseEvaluationCount: baseEvaluationCache.size,
  totalMissingEvaluationCount: uniqueItems.length,
  shardSizes,
  shards,
});

console.log(
  `V12 deep neighbourhood search round ${deepSearchRound}: ${deepSeeds.length} measured seed decks, `
  + `${deepReplacementReferenceCount} legal one-slot replacements, ${deepNewEvaluationCount} newly missing evaluations.`,
);
console.log(
  `V12 finalization work plan: ${uniqueItems.length} unique missing evaluations `
  + `from ${replacementReferenceCount} bounded counterfactual references across ${scannedAnchorCount} anchors `
  + `plus exhaustive elite neighbourhoods; shards min=${shardSizes.length ? Math.min(...shardSizes) : 0}, `
  + `max=${shardSizes.length ? Math.max(...shardSizes) : 0}.`,
);
