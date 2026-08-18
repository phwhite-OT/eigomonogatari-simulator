import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { findLightestScoutUpperBound, resolveLightestEnemy } from "../src/core/lightest.js";
import {
  exactStageInfeasibility,
  prepareExactLightestCandidateProfile,
} from "../src/core/lightest-exact.js";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";

const CACHE_VERSION = "lightest-local-v1";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const workerPath = path.resolve(scriptDirectory, "lightest-local-worker.mjs");

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function booleanArgument(name, fallback = false) {
  const value = argument(name, null);
  if (value === null) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function solverVersion() {
  const files = [
    "src/core/lightest.js",
    "src/core/lightest-exact.js",
    "src/core/damage.js",
    "src/core/skills.js",
    "src/data/rules.js",
    "scripts/run-lightest-local.mjs",
    "scripts/lightest-local-worker.mjs",
  ];
  const sources = await Promise.all(files.map((file) => fs.readFile(path.resolve(projectRoot, file), "utf8")));
  return createHash("sha256").update(sources.join("\u001f")).digest("hex");
}

function defaultWorkerCount() {
  const logical = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, logical - 1);
}

function resolveCharacters(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.characters)) return payload.characters;
  throw new Error("--characters はキャラ配列、または characters を持つJSONにしてください");
}

function resolveEnemyList(rawEnemies, characters, stage) {
  const byId = new Map(characters.map((character) => [String(character.id), character]));
  return (rawEnemies ?? []).map((rawEnemy, index) => {
    const sourceId = rawEnemy?.characterId ?? rawEnemy?.sourceCharacterId ?? rawEnemy?.id;
    const source = byId.get(String(sourceId));
    if (!source) {
      if (rawEnemy?.attributes && rawEnemy?.hp !== undefined && rawEnemy?.pow !== undefined) return rawEnemy;
      throw new Error(`敵 ${index + 1} のキャラID「${sourceId}」が見つかりません`);
    }
    return resolveLightestEnemy(source, {
      difficulty: rawEnemy?.difficulty ?? stage.difficulty,
      hp: rawEnemy?.hp,
      pow: rawEnemy?.pow,
      order: index,
      instanceId: rawEnemy?.instanceId,
    });
  });
}

function normalizeInput(payload, characters) {
  const rawStage = payload.stage ?? payload;
  const rawOptions = payload.searchOptions ?? rawStage.searchOptions ?? {};
  const deckSizes = Array.isArray(rawStage.deckSizes) && rawStage.deckSizes.length
    ? [...new Set(rawStage.deckSizes.map(Number).filter((size) => Number.isInteger(size) && size >= 1 && size <= 5))]
    : [1, 2, 3, 4, 5];
  const stage = {
    ...rawStage,
    deckSizes: deckSizes.sort((left, right) => left - right),
    maxCost: Number(rawStage.maxCost),
    maxTurns: Math.max(1, Number(rawStage.maxTurns) || 12),
    enemies: resolveEnemyList(rawStage.enemies, characters, rawStage),
  };
  if (!Number.isFinite(stage.maxCost) || stage.maxCost < 0) {
    throw new Error("stage.maxCost に0以上の数値を設定してください");
  }
  if (!stage.enemies.length) throw new Error("stage.enemies を1体以上設定してください");
  const options = {
    allowDuplicates: rawOptions.allowDuplicates ?? true,
    ownedOnly: rawOptions.ownedOnly ?? false,
    answerMultiplier: Number(rawOptions.answerMultiplier) || 2.592,
    enemyAttackMultiplier: Number(rawOptions.enemyAttackMultiplier) || 1,
    eventBonusMultiplier: Number(rawOptions.eventBonusMultiplier) || 1.5,
    allowHalfAnswer: Boolean(rawOptions.allowHalfAnswer),
    // automatic first, then every manual plan. This remains an exact search.
    targetSearch: rawOptions.targetSearch === "all" ? "all" : "lazy",
    skillSearch: "all",
    resultLimit: 1,
  };
  return { stage, options };
}

function totalEnemyHp(enemies) {
  return enemies.reduce((total, enemy) => total + Math.max(0, Number(enemy.hp) || 0), 0);
}

function exactCostPlan(characters, stage, options, maximumCost) {
  const stageInfeasibility = exactStageInfeasibility(stage, options);
  if (stageInfeasibility) return { costs: [], byCost: new Map(), stageInfeasibility };
  const byCost = new Map();
  const enemyHp = totalEnemyHp(stage.enemies);
  for (const deckSize of stage.deckSizes) {
    const profile = prepareExactLightestCandidateProfile(characters, { ...stage, deckSize }, options);
    if (profile.infeasibility) continue;
    for (const cost of profile.attainableCosts) {
      if (cost > maximumCost || (profile.combinationCountsByCost.get(cost) ?? 0) <= 0) continue;
      // This is the same generous bound used by the exact solver. Skipping it
      // therefore cannot remove a winning composition.
      const damageBound = profile.optimisticDamageUpperBoundsByCost.get(cost);
      if (damageBound !== undefined && damageBound < enemyHp) continue;
      const entry = byCost.get(cost) ?? [];
      entry.push({ deckSize, combinations: profile.combinationCountsByCost.get(cost) ?? 0 });
      byCost.set(cost, entry);
    }
  }
  return { costs: [...byCost.keys()].sort((left, right) => left - right), byCost, stageInfeasibility: null };
}

