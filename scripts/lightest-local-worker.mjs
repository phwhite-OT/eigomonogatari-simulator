import { parentPort, workerData } from "node:worker_threads";

import { findExactLightestDeck } from "../src/core/lightest-exact.js";

if (!parentPort) throw new Error("最軽装ローカルWorkerは親プロセスから起動してください");

parentPort.on("message", async (message) => {
  if (message?.type !== "run") return;
  const startedAt = Date.now();
  try {
    const result = await findExactLightestDeck(workerData.characters, {
      ...workerData.stage,
      deckSize: message.deckSize,
      targetCost: message.cost,
    }, {
      ...workerData.options,
      candidateShard: { index: message.shardIndex, count: message.shardCount },
      // A winning candidate at this cost is sufficient after all lower costs
      // have completed, so do not spend time collecting alternative winners.
      stopOnFirstWin: true,
    });
    parentPort.postMessage({
      type: "complete",
      taskId: message.taskId,
      cost: message.cost,
      deckSize: message.deckSize,
      shardIndex: message.shardIndex,
      elapsedMs: Date.now() - startedAt,
      result,
    });
  } catch (error) {
    parentPort.postMessage({
      type: "failed",
      taskId: message.taskId,
      cost: message.cost,
      deckSize: message.deckSize,
      shardIndex: message.shardIndex,
      elapsedMs: Date.now() - startedAt,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      },
    });
  }
});
