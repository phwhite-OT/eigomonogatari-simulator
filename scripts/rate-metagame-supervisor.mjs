import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

async function readJson(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function processExists(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runBatch(scriptPath, argumentsToForward) {
  const child = spawn(process.execPath, [scriptPath, ...argumentsToForward], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return {
    child,
    completed: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const separatorIndex = process.argv.indexOf("--");
const forwarded = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];
const batchScript = path.resolve(projectRoot, forwarded.shift() ?? "scripts/rate-metagame-batch.mjs");
const batchArguments = forwarded;
const batchStatusPath = path.resolve(projectRoot, readArgument("batch-status", "reports/metagame-v2-batch-status.json"));
const supervisorStatusPath = path.resolve(projectRoot, readArgument("status", "reports/metagame-v2-supervisor-status.json"));
const activePath = path.resolve(projectRoot, readArgument("active", "reports/metagame-v2-active.json"));
const watchedProcessId = Number(readArgument("watch-pid", "0"));
const maxTaskRetries = Math.max(1, Number(readArgument("max-task-retries", "5")) || 5);
const retryDelay = Math.max(1000, Number(readArgument("retry-delay-ms", "10000")) || 10000);
const failureCounts = new Map();
let restartCount = 0;
let childProcessId = processExists(watchedProcessId) ? watchedProcessId : null;
let lastObservedTask = null;

async function updateStatus(status, extra = {}) {
  const batchStatus = await readJson(batchStatusPath);
  if (batchStatus?.current) lastObservedTask = batchStatus.current;
  const value = {
    status,
    supervisorProcessId: process.pid,
    childProcessId,
    updatedAt: new Date().toISOString(),
    restartCount,
    maxTaskRetries,
    current: batchStatus?.current ?? lastObservedTask,
    completedRuns: batchStatus?.completedRuns ?? 0,
    totalRuns: batchStatus?.totalRuns ?? null,
    ...extra,
  };
  await writeJson(supervisorStatusPath, value);
  const active = await readJson(activePath) ?? {};
  await writeJson(activePath, {
    ...active,
    ProcessId: childProcessId ?? active.ProcessId,
    SupervisorProcessId: process.pid,
    SupervisorStatus: supervisorStatusPath,
  });
}

if (childProcessId) {
  await updateStatus("monitoring-existing");
  while (processExists(childProcessId)) {
    await wait(5000);
    await updateStatus("monitoring-existing");
  }
  childProcessId = null;
}

while (true) {
  const batchStatus = await readJson(batchStatusPath);
  if (batchStatus?.status === "completed") {
    await updateStatus("completed", { completedAt: new Date().toISOString() });
    break;
  }

  const failedTask = batchStatus?.current ?? lastObservedTask;
  const failedTaskId = failedTask?.id ?? "unknown";
  if (batchStatus?.status === "failed") {
    const failures = (failureCounts.get(failedTaskId) ?? 0) + 1;
    failureCounts.set(failedTaskId, failures);
    if (failures > maxTaskRetries) {
      await updateStatus("blocked", {
        failedTask,
        failureCount: failures,
        error: batchStatus.error,
      });
      process.exitCode = 1;
      break;
    }
  }

  restartCount += 1;
  await updateStatus("restarting", { retryAt: new Date(Date.now() + retryDelay).toISOString() });
  await wait(retryDelay);
  const running = runBatch(batchScript, batchArguments);
  childProcessId = running.child.pid;
  await updateStatus("running");
  const result = await running.completed;
  childProcessId = null;
  const latestStatus = await readJson(batchStatusPath);
  if (result.code === 0 && latestStatus?.status === "completed") {
    await updateStatus("completed", { completedAt: new Date().toISOString() });
    break;
  }
  await updateStatus("retry-pending", {
    lastExitCode: result.code,
    lastSignal: result.signal,
    error: latestStatus?.error ?? null,
  });
}
