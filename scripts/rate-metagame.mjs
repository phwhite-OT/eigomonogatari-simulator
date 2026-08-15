import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  buildCandidatePositionEntryScenarios,
  buildEnvironmentPositionPool,
  buildPositionEntryScenarios,
  DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
  DEFAULT_STRATEGIC_DECK_PROFILES,
  createDeckCompletionSolver,
  evaluateCandidateMatchOutcome,
  readinessSummary,
} from "../src/core/environment-rating.js";
import {
  buildBootstrapEnvironment,
  buildUsageEnvironment,
  metagameReportToCsv,
  METAGAME_USAGE_MIX,
  rankDetailedMetagameResults,
  rankMetagameResults,
  RARITY_OWNERSHIP_MODEL,
  selectDetailedCandidates,
  serializeMetagameResult,
  summarizeStrategicUsage,
} from "../src/core/metagame-rating.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

const MODEL_VERSION = "iterative-metagame-v7-attribute-tactics";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function compactUsage(entries) {
  return entries.map((entry) => ({
    id: String(entry.character.id),
    name: entry.character.name,
    rarity: entry.character.rarity,
    battleRank: entry.battleRank,
    usageRank: entry.usageRank,
    ownershipProbability: Math.round(entry.ownershipProbability * 10000) / 10000,
    projectedUsageShare: Math.round(entry.projectedUsageShare * 1000000) / 1000000,
    weight: entry.weight,
    strategicClass: entry.strategicClass ?? "none",
  }));
}

function compactScenarioOptions(options) {
  return {
    count: options.count,
    position: options.position,
    seed: options.seed,
    turns: options.turns,
    positionEnvironments: options.positionEnvironments.map((entries) => entries.map((value) => ({
      id: String((value.character ?? value).id),
      weight: Math.max(0, Number(value.weight ?? 1) || 0),
    })).filter((entry) => entry.weight > 0)),
  };
}

