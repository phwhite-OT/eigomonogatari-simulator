import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  METAGAME_V8_MODEL_VERSION,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import { buildMetagameCandidateShardPlan } from "../src/core/metagame-work-shards.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

async function readProgress(checkpointPath) {
  if (!checkpointPath) return null;
  try {
    const serialized = await fs.readFile(path.resolve(checkpointPath), "utf8");
    return serialized.trim() ? JSON.parse(serialized) : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const inputId = readArgument("input", "fire:100");
const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`Unknown metagame input: ${inputId}`);

const partnerLimit = positiveInteger(readArgument("partner-limit", "48"), 48, 32);
const maxCandidates = Math.max(0, Math.floor(Number(readArgument("max-candidates", "0")) || 0));
const maxWorkers = positiveInteger(readArgument("max-workers", "20"), 20);
const savedProgress = await readProgress(readArgument("checkpoint-path", ""));
// A model revision intentionally starts all candidate ratings over.  The
// workflow's completion gate already checks this version; mirror it here so
// an older fully-populated checkpoint cannot produce a zero-shard no-op.
const progress = savedProgress?.context?.version === METAGAME_V8_MODEL_VERSION
  ? savedProgress
  : null;
const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const candidateIdsByPosition = candidatePools.allByPosition.map((candidates) => (
  (maxCandidates ? candidates.slice(0, maxCandidates) : candidates).map((character) => String(character.id))
));
const plan = buildMetagameCandidateShardPlan(
  candidateIdsByPosition,
  progress?.resultsByPosition,
  { maxWorkers },
);

process.stdout.write(`${JSON.stringify({
  include: plan.map(({ position, shard, candidateIndices }) => ({
    input: inputId,
    output_directory: inputId.replaceAll(":", "-"),
    position,
    shard,
    candidate_indices: candidateIndices.join(","),
  })),
})}\n`);

