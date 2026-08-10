import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V7_INPUTS } from "../src/data/metagame-v7-inputs.js";
import {
  METAGAME_V7_MODEL_VERSION,
  buildMetagameV7CandidatePools,
  createMetagameV7EnvironmentDecks,
  rankMetagameV7Characters,
  rateMetagameV7Character,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvReport(report) {
  const headers = [
    "枠", "順位", "キャラID", "名前", "コスト", "HP", "Power", "スキルターン", "スキル種類",
    "v7下限勝率", "完成デッキ勝率", "完成デッキコスト", "残コスト", "デッキ探索数", "運用例採用",
    "完成デッキ",
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
    character.v7Score,
    character.bestDeck.expectedWinRate,
    character.bestDeck.totalCost,
    character.bestDeck.remainingCost,
    character.evaluatedDeckCount,
    character.bestDeck.origin === "example" ? "はい" : "いいえ",
    character.bestDeck.names.join(" / "),
  ]));
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function stableJson(value) {
  return JSON.stringify(value);
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
  const temporaryPath = `${checkpointPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, checkpointPath);
}

const inputId = readArgument("input", "fire:100");
const input = METAGAME_V7_INPUTS.find((entry) => entry.id === inputId);
if (!input) throw new Error(`v7入力 ${inputId} が見つかりません。`);

const environmentCount = positiveInteger(readArgument("environment-count", "72"), 72, 5);
const partnerLimit = positiveInteger(readArgument("partner-limit", "24"), 24, 8);
const autoDeckLimit = positiveInteger(readArgument("auto-deck-limit", "8"), 8, 1);
const beamWidth = positiveInteger(readArgument("beam-width", "500"), 500, 50);
const turns = Math.min(12, positiveInteger(readArgument("turns", "12"), 12, 1));
const maxCandidates = Math.max(0, Math.floor(Number(readArgument("max-candidates", "0")) || 0));
const requestedPosition = readArgument("position", "all").toLowerCase();
if (!/^(all|next|[1-5])$/.test(requestedPosition)) {
  throw new Error(`Invalid --position value: ${requestedPosition}`);
}
const outputRoot = readArgument("output-root", "reports/metagame-ratings-v7");
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
console.log(`v7固定環境: ${resolvedInput.label} / 環境候補 ${resolvedInput.environmentPools.map((pool) => pool.length).join(", ")}体`);
console.log(`名前照合: ${resolvedInput.audit.length}件（要確認 ${nonExactMatches.length}件）`);
for (const match of nonExactMatches) {
  console.warn(`  ${match.position}枠 ${match.inputName} -> ${match.name ?? "未解決"} [${match.confidence}]`);
}
if (resolvedInput.invalidExamples.length) {
  console.warn(`スキルターンまたはコスト制限を満たさないデッキ例: ${resolvedInput.invalidExamples.join(", ")}（評価用デッキ候補には使いません）`);
}

const environmentDecks = createMetagameV7EnvironmentDecks(resolvedInput, { count: environmentCount });
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const selectedCandidatesByPosition = [1, 2, 3, 4, 5].map((position) => {
  const candidates = candidatePools.allByPosition[position - 1];
  return maxCandidates ? candidates.slice(0, maxCandidates) : candidates;
});
const checkpointContext = {
  version: METAGAME_V7_MODEL_VERSION,
  inputId,
  environmentCount,
  partnerLimit,
  autoDeckLimit,
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
const mergedCheckpoints = await Promise.all(mergeCheckpointPaths.map((entry) => readCheckpoint(entry, checkpointContext)));
for (const checkpoint of mergedCheckpoints) {
  if (!checkpoint) continue;
  for (const [index, ratings] of (checkpoint.resultsByPosition ?? []).entries()) {
    if (!resultsByPosition[index]) continue;
    for (const rating of ratings ?? []) resultsByPosition[index].set(String(rating.id), rating);
  }
}
const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;
let stoppedEarly = false;

async function saveProgress(status = "in_progress") {
  await writeCheckpoint(checkpointPath, {
    status,
    updatedAt: new Date().toISOString(),
    context: checkpointContext,
    resultsByPosition: resultsByPosition.map((ratings) => [...ratings.values()]),
  });
}

if (loadedCheckpoint) {
  const restored = resultsByPosition.reduce((sum, ratings) => sum + ratings.size, 0);
  console.log(`Resuming checkpoint: ${restored} character ratings restored`);
}
if (mergeCheckpointPaths.length) {
  const merged = mergedCheckpoints.filter(Boolean).length;
  console.log(`Merged ${merged}/${mergeCheckpointPaths.length} position checkpoints`);
}

const positionsToEvaluate = requestedPosition === "all"
  ? [1, 2, 3, 4, 5]
  : requestedPosition === "next"
    ? [resultsByPosition.findIndex((ratings, index) => ratings.size < selectedCandidatesByPosition[index].length) + 1].filter(Boolean)
    : [Number(requestedPosition)];

if (!finalizeOnly) {
  for (const position of positionsToEvaluate) {
    const candidates = candidatePools.allByPosition[position - 1];
    const selectedCandidates = selectedCandidatesByPosition[position - 1];
    const results = resultsByPosition[position - 1];
    console.log(`${position}枠目: ${selectedCandidates.length}/${candidates.length}体を評価`);
    for (const [index, character] of selectedCandidates.entries()) {
      if (results.has(String(character.id))) continue;
      if (Date.now() >= deadline) {
        stoppedEarly = true;
        break;
      }
      const rating = rateMetagameV7Character(
        character,
        position,
        resolvedInput,
        candidatePools,
        environmentDecks,
        { autoDeckLimit, beamWidth, turns },
      );
      if (rating) results.set(String(rating.id), rating);
      if ((index + 1) % 5 === 0) await saveProgress();
      if ((index + 1) % 20 === 0 || index + 1 === selectedCandidates.length) {
        console.log(`  ${index + 1}/${selectedCandidates.length}`);
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
  const reason = stoppedEarly
    ? "Time budget reached"
    : finalizeOnly ? "Finalization found incomplete position checkpoints" : "Selected positions complete";
  console.log(`${reason}. Saved ${completed}/${total} ratings to ${path.relative(projectRoot, checkpointPath)}.`);
  process.exit(0);
}

await saveProgress("complete");
const rankingsByPosition = resultsByPosition.map((ratings, index) => ({
  position: index + 1,
  characters: rankMetagameV7Characters([...ratings.values()]),
}));

const report = {
  generatedAt: new Date().toISOString(),
  model: {
    version: METAGAME_V7_MODEL_VERSION,
    objective: "ユーザー提示の固定環境に対し、コスト100内で完成するデッキの下限勝率をキャラ評価へ使う。",
    environment: "環境は枠別の提示候補からのみ構成し、予測使用率・所持率・自動メタ生成を使わない。",
    characterScope: "属性・コスト・配置・従来のスキルターン制限を満たす全キャラ。",
    costPolicy: "単体コストで割らず、そのキャラを固定した完成5体デッキの結果で比較する。高コストによる残り枠の弱体化、低コストによる全体強化を勝率へ反映する。",
    continuationPolicy: "継続効果は12ターンの戦闘再現で評価し、提示デッキ例は成立済みの運用候補として自動生成候補と同列に検証する。",
    proxyPolicy: "パートナー探索だけに軽量の補助点を用い、最終順位は固定環境との戦闘結果だけで決める。",
  },
  context: {
    inputId: resolvedInput.id,
    label: resolvedInput.label,
    allowedAttributes: resolvedInput.allowedAttributes,
    totalCost: resolvedInput.totalCost,
    turns,
    requestedEnvironmentCount: environmentCount,
    environmentCount: environmentDecks.length,
    partnerLimit,
    autoDeckLimit,
    beamWidth,
    maxCandidates: maxCandidates || null,
    eligibleCandidateCountByPosition: candidatePools.allByPosition.map((pool) => pool.length),
  },
  inputAudit: {
    source: resolvedInput.source,
    environmentPoolCounts: resolvedInput.environmentPools.map((pool) => pool.length),
    invalidExamples: resolvedInput.invalidExamples,
    matches: resolvedInput.audit,
  },
  environmentDecks: environmentDecks.map((deck) => deck.map((character) => ({
    id: String(character.id), name: character.name, cost: character.cost,
  }))),
  environmentPools: resolvedInput.environmentPools.map((pool) => pool.map((character) => ({
    id: String(character.id), name: character.name, cost: character.cost,
  }))),
  rankingsByPosition,
};

await fs.mkdir(outputDirectory, { recursive: true });
const jsonPath = path.join(outputDirectory, "report.json");
const csvPath = path.join(outputDirectory, "report.csv");
await Promise.all([
  fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  fs.writeFile(csvPath, csvReport(report), "utf8"),
]);
console.log(`JSON: ${path.relative(projectRoot, jsonPath)}`);
console.log(`CSV : ${path.relative(projectRoot, csvPath)}`);
