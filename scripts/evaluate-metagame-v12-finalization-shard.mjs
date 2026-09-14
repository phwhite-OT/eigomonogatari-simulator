import fs from "node:fs/promises";
import path from "node:path";

import { MetagameV12EvaluationPool } from "./metagame-v12-evaluation-pool.mjs";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import { resolveMetagameV7Input } from "../src/core/metagame-v7.js";
import {
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
const workManifestPath = path.resolve(readArgument("work-manifest"));
const outputCheckpointPath = path.resolve(readArgument("output-checkpoint"));
const shardIndex = integerArgument("shard-index", 0, 0);
const requestedWorkers = integerArgument("workers", 4, 1);
const timeBudgetSeconds = Math.max(0, Number(readArgument("time-budget-seconds", "7200")) || 0);
const checkpointEvery = integerArgument("checkpoint-every", 25, 1);
const checkpointIntervalSeconds = integerArgument("checkpoint-interval-seconds", 60, 5);

if (!readArgument("input-checkpoint")) throw new Error("--input-checkpoint is required.");
if (!readArgument("work-manifest")) throw new Error("--work-manifest is required.");
if (!readArgument("output-checkpoint")) throw new Error("--output-checkpoint is required.");

const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`Input ${inputId} was not found.`);
const checkpoint = JSON.parse(await fs.readFile(inputCheckpointPath, "utf8"));
const manifest = JSON.parse(await fs.readFile(workManifestPath, "utf8"));
if (checkpoint?.context?.inputId !== inputId) {
  throw new Error(`Checkpoint input mismatch: expected ${inputId}, got ${checkpoint?.context?.inputId ?? "missing"}.`);
}
if (manifest?.version !== 2 || manifest?.inputId !== inputId || !Array.isArray(manifest?.shards)) {
  throw new Error("Finalization work manifest is missing, stale, or incompatible.");
}
if (manifest.contextVersion !== checkpoint.context?.version || manifest.battleSemantics !== checkpoint.context?.battleSemantics) {
  throw new Error("Finalization work manifest context does not match the checkpoint.");
}
if (shardIndex >= manifest.shards.length) {
  throw new Error(`Invalid finalization shard ${shardIndex}/${manifest.shards.length}.`);
}

const context = checkpoint.context;
const turns = Math.min(12, Math.max(1, Number(context.turns) || 12));
if (Number(manifest.turns) !== turns) throw new Error("Finalization work manifest turn count does not match the checkpoint.");
const environmentCount = Math.max(9, Number(context.environmentCount) || 72);
const environmentVariants = Math.max(1, Number(context.environmentVariants) || 2);
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

const characterById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
const baseEvaluationCache = new Map();
hydrateMetagameV12EvaluationCache(baseEvaluationCache, checkpoint?.evaluatedDeckPool);
const deltaEvaluationCache = new Map();
const assignedItems = manifest.shards[shardIndex];
const pendingItems = assignedItems.filter((item) => !baseEvaluationCache.has(String(item.key)));
const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;
const deadlineReached = (guardMs = 15000) => Number.isFinite(deadline) && Date.now() + guardMs >= deadline;
let lastCheckpointAt = Date.now();
let evaluationsAtLastCheckpoint = 0;
let processedWorkItemCount = 0;
let stoppedEarly = false;

async function saveDelta() {
  await writeJsonAtomic(outputCheckpointPath, {
    status: "finalizing",
    updatedAt: new Date().toISOString(),
    context,
    sharedPoolVersion: checkpoint.sharedPoolVersion,
    evaluatedDeckPool: serializeMetagameV12EvaluationCache(deltaEvaluationCache),
    finalizationPrefill: {
      version: 2,
      partition: "global-unique-evaluation-round-robin",
      shardIndex,
      shardCount: manifest.shardCount,
      sourcePlanIndex: manifest.sourcePlanIndex,
      sourceReplacementIndex: manifest.sourceReplacementIndex,
      assignedEvaluationCount: assignedItems.length,
      processedWorkItemCount,
      newEvaluationCount: deltaEvaluationCache.size,
      completeForShard: !stoppedEarly && processedWorkItemCount >= pendingItems.length,
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

function deckForItem(item) {
  return item.ids.map((id) => {
    const character = characterById.get(String(id));
    if (!character) throw new Error(`Finalization manifest references unknown character ${id}.`);
    return character;
  });
}

const evaluationPool = new MetagameV12EvaluationPool({
  teamScenarios,
  turns,
  workerCount: requestedWorkers,
});
const batchSize = Math.max(1, evaluationPool.workerCount * 4);
console.log(
  `V12 unique-evaluation shard ${shardIndex + 1}/${manifest.shardCount}: `
  + `${pendingItems.length}/${assignedItems.length} pending unique evaluations, `
  + `${evaluationPool.workerCount} worker(s), batch size ${batchSize}.`,
);

try {
  for (let offset = 0; offset < pendingItems.length;) {
    if (deadlineReached()) { stoppedEarly = true; break; }
    const batch = pendingItems.slice(offset, Math.min(pendingItems.length, offset + batchSize));
    const evaluated = await evaluationPool.evaluateMany(batch.map(deckForItem));
    for (let index = 0; index < batch.length; index += 1) {
      deltaEvaluationCache.set(String(batch[index].key), evaluated[index]);
    }
    processedWorkItemCount += batch.length;
    offset += batch.length;
    await maybeSaveDelta();
    if (processedWorkItemCount % 100 === 0 || offset >= pendingItems.length) {
      console.log(
        `V12 unique-evaluation shard ${shardIndex + 1}/${manifest.shardCount}: `
        + `${processedWorkItemCount}/${pendingItems.length} evaluations complete.`,
      );
    }
  }
} finally {
  await evaluationPool.close();
}

await maybeSaveDelta(true);
console.log(
  `V12 unique-evaluation shard ${shardIndex + 1}/${manifest.shardCount} `
  + `${stoppedEarly ? "paused" : "complete"}: ${processedWorkItemCount}/${pendingItems.length} evaluations.`,
);