async function loadUsageEnvironment(reportPath, charactersById) {
  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const entries = report.environment?.finalUsage ?? [];
    const environment = entries.flatMap((entry) => {
      const character = charactersById.get(String(entry.id));
      return character ? [{
        character,
        weight: Number(entry.projectedUsageShare) || Number(entry.weight) || 0,
      }] : [];
    }).filter((entry) => entry.weight > 0);
    return environment.length ? {
      environment,
      modelVersion: report.model?.version ?? "unknown",
    } : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readCheckpoint(checkpointPath, context) {
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    return JSON.stringify(checkpoint.context) === JSON.stringify(context) ? checkpoint : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCheckpoint(checkpointPath, checkpoint) {
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
  await fs.rename(temporaryPath, checkpointPath);
}

function evaluateCharacter(character, scenarioOptions, solveCompletion, turns) {
  const scenarios = buildCandidatePositionEntryScenarios({
    ...scenarioOptions,
    character,
    solveCompletion,
    rules: DEFAULT_RULES,
    allowPartial: true,
  });
  return {
    ...evaluateCandidateMatchOutcome(character, scenarios, {
      rules: DEFAULT_RULES,
      solveCompletion,
      turns,
    }),
    position: scenarioOptions.position,
  };
}

function resultCharacterId(result) {
  return String(result?.character?.id ?? "");
}

function orderResults(candidates, resultsById) {
  return candidates.flatMap((character) => {
    const result = resultsById.get(String(character.id));
    return result ? [result] : [];
  });
}

async function evaluatePool(label, candidates, scenarioOptions, options) {
  const {
    workerCount,
    allowedAttributes,
    totalCost,
    turns,
    solveCompletion,
    completedResults = [],
    skippedCandidateIds = [],
    checkpointInterval = 1,
    deadlineAt = 0,
    onCheckpoint,
  } = options;
  const candidateIds = new Set(candidates.map((character) => String(character.id)));
  const resultsById = new Map(completedResults.flatMap((result) => {
    const id = resultCharacterId(result);
    return id && candidateIds.has(id) ? [[id, result]] : [];
  }));
  const skippedIds = new Set(skippedCandidateIds.filter((id) => candidateIds.has(String(id))).map(String));
  const pendingCandidates = candidates.filter((character) => {
    const id = String(character.id);
    return !resultsById.has(id) && !skippedIds.has(id);
  });
  let completedSinceCheckpoint = 0;
  let checkpointQueue = Promise.resolve();
  const snapshot = () => ({
    results: orderResults(candidates, resultsById),
    skippedCandidateIds: candidates.map((character) => String(character.id)).filter((id) => skippedIds.has(id)),
  });
  const checkpoint = (force = false) => {
    if (!onCheckpoint || (!force && completedSinceCheckpoint < checkpointInterval)) return;
    completedSinceCheckpoint = 0;
    checkpointQueue = checkpointQueue.then(() => onCheckpoint(snapshot()));
  };
  const recordCandidate = ({ result, skippedCandidateId }) => {
    if (result) resultsById.set(resultCharacterId(result), result);
    if (skippedCandidateId) skippedIds.add(String(skippedCandidateId));
    completedSinceCheckpoint += 1;
    checkpoint();
  };
  console.log(`${label}: ${pendingCandidates.length}/${candidates.length}体を評価 / 候補別${scenarioOptions.count}盤面 × 最大${turns}ターン × ${workerCount}並列`);
  let paused = false;
  if (workerCount <= 1 || pendingCandidates.length < workerCount * 2) {
    for (const character of pendingCandidates) {
      if (deadlineAt && Date.now() >= deadlineAt) {
        paused = true;
        break;
      }
      try {
        recordCandidate({ result: evaluateCharacter(character, scenarioOptions, solveCompletion, turns) });
      } catch (error) {
        if (error.code !== "INSUFFICIENT_ENTRY_SCENARIOS") throw error;
        recordCandidate({ skippedCandidateId: String(character.id) });
      }
    }
  } else {
    const chunks = Array.from({ length: workerCount }, () => []);
    pendingCandidates.forEach((character, index) => chunks[index % workerCount].push(String(character.id)));
    const progressByWorker = new Map();
    const workerScenarioOptions = compactScenarioOptions(scenarioOptions);
    const workerStates = await Promise.all(chunks.filter((chunk) => chunk.length).map((workerCandidateIds, workerIndex) => (
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./metagame-rating-worker.mjs", import.meta.url), {
          workerData: {
            workerIndex,
            candidateIds: workerCandidateIds,
            scenarioOptions: workerScenarioOptions,
            allowedAttributes,
            totalCost,
            turns,
            deadlineAt,
          },
        });
        worker.on("message", (message) => {
          if (message.type === "candidate") {
            recordCandidate(message);
            return;
          }
          if (message.type === "progress") {
            progressByWorker.set(workerIndex, message.completed);
            const totalCompleted = [...progressByWorker.values()].reduce((sum, value) => sum + value, 0);
            console.log(`  ${totalCompleted}/${pendingCandidates.length} (worker ${workerIndex + 1}: ${message.completed}/${message.total})`);
            return;
          }
          if (message.type === "result") resolve({ paused: Boolean(message.paused) });
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`メタ環境評価ワーカーが終了コード${code}で停止しました。`));
        });
      })
    )));
    paused = workerStates.some((state) => state.paused);
  }
  checkpoint(true);
  await checkpointQueue;
  const evaluated = snapshot();
  if (evaluated.skippedCandidateIds.length) console.warn(`${label}: 登場盤面を作れない${evaluated.skippedCandidateIds.length}体を除外しました。`);
  return { ...evaluated, paused };
}

const totalCost = Number(readArgument("cost", "150"));
const position = Math.min(5, Math.max(1, Number(readArgument("position", "2"))));
const allowedAttributes = readArgument("attributes", "fire").split(",").map((value) => value.trim()).filter(Boolean);
const firstScenarioCount = Math.max(12, Number(readArgument("first-scenarios", "12")));
const finalScenarioCount = Math.max(72, Number(readArgument("final-scenarios", "72")));
const detailedCandidateLimit = Math.max(1, Math.floor(Number(readArgument("finalists", "96")) || 96));
const checkpointInterval = Math.max(1, Math.floor(Number(readArgument("checkpoint-interval", "2")) || 2));
const timeBudgetSeconds = Math.max(0, Math.floor(Number(readArgument("time-budget-seconds", "0")) || 0));
const turns = Math.min(12, Math.max(1, Number(readArgument("turns", "12"))));
const workerCount = Math.max(1, Math.min(
  Number(readArgument("workers", String(Math.min(6, Math.max(1, os.cpus().length - 1))))),
  os.cpus().length,
));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const attributeKey = allowedAttributes.join("-") || "all";
const outputRoot = path.resolve(projectRoot, readArgument("output-root", "reports/metagame-ratings-v6"));
const outputDirectory = path.join(outputRoot, attributeKey);

