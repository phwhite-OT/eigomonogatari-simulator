import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const runnerPath = path.resolve(scriptDirectory, "run-lightest-local.mjs");
const bridgePort = Math.max(1, Math.floor(Number(
  process.argv.find((entry) => entry.startsWith("--port="))?.slice("--port=".length) ?? 41773,
)) || 41773);
const jobDirectory = path.resolve(projectRoot, ".cache", "lightest", "browser-jobs");
const jobs = new Map();

function defaultWorkerCount() {
  const logical = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, logical - 1);
}

function applyCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome's Local Network Access preflight requires this when the browser
  // page is served over HTTPS and the solver is bound to localhost.
  response.setHeader("Access-Control-Allow-Private-Network", "true");
}

function respond(response, statusCode, value) {
  applyCors(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readBody(request, limit = 30 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("リクエストが大きすぎます（上限30MB）");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error ?? null,
    output: job.output.slice(-20),
    result: job.status === "complete" ? job.result : undefined,
  };
}

async function removeJobFiles(job) {
  await Promise.all([job.stagePath, job.charactersPath, job.resultPath]
    .filter(Boolean)
    .map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
}

async function startJob(payload) {
  if (!payload?.stage || !Array.isArray(payload.characters)) {
    throw new Error("stage と characters 配列が必要です");
  }
  if ([...jobs.values()].some((job) => ["starting", "running"].includes(job.status))) {
    const error = new Error("A local lightest-search job is already running.");
    error.statusCode = 409;
    throw error;
  }
  const id = randomUUID();
  const job = {
    id,
    status: "starting",
    createdAt: new Date().toISOString(),
    output: [],
    stagePath: path.join(jobDirectory, `${id}.stage.json`),
    charactersPath: path.join(jobDirectory, `${id}.characters.json`),
    resultPath: path.join(jobDirectory, `${id}.result.json`),
  };
  jobs.set(id, job);
  await writeJson(job.stagePath, { stage: payload.stage, searchOptions: payload.searchOptions ?? {} });
  await writeJson(job.charactersPath, { characters: payload.characters });
  const requestedWorkers = Math.max(1, Math.floor(Number(payload.workers) || defaultWorkerCount()));
  const child = spawn(process.execPath, [
    runnerPath,
    `--stage=${path.relative(projectRoot, job.stagePath)}`,
    `--characters=${path.relative(projectRoot, job.charactersPath)}`,
    `--workers=${requestedWorkers}`,
    `--result=${path.relative(projectRoot, job.resultPath)}`,
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const append = (chunk) => {
    job.output.push(chunk.toString("utf8").trim());
    if (job.output.length > 100) job.output.splice(0, job.output.length - 100);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", async (error) => {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    await removeJobFiles(job);
  });
  child.once("exit", async (code, signal) => {
    if (job.status === "cancelled") return;
    const result = await readJson(job.resultPath);
    job.completedAt = new Date().toISOString();
    if (code === 0 && result?.status === "complete") {
      job.status = "complete";
      job.result = result;
    } else {
      job.status = "failed";
      job.error = signal
        ? `計算プロセスが停止しました (${signal})`
        : job.output.at(-1) || `計算プロセスが終了しました (code ${code})`;
    }
    await removeJobFiles(job);
  });
  return job;
}

async function cancelJob(job) {
  if (!job || !["starting", "running"].includes(job.status)) return;
  job.status = "cancelled";
  job.completedAt = new Date().toISOString();
  job.child?.kill();
  await removeJobFiles(job);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "OPTIONS") {
      applyCors(response);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      respond(response, 200, {
        ready: true,
        defaultWorkerCount: defaultWorkerCount(),
        activeJobCount: [...jobs.values()].filter((job) => job.status === "running").length,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      const job = await startJob(await readBody(request));
      respond(response, 202, publicJob(job));
      return;
    }
    const match = url.pathname.match(/^\/jobs\/([\w-]+)$/);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return respond(response, 404, { error: "計算ジョブが見つかりません" });
      if (request.method === "GET") return respond(response, 200, publicJob(job));
      if (request.method === "DELETE") {
        await cancelJob(job);
        return respond(response, 200, publicJob(job));
      }
    }
    respond(response, 404, { error: "Not found" });
  } catch (error) {
    respond(response, error?.statusCode ?? 400, { error: error?.message ?? String(error) });
  }
});

server.listen(bridgePort, "127.0.0.1", () => {
  console.log(`最軽装ローカル計算機を起動しました: http://127.0.0.1:${bridgePort}`);
  console.log("ブラウザで最軽装の探索ボタンを押すと、このPCのWorkerで計算します。");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await Promise.all([...jobs.values()].map(cancelJob));
    server.close(() => process.exit(0));
  });
}
