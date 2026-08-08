import { parentPort, workerData } from "node:worker_threads";

import {
  buildCandidatePositionEntryScenarios,
  buildEnvironmentPositionPool,
  createDeckCompletionSolver,
  evaluateCandidateMatchOutcome,
} from "../src/core/environment-rating.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

const positionPools = [1, 2, 3, 4, 5].map((position) => buildEnvironmentPositionPool(
  WORKBOOK_CHARACTERS,
  position,
  { allowedAttributes: workerData.allowedAttributes },
));
const solveCompletion = createDeckCompletionSolver(positionPools, workerData.totalCost);
const charactersById = new Map(WORKBOOK_CHARACTERS.map((character) => [String(character.id), character]));
const positionEnvironments = workerData.scenarioOptions.positionEnvironments.map((entries) => entries.flatMap((entry) => {
  const character = charactersById.get(String(entry.id));
  return character ? [{ character, weight: entry.weight }] : [];
}));
const scenarioOptions = {
  ...workerData.scenarioOptions,
  positionEnvironments,
};
let paused = false;
for (let index = 0; index < workerData.candidateIds.length; index += 1) {
  if (workerData.deadlineAt && Date.now() >= workerData.deadlineAt) {
    paused = true;
    break;
  }
  const id = workerData.candidateIds[index];
  const character = charactersById.get(String(id));
  try {
    const scenarios = buildCandidatePositionEntryScenarios({
      ...scenarioOptions,
      character,
      solveCompletion,
      rules: DEFAULT_RULES,
      allowPartial: true,
    });
    const result = {
      ...evaluateCandidateMatchOutcome(character, scenarios, {
        rules: DEFAULT_RULES,
        solveCompletion,
        turns: workerData.turns,
      }),
      position: workerData.scenarioOptions.position,
    };
    parentPort.postMessage({ type: "candidate", workerIndex: workerData.workerIndex, result });
  } catch (error) {
    if (error.code !== "INSUFFICIENT_ENTRY_SCENARIOS") throw error;
    parentPort.postMessage({ type: "candidate", workerIndex: workerData.workerIndex, skippedCandidateId: String(character.id) });
  }
  if ((index + 1) % 10 === 0 || index + 1 === workerData.candidateIds.length) {
    parentPort.postMessage({
      type: "progress",
      workerIndex: workerData.workerIndex,
      completed: index + 1,
      total: workerData.candidateIds.length,
    });
  }
}

parentPort.postMessage({ type: "result", workerIndex: workerData.workerIndex, paused });
