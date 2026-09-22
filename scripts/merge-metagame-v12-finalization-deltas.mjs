import fs from "node:fs/promises";
import path from "node:path";

import {
  hydrateMetagameV12EvaluationCache,
  serializeMetagameV12EvaluationCache,
} from "../src/core/metagame-v12-shared-pool.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function compatibleContext(base, delta) {
  const left = base?.context ?? {};
  const right = delta?.context ?? {};
  return (
    String(left.inputId ?? "") === String(right.inputId ?? "") &&
    String(left.version ?? "") === String(right.version ?? "") &&
    String(left.battleSemantics ?? "") === String(right.battleSemantics ?? "") &&
    Number(left.teamScenarioCount ?? 0) === Number(right.teamScenarioCount ?? 0) &&
    Number(left.turns ?? 0) === Number(right.turns ?? 0)
  );
}

const checkpointPath = path.resolve(readArgument("checkpoint"));
const deltaPaths = readArgument("deltas")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

if (!readArgument("checkpoint")) throw new Error("--checkpoint is required.");
if (!deltaPaths.length) throw new Error("--deltas must contain at least one checkpoint.");

const checkpoint = await readJson(checkpointPath);
const cache = new Map();
hydrateMetagameV12EvaluationCache(cache, checkpoint?.evaluatedDeckPool);
const before = cache.size;
let accepted = 0;

for (const deltaPath of deltaPaths) {
  const delta = await readJson(deltaPath);
  if (!compatibleContext(checkpoint, delta)) {
    throw new Error(`Incompatible finalization delta: ${deltaPath}`);
  }
  hydrateMetagameV12EvaluationCache(cache, delta?.evaluatedDeckPool);
  accepted += 1;
}

checkpoint.evaluatedDeckPool = serializeMetagameV12EvaluationCache(cache);
checkpoint.updatedAt = new Date().toISOString();
checkpoint.recoveredFinalizationDeltas = {
  version: 1,
  accepted,
  cacheEntriesBefore: before,
  cacheEntriesAfter: cache.size,
  recoveredEntryCount: cache.size - before,
};

await writeJsonAtomic(checkpointPath, checkpoint);
console.log(JSON.stringify(checkpoint.recoveredFinalizationDeltas, null, 2));
