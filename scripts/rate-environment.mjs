import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { Worker } from "node:worker_threads";

import {
  buildEnvironmentPositionPool,
  buildOpeningScenarios,
  buildSlotEntryScenarios,
  buildWeightedEnvironment,
  createDeckCompletionSolver,
  DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
  evaluateCandidateInEnvironment,
  rankEnvironmentResults,
  readinessSummary,
  serializeEnvironmentResult,
} from "../src/core/environment-rating.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function selectOpenerSeed(candidates) {
  const selected = new Map();
  const add = (items) => items.forEach((character) => selected.set(String(character.id), character));
  add([...candidates].sort((left, right) => right.pow - left.pow).slice(0, 120));
  add([...candidates].sort((left, right) => right.hp - left.hp).slice(0, 120));
  add([...candidates].sort((left, right) => (
    (right.hp + right.pow) / Math.max(1, right.cost) -
    (left.hp + left.pow) / Math.max(1, left.cost)
  )).slice(0, 120));
  add(candidates.filter((character) => character.skillTurn === 0));
  const byCost = new Map();
  for (const character of candidates) {
    const bucket = byCost.get(character.cost) ?? [];
    bucket.push(character);
    bucket.sort((left, right) => right.hp + right.pow - left.hp - left.pow);
    if (bucket.length > 2) bucket.length = 2;
    byCost.set(character.cost, bucket);
  }
  add([...byCost.values()].flat());
  return [...selected.values()];
}

async function evaluatePool(label, candidates, scenarios, options) {
  console.log(`${label}: ${candidates.length}体 × ${scenarios.length}盤面 × ${workerCount}並列`);
  if (workerCount <= 1 || candidates.length < workerCount * 2) {
    const results = candidates.map((character) => evaluateCandidateInEnvironment(character, scenarios, options));
    return rankEnvironmentResults(results);
  }
  const chunks = Array.from({ length: workerCount }, () => []);
  candidates.forEach((character, index) => chunks[index % workerCount].push(String(character.id)));
  let completed = 0;
  const workerResults = await Promise.all(chunks.filter((chunk) => chunk.length).map((candidateIds, workerIndex) => (
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./environment-rating-worker.mjs", import.meta.url), {
        workerData: {
          workerIndex,
          candidateIds,
          scenarios,
          allowedAttributes,
          totalCost,
        },
      });
      worker.once("message", ({ results }) => {
        completed += results.length;
        console.log(`  ${completed}/${candidates.length}`);
        resolve(results);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`環境評価ワーカーが終了コード${code}で停止しました。`));
      });
    })
  )));
  return rankEnvironmentResults(workerResults.flat());
}

