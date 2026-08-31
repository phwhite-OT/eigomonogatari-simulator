import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import {
  METAGAME_V12_MODEL_VERSION,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
  rankMetagameV12Characters,
  rateMetagameV12Character,
} from "../src/core/metagame-v12.js";
import {
  METAGAME_V12_SHARED_POOL_VERSION,
  buildMetagameV12SharedDeckPool,
  hydrateMetagameV12EvaluationCache,
  reconcileMetagameV12RatingsByPosition,
  serializeMetagameV12EvaluationCache,
} from "../src/core/metagame-v12-shared-pool.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvReport(report) {
  const headers = [
    "枠", "順位", "キャラID", "名前", "コスト", "HP", "Power", "スキルターン", "スキル種類",
    "機会勝率差", "安定補正後差", "候補勝率", "代替勝率", "候補デッキ", "代替デッキ", "評価状態",
  ];
  const rows = report.rankingsByPosition.flatMap((slot) => slot.characters.map((character) => [
    slot.position,
    character.rank,
    character.id,
    character.name,
    character.cost,
    character.hp,
    character.pow,
    character.skillTurn,
    character.skillType,
    character.opportunityWinGain,
    character.robustOpportunityWinGain,
    character.candidateExpectedWinRate,
    character.benchmarkExpectedWinRate,
    character.bestDeck.names.join(" / "),
    character.baselineDeck.names.join(" / "),
    character.evaluationStatus,
  ]));
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function readCheckpoint(checkpointPath, context) {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    if (stableJson(parsed.context) !== stableJson(context)) {
      console.warn(`Ignoring incompatible checkpoint: ${checkpointPath}`);
      return null;
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      console.warn(`Ignoring unreadable checkpoint: ${checkpointPath}`);
      return null;
    }
    throw error;
  }
}

async function writeCheckpoint(checkpointPath, checkpoint) {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, checkpointPath);
}

const inputId = readArgument("input", "fire:100");
const input = METAGAME_V8_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`入力 ${inputId} が見つかりません。`);

const environmentCount = positiveInteger(readArgument("environment-count", "72"), 72, 9);
const environmentVariants = positiveInteger(readArgument("environment-variants", "2"), 2, 1);
const partnerLimit = positiveInteger(readArgument("partner-limit", "48"), 48, 32);
const autoDeckLimit = positiveInteger(readArgument("auto-deck-limit", "3"), 3, 1);
const alternativeDeckLimit = positiveInteger(readArgument("alternative-deck-limit", "3"), 3, 1);
const anchorDeckLimit = Math.max(0, Math.floor(Number(readArgument("anchor-deck-limit", "0")) || 0));
const beamWidth = positiveInteger(readArgument("beam-width", "500"), 500, 50);
const turns = Math.min(12, positiveInteger(readArgument("turns", "12"), 12, 1));
const maxCandidates = Math.max(0, Math.floor(Number(readArgument("max-candidates", "0")) || 0));
const requestedPosition = readArgument("position", "all").toLowerCase();
if (!/^(all|next|[1-5])$/.test(requestedPosition)) throw new Error(`Invalid --position value: ${requestedPosition}`);

