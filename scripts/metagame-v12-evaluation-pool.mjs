import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { evaluateMetagameV7Deck } from "../src/core/metagame-v7.js";

function serializedError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? "",
  };
}

if (!isMainThread) {
  const { teamScenarios, turns } = workerData ?? {};
  parentPort.on("message", ({ taskId, deck }) => {
    try {
      const result = evaluateMetagameV7Deck(deck, teamScenarios, { turns });
      parentPort.postMessage({ taskId, result });
    } catch (error) {
      parentPort.postMessage({ taskId, error: serializedError(error) });
    }
  });
}

export function recommendedMetagameV12WorkerCount(requested = 4) {
  const available = Math.max(1, Number(availableParallelism?.()) || 1);
  const wanted = Math.max(1, Math.floor(Number(requested) || 1));
  return Math.min(4, available, wanted);
}

export class MetagameV12EvaluationPool {
  constructor({ teamScenarios, turns, workerCount = 4 }) {
    this.teamScenarios = teamScenarios;
    this.turns = turns;
    this.workerCount = recommendedMetagameV12WorkerCount(workerCount);
    this.closed = false;
    this.nextTaskId = 1;
    this.queue = [];
    this.pending = new Map();
    this.workers = [];

    if (this.workerCount > 1) {
      for (let index = 0; index < this.workerCount; index += 1) this.#spawnWorker();
    }
  }

  #spawnWorker() {
    const slot = { worker: null, taskId: null, closing: false };
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
      workerData: {
        teamScenarios: this.teamScenarios,
        turns: this.turns,
      },
    });
    slot.worker = worker;
    this.workers.push(slot);

    worker.on("message", (message) => {
      const task = this.pending.get(message.taskId);
      if (!task) return;
      this.pending.delete(message.taskId);
      slot.taskId = null;
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        error.stack = message.error.stack || error.stack;
        task.reject(error);
      } else {
        task.resolve(message.result);
      }
      this.#drain();
    });

    worker.on("error", (error) => {
      if (slot.taskId !== null) {
        const task = this.pending.get(slot.taskId);
        if (task) {
          this.pending.delete(slot.taskId);
          task.reject(error);
        }
        slot.taskId = null;
      }
    });

    worker.on("exit", (code) => {
      if (slot.taskId !== null) {
        const task = this.pending.get(slot.taskId);
        if (task) {
          this.pending.delete(slot.taskId);
          task.reject(new Error(`V12 evaluation worker exited with code ${code}.`));
        }
        slot.taskId = null;
      }
      const index = this.workers.indexOf(slot);
      if (index >= 0) this.workers.splice(index, 1);
      if (!this.closed && !slot.closing && code !== 0) this.#spawnWorker();
      this.#drain();
    });
  }

  #drain() {
    if (this.closed) return;
    for (const slot of this.workers) {
      if (slot.taskId !== null) continue;
      const task = this.queue.shift();
      if (!task) break;
      slot.taskId = task.taskId;
      this.pending.set(task.taskId, task);
      slot.worker.postMessage({ taskId: task.taskId, deck: task.deck });
    }
  }

  async evaluateMany(decks) {
    if (!Array.isArray(decks) || decks.length === 0) return [];
    if (this.closed) throw new Error("V12 evaluation pool is already closed.");
    if (this.workerCount <= 1) {
      return decks.map((deck) => evaluateMetagameV7Deck(deck, this.teamScenarios, { turns: this.turns }));
    }
    const promises = decks.map((deck) => new Promise((resolve, reject) => {
      const taskId = this.nextTaskId;
      this.nextTaskId += 1;
      this.queue.push({ taskId, deck, resolve, reject });
    }));
    this.#drain();
    return Promise.all(promises);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("V12 evaluation pool closed before queued work completed.");
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    const workers = [...this.workers];
    this.workers.length = 0;
    await Promise.all(workers.map(async (slot) => {
      slot.closing = true;
      await slot.worker.terminate();
    }));
  }
}
