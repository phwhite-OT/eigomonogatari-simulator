import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import {
  createMetagameV12FinalizationState,
} from "../src/core/metagame-v12-finalization.js";
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

function deckDifference(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Number.MAX_SAFE_INTEGER;
  return left.reduce((count, id, index) => count + (String(id) === String(right[index]) ? 0 : 1), 0);
}

function selectDeepSearchSeeds(pool, limit) {
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!boundedLimit) return [];
  const available = [...(pool ?? [])];
  if (available.length <= boundedLimit) return available;

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

function seedKeys(entries) {
  return entries.map((entry) => entry.ids.map(String).join("|")).sort();
}

function sameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => String(value) === String(right[index]));
}

const checkpointArgument = readArgument("checkpoint");
const manifestArgument = readArgument("manifest");
if (!checkpointArgument) throw new Error("--checkpoint is required.");
if (!manifestArgument) throw new Error("--manifest is required.");

const checkpointPath = path.resolve(checkpointArgument);
const manifestPath = path.resolve(manifestArgument);
const maxRounds = integerArgument("max-rounds", 5, 1);

const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (checkpoint?.context?.inputId !== manifest?.inputId) {
  throw new Error(`Checkpoint/manifest input mismatch: ${checkpoint?.context?.inputId ?? "missing"} vs ${manifest?.inputId ?? "missing"}.`);
}
if (checkpoint?.status !== "complete") {
  console.log(`V12 deep-search convergence check skipped because checkpoint status is ${checkpoint?.status ?? "missing"}.`);
  process.exit(0);
}

const turns = Math.min(12, Math.max(1, Number(checkpoint?.context?.turns) || 12));
const evaluationCache = new Map();
hydrateMetagameV12EvaluationCache(evaluationCache, checkpoint?.evaluatedDeckPool);

const plannedItems = (manifest?.shards ?? []).flat();
const missingPlannedCount = plannedItems.reduce((count, item) => (
  evaluationCache.has(String(item?.key ?? "")) ? count : count + 1
), 0);

const seedLimit = Math.max(0, Number(manifest?.deepSearch?.seedLimit) || 4);
const previousSeedKeys = [...(manifest?.deepSearch?.seedKeys ?? [])].map(String).sort();
const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
const currentSeeds = selectDeepSearchSeeds(sharedDeckPool, seedLimit);
const currentSeedKeys = seedKeys(currentSeeds);
const currentRound = Math.max(1, Number(manifest?.deepSearch?.round) || Number(checkpoint?.finalizationState?.deepSearchRound) || 1);

let reopenReason = "";
let nextRound = currentRound;
if (missingPlannedCount > 0) {
  reopenReason = `${missingPlannedCount} planned unique evaluations are still missing`;
} else if (!sameStringArray(previousSeedKeys, currentSeedKeys) && currentRound < maxRounds) {
  nextRound = currentRound + 1;
  reopenReason = `elite seed set changed after deep-search round ${currentRound}`;
}

if (!reopenReason) {
  if (!sameStringArray(previousSeedKeys, currentSeedKeys) && currentRound >= maxRounds) {
    console.warn(`V12 deep search reached safety cap ${maxRounds} with a still-changing elite seed set; accepting the best measured pool so far.`);
  } else {
    console.log(`V12 deep search converged after round ${currentRound}: elite seed set is stable and all planned evaluations are cached.`);
  }
  process.exit(0);
}

const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));
const policy = checkpoint?.finalizationState?.policy ?? {};
const reopenedState = createMetagameV12FinalizationState(resultsByPosition, sharedDeckPool, policy);
reopenedState.deepSearchRound = nextRound;
reopenedState.lastProgressAt = new Date().toISOString();

checkpoint.status = "finalizing";
checkpoint.updatedAt = new Date().toISOString();
checkpoint.finalizationState = reopenedState;
await writeJsonAtomic(checkpointPath, checkpoint);

console.log(
  `V12 deep search reopened ${checkpoint.context.inputId}: ${reopenReason}; `
  + `continuing at round ${nextRound} with ${reopenedState.plan.length} refreshed anchor shells.`,
);
