import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import { buildMetagameV12CounterfactualReplacementDecks } from "../src/core/metagame-v12.js";
import { hydrateMetagameV12EvaluationCache } from "../src/core/metagame-v12-shared-pool.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

const inputId = readArgument("input", "fire:100");
const checkpointArgument = readArgument("checkpoint");
if (!checkpointArgument) throw new Error("--checkpoint is required.");

const checkpointPath = path.resolve(checkpointArgument);
const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`Input ${inputId} was not found.`);

const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
if (checkpoint?.context?.inputId !== inputId) {
  throw new Error(`Checkpoint input mismatch: expected ${inputId}, got ${checkpoint?.context?.inputId ?? "missing"}.`);
}
const finalizationState = checkpoint?.finalizationState;
if (!finalizationState || !Array.isArray(finalizationState.plan)) {
  throw new Error("Checkpoint does not contain a V12 finalization plan.");
}
if (finalizationState.phase !== "counterfactual" && finalizationState.phase !== "complete") {
  throw new Error(`Unsupported V12 finalization phase: ${finalizationState.phase ?? "missing"}.`);
}

if (finalizationState.phase === "complete") {
  console.log("V12 cached finalization plan is already complete.");
  process.exit(0);
}

const context = checkpoint.context;
const turns = Math.min(12, Math.max(1, Number(context.turns) || 12));
const partnerLimit = Math.max(32, Number(context.partnerLimit) || 48);
const replacementDeckLimit = Math.max(1, Number(finalizationState.policy?.replacementDeckLimit) || 24);
const replacementBeamWidth = Math.max(1, Number(finalizationState.policy?.replacementBeamWidth) || 4000);
const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map(
  (checkpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]),
));
const evaluationCache = new Map();
hydrateMetagameV12EvaluationCache(evaluationCache, checkpoint?.evaluatedDeckPool);

const startPlanIndex = Math.max(0, Number(finalizationState.cursor?.planIndex) || 0);
const startReplacementIndex = Math.max(0, Number(finalizationState.cursor?.replacementIndex) || 0);
let advancedCandidateDeckCount = 0;
let stoppedAtMissingKey = "";

counterfactualAudit:
for (let planIndex = startPlanIndex; planIndex < finalizationState.plan.length; planIndex += 1) {
  const planEntry = finalizationState.plan[planIndex];
  const position = Number(planEntry.position);
  const rating = resultsByPosition[position - 1]?.get(String(planEntry.ratingId));
  if (!rating) {
    finalizationState.cursor = { planIndex: planIndex + 1, replacementIndex: 0 };
    finalizationState.lastProgressAt = new Date().toISOString();
    continue;
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
    const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
    if (!evaluationCache.has(key)) {
      stoppedAtMissingKey = key;
      break counterfactualAudit;
    }
    finalizationState.processedCandidateDeckCount = (finalizationState.processedCandidateDeckCount ?? 0) + 1;
    advancedCandidateDeckCount += 1;
    finalizationState.cursor = { planIndex, replacementIndex: replacementIndex + 1 };
    finalizationState.lastProgressAt = new Date().toISOString();
  }

  finalizationState.cursor = { planIndex: planIndex + 1, replacementIndex: 0 };
  finalizationState.lastProgressAt = new Date().toISOString();
}

if (!stoppedAtMissingKey && finalizationState.cursor.planIndex >= finalizationState.plan.length) {
  finalizationState.phase = "complete";
  finalizationState.cursor = { planIndex: finalizationState.plan.length, replacementIndex: 0 };
  finalizationState.lastProgressAt = new Date().toISOString();
}

checkpoint.status = "finalizing";
checkpoint.updatedAt = new Date().toISOString();
await writeJsonAtomic(checkpointPath, checkpoint);

console.log(JSON.stringify({
  phase: finalizationState.phase,
  cursor: finalizationState.cursor,
  planLength: finalizationState.plan.length,
  advancedCandidateDeckCount,
  stoppedAtMissingKey: stoppedAtMissingKey || null,
  evaluationCacheSize: evaluationCache.size,
}, null, 2));
