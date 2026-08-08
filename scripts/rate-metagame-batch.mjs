import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildMetagameBatchTasks,
  DEFAULT_ATTRIBUTE_GROUPS,
  DEFAULT_REPRESENTATIVE_COSTS,
} from "../src/core/metagame-batch.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function parseList(value) {
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseAttributeGroups(value) {
  return String(value).split(";").map((group) => (
    [...new Set(group.split("+").map((item) => item.trim()).filter(Boolean))]
  )).filter((group) => group.length);
}

function parseCosts(value) {
  return parseList(value).map(Number).filter((cost) => Number.isFinite(cost) && cost >= 0);
}

function runNode(scriptPath, argumentsToForward) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...argumentsToForward], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`rating process stopped: code=${code}, signal=${signal ?? "none"}`));
    });
  });
}

async function readStatus() {
  try {
    return JSON.parse((await fs.readFile(statusPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeStatus(status) {
  await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const MODEL_VERSION = "iterative-metagame-v6-continuation-decks";
const ratingScript = path.join(scriptDirectory, "rate-metagame.mjs");
const statusPath = path.resolve(projectRoot, readArgument("status", "reports/metagame-v6-batch-status.json"));
const outputRoot = readArgument("output-root", "reports/metagame-ratings-v6");
const priorOutputRoot = readArgument("prior-output-root", "");
const attributeGroupsArgument = readArgument("attribute-groups", "");
const legacyAttributesArgument = readArgument("attributes", "");
const attributeGroups = attributeGroupsArgument
  ? parseAttributeGroups(attributeGroupsArgument)
  : legacyAttributesArgument
    ? parseList(legacyAttributesArgument).map((attribute) => [attribute])
    : DEFAULT_ATTRIBUTE_GROUPS.map((group) => [...group]);
const costsArgument = readArgument("costs", "");
const legacyCostArgument = readArgument("cost", "");
const costs = costsArgument
  ? parseCosts(costsArgument)
  : legacyCostArgument
    ? [Math.max(0, Number(legacyCostArgument) || 0)]
    : [...DEFAULT_REPRESENTATIVE_COSTS];
const positions = parseList(readArgument("positions", "1,2,3,4,5")).map(Number);
const passes = Math.max(1, Number(readArgument("passes", "2")) || 2);
const firstScenarios = Math.max(12, Number(readArgument("first-scenarios", "12")) || 12);
const finalScenarios = Math.max(72, Number(readArgument("final-scenarios", "72")) || 72);
const finalists = Math.max(1, Math.floor(Number(readArgument("finalists", "96")) || 96));
const turns = Math.min(12, Math.max(1, Number(readArgument("turns", "12")) || 12));
const workers = Math.max(1, Number(readArgument("workers", "6")) || 6);
const fallbackWorkers = Math.min(workers, Math.max(1, Number(readArgument("fallback-workers", "1")) || 1));
const screeningCandidateLimit = Math.max(0, Math.floor(Number(readArgument("screening-candidates", "0")) || 0));
const maxTasks = Math.max(0, Math.floor(Number(readArgument("max-tasks", "0")) || 0));
const maxConstraints = Math.max(0, Math.floor(Number(readArgument("max-constraints", "0")) || 0));
const initialCompleted = new Set(parseList(readArgument("completed", "")));
const tasks = buildMetagameBatchTasks({ attributeGroups, costs, positions, passes });
const taskIds = new Set(tasks.map((task) => task.id));
const previousStatus = await readStatus();
const previousModelVersion = previousStatus?.config?.modelVersion;
const resetForModelChange = Boolean(previousStatus && previousModelVersion !== MODEL_VERSION);
const resumedCompletedTaskIds = resetForModelChange ? [] : (previousStatus?.completedTaskIds ?? []);
const resumedRecoveredTaskIds = resetForModelChange ? [] : (previousStatus?.recoveredTaskIds ?? []);
const completedTaskIds = new Set([
  ...(resetForModelChange ? [] : initialCompleted),
  ...resumedCompletedTaskIds,
].filter((id) => taskIds.has(id)));
const recoveredTaskIds = new Set(resumedRecoveredTaskIds.filter((id) => taskIds.has(id)));
const startedAt = resetForModelChange ? new Date().toISOString() : (previousStatus?.startedAt ?? new Date().toISOString());
const config = {
  attributeGroups,
  costs,
  positions,
  passes,
  firstScenarios,
  finalScenarios,
  finalists,
  turns,
  workers,
  fallbackWorkers,
  screeningCandidateLimit,
  outputRoot,
  priorOutputRoot,
  modelVersion: MODEL_VERSION,
};

await fs.mkdir(path.dirname(statusPath), { recursive: true });
if (resetForModelChange) {
  await fs.rm(path.resolve(projectRoot, outputRoot), { recursive: true, force: true });
  console.warn(`Metagame model changed from ${previousModelVersion ?? "unknown"} to ${MODEL_VERSION}; restarting v6 from zero.`);
}
console.log(`Metagame batch: ${completedTaskIds.size}/${tasks.length} runs already complete`);

let currentTask = null;
let completedThisRun = 0;
const completedConstraintIdsThisRun = new Set();

try {
  for (const task of tasks) {
    if (completedTaskIds.has(task.id)) continue;
    const startsNewConstraint = !completedConstraintIdsThisRun.has(task.constraintId);
    if (startsNewConstraint && maxConstraints && completedConstraintIdsThisRun.size >= maxConstraints) break;
    completedConstraintIdsThisRun.add(task.constraintId);
    currentTask = task;
    const status = {
      status: "running",
      startedAt,
      updatedAt: new Date().toISOString(),
      config,
      totalRuns: tasks.length,
      completedRuns: completedTaskIds.size,
      completedTaskIds: [...completedTaskIds],
      recoveredTaskIds: [...recoveredTaskIds],
      current: task,
    };
    await writeStatus(status);
    console.log(`\n[${completedTaskIds.size + 1}/${tasks.length}] ${task.constraintId} / pass ${task.pass} / slot ${task.position}`);
    const ratingArguments = [
      "--attributes=" + task.allowedAttributes.join(","),
      "--cost=" + task.cost,
      "--position=" + task.position,
      "--first-scenarios=" + firstScenarios,
      "--final-scenarios=" + finalScenarios,
      "--finalists=" + finalists,
      "--turns=" + turns,
      "--output-root=" + outputRoot,
      "--screening-candidates=" + screeningCandidateLimit,
      "--screening-offset=" + (task.pass - 1),
    ];
    let recoveredWithFallback = false;
    try {
      await runNode(ratingScript, [...ratingArguments, "--workers=" + workers]);
    } catch (primaryError) {
      if (fallbackWorkers >= workers) throw primaryError;
      console.warn("Primary workers failed for " + task.id + "; retrying with " + fallbackWorkers + " worker(s).");
      await writeStatus({
        ...status,
        status: "retrying",
        updatedAt: new Date().toISOString(),
        recovery: {
          taskId: task.id,
          primaryWorkers: workers,
          fallbackWorkers,
          primaryError: primaryError.stack ?? String(primaryError),
        },
      });
      await runNode(ratingScript, [...ratingArguments, "--workers=" + fallbackWorkers]);
      recoveredWithFallback = true;
    }
    completedTaskIds.add(task.id);
    if (recoveredWithFallback) recoveredTaskIds.add(task.id);
    completedThisRun += 1;
    await writeStatus({
      ...status,
      updatedAt: new Date().toISOString(),
      completedRuns: completedTaskIds.size,
      completedTaskIds: [...completedTaskIds],
      recoveredTaskIds: [...recoveredTaskIds],
      current: null,
    });
    currentTask = null;
    if (maxTasks && completedThisRun >= maxTasks) break;
  }
  if (completedTaskIds.size === tasks.length) {
    await writeStatus({
      status: "completed",
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      config,
      totalRuns: tasks.length,
      completedRuns: completedTaskIds.size,
      completedTaskIds: [...completedTaskIds],
      recoveredTaskIds: [...recoveredTaskIds],
      current: null,
    });
    console.log("All " + tasks.length + " metagame runs completed.");
  } else {
    const pausedAt = new Date().toISOString();
    const pauseReason = maxConstraints
      ? "Stopped after " + completedThisRun + " task(s) across " + completedConstraintIdsThisRun.size + " constraint(s) due to max-constraints."
      : "Stopped after " + completedThisRun + " task(s) due to max-tasks.";
    await writeStatus({
      status: "paused",
      startedAt,
      updatedAt: pausedAt,
      pausedAt,
      pauseReason,
      config,
      totalRuns: tasks.length,
      completedRuns: completedTaskIds.size,
      completedTaskIds: [...completedTaskIds],
      recoveredTaskIds: [...recoveredTaskIds],
      current: null,
    });
    console.log(pauseReason);
  }
} catch (error) {
  await writeStatus({
    status: "failed",
    startedAt,
    updatedAt: new Date().toISOString(),
    config,
    totalRuns: tasks.length,
    completedRuns: completedTaskIds.size,
    completedTaskIds: [...completedTaskIds],
    recoveredTaskIds: [...recoveredTaskIds],
    current: currentTask,
    error: error.stack ?? String(error),
  });
  throw error;
}