function csv(report) {
  const headers = [
    "総合順位", "攻撃順位", "防御順位", "ID", "名前", "属性", "コスト", "HP", "Power", "スキルターン",
    "スキル名", "評価盤面数", "実発動率", "同枠敵撃破率", "同枠敵マクロ撃破率", "50%以上対処できた敵種類数",
    "直接撃破/盤面", "スキル追加撃破/盤面", "味方維持率", "本人存命率", "スキル防止撃破/盤面", "非敗勢率",
  ];
  const rows = report.secondSlot.overall.map((entry) => [
    entry.ranks.overall,
    entry.ranks.offense,
    entry.ranks.defense,
    entry.id,
    entry.name,
    entry.attributeClass,
    entry.cost,
    entry.hp,
    entry.pow,
    entry.skillTurn,
    entry.skillName,
    entry.scenarioCount,
    entry.reproduction.skillActivationRate,
    entry.offense.sameSlotDefeatRate,
    entry.offense.macroSameSlotDefeatRate,
    entry.offense.handledEnemyCount50,
    entry.offense.directDefeatsPerScenario,
    entry.offense.skillAddedDefeatsPerScenario,
    entry.defense.allyRetentionRate,
    entry.defense.candidateSurvivalRate,
    entry.defense.skillPreventedDefeatsPerScenario,
    entry.outcome.nonLosingRate,
  ]);
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

const totalCost = Number(readArgument("cost", "150"));
const allowedAttributes = readArgument("attributes", "fire,water,wind").split(",").filter(Boolean);
const openingScreenScenarioCount = Number(readArgument("opening-screen-scenarios", "12"));
const openingFinalScenarioCount = Number(readArgument("opening-final-scenarios", "36"));
const firstEntryScenarioCount = Number(readArgument("first-entry-scenarios", "60"));
const finalEntryScenarioCount = Number(readArgument("final-entry-scenarios", "240"));
const workerCount = Math.max(1, Math.min(
  Number(readArgument("workers", String(Math.min(6, Math.max(1, os.cpus().length - 1))))),
  os.cpus().length,
));
const positionPools = [1, 2, 3, 4, 5].map((position) => buildEnvironmentPositionPool(
  WORKBOOK_CHARACTERS,
  position,
  { allowedAttributes },
));
const solveCompletion = createDeckCompletionSolver(positionPools, totalCost);
const allFeasibleOpeners = positionPools[0].filter((character) => solveCompletion({ 1: character }));
const openerCandidates = readArgument("opener-seed", "false") === "true"
  ? selectOpenerSeed(allFeasibleOpeners)
  : allFeasibleOpeners;
const secondCandidates = positionPools[1].filter((character) => solveCompletion({ 2: character }));
const commonOptions = { rules: DEFAULT_RULES, solveCompletion };

console.log(`環境評価開始: 総コスト${totalCost} / 属性${allowedAttributes.join(",")}`);
console.log(`候補: 初手${openerCandidates.length}体 / 2枠目${secondCandidates.length}体`);
console.time("environment-rating");

const openingScreenScenarios = buildOpeningScenarios({
  count: openingScreenScenarioCount,
  openerEnvironment: openerCandidates,
  secondEnvironment: secondCandidates,
  solveCompletion,
  seed: 1101,
});
const openingScreenRankings = await evaluatePool(
  "初手環境の一次評価",
  openerCandidates,
  openingScreenScenarios,
  commonOptions,
);
const preliminaryOpenerEnvironment = buildWeightedEnvironment(openingScreenRankings, {
  overallLimit: 120,
  offenseLimit: 100,
  defenseLimit: 100,
});
const openingFinalScenarios = buildOpeningScenarios({
  count: openingFinalScenarioCount,
  openerEnvironment: preliminaryOpenerEnvironment,
  secondEnvironment: secondCandidates,
  solveCompletion,
  seed: 1151,
});
const openingRankings = await evaluatePool(
  "更新環境での初手再評価",
  openerCandidates,
  openingFinalScenarios,
  commonOptions,
);
const openerEnvironment = buildWeightedEnvironment(openingRankings, {
  overallLimit: 100,
  offenseLimit: 80,
  defenseLimit: 80,
});

const firstEntryScenarios = buildSlotEntryScenarios({
  count: firstEntryScenarioCount,
  openerEnvironment,
  secondEnvironment: secondCandidates,
  solveCompletion,
  rules: DEFAULT_RULES,
  seed: 2202,
});
const firstSecondRankings = await evaluatePool(
  "2枠目の一次環境評価",
  secondCandidates,
  firstEntryScenarios,
  commonOptions,
);
const secondEnvironment = buildWeightedEnvironment(firstSecondRankings, {
  overallLimit: 100,
  offenseLimit: 80,
  defenseLimit: 80,
});

const finalEntryScenarios = buildSlotEntryScenarios({
  count: finalEntryScenarioCount,
  openerEnvironment,
  secondEnvironment,
  solveCompletion,
  rules: DEFAULT_RULES,
  seed: 3303,
});
const finalRankings = await evaluatePool(
  "2枠目の環境再評価",
  secondCandidates,
  finalEntryScenarios,
  commonOptions,
);

const serializeRanking = (ranking) => ranking.map(serializeEnvironmentResult);
const report = {
  generatedAt: new Date().toISOString(),
  model: {
    version: "environment-matchup-v3",
    rankingMethod: {
      offense: "実盤面で現在の同枠敵が交代した割合を優先",
      defense: "実盤面で味方の現在キャラを維持した割合を優先",
      overall: "1ターン後に敵交代数が味方交代数以上だった割合を優先",
    },
    baseline: "同じHP・Power・属性でスキルだけを外した自分との対照実験",
    environmentSource: "実戦採用ログではなく、全候補の自己対戦評価から反復生成した予測環境",
    skillReadiness: "前枠から実際に再現したスキルカウントで判定し、固定減点は使わない",
    targeting: "残数平準化・撃破確定・発動脅威の3方針を同数で再現し、各方針で推定高火力順に攻撃",
    ignoredSkillTypes: ["delay", "skill_reduction"],
  },
  context: {
    totalCost,
    allowedAttributes,
    feasibleOpenerCount: allFeasibleOpeners.length,
    evaluatedOpenerCount: openerCandidates.length,
    workerCount,
    secondCandidateCount: secondCandidates.length,
    openingScreenScenarioCount,
    openingFinalScenarioCount,
    firstEntryScenarioCount,
    finalEntryScenarioCount,
    battleProfiles: DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
  },
  readiness: readinessSummary(finalEntryScenarios),
  openerEnvironment: {
    overall: serializeRanking(openingRankings.overall.slice(0, 30)),
    offense: serializeRanking(openingRankings.offense.slice(0, 30)),
    defense: serializeRanking(openingRankings.defense.slice(0, 30)),
  },
  secondSlot: {
    overall: serializeRanking(finalRankings.overall),
    offense: serializeRanking(finalRankings.offense),
    defense: serializeRanking(finalRankings.defense),
  },
};

console.timeEnd("environment-rating");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const attributeKey = allowedAttributes.join("-") || "all";
const outputDirectory = path.join(projectRoot, "reports", "environment-ratings", attributeKey);
const outputBase = path.join(outputDirectory, `slot-2-cost-${totalCost}`);
await fs.mkdir(outputDirectory, { recursive: true });
await Promise.all([
  fs.writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  fs.writeFile(`${outputBase}.csv`, csv(report), "utf8"),
]);

console.log(`2枠目スキルターン別の使用可能率: ${JSON.stringify(report.readiness.usableRates)}`);
console.log(`2枠目の登場ターン分布: ${JSON.stringify(report.readiness.entryTurnCounts)}`);
console.log(`標的方針別の使用可能率: ${JSON.stringify(report.readiness.byBattleProfile)}`);
console.log("2枠目・攻撃環境上位:");
for (const entry of report.secondSlot.offense.slice(0, 10)) {
  console.log(`${String(entry.ranks.offense).padStart(3)}位 ${entry.name} 同枠撃破=${entry.offense.sameSlotDefeatRate} 発動=${entry.reproduction.skillActivationRate}`);
}
console.log(`JSON: ${outputBase}.json`);
console.log(`CSV : ${outputBase}.csv`);
