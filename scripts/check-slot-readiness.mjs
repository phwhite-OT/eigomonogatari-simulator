import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEnvironmentPositionPool,
  buildSlotEntryScenarios,
  createDeckCompletionSolver,
  readinessSummary,
} from "../src/core/environment-rating.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import { DEFAULT_RULES } from "../src/data/rules.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function weightedCharacters(sections, charactersById, limits) {
  const weighted = [];
  for (const [key, copies] of [["overall", 3], ["offense", 2], ["defense", 2]]) {
    for (const entry of (sections[key] ?? []).slice(0, limits[key])) {
      const character = charactersById.get(String(entry.id));
      if (!character) continue;
      for (let count = 0; count < copies; count += 1) weighted.push(character);
    }
  }
  return weighted;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const totalCost = Number(readArgument("cost", "150"));
const allowedAttributes = readArgument("attributes", "fire,water,wind").split(",").filter(Boolean);
const count = Number(readArgument("count", "600"));
const attributeKey = allowedAttributes.join("-") || "all";
const reportPath = path.join(
  projectRoot,
  "reports",
  "environment-ratings",
  attributeKey,
  `slot-2-cost-${totalCost}.json`,
);
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const charactersById = new Map(WORKBOOK_CHARACTERS.map((character) => [String(character.id), character]));
const positionPools = [1, 2, 3, 4, 5].map((position) => buildEnvironmentPositionPool(
  WORKBOOK_CHARACTERS,
  position,
  { allowedAttributes },
));
const solveCompletion = createDeckCompletionSolver(positionPools, totalCost);
const openerEnvironment = weightedCharacters(report.openerEnvironment, charactersById, {
  overall: 30,
  offense: 30,
  defense: 30,
});
const secondEnvironment = weightedCharacters(report.secondSlot, charactersById, {
  overall: 100,
  offense: 80,
  defense: 80,
});

if (!openerEnvironment.length || !secondEnvironment.length) {
  throw new Error("既存の環境評価レポートから候補環境を復元できませんでした。");
}

console.time("slot-readiness");
const scenarios = buildSlotEntryScenarios({
  count,
  openerEnvironment,
  secondEnvironment,
  solveCompletion,
  rules: DEFAULT_RULES,
  seed: Number(readArgument("seed", "4404")),
});
const summary = readinessSummary(scenarios);
console.timeEnd("slot-readiness");
console.log(JSON.stringify(summary, null, 2));
