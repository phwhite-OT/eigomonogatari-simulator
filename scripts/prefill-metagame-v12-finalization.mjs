import fs from "node:fs/promises";
import path from "node:path";

import { MetagameV12EvaluationPool } from "./metagame-v12-evaluation-pool.mjs";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import {
  buildMetagameV12CounterfactualReplacementDecks,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
} from "../src/core/metagame-v12.js";
import {
  hydrateMetagameV12EvaluationCache,
  serializeMetagameV12EvaluationCache,
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

const inputId = readArgument("input", "fire:100");
const inputCheckpointPath = path.resolve(readArgument("input-checkpoint"));
const outputCheckpointPath = path.resolve(readArgument("output-checkpoint"));
const shardCount = integerArgument("shard-count", 19, 1);
const shardIndex = integerArgument("shard-index", 0, 0);
const requestedWorkers = integerArgument("workers", 4, 1);
const timeBudgetSeconds = Math.max(0, Number(readArgument("time-budget-seconds", "7200")) || 0);
const checkpointEvery = integerArgument("checkpoint-every", 25, 1);
const checkpointIntervalSeconds = integerArgument("checkpoint-interval-seconds", 60, 5);

if (!readArgument("input-checkpoint")) throw new Error("--input-checkpoint is required.");
if (!readArgument("output-checkpoint")) throw new Error("--output-checkpoint is required.");
if (shardIndex >= shardCount) throw new Error(`Invalid finalization shard ${shardIndex}/${shardCount}.`);

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
const environmentCount = Math.max(9, Number(context.environmentCount) || 72);
const environmentVariants = Math.max(1, Number(context.environmentVariants) || 2);
const partnerLimit = Math.max(32, Number(context.partnerLimit) || 48);
const replacementDeckLimit = Math.max(1, Number(finalizationState.policy?.replacementDeckLimit) || 24);
const replacementBeamWidth = Math.max(1, Number(finalizationState.policy?.replacementBeamWidth) || 4000);

const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const environmentDecks = createMetagameV12EnvironmentDecks(resolvedInput, {
  count: environmentCount,
  environmentVariants,
});
const teamScenarios = createMetagameV12TeamScenarios(resolvedInput, {
  environmentDecks,
  count: environmentCount,
});
if (context.teamScenarioCount && teamScenarios.length !== Number(context.teamScenarioCount)) {
  throw new Error(`Team scenario mismatch: checkpoint=${context.teamScenarioCount}, rebuilt=${teamScenarios.length}.`);
}
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));

const baseEvaluationCache = new Map();
hydrateMetagameV12EvaluationCache(baseEvaluationCache, checkpoint?.evaluatedDeckPool);
const deltaEvaluationCache = new Map();
const startPlanIndex = Math.max(0, Number(finalizationState.cursor?.planIndex) || 0);
const startReplacementIndex = Math.max(0, Number(finalizationState.cursor?.replacementIndex) || 0);
const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;
const deadlineReached = (guardMs = 15000) => Number.isFinite(deadline) && Date.now() + guardMs >= deadline;
let lastCheckpointAt = Date.now();
let evaluationsAtLastCheckpoint = 0;
let processedAnchorCount = 0;
let stoppedEarly = false;

async function saveDelta() {
  await writeJsonAtomic(outputCheckpointPath, {
    status: "finalizing",
    updatedAt: new Date().toISOString(),
    context,
    sharedPoolVersion: checkpoint.sharedPoolVersion,
    evaluatedDeckPool: serializeMetagameV12EvaluationCache(deltaEvaluationCache),
    finalizationPrefill: {
      version: 1,
      shardIndex,
      shardCount,
      sourcePlanIndex: startPlanIndex,
      sourceReplacementIndex: startReplacementIndex,
      processedAnchorCount,
      newEvaluationCount: deltaEvaluationCache.size,
      completeForShard: !stoppedEarly,
    },
  });
  lastCheckpointAt = Date.now();
  evaluationsAtLastCheckpoint = deltaEvaluationCache.size;
}

async function maybeSaveDelta(force = false) {
  const evaluationsSinceSave = deltaEvaluationCache.size - evaluationsAtLastCheckpoint;
  const elapsedMs = Date.now() - lastCheckpointAt;
  if (!force && evaluationsSinceSave < checkpointEvery && elapsedMs < checkpointIntervalSeconds * 1000) return;
  await saveDelta();
}

const evaluationPool = new MetagameV12EvaluationPool({
  teamScenarios,
  turns,
  workerCount: requestedWorkers,
});
const batchSize = Math.max(1, evaluationPool.workerCount * 2);
console.log(`V12 distributed finalization shard ${shardIndex + 1}/${shardCount}: plan ${startPlanIndex}/${finalizationState.plan.length}, ${evaluationPool.workerCount} worker(s), batch size ${batchSize}.`);

try {
  outer:
  for (let planIndex = startPlanIndex; planIndex < finalizationState.plan.length; planIndex += 1) {
    if (planIndex % shardCount !== shardIndex) continue;
    if (deadlineReached()) { stoppedEarly = true; break; }

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

    for (let replacementIndex = replacementStart; replacementIndex < replacements.length;) {
      if (deadlineReached()) { stoppedEarly = true; break outer; }
      const batchEnd = Math.min(replacements.length, replacementIndex + batchSize);
      const missingByKey = new Map();
      for (let batchIndex = replacementIndex; batchIndex < batchEnd; batchIndex += 1) {
        const entry = replacements[batchIndex];
        const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
        if (!baseEvaluationCache.has(key) && !deltaEvaluationCache.has(key) && !missingByKey.has(key)) {
          missingByKey.set(key, entry.deck);
        }
      }
      if (missingByKey.size) {
        const pending = [...missingByKey.entries()];
        const evaluated = await evaluationPool.evaluateMany(pending.map(([, deck]) => deck));
        for (let index = 0; index < pending.length; index += 1) {
          deltaEvaluationCache.set(pending[index][0], evaluated[index]);
        }
      }
      await maybeSaveDelta();
      replacementIndex = batchEnd;
    }
    processedAnchorCount += 1;
    if (processedAnchorCount % 25 === 0) {
      console.log(`V12 distributed shard ${shardIndex + 1}/${shardCount}: ${processedAnchorCount} anchors, ${deltaEvaluationCache.size} new deck evaluations.`);
    }
  }
} finally {
  await evaluationPool.close();
}

await maybeSaveDelta(true);
console.log(`V12 distributed shard ${shardIndex + 1}/${shardCount} ${stoppedEarly ? "paused" : "complete"}: ${processedAnchorCount} anchors, ${deltaEvaluationCache.size} new deck evaluations.`);
