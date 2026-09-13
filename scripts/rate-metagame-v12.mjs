import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import {
  buildMetagameV7CandidatePools,
  evaluateMetagameV7Deck,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";
import {
  METAGAME_V12_MODEL_VERSION,
  buildMetagameV12CounterfactualReplacementDecks,
  buildMetagameV12GlobalBaselineDecks,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
  rankMetagameV12Characters,
  rateMetagameV12Character,
} from "../src/core/metagame-v12.js";
import {
  createMetagameV12FinalizationState,
  isMetagameV12FinalizationStateCompatible,
  metagameV12FinalizationCursorSignature,
} from "../src/core/metagame-v12-finalization.js";
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
    "機会勝率差", "安定補正後差", "同一4枠差し替え勝率差", "差し替え安定補正後差",
    "候補勝率", "代替勝率", "候補デッキ", "代替デッキ", "同一4枠差し替えデッキ", "評価状態",
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
    character.counterfactualWinGain ?? "",
    character.counterfactualRobustWinGain ?? "",
    character.candidateExpectedWinRate,
    character.benchmarkExpectedWinRate,
    character.bestDeck.names.join(" / "),
    character.baselineDeck.names.join(" / "),
    character.counterfactualReplacementDeck?.names?.join(" / ") ?? "",
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
  await fs.writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
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
const baselineDeckLimit = positiveInteger(readArgument("baseline-deck-limit", "32"), 32, 8);
const baselineBeamWidth = positiveInteger(readArgument("baseline-beam-width", "2000"), 2000, 500);
const replacementDeckLimit = positiveInteger(readArgument("replacement-deck-limit", "24"), 24, 1);
const replacementBeamWidth = positiveInteger(readArgument("replacement-beam-width", "4000"), 4000, 500);
const counterfactualAnchorLimit = positiveInteger(readArgument("counterfactual-anchor-limit", "3"), 3, 1);
const finalizationCheckpointEvery = positiveInteger(readArgument("finalization-checkpoint-every", "25"), 25, 1);
const finalizationCheckpointIntervalSeconds = positiveInteger(readArgument("finalization-checkpoint-interval-seconds", "60"), 60, 5);
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
if (candidateIndices && !/^[1-5]$/.test(requestedPosition)) throw new Error("--candidate-indices requires one explicit --position from 1 through 5");

const outputRoot = readArgument("output-root", "reports/metagame-ratings-v12-team-opportunity");
const timeBudgetSeconds = Math.max(0, Number(readArgument("time-budget-seconds", "0")) || 0);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.resolve(projectRoot, outputRoot, inputId.replaceAll(":", "-"));
const checkpointArgument = readArgument("checkpoint-path", "");
const checkpointPath = checkpointArgument ? path.resolve(projectRoot, checkpointArgument) : path.join(outputDirectory, "progress.json");
const mergeCheckpointPaths = readArgument("merge-checkpoint-paths", "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(projectRoot, entry));
const finalizeOnly = readArgument("finalize-only", "false").toLowerCase() === "true";

const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
const nonExactMatches = resolvedInput.audit.filter((entry) => !["exact", "high"].includes(entry.confidence));
console.log(`V12固定環境: ${resolvedInput.label} / 候補 ${resolvedInput.environmentPools.map((pool) => pool.length).join(", ")}体`);
for (const match of nonExactMatches) console.warn(`  ${match.position}枠 ${match.inputName} -> ${match.name ?? "未解決"} [${match.confidence}]`);

const environmentDecks = createMetagameV12EnvironmentDecks(resolvedInput, { count: environmentCount, environmentVariants });
const teamScenarios = createMetagameV12TeamScenarios(resolvedInput, { environmentDecks, count: environmentCount });
const candidatePools = buildMetagameV7CandidatePools(resolvedInput, CHARACTER_CATALOG, { partnerLimit });
const selectedCandidatesByPosition = [1, 2, 3, 4, 5].map((position) => {
  const candidates = candidatePools.allByPosition[position - 1];
  return maxCandidates ? candidates.slice(0, maxCandidates) : candidates;
});
const METAGAME_V12_BATTLE_SEMANTICS_VERSION = "opportunity-baseline-v4";
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
  baselineDeckLimit,
  baselineBeamWidth,
  turns,
  maxCandidates: maxCandidates || null,
  candidateIdsByPosition: selectedCandidatesByPosition.map((candidates) => candidates.map((character) => String(character.id))),
};

await fs.mkdir(outputDirectory, { recursive: true });
const loadedCheckpoint = await readCheckpoint(checkpointPath, checkpointContext);
const resultsByPosition = [0, 1, 2, 3, 4].map((index) => new Map((loadedCheckpoint?.resultsByPosition?.[index] ?? []).map((rating) => [String(rating.id), rating])));
const evaluationCache = new Map();
hydrateMetagameV12EvaluationCache(evaluationCache, loadedCheckpoint?.evaluatedDeckPool);
let finalizationState = loadedCheckpoint?.finalizationState ?? null;
const mergedCheckpoints = await Promise.all(mergeCheckpointPaths.map((entry) => readCheckpoint(entry, checkpointContext)));
for (const checkpoint of mergedCheckpoints) {
  if (!checkpoint) continue;
  for (const [index, ratings] of (checkpoint.resultsByPosition ?? []).entries()) {
    if (!resultsByPosition[index]) continue;
    for (const rating of ratings ?? []) resultsByPosition[index].set(String(rating.id), rating);
  }
  hydrateMetagameV12EvaluationCache(evaluationCache, checkpoint.evaluatedDeckPool);
  if (!finalizationState && checkpoint.finalizationState) finalizationState = checkpoint.finalizationState;
}

const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;
const finalizationDeadlineReached = (guardMs = 15000) => Number.isFinite(deadline) && Date.now() + guardMs >= deadline;
let stoppedEarly = false;
async function saveProgress(status = "in_progress") {
  await writeCheckpoint(checkpointPath, {
    status,
    updatedAt: new Date().toISOString(),
    context: checkpointContext,
    sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
    finalizationState,
    resultsByPosition: resultsByPosition.map((ratings) => [...ratings.values()]),
    evaluatedDeckPool: serializeMetagameV12EvaluationCache(evaluationCache),
  });
}

const positionsToEvaluate = requestedPosition === "all" ? [1, 2, 3, 4, 5] : requestedPosition === "next" ? [resultsByPosition.findIndex((ratings, index) => ratings.size < selectedCandidatesByPosition[index].length) + 1].filter(Boolean) : [Number(requestedPosition)];
if (candidateIndices) {
  const selectedCandidates = selectedCandidatesByPosition[positionsToEvaluate[0] - 1];
  for (const candidateIndex of candidateIndices) if (candidateIndex >= selectedCandidates.length) throw new Error(`Candidate index ${candidateIndex} is outside position ${positionsToEvaluate[0]}`);
}

if (!finalizeOnly) {
  for (const position of positionsToEvaluate) {
    const selectedCandidates = selectedCandidatesByPosition[position - 1];
    const results = resultsByPosition[position - 1];
    const selectedWork = selectedCandidates.map((character, index) => ({ character, index })).filter(({ index }) => !candidateIndices || candidateIndices.has(index));
    console.log(`${position}枠目: ${selectedWork.length}/${selectedCandidates.length}体をV12評価`);
    let processedWork = 0;
    for (const { index, character } of selectedWork) {
      if (results.has(String(character.id))) continue;
      if (Date.now() >= deadline) { stoppedEarly = true; break; }
      const rating = rateMetagameV12Character(character, position, resolvedInput, candidatePools, teamScenarios, { autoDeckLimit, alternativeDeckLimit, anchorDeckLimit, beamWidth, turns, evaluationCache });
      if (rating) results.set(String(rating.id), rating);
      processedWork += 1;
      await saveProgress();
      if (processedWork % 10 === 0 || processedWork === selectedWork.length) console.log(`  ${processedWork}/${selectedWork.length} (global index ${index}, eval cache ${evaluationCache.size})`);
    }
    if (stoppedEarly) break;
  }
}

const allRatingsComplete = resultsByPosition.every((ratings, index) => ratings.size >= selectedCandidatesByPosition[index].length);
if (stoppedEarly || !allRatingsComplete) {
  await saveProgress();
  const completed = resultsByPosition.reduce((sum, ratings) => sum + ratings.size, 0);
  const total = selectedCandidatesByPosition.reduce((sum, candidates) => sum + candidates.length, 0);
  console.log(`V12 progress saved: ${completed}/${total}.`);
  process.exit(0);
}

await saveProgress("finalizing");
const globalBaselineCandidates = buildMetagameV12GlobalBaselineDecks(resolvedInput, candidatePools, { baselineDeckLimit, baselineBeamWidth });
let globalBaselineNewEvaluations = 0;
for (const entry of globalBaselineCandidates) {
  const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
  if (evaluationCache.has(key)) continue;
  if (finalizationDeadlineReached()) { stoppedEarly = true; break; }
  evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));
  globalBaselineNewEvaluations += 1;
  if (globalBaselineNewEvaluations % finalizationCheckpointEvery === 0) await saveProgress("finalizing");
}
if (globalBaselineNewEvaluations) await saveProgress("finalizing");
if (stoppedEarly) {
  await saveProgress("finalizing");
  if (globalBaselineNewEvaluations === 0) throw new Error(`V12 global-baseline finalization made no forward progress before its ${timeBudgetSeconds}s time budget expired. Refusing to self-dispatch another silent no-progress segment.`);
  console.log(`V12 finalization chunk stopped safely during global baseline after ${globalBaselineNewEvaluations} new deck evaluations.`);
  process.exit(0);
}

let sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
let reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, { totalCost: resolvedInput.totalCost });
function applyReconciledRatings() {
  for (const [index, ratings] of reconciledByPosition.entries()) {
    resultsByPosition[index].clear();
    for (const rating of ratings) resultsByPosition[index].set(String(rating.id), rating);
  }
}
applyReconciledRatings();

const finalizationOptions = { counterfactualAnchorLimit, replacementDeckLimit, replacementBeamWidth };
if (!isMetagameV12FinalizationStateCompatible(finalizationState, finalizationOptions)) {
  finalizationState = createMetagameV12FinalizationState(resultsByPosition, sharedDeckPool, finalizationOptions);
  await saveProgress("finalizing");
  console.log(`V12 finalization plan frozen: ${finalizationState.plan.length} anchor shells.`);
} else {
  console.log(`V12 finalization resume: ${finalizationState.cursor.planIndex}/${finalizationState.plan.length} anchor shells, replacement ${finalizationState.cursor.replacementIndex}.`);
}

let segmentCounterfactualNewEvaluations = 0;
let lastFinalizationCheckpointAt = Date.now();
let evaluationsAtLastCheckpoint = 0;
const segmentStartCursor = metagameV12FinalizationCursorSignature(finalizationState);
const segmentStartCacheSize = evaluationCache.size;
const segmentStartProcessedCandidateDeckCount = finalizationState.processedCandidateDeckCount ?? 0;
finalizationState.segmentCount = (finalizationState.segmentCount ?? 0) + 1;
async function maybeSaveFinalizationProgress(force = false) {
  const elapsedMs = Date.now() - lastFinalizationCheckpointAt;
  const evaluationsSinceSave = segmentCounterfactualNewEvaluations - evaluationsAtLastCheckpoint;
  if (!force && evaluationsSinceSave < finalizationCheckpointEvery && elapsedMs < finalizationCheckpointIntervalSeconds * 1000) return;
  await saveProgress("finalizing");
  lastFinalizationCheckpointAt = Date.now();
  evaluationsAtLastCheckpoint = segmentCounterfactualNewEvaluations;
}

