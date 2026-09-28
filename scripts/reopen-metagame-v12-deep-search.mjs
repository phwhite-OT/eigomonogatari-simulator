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
import {
  METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION,
  assessMetagameV12DeepFrontierConvergence,
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

function numberArgument(name, fallback, minimum = 0) {
  const parsed = Number(readArgument(name, String(fallback)));
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

function deckSeedKey(entry) {
  return entry.ids.map(String).join("|");
}

const checkpointArgument = readArgument("checkpoint");
const manifestArgument = readArgument("manifest");
if (!checkpointArgument) throw new Error("--checkpoint is required.");
if (!manifestArgument) throw new Error("--manifest is required.");

const checkpointPath = path.resolve(checkpointArgument);
const manifestPath = path.resolve(manifestArgument);
// Twelve active seeds per clean round can cover the 48-deck frontier in four
// rounds. Keep a generous finite cap for wave truncation and frontier churn;
// the cap is a safety brake, not the expected number of rounds.
const configuredMinRounds = integerArgument("min-rounds", 2, 1);
const configuredMaxRounds = integerArgument("max-rounds", 4, configuredMinRounds);
const legacyMaxRounds = integerArgument("legacy-max-rounds", 16, 1);
const frontierOverlapThreshold = numberArgument("frontier-overlap-threshold", 0.875, 0);
const frontierImprovementThreshold = numberArgument("frontier-improvement-threshold", 0.0025, 0);

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
const frontierLimit = Math.max(seedLimit, Number(manifest?.deepSearch?.frontierLimit) || 48);
const activeSeedKeys = [...(manifest?.deepSearch?.seedKeys ?? [])].map(String);
const visitedSeedKeys = new Set([
  ...(checkpoint?.finalizationState?.deepSearchVisitedSeedKeys ?? []),
  ...(manifest?.deepSearch?.visitedSeedKeys ?? []),
].map(String));
const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
const currentFrontier = selectDeepSearchSeeds(sharedDeckPool, frontierLimit);
const currentFrontierKeys = currentFrontier.map(deckSeedKey);
const currentRound = Math.max(1, Number(manifest?.deepSearch?.round) || Number(checkpoint?.finalizationState?.deepSearchRound) || 1);
const deepWorkTruncated = manifest?.deepSearch?.truncated === true;
const deepSearchPolicyVersion = Number(manifest?.deepSearch?.policyVersion) || 2;
const boundedDeepSearch = deepSearchPolicyVersion >= METAGAME_V12_BOUNDED_DEEP_SEARCH_POLICY_VERSION;
const maxRounds = boundedDeepSearch ? configuredMaxRounds : legacyMaxRounds;
const completedDeepEvaluations = missingPlannedCount === 0
  ? Math.max(0, Number(manifest?.deepSearch?.newEvaluationCount) || 0)
  : 0;
const deepSearchEvaluationCount = Math.max(
  0,
  Number(checkpoint?.finalizationState?.deepSearchEvaluationCount) || 0,
) + completedDeepEvaluations;
const maxDeepEvaluations = Number(manifest?.deepSearch?.maxEvaluationBudget);
const budgetExhausted = boundedDeepSearch && Number.isFinite(maxDeepEvaluations)
  && deepSearchEvaluationCount >= maxDeepEvaluations;
const currentBestWinRate = Number(currentFrontier[0]?.result?.expectedWinRate) || 0;
const frontierConvergence = assessMetagameV12DeepFrontierConvergence(
  manifest?.deepSearch?.frontierKeys,
  currentFrontierKeys,
  manifest?.deepSearch?.frontierBestWinRate,
  currentBestWinRate,
  {
    overlapThreshold: frontierOverlapThreshold,
    improvementThreshold: frontierImprovementThreshold,
  },
);

// A seed only counts as visited after the entire planned wave is present in the
// merged exact cache and the neighbourhood itself was not clipped by the wave
// cap. If a wave was clipped, the next pass safely retries it and cache hits
// make already completed deck evaluations free.
if (missingPlannedCount === 0 && !deepWorkTruncated) {
  activeSeedKeys.forEach((key) => visitedSeedKeys.add(String(key)));
}

const unvisitedFrontierKeys = currentFrontierKeys.filter((key) => !visitedSeedKeys.has(String(key)));

let reopenReason = "";
let nextRound = currentRound;
if (missingPlannedCount > 0) {
  reopenReason = `${missingPlannedCount} planned unique evaluations are still missing`;
} else if (deepWorkTruncated) {
  reopenReason = `deep-search neighbourhood was truncated by the ${manifest?.maxWorkItems ?? "configured"}-evaluation wave cap`;
} else if (boundedDeepSearch && budgetExhausted) {
  reopenReason = "";
} else if (boundedDeepSearch && currentRound >= configuredMinRounds && frontierConvergence.converged) {
  reopenReason = "";
} else if (unvisitedFrontierKeys.length > 0 && currentRound < maxRounds) {
  nextRound = currentRound + 1;
  reopenReason = `${unvisitedFrontierKeys.length}/${currentFrontierKeys.length} measured frontier seeds remain unvisited after round ${currentRound}`;
}

if (!reopenReason) {
  checkpoint.finalizationState.deepSearchPolicyVersion = deepSearchPolicyVersion;
  checkpoint.finalizationState.deepSearchEvaluationCount = deepSearchEvaluationCount;
  checkpoint.finalizationState.deepSearchFrontierKeys = currentFrontierKeys;
  checkpoint.finalizationState.deepSearchBestExpectedWinRate = currentBestWinRate;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint);

  if (boundedDeepSearch && budgetExhausted) {
    console.log(
      `V12 bounded deep search stopped at the ${maxDeepEvaluations}-evaluation condition budget after round ${currentRound}.`,
    );
  } else if (boundedDeepSearch && currentRound >= configuredMinRounds && frontierConvergence.converged) {
    console.log(
      `V12 bounded deep search converged after round ${currentRound}: frontier overlap `
      + `${(frontierConvergence.overlapRatio * 100).toFixed(1)}%, best-deck improvement `
      + `${(frontierConvergence.improvement * 100).toFixed(3)}pt.`,
    );
  } else if (unvisitedFrontierKeys.length > 0 && currentRound >= maxRounds) {
    console.warn(
      `V12 deep search reached safety cap ${maxRounds} with ${unvisitedFrontierKeys.length} `
      + `unvisited measured frontier seed(s); accepting the best measured pool so far.`,
    );
  } else {
    console.log(
      `V12 deep search converged after round ${currentRound}: all ${currentFrontierKeys.length} `
      + `current elite/diverse frontier seeds have been explored and all planned evaluations are cached.`,
    );
  }
  process.exit(0);
}

const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));
const policy = checkpoint?.finalizationState?.policy ?? {};
const reopenedState = createMetagameV12FinalizationState(resultsByPosition, sharedDeckPool, policy);
reopenedState.deepSearchRound = nextRound;
reopenedState.deepSearchVisitedSeedKeys = [...visitedSeedKeys].sort();
reopenedState.deepSearchPolicyVersion = deepSearchPolicyVersion;
reopenedState.deepSearchEvaluationCount = deepSearchEvaluationCount;
reopenedState.deepSearchFrontierKeys = currentFrontierKeys;
reopenedState.deepSearchBestExpectedWinRate = currentBestWinRate;
reopenedState.lastProgressAt = new Date().toISOString();

checkpoint.status = "finalizing";
checkpoint.updatedAt = new Date().toISOString();
checkpoint.finalizationState = reopenedState;
await writeJsonAtomic(checkpointPath, checkpoint);

console.log(
  `V12 deep search reopened ${checkpoint.context.inputId}: ${reopenReason}; `
  + `${visitedSeedKeys.size} seed neighbourhood(s) already covered, continuing at round ${nextRound} `
  + `with ${reopenedState.plan.length} refreshed anchor shells.`,
);