function taskId(cost, deckSize, shardIndex) {
  return `${cost}:${deckSize}:${shardIndex}`;
}

function compactResult(result) {
  return {
    foundThreeStar: result.foundThreeStar,
    simulatedDeckCount: result.simulatedDeckCount,
    generatedCombinationCount: result.generatedCombinationCount,
    prePrunedCombinationCount: result.prePrunedCombinationCount,
    prePrunedReasons: result.prePrunedReasons,
    winner: result.results?.[0] ?? null,
  };
}

async function runExactCost({ characters, stage, options, cost, deckEntries, workerCount, checkpoint, saveCheckpoint }) {
  const completed = new Set(checkpoint.completedTaskIds ?? []);
  const tasks = deckEntries.flatMap(({ deckSize }) => Array.from({ length: workerCount }, (_, shardIndex) => ({
    taskId: taskId(cost, deckSize, shardIndex),
    cost,
    deckSize,
    shardIndex,
    shardCount: workerCount,
    attempts: 0,
  }))).filter((task) => !completed.has(task.taskId));
  if (!tasks.length) return { winner: null, completed: true, summaries: [] };

  const summaries = [];
  const workers = [];
  let cursor = 0;
  let active = 0;
  let settled = false;
  let abort = null;
  const stopped = new Promise((resolve, reject) => { abort = { resolve, reject }; });

  const finish = async (outcome) => {
    if (settled) return;
    settled = true;
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
    abort.resolve(outcome);
  };
  const fail = async (error) => {
    if (settled) return;
    settled = true;
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
    abort.reject(error);
  };
  const dispatch = (worker) => {
    if (settled) return;
    const task = tasks[cursor++];
    if (!task) {
      if (active === 0) finish({ winner: null, completed: true, summaries });
      return;
    }
    active += 1;
    worker.postMessage({ type: "run", ...task });
  };

  for (let index = 0; index < Math.min(workerCount, tasks.length); index += 1) {
    const worker = new Worker(workerPath, { workerData: { characters, stage, options } });
    workers.push(worker);
    worker.on("message", async (message) => {
      if (settled || !message?.type) return;
      active -= 1;
      if (message.type === "failed") {
        const retry = tasks.find((task) => task.taskId === message.taskId);
        if (retry && retry.attempts < 2) {
          retry.attempts += 1;
          tasks.push(retry);
          dispatch(worker);
          return;
        }
        await fail(new Error(`Worker ${message.shardIndex} が失敗しました: ${message.error?.message ?? "不明なエラー"}`));
        return;
      }
      const summary = compactResult(message.result);
      summaries.push({
        taskId: message.taskId,
        deckSize: message.deckSize,
        shardIndex: message.shardIndex,
        elapsedMs: message.elapsedMs,
        ...summary,
      });
      checkpoint.completedTaskIds = [...new Set([...(checkpoint.completedTaskIds ?? []), message.taskId])];
      checkpoint.lastUpdateAt = new Date().toISOString();
      await saveCheckpoint();
      if (summary.winner?.threeStar) {
        await finish({ winner: summary.winner, completed: false, summaries });
        return;
      }
      dispatch(worker);
    });
    worker.on("error", (error) => { fail(error); });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) fail(new Error(`最軽装Workerが終了しました (code ${code})`));
    });
    dispatch(worker);
  }
  return stopped;
}