if (finalizationState.phase !== "complete") {
  counterfactualAudit:
  for (let planIndex = finalizationState.cursor.planIndex; planIndex < finalizationState.plan.length; planIndex += 1) {
    if (finalizationDeadlineReached()) { stoppedEarly = true; break; }
    const planEntry = finalizationState.plan[planIndex];
    const position = Number(planEntry.position);
    const rating = resultsByPosition[position - 1]?.get(String(planEntry.ratingId));
    if (!rating) {
      finalizationState.cursor = { planIndex: planIndex + 1, replacementIndex: 0 };
      finalizationState.lastProgressAt = new Date().toISOString();
      await maybeSaveFinalizationProgress();
      continue;
    }
    const anchorRating = { ...rating, bestDeck: { ...(rating.bestDeck ?? {}), ids: [...planEntry.anchorIds] } };
    if (finalizationDeadlineReached()) { stoppedEarly = true; break; }
    const replacements = buildMetagameV12CounterfactualReplacementDecks(anchorRating, position, resolvedInput, candidatePools, { replacementDeckLimit, replacementBeamWidth });
    const startReplacementIndex = planIndex === finalizationState.cursor.planIndex ? finalizationState.cursor.replacementIndex : 0;
    if (startReplacementIndex > replacements.length) throw new Error(`V12 finalization cursor is invalid for plan ${planIndex}: ${startReplacementIndex} > ${replacements.length}.`);
    for (let replacementIndex = startReplacementIndex; replacementIndex < replacements.length; replacementIndex += 1) {
      if (finalizationDeadlineReached()) { stoppedEarly = true; break counterfactualAudit; }
      const entry = replacements[replacementIndex];
      const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
      if (!evaluationCache.has(key)) {
        evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));
        segmentCounterfactualNewEvaluations += 1;
        finalizationState.newEvaluationCount = (finalizationState.newEvaluationCount ?? 0) + 1;
      }
      finalizationState.processedCandidateDeckCount = (finalizationState.processedCandidateDeckCount ?? 0) + 1;
      finalizationState.cursor = { planIndex, replacementIndex: replacementIndex + 1 };
      finalizationState.lastProgressAt = new Date().toISOString();
      await maybeSaveFinalizationProgress();
    }
    finalizationState.cursor = { planIndex: planIndex + 1, replacementIndex: 0 };
    finalizationState.lastProgressAt = new Date().toISOString();
    await maybeSaveFinalizationProgress();
  }
}

