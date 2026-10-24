import { findBestMetagameDeck } from "./metagame-deck.js";

globalThis.postMessage({ type: "ready" });

globalThis.addEventListener("message", async (event) => {
  const message = event.data ?? {};
  if (message.type !== "search") return;
  const jobId = String(message.jobId ?? "");
  try {
    const result = await findBestMetagameDeck(
      message.data,
      message.constraintId,
      message.characters,
      {
        ...(message.options ?? {}),
        onProgress: (progress) => {
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