async function main() {
  const stageArgument = argument("stage");
  if (!stageArgument) {
    throw new Error("使い方: node scripts/run-lightest-local.mjs --stage=設定.json [--workers=8] [--characters=キャラ.json]");
  }
  const stagePath = path.resolve(projectRoot, stageArgument);
  const payload = await readJson(stagePath);
  if (!payload) throw new Error(`設定ファイルが見つかりません: ${stagePath}`);
  const charactersPath = argument("characters");
  const characters = charactersPath
    ? resolveCharacters(await readJson(path.resolve(projectRoot, charactersPath)))
    : CHARACTER_CATALOG;
  const { stage, options } = normalizeInput(payload, characters);
  const workerCount = positiveInteger(argument("workers"), defaultWorkerCount());
  const scoutEnabled = !booleanArgument("no-scout", false);
  const logicVersion = await solverVersion();
  const fingerprint = createHash("sha256").update(stableJson({
    cacheVersion: CACHE_VERSION,
    logicVersion,
    stage,
    options,
    characters,
  })).digest("hex");
  const cacheDirectory = path.resolve(projectRoot, ".cache", "lightest");
  const cachePath = path.join(cacheDirectory, `${fingerprint}.json`);
  const checkpointPath = path.join(cacheDirectory, `${fingerprint}.checkpoint.json`);
  const cached = await readJson(cachePath);
  if (cached?.status === "complete") {
    console.log(`キャッシュを使用しました: 最小コスト ${cached.minimumCost ?? "未発見"} (${cachePath})`);
    return;
  }

  let checkpoint = await readJson(checkpointPath);
  if (checkpoint?.cacheVersion !== CACHE_VERSION || checkpoint?.fingerprint !== fingerprint) checkpoint = null;
  checkpoint ??= {
    cacheVersion: CACHE_VERSION,
    fingerprint,
    logicVersion,
    status: "running",
    startedAt: new Date().toISOString(),
    completedTaskIds: [],
    completedCosts: [],
    workerCount,
  };
  let pendingWrite = Promise.resolve();
  const saveCheckpoint = () => {
    pendingWrite = pendingWrite.then(() => writeJson(checkpointPath, checkpoint));
    return pendingWrite;
  };
  await saveCheckpoint();

  let upperCost = checkpoint.scout?.upperCost ?? null;
  if (upperCost === null && scoutEnabled) {
    console.log("第1段階: 自動ターゲット・自動スキルで勝利コスト上限を探索しています...");
    const scout = await findLightestScoutUpperBound(characters, stage, {
      ...options,
      candidateGuidance: payload.scoutCandidateGuidance ?? "stage",
      scoutDeckLimit: positiveInteger(payload.scoutDeckLimit, 36),
      scoutCandidateLimit: positiveInteger(payload.scoutCandidateLimit, 10),
      scoutBeamWidth: positiveInteger(payload.scoutBeamWidth, 12),
      onProgress: ({ completed, total }) => {
        if (completed === total || completed % 8 === 0) console.log(`  高速探索 ${completed}/${total}`);
      },
    });
    checkpoint.scout = {
      found: scout.found,
      upperCost: scout.upperCost,
      sampledDeckCount: scout.scout.sampledDeckCount,
      candidateDeckCount: scout.scout.candidateDeckCount,
    };
    upperCost = scout.upperCost;
    await saveCheckpoint();
    console.log(scout.found
      ? `  勝利候補をコスト ${upperCost} に発見。これ以下を完全検証します。`
      : "  高速探索では勝利候補なし。最大コストまで完全検証します。");
  }

  const proofLimit = upperCost ?? stage.maxCost;
  const plan = exactCostPlan(characters, stage, options, proofLimit);
  if (plan.stageInfeasibility) {
    checkpoint.status = "complete";
    checkpoint.completedAt = new Date().toISOString();
    checkpoint.reason = plan.stageInfeasibility;
    await saveCheckpoint();
    await writeJson(cachePath, { ...checkpoint, minimumCost: null, result: null });
    console.log("敵出現数の上限により、この条件は不可能です。");
    return;
  }

  console.log(`第2段階: ${workerCount} Workerで低コストから完全検証します (上限 ${proofLimit})。`);
  for (const cost of plan.costs) {
    if ((checkpoint.completedCosts ?? []).includes(cost)) continue;
    const deckEntries = plan.byCost.get(cost) ?? [];
    const combinations = deckEntries.reduce((sum, entry) => sum + entry.combinations, 0);
    checkpoint.current = { cost, deckEntries, combinations, startedAt: new Date().toISOString() };
    await saveCheckpoint();
    console.log(`  コスト ${cost}: ${combinations.toLocaleString("ja-JP")} 組合せをshard分割中`);
    const outcome = await runExactCost({
      characters,
      stage,
      options,
      cost,
      deckEntries,
      workerCount,
      checkpoint,
      saveCheckpoint,
    });
    if (outcome.winner?.threeStar) {
      const final = {
        ...checkpoint,
        status: "complete",
        completedAt: new Date().toISOString(),
        minimumCost: cost,
        result: outcome.winner,
        exactProof: {
          completedCosts: checkpoint.completedCosts ?? [],
          winnerCost: cost,
          workerCount,
        },
      };
      checkpoint = final;
      await saveCheckpoint();
      await writeJson(cachePath, final);
      console.log(`完了: 最小コスト = ${cost}。結果を ${cachePath} に保存しました。`);
      return;
    }
    checkpoint.completedCosts = [...new Set([...(checkpoint.completedCosts ?? []), cost])].sort((left, right) => left - right);
    checkpoint.current = null;
    await saveCheckpoint();
  }

  const final = {
    ...checkpoint,
    status: "complete",
    completedAt: new Date().toISOString(),
    minimumCost: null,
    result: null,
    exactProof: { completedCosts: checkpoint.completedCosts ?? [], workerCount },
  };
  checkpoint = final;
  await saveCheckpoint();
  await writeJson(cachePath, final);
  console.log(`完了: コスト ${proofLimit} 以下に★3勝利はありません。結果を ${cachePath} に保存しました。`);
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
}