if (stoppedEarly) {
  await maybeSaveFinalizationProgress(true);
  const cursorAdvanced = metagameV12FinalizationCursorSignature(finalizationState) !== segmentStartCursor;
  const cacheAdvanced = evaluationCache.size !== segmentStartCacheSize;
  const candidateAdvanced = (finalizationState.processedCandidateDeckCount ?? 0) !== segmentStartProcessedCandidateDeckCount;
  if (!cursorAdvanced && !cacheAdvanced && !candidateAdvanced) throw new Error(`V12 finalization made no forward progress before its ${timeBudgetSeconds}s time budget expired. Refusing to self-dispatch another silent no-progress segment.`);
  console.log(`V12 finalization paused at ${finalizationState.cursor.planIndex}/${finalizationState.plan.length} anchor shells (${segmentCounterfactualNewEvaluations} new deck evaluations this segment).`);
  process.exit(0);
}

finalizationState.phase = "complete";
finalizationState.cursor = { planIndex: finalizationState.plan.length, replacementIndex: 0 };
finalizationState.lastProgressAt = new Date().toISOString();
await maybeSaveFinalizationProgress(true);
if (segmentCounterfactualNewEvaluations) {
  sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
  reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, { totalCost: resolvedInput.totalCost });
  applyReconciledRatings();
}

const counterfactualCandidateDeckCount = finalizationState.processedCandidateDeckCount ?? 0;
const counterfactualNewEvaluations = finalizationState.newEvaluationCount ?? 0;
const rankingsByPosition = resultsByPosition.map((ratings, index) => ({ position: index + 1, characters: rankMetagameV12Characters([...ratings.values()]) }));
const sharedPoolImprovementCount = rankingsByPosition.reduce((sum, slot) => sum + slot.characters.filter((character) => character.sharedPoolImprovedCandidate || character.sharedPoolImprovedBaseline).length, 0);
const report = {
  generatedAt: new Date().toISOString(),
  model: {
    version: METAGAME_V12_MODEL_VERSION,
    sharedPoolVersion: METAGAME_V12_SHARED_POOL_VERSION,
    battleFormat: "5v5",
    objective: "完成デッキの強さを確認した上で、他4枠を固定して対象キャラだけ差し替える反実仮想比較から、そのキャラ自身の実貢献を検証する。",
    scoringPolicy: "同一4枠の差し替え比較を個人貢献の第一根拠にする。強い4人に運ばれたキャラは差し替え安定補正後差が正でなければ上位群へ入れない。差し替え証拠が無い場合だけ従来の全体再最適化機会費用へフォールバックする。",
    costPolicy: "候補を外した際のコストを5枠全体で再配分し、さらに全合法候補から作る共有基準デッキを比較対象へ追加する。高コストの機会損失を小さなパートナー候補集合だけで過小評価しない。",
    environmentPolicy: "提示環境だけを使い、10人内の同一キャラ重複を人工的に避けない。伝説判定は『伝』とLEGENDの両方を認識する。",
    performancePolicy: "各候補の直接探索と共有基準デッキは既存キャッシュを再利用する。全shard統合後、各キャラについて構成の異なる強い完成デッキを最大3本だけ一度固定して監査し、各デッキで他4枠固定の差し替え候補を最大24本探索する。監査計画とカーソルをcheckpointへ保存し、再開時に計算範囲を増殖させず未処理位置から継続する。",
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
    baselineDeckLimit,
    baselineBeamWidth,
    replacementDeckLimit,
    replacementBeamWidth,
    counterfactualAnchorLimit,
    finalizationPlanLength: finalizationState.plan.length,
    finalizationSegmentCount: finalizationState.segmentCount,
    globalBaselineCandidateCount: globalBaselineCandidates.length,
    globalBaselineNewEvaluationCount: globalBaselineNewEvaluations,
    counterfactualCandidateDeckCount,
    counterfactualNewEvaluationCount: counterfactualNewEvaluations,
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
await saveProgress("complete");
console.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated this segment).`);
console.log(`V12 matched-slot counterfactuals: ${counterfactualCandidateDeckCount} planned/processed decks (${counterfactualNewEvaluations} newly evaluated since the frozen plan).`);
console.log(`V12 shared pool: ${sharedDeckPool.length} evaluated decks / ${sharedPoolImprovementCount} ratings changed.`);
console.log(`V12 report: ${path.relative(projectRoot, outputDirectory)}`);
