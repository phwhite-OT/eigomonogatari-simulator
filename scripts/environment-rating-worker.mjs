import { parentPort, workerData } from "node:worker_threads";

import {
  buildEnvironmentPositionPool,
  createDeckCompletionSolver,
  evaluateCandidateInEnvironment,
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
const results = workerData.candidateIds.map((id) => evaluateCandidateInEnvironment(
  charactersById.get(String(id)),
  workerData.scenarios,
  { rules: DEFAULT_RULES, solveCompletion },
));

parentPort.postMessage({ workerIndex: workerData.workerIndex, results });