const outputBase = path.join(outputDirectory, `slot-${position}-cost-${totalCost}`);
const checkpointPath = `${outputBase}.progress.json`;
const charactersById = new Map(WORKBOOK_CHARACTERS.map((character) => [String(character.id), character]));
const positionPools = [1, 2, 3, 4, 5].map((slot) => buildEnvironmentPositionPool(
  WORKBOOK_CHARACTERS,
  slot,
  { allowedAttributes },
));
const solveCompletion = createDeckCompletionSolver(positionPools, totalCost);
const feasiblePositionPools = positionPools.map((pool, index) => pool.filter((character) => (
  solveCompletion({ [index + 1]: character })
)));
const candidates = feasiblePositionPools[position - 1];
const positionEnvironments = feasiblePositionPools.map((pool, index) => buildBootstrapEnvironment(pool, index + 1));
const warmStartSources = positionPools.map(() => "bootstrap");

await fs.mkdir(outputDirectory, { recursive: true });
for (let slot = 1; slot <= 5; slot += 1) {
  const existing = await loadUsageEnvironment(
    path.join(outputDirectory, `slot-${slot}-cost-${totalCost}.json`),
    charactersById,
  );
  if (!existing || existing.modelVersion !== MODEL_VERSION) continue;
  const environment = existing.environment.filter((entry) => solveCompletion({ [slot]: entry.character }));
  if (!environment.length) continue;
  positionEnvironments[slot - 1] = environment;
  warmStartSources[slot - 1] = "current-v6-100%";
}
console.log(`メタ環境評価開始: 総コスト${totalCost} / 属性${allowedAttributes.join(",")} / ${position}枠目`);
console.log(`候補${candidates.length}/${positionPools[position - 1].length}体 / 候補ごとにコスト内デッキを再生成 / 伝説は1デッキ1体まで`);
const checkpointContext = {
  modelVersion: MODEL_VERSION,
  totalCost,
  allowedAttributes,
  position,
  candidateIds: candidates.map((character) => String(character.id)),
  firstScenarioCount,
  finalScenarioCount,
  detailedCandidateLimit,
  turns,
};
const restoredCheckpoint = await readCheckpoint(checkpointPath, checkpointContext);
if (restoredCheckpoint?.status === "completed") {
  console.log("この評価タスクは保存済みです。");
  process.exit(0);
}
const deadlineAt = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : 0;
const restoredFirstResults = restoredCheckpoint?.firstResults ?? [];
const restoredFirstSkippedCandidateIds = restoredCheckpoint?.firstSkippedCandidateIds ?? [];
const restoredFinalResults = restoredCheckpoint?.finalResults ?? [];
const restoredFinalSkippedCandidateIds = restoredCheckpoint?.finalSkippedCandidateIds ?? [];
const makeCheckpoint = ({
  status,
  phase,
  firstResults,
  firstSkippedCandidateIds,
  finalResults = [],
  finalSkippedCandidateIds = [],
}) => ({
  version: 1,
  status,
  phase,
  updatedAt: new Date().toISOString(),
  context: checkpointContext,
  progress: {
    screeningCompleted: firstResults.length + firstSkippedCandidateIds.length,
    screeningTotal: candidates.length,
    screeningSkipped: firstSkippedCandidateIds.length,
    detailedCompleted: finalResults.length + finalSkippedCandidateIds.length,
    detailedSkipped: finalSkippedCandidateIds.length,
  },
  firstResults,
  firstSkippedCandidateIds,
  finalResults,
  finalSkippedCandidateIds,
});
console.time("metagame-rating");

