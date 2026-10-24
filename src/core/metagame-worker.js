import { findBestMetagameDeck } from "./metagame-deck.js";

globalThis.postMessage({ type: "ready" });

globalThis.addEventListener("message", async (event) => {
  const message = event.data ?? {};
  if (message.type !== "search") return;
  const jobId = String(message.jobId ?? "");
  try {
    let lastProgressAt = 0;
    const result = await findBestMetagameDeck(
      message.data,
      message.constraintId,
      message.characters,
      {
        ...(message.options ?? {}),
        onProgress: (progress) => {
          const now = globalThis.performance?.now?.() ?? Date.now();
          const total = Number(progress?.total) || 0;
          const completed = Number(progress?.completed) || 0;
          if (total > 0 && completed < total && now - lastProgressAt < 50) return;
          lastProgressAt = now;
          globalThis.postMessage({ type: "progress", jobId, progress });
        },
      },
    );
    globalThis.postMessage({ type: "result", jobId, result });
  } catch (error) {
    globalThis.postMessage({
      type: "error",
      jobId,
      error: {
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
        stack: error?.stack ?? "",
      },
    });
  }
});
