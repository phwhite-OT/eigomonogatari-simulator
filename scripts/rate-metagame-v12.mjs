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
const baselineDeckLimit = positiveInteger(readArgument("baseline-deck-limit", "32"), 32, 8);
const baselineBeamWidth = positiveInteger(readArgument("baseline-beam-width", "2000"), 2000, 500);
const replacementDeckLimit = positiveInteger(readArgument("replacement-deck-limit", "24"), 24, 1);
const replacementBeamWidth = positiveInteger(readArgument("replacement-beam-width", "4000"), 4000, 500);
const counterfactualAnchorLimit = positiveInteger(readArgument("counterfactual-anchor-limit", "3"), 3, 1);
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
const finalizationDeadlineReached = (guardMs = 15000) => Number.isFinite(deadline) && Date.now() + guardMs >= deadline;
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

// Candidate battles are complete. From here on the checkpoint deliberately
// remains resumable: a workflow chunk may stop before GitHub kills the runner,
// persist the evaluated-deck cache, and continue in the next run.
await saveProgress("finalizing");

// Seed a shared baseline from all legal candidates before reconciliation.
// This search is paid once per condition, rather than once per character, so
// cheap strong replacements cannot disappear merely because they missed the
// bounded partner sample used by the direct per-character probes.
const globalBaselineCandidates = buildMetagameV12GlobalBaselineDecks(
  resolvedInput,
  candidatePools,
  { baselineDeckLimit, baselineBeamWidth },
);
let globalBaselineNewEvaluations = 0;
for (const entry of globalBaselineCandidates) {
  const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
  if (evaluationCache.has(key)) continue;
  if (finalizationDeadlineReached()) {
    stoppedEarly = true;
    break;
  }
  evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));
  globalBaselineNewEvaluations += 1;
  if (globalBaselineNewEvaluations % 5 === 0) await saveProgress("finalizing");
}
if (globalBaselineNewEvaluations) await saveProgress("finalizing");
if (stoppedEarly) {
  await saveProgress("finalizing");
  console.log(`V12 finalization chunk stopped safely during global baseline after ${globalBaselineNewEvaluations} new deck evaluations.`);
  process.exit(0);
}

let sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
let reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {
  totalCost: resolvedInput.totalCost,
});
function applyReconciledRatings() {
  for (const [index, ratings] of reconciledByPosition.entries()) {
    resultsByPosition[index].clear();
    for (const rating of ratings) resultsByPosition[index].set(String(rating.id), rating);
  }
}
applyReconciledRatings();

function selectCounterfactualAnchors(rating, position, pool, limit) {
  const positionIndex = position - 1;
  const candidateId = String(rating.id);
  const available = (pool ?? []).filter((entry) => String(entry.ids?.[positionIndex]) === candidateId);
  const selected = [];
  for (const entry of available) {
    if (!selected.length) {
      selected.push(entry);
    } else {
      const minOtherSlotDifference = Math.min(...selected.map((chosen) => (
        entry.ids.reduce((count, id, index) => (
          index === positionIndex || String(id) === String(chosen.ids[index]) ? count : count + 1
        ), 0)
      )));
      if (minOtherSlotDifference >= 2) selected.push(entry);
    }
    if (selected.length >= limit) break;
  }
  for (const entry of available) {
    if (selected.length >= limit) break;
    if (!selected.includes(entry)) selected.push(entry);
  }
  return selected;
}

// Audit several structurally different strong shells for every rated card, not
// only one best deck. Within each shell, only the rated slot may change. This
// catches cards that are passengers in one shell and genuinely useful in another.
let counterfactualNewEvaluations = 0;
let counterfactualCandidateDeckCount = 0;
counterfactualAudit:
for (const [index, ratings] of resultsByPosition.entries()) {
  const position = index + 1;
  for (const rating of ratings.values()) {
    const anchors = selectCounterfactualAnchors(rating, position, sharedDeckPool, counterfactualAnchorLimit);
    const fallbackAnchor = rating.bestDeck?.ids?.length === 5 ? [{ ids: rating.bestDeck.ids }] : [];
    for (const anchor of (anchors.length ? anchors : fallbackAnchor)) {
      const anchorRating = {
        ...rating,
        bestDeck: { ...(rating.bestDeck ?? {}), ids: [...anchor.ids] },
      };
      const replacements = buildMetagameV12CounterfactualReplacementDecks(
        anchorRating,
        position,
        resolvedInput,
        candidatePools,
        { replacementDeckLimit, replacementBeamWidth },
      );
      counterfactualCandidateDeckCount += replacements.length;
      for (const entry of replacements) {
        const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
        if (evaluationCache.has(key)) continue;
        if (finalizationDeadlineReached()) {
          stoppedEarly = true;
          break counterfactualAudit;
        }
        evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));
        counterfactualNewEvaluations += 1;
        if (counterfactualNewEvaluations % 5 === 0) await saveProgress("finalizing");
      }
    }
  }
}
if (counterfactualNewEvaluations) await saveProgress("finalizing");
if (stoppedEarly) {
  await saveProgress("finalizing");
  console.log(`V12 finalization chunk stopped safely after ${counterfactualNewEvaluations} new matched-slot deck evaluations.`);
  process.exit(0);
}
if (counterfactualNewEvaluations) {
  await saveProgress();
  sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
  reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {
    totalCost: resolvedInput.totalCost,
  });
  applyReconciledRatings();
}

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
    objective: "完成デッキの強さを確認した上で、他4枠を固定して対象キャラだけ差し替える反実仮想比較から、そのキャラ自身の実貢献を検証する。",
    scoringPolicy: "同一4枠の差し替え比較を個人貢献の第一根拠にする。強い4人に運ばれたキャラは差し替え安定補正後差が正でなければ上位群へ入れない。差し替え証拠が無い場合だけ従来の全体再最適化機会費用へフォールバックする。",
    costPolicy: "候補を外した際のコストを5枠全体で再配分し、さらに全合法候補から作る共有基準デッキを比較対象へ追加する。高コストの機会損失を小さなパートナー候補集合だけで過小評価しない。",
    environmentPolicy: "提示環境だけを使い、10人内の同一キャラ重複を人工的に避けない。伝説判定は『伝』とLEGENDの両方を認識する。",
    performancePolicy: "各候補の直接探索と共有基準デッキは既存キャッシュを再利用する。全shard統合後、各キャラについて構成の異なる強い完成デッキを最大3本監査し、各デッキで他4枠固定の差し替え候補を最大24本、proxy上位だけに偏らないよう層化して探索する。finalizeは時間予算内で必ずcheckpointを永続化して再開する。",
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
// Only a fully materialized report may be called complete. The previous order
// allowed a runner death after progress.json said complete but before reports existed.
await saveProgress("complete");
console.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated).`);
console.log(`V12 matched-slot counterfactuals: ${counterfactualCandidateDeckCount} decks (${counterfactualNewEvaluations} newly evaluated).`);
console.log(`V12 shared pool: ${sharedDeckPool.length} evaluated decks / ${sharedPoolImprovementCount} ratings changed.`);
console.log(`V12 report: ${path.relative(projectRoot, outputDirectory)}`);