const firstScenarioOptions = {
  count: firstScenarioCount,
  position,
  positionEnvironments,
  seed: 5100 + position * 101 + totalCost,
  turns,
};
const firstEvaluation = await evaluatePool("一次勝利評価", candidates, firstScenarioOptions, {
  workerCount,
  allowedAttributes,
  totalCost,
  turns,
  solveCompletion,
  completedResults: restoredFirstResults,
  skippedCandidateIds: restoredFirstSkippedCandidateIds,
  checkpointInterval,
  deadlineAt,
  onCheckpoint: ({ results, skippedCandidateIds }) => writeCheckpoint(checkpointPath, makeCheckpoint({
    status: "running",
    phase: "screening",
    firstResults: results,
    firstSkippedCandidateIds: skippedCandidateIds,
    finalResults: restoredFinalResults,
    finalSkippedCandidateIds: restoredFinalSkippedCandidateIds,
  })),
});
if (firstEvaluation.paused) {
  await writeCheckpoint(checkpointPath, makeCheckpoint({
    status: "paused",
    phase: "screening",
    firstResults: firstEvaluation.results,
    firstSkippedCandidateIds: firstEvaluation.skippedCandidateIds,
    finalResults: restoredFinalResults,
    finalSkippedCandidateIds: restoredFinalSkippedCandidateIds,
  }));
  console.log("時間予算に達したため、一次評価の途中結果を保存して次回実行へ引き継ぎます。");
  process.exit(0);
}
const firstResults = firstEvaluation.results;
if (!firstResults.length) throw new Error("評価可能な候補の登場盤面を作れませんでした。");
const firstRankings = rankMetagameResults(firstResults);
const detailedCandidates = selectDetailedCandidates(firstRankings, detailedCandidateLimit);
console.log(`Detailed evaluation shortlist: ${detailedCandidates.length}/${candidates.length}`);
const preliminaryUsage = buildUsageEnvironment(firstRankings);
positionEnvironments[position - 1] = preliminaryUsage;

