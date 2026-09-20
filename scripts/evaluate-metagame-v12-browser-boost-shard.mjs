import fs from "node:fs/promises";

import { MetagameV12EvaluationPool } from "./metagame-v12-evaluation-pool.mjs";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import { resolveMetagameV7Input } from "../src/core/metagame-v7.js";
import {
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
} from "../src/core/metagame-v12.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function rounded(value, digits = 5) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function robustDelta(boostedValues, baseValues) {
  const deltas = boostedValues.map((value, index) => Number(value) - Number(baseValues[index]));
  const mean = average(deltas);
  const standardError = deltas.length > 1 ? standardDeviation(deltas) / Math.sqrt(deltas.length) : 0;
  return {
    mean: rounded(mean),
    robust: rounded(mean - 1.28 * standardError),
    standardError: rounded(standardError),
  };
}

const manifestPath = readArgument("manifest", "");
const outputPath = readArgument("output", "boost-shard.json");
const shardIndex = Math.max(0, Math.floor(Number(readArgument("shard-index", "0")) || 0));
const workers = positiveInteger(readArgument("workers", "4"), 4, 1);
const batchSize = positiveInteger(readArgument("batch-size", "16"), 16, 1);
if (!manifestPath) throw new Error("--manifest is required.");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.shards) || !Array.isArray(manifest.shards[shardIndex])) {
  throw new Error(`Shard ${shardIndex} is not present in the manifest.`);
}
const input = METAGAME_V8_INPUTS.find((entry) => entry.id === manifest.inputId);
if (!input) throw new Error(`Input ${manifest.inputId} was not found.`);
const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const environmentDecks = createMetagameV12EnvironmentDecks(resolvedInput, {
  count: manifest.context.environmentCount,
  environmentVariants: manifest.context.environmentVariants,
});
const teamScenarios = createMetagameV12TeamScenarios(resolvedInput, {
  environmentDecks,
  count: manifest.context.teamScenarioCount,
});
if (teamScenarios.length !== manifest.context.teamScenarioCount) {
  throw new Error(`Scenario count mismatch: ${teamScenarios.length} != ${manifest.context.teamScenarioCount}`);
}

const charactersById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
const boostMultiplier = Number(manifest.context.boostMultiplier) || 1.5;
const tasks = manifest.shards[shardIndex];
const pool = new MetagameV12EvaluationPool({
  teamScenarios,
  turns: manifest.context.turns,
  workerCount: workers,
});
const results = [];
try {
  for (let start = 0; start < tasks.length; start += batchSize) {
    const batch = tasks.slice(start, start + batchSize);
    const deckPairs = batch.map((task) => {
      const baseDeck = task.d.map((id) => {
        const character = charactersById.get(String(id));
        if (!character) throw new Error(`Unknown character ${id}.`);
        return character;
      });
      const positionIndex = Number(task.p) - 1;
      if (String(baseDeck[positionIndex]?.id) !== String(task.i)) {
        throw new Error(`Task ${task.n} anchor does not contain ${task.i} in position ${task.p}.`);
      }
      const boostedDeck = [...baseDeck];
      const original = boostedDeck[positionIndex];
      boostedDeck[positionIndex] = {
        ...original,
        hp: Math.max(0, Number(original.hp) || 0) * boostMultiplier,
        pow: Math.max(0, Number(original.pow) || 0) * boostMultiplier,
        metagameStatBoost: {
          multiplier: boostMultiplier,
          hpMultiplier: boostMultiplier,
          powMultiplier: boostMultiplier,
        },
      };
      return { baseDeck, boostedDeck };
    });
    // Re-evaluate both sides under the exact same current battle semantics.
    // This deliberately doubles offline work so boost deltas never depend on
    // rounded checkpoint values or an older cached representation.
    const evaluated = await pool.evaluateMany(deckPairs.flatMap(({ baseDeck, boostedDeck }) => [baseDeck, boostedDeck]));
    for (let index = 0; index < batch.length; index += 1) {
      const task = batch[index];
      const baseResult = evaluated[index * 2];
      const result = evaluated[index * 2 + 1];
      if (!Array.isArray(baseResult?.scenarioValues) || !Array.isArray(result?.scenarioValues) ||
          result.scenarioValues.length !== baseResult.scenarioValues.length) {
        throw new Error(`Task ${task.n} returned an incompatible scenario vector.`);
      }
      const delta = robustDelta(result.scenarioValues, baseResult.scenarioValues);
      results.push({
        n: task.n,
        p: task.p,
        i: task.i,
        a: task.a,
        d: task.d,
        w: rounded(result.expectedWinRate),
        l: rounded(result.expectedWinLowerBound),
        x: rounded(result.decisiveWinRate),
        m: delta.mean,
        r: delta.robust,
        e: delta.standardError,
        bw: rounded(baseResult.expectedWinRate),
        bl: rounded(baseResult.expectedWinLowerBound),
      });
    }
    console.log(`Shard ${shardIndex}: ${Math.min(start + batch.length, tasks.length)}/${tasks.length} boosted anchors complete.`);
  }
} finally {
  await pool.close();
}

await fs.writeFile(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputId: manifest.inputId,
  modelVersion: manifest.modelVersion,
  shardIndex,
  taskCount: tasks.length,
  results,
})}\n`, "utf8");
console.log(`Wrote ${results.length} boosted anchor result(s) to ${outputPath}.`);