const candidateIndicesArgument = readArgument("candidate-indices", "").trim();
const candidateIndices = candidateIndicesArgument
  ? new Set(candidateIndicesArgument.split(",").map((value) => {
    if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid candidate index: ${value}`);
    return Number(value);
  }))
  : null;
if (candidateIndices && !/^[1-5]$/.test(requestedPosition)) {
  throw new Error("--candidate-indices requires one explicit --position from 1 through 5");
}

const outputRoot = readArgument("output-root", "reports/metagame-ratings-v12-team-opportunity");
const timeBudgetSeconds = Math.max(0, Number(readArgument("time-budget-seconds", "0")) || 0);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.resolve(projectRoot, outputRoot, inputId.replaceAll(":", "-"));
const checkpointArgument = readArgument("checkpoint-path", "");
const checkpointPath = checkpointArgument
  ? path.resolve(projectRoot, checkpointArgument)
  : path.join(outputDirectory, "progress.json");
const mergeCheckpointPaths = readArgument("merge-checkpoint-paths", "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(projectRoot, entry));
const finalizeOnly = readArgument("finalize-only", "false").toLowerCase() === "true";

const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const nonExactMatches = resolvedInput.audit.filter((entry) => !["exact", "high"].includes(entry.confidence));
console.log(`V12固定環境: ${resolvedInput.label} / 候補 ${resolvedInput.environmentPools.map((pool) => pool.length).join(", ")}体`);
for (const match of nonExactMatches) {
  console.warn(`  ${match.position}枠 ${match.inputName} -> ${match.name ?? "未解決"} [${match.confidence}]`);
}

const environmentDecks = createMetagameV12EnvironmentDecks(resolvedInput, {
  count: environmentCount,
  environmentVariants,
});
const teamScenarios = createMetagameV12TeamScenarios(resolvedInput, {
  environmentDecks,
  count: environmentCount,
});
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const selectedCandidatesByPosition = [1, 2, 3, 4, 5].map((position) => {
  const candidates = candidatePools.allByPosition[position - 1];
  return maxCandidates ? candidates.slice(0, maxCandidates) : candidates;
});

const METAGAME_V12_BATTLE_SEMANTICS_VERSION = "defense-outcome-v3";

const checkpointContext = {
  version: METAGAME_V12_MODEL_VERSION,
  battleSemantics: METAGAME_V12_BATTLE_SEMANTICS_VERSION,
  inputId,
  environmentCount,
  environmentVariants,
  teamScenarioCount: teamScenarios.length,
  partnerLimit,
  autoDeckLimit,
  alternativeDeckLimit,
  anchorDeckLimit,
  beamWidth,
  turns,
  maxCandidates: maxCandidates || null,
  candidateIdsByPosition: selectedCandidatesByPosition.map((candidates) => candidates.map((character) => String(character.id))),
};

await fs.mkdir(outputDirectory, { recursive: true });
const loadedCheckpoint = await readCheckpoint(checkpointPath, checkpointContext);
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => (
  new Map((loadedCheckpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating]))
));
const evaluationCache = new Map();
hydrateMetagameV12EvaluationCache(evaluationCache, loadedCheckpoint?.evaluatedDeckPool);
const mergedCheckpoints = await Promise.all(mergeCheckpointPaths.map((entry) => readCheckpoint(entry, checkpointContext)));
for (const checkpoint of mergedCheckpoints) {
  if (!checkpoint) continue;
  for (const [index, ratings] of (checkpoint.resultsByPosition ?? []).entries()) {
    if (!resultsByPosition[index]) continue;
    for (const rating of ratings ?? []) resultsByPosition[index].set(String(rating.id), rating);
  }
  hydrateMetagameV12EvaluationCache(evaluationCache, checkpoint.evaluatedDeckPool);
}

const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;
let stoppedEarly = false;

async function saveProgress(status = "in_progress") {
  await writeCheckpoint(checkpointPath, {
    status,
    updatedAt: new Date().toISOString(),
    context: checkpointContext,
    sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
    resultsByPosition: resultsByPosition.map((ratings) => [...ratings.values()]),
    evaluatedDeckPool: serializeMetagameV12EvaluationCache(evaluationCache),
  });
}

const positionsToEvaluate = requestedPosition === "all"
  ? [1, 2, 3, 4, 5]
  : requestedPosition === "next"
    ? [resultsByPosition.findIndex((ratings, index) => ratings.size < selectedCandidatesByPosition[index].length) + 1].filter(Boolean)
    : [Number(requestedPosition)];

if (candidateIndices) {
  const selectedCandidates = selectedCandidatesByPosition[positionsToEvaluate[0] - 1];
  for (const candidateIndex of candidateIndices) {
    if (candidateIndex >= selectedCandidates.length) throw new Error(`Candidate index ${candidateIndex} is outside position ${positionsToEvaluate[0]}`);
  }
}

if (!finalizeOnly) {
  for (const position of positionsToEvaluate) {
    const selectedCandidates = selectedCandidatesByPosition[position - 1];
    const results = resultsByPosition[position - 1];
    const selectedWork = selectedCandidates
      .map((character, index) => ({ character, index }))
      .filter(({ index }) => !candidateIndices || candidateIndices.has(index));
    console.log(`${position}枠目: ${selectedWork.length}/${selectedCandidates.length}体をV12評価`);
    let processedWork = 0;
    for (const { index, character } of selectedWork) {
      if (results.has(String(character.id))) continue;
      if (Date.now() >= deadline) {
        stoppedEarly = true;
        break;
      }
      const rating = rateMetagameV12Character(
        character,
        position,
        resolvedInput,
        candidatePools,
        teamScenarios,
        {
          autoDeckLimit,
          alternativeDeckLimit,
          anchorDeckLimit,
          beamWidth,
          turns,
          evaluationCache,
        },
      );
      if (rating) results.set(String(rating.id), rating);
      processedWork += 1;
      // Save both the rating and every completed deck result. On resume, those
      // 72-scenario battles can be reused instead of being repeated.
      await saveProgress();
      if (processedWork % 10 === 0 || processedWork === selectedWork.length) {
        console.log(`  ${processedWork}/${selectedWork.length} (global index ${index}, eval cache ${evaluationCache.size})`);
      }
    }
    if (stoppedEarly) break;
  }
}

const allRatingsComplete = resultsByPosition.every((ratings, index) => (
  ratings.size >= selectedCandidatesByPosition[index].length
));

if (stoppedEarly || !allRatingsComplete) {
  await saveProgress();
  const completed = resultsByPosition.reduce((sum, ratings) => sum + ratings.size, 0);
  const total = selectedCandidatesByPosition.reduce((sum, candidates) => sum + candidates.length, 0);
  console.log(`V12 progress saved: ${completed}/${total}.`);
  process.exit(0);
}

// Zero-simulation second pass: every deck already evaluated by any candidate
// or shard becomes evidence for every character that occupies the same slot.
// Likewise, any evaluated deck that excludes a character can serve as that
// character's opportunity-cost baseline. Exact scenarioValues are retained,
// so the paired robustness correction is recomputed rather than estimated.
const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
const reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {
  totalCost: resolvedInput.totalCost,
});
for (const [index, ratings] of reconciledByPosition.entries()) {
  resultsByPosition[index].clear();
  for (const rating of ratings) resultsByPosition[index].set(String(rating.id), rating);
}
await saveProgress("complete");

const rankingsByPosition = resultsByPosition.map((ratings, index) => ({
  position: index + 1,
  characters: rankMetagameV12Characters([...ratings.values()]),
}));

const sharedPoolImprovementCount = rankingsByPosition.reduce((sum, slot) => (
  sum + slot.characters.filter((character) => character.sharedPoolImprovedCandidate || character.sharedPoolImprovedBaseline).length
), 0);
const report = {
  generatedAt: new Date().toISOString(),
  model: {
    version: METAGAME_V12_MODEL_VERSION,
    sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
    battleFormat: "5v5",
    objective: "候補キャラ入りの最善デッキと、そのキャラを禁止して同じ総コスト上限で再最適化した最善デッキを比較し、チーム勝率差をキャラ価値とする。",
    scoringPolicy: "最終順位に個人攻撃・個人耐久・役割・スキル発動の固定加点を使わない。負のチーム貢献も保持する。",
    costPolicy: "候補を外した際のコストを5枠全体で再配分するため、コスト効率は機会費用比較へ内包する。",
    environmentPolicy: "提示環境だけを使い、10人内の同一キャラ重複を人工的に避けない。伝説判定は『伝』とLEGENDの両方を認識する。",
    performancePolicy: "各候補の直接探索は候補デッキ3本+除外代替3本のまま増やさない。全候補・全shardの計算後、既に72シナリオ評価済みのデッキを共有プール化して全カードを再集計するため、共有処理による追加戦闘は0。checkpointにも評価済みデッキを保存し、再開時の重複戦闘を避ける。",
  },
  context: {
    inputId: resolvedInput.id,
    label: resolvedInput.label,
    allowedAttributes: resolvedInput.allowedAttributes,
    totalCost: resolvedInput.totalCost,
    turns,
    requestedEnvironmentCount: environmentCount,
    environmentCount: environmentDecks.length,
    environmentVariants,
    teamScenarioCount: teamScenarios.length,
    partnerLimit,
    autoDeckLimit,
    alternativeDeckLimit,
    beamWidth,
    sharedEvaluatedDeckCount: sharedDeckPool.length,
    sharedPoolImprovementCount,
    eligibleCandidateCountByPosition: candidatePools.allByPosition.map((pool) => pool.length),
  },
  inputAudit: {
    source: resolvedInput.source,
    environmentPoolCounts: resolvedInput.environmentPools.map((pool) => pool.length),
    invalidExamples: resolvedInput.invalidExamples,
    nonExactMatches,
  },
  rankingsByPosition,
};

await fs.writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDirectory, "ranking.csv"), csvReport(report), "utf8");
console.log(`V12 shared pool: ${sharedDeckPool.length} evaluated decks / ${sharedPoolImprovementCount} ratings changed.`);
console.log(`V12 report: ${path.relative(projectRoot, outputDirectory)}`);