const finalScenarioOptions = {
  count: finalScenarioCount,
  position,
  positionEnvironments,
  seed: 7100 + position * 101 + totalCost,
  turns,
};
const finalEvaluation = await evaluatePool("予測環境での最終勝利評価", detailedCandidates, finalScenarioOptions, {
  workerCount,
  allowedAttributes,
  totalCost,
  turns,
  solveCompletion,
  completedResults: restoredFinalResults,
  skippedCandidateIds: restoredFinalSkippedCandidateIds,
  checkpointInterval,
  deadlineAt,
  onCheckpoint: ({ results, skippedCandidateIds }) => writeCheckpoint(checkpointPath, makeCheckpoint({
    status: "running",
    phase: "detailed",
    firstResults,
    firstSkippedCandidateIds: firstEvaluation.skippedCandidateIds,
    finalResults: results,
    finalSkippedCandidateIds: skippedCandidateIds,
  })),
});
if (finalEvaluation.paused) {
  await writeCheckpoint(checkpointPath, makeCheckpoint({
    status: "paused",
    phase: "detailed",
    firstResults,
    firstSkippedCandidateIds: firstEvaluation.skippedCandidateIds,
    finalResults: finalEvaluation.results,
    finalSkippedCandidateIds: finalEvaluation.skippedCandidateIds,
  }));
  console.log("時間予算に達したため、最終評価の途中結果を保存して次回実行へ引き継ぎます。");
  process.exit(0);
}
const finalResults = finalEvaluation.results;
if (!finalResults.length) throw new Error("最終評価可能な候補の登場盤面を作れませんでした。");
const finalRankings = rankDetailedMetagameResults(finalResults, finalScenarioCount);
const finalUsage = buildUsageEnvironment(finalRankings);
positionEnvironments[position - 1] = finalUsage;
const readinessScenarios = buildPositionEntryScenarios({
  count: finalScenarioCount,
  position,
  positionEnvironments,
  solveCompletion,
  rules: DEFAULT_RULES,
  seed: 8100 + position * 101 + totalCost,
  turns,
});
const usageById = new Map(finalUsage.map((entry) => [String(entry.character.id), entry]));
const detailedIds = new Set(detailedCandidates.map((character) => String(character.id)));
const serializeRanking = (ranking) => ranking.map((result) => ({
  ...serializeMetagameResult(result, usageById),
  evaluationStage: detailedIds.has(String(result.character.id)) ? "detailed" : "screening",
}));
const report = {
  generatedAt: new Date().toISOString(),
  model: {
    version: MODEL_VERSION,
    objective: "刺さりではなく最終勝利見込みを第一基準にする",
    rankingOrder: [
      "詳細評価済み候補だけで同数の成立盤面を確保",
      "予測勝率の信頼下限",
      "予測勝率",
      "味方維持60%・敵進行40%の調和平均による攻守均衡",
      "有利を作る行動（味方交代を防ぐ）",
      "不利を防ぐ対抗行動（敵交代を増やす）",
    ],
    candidateConditioning: "候補を対象枠へ固定してから残り4枠を使用率と総コストに従って生成し、候補ごとに同数盤面を評価",
    legacyWarmStart: "旧モデルの予測使用率は使用せず、同一モデルの完了済み枠だけを初期環境に使用",
    stagedEvaluation: "一次評価は詳細評価候補の選別専用。最終順位・予測使用率・環境生成は詳細評価済み候補だけで計算",
    environmentLoop: "一次順位と所持率から予測使用率を作り、その使用率で再生成した環境に対して最終評価",
    reserveSkills: "対象枠より後ろを含む全キャラのスキルを保持",
    laterPositionSkillPolicy: "2枠目以降は使用可能なスキルを原則すぐ使用。蘇生は撃破予測時に使用",
    ownershipModel: RARITY_OWNERSHIP_MODEL,
    ownershipUsage: "所持率は環境出現頻度にのみ使用し、所有済みキャラ自身の戦闘評価は減点しない",
    legendRule: "伝説は1デッキ1体まで。強さで所持率は上がるが推定上限40%",
    strategicActionClasses: {
      advantage_creation: ["attribute_guard", "damage_reduction", "guard", "heal", "revive"],
      counteraction: ["single_attack", "aoe_attack", "attack_buff", "multi_hit_attack"],
      adaptive: ["attribute_change"],
    },
    usageMixture: METAGAME_USAGE_MIX,
    environmentDeckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES,
    environmentBattleProfiles: DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
    tacticalEvaluation: "records upside, coverage, and risk independently for stock balance, skill interception, and priority finishing",
    drawValue: 0.5,
    ignoredSkillTypes: ["delay", "skill_reduction"],
  },
  context: {
    totalCost,
    allowedAttributes,
    position,
    candidateCount: positionPools[position - 1].length,
    screeningCandidateCount: candidates.length,
    detailedCandidateCount: detailedCandidates.length,
    detailedCandidateLimit,
    firstScenarioCount,
    finalScenarioCount,
    turns,
    workerCount,
    outputRoot,
    warmStartSources,
  },
  evaluation: {
    screeningCandidateCount: firstResults.length,
    screeningSkippedCandidateCount: firstEvaluation.skippedCandidateIds.length,
    screeningScenarioCount: firstScenarioCount,
    detailedCandidateCount: finalResults.length,
    detailedSkippedCandidateCount: finalEvaluation.skippedCandidateIds.length,
    detailedScenarioCount: finalScenarioCount,
    excludedFromFinalRankCount: Math.max(0, firstResults.length - finalResults.length),
  },
  readiness: readinessSummary(readinessScenarios, Math.min(7, position + 2)),
  environment: {
    firstUsage: compactUsage(preliminaryUsage),
    finalUsage: compactUsage(finalUsage),
    firstStrategicMix: summarizeStrategicUsage(preliminaryUsage),
    finalStrategicMix: summarizeStrategicUsage(finalUsage),
  },
  rankings: {
    overall: serializeRanking(finalRankings.overall),
    advantage: serializeRanking(finalRankings.advantage),
    counter: serializeRanking(finalRankings.counter),
    continuation: serializeRanking(finalRankings.continuation),
    combination: serializeRanking(finalRankings.combination),
    tactical: serializeRanking(finalRankings.tactical),
  },
};

await Promise.all([
  fs.writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  fs.writeFile(`${outputBase}.csv`, metagameReportToCsv(report), "utf8"),
]);
await writeCheckpoint(checkpointPath, makeCheckpoint({
  status: "completed",
  phase: "completed",
  firstResults,
  firstSkippedCandidateIds: firstEvaluation.skippedCandidateIds,
  finalResults,
  finalSkippedCandidateIds: finalEvaluation.skippedCandidateIds,
}));
console.timeEnd("metagame-rating");
console.log("最終総合上位:");
for (const entry of report.rankings.overall.slice(0, 10)) {
  console.log(`${String(entry.ranks.overall).padStart(3)}位 ${entry.name} 勝率=${entry.matchOutcome.expectedWinRate} 均衡=${entry.teamBalance.balancedContribution} 使用=${entry.usage.projectedUsageShare}`);
}
console.log(`JSON: ${outputBase}.json`);
console.log(`CSV : ${outputBase}.csv`);
