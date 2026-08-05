import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCharacterRatingReport, ratingReportToCsv } from "../src/core/character-rating.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const position = Number(readArgument("position", "2"));
const totalCost = Number(readArgument("cost", "150"));
const allowedAttributes = readArgument("attributes", "fire,water,wind")
  .split(",")
  .map((attribute) => attribute.trim())
  .filter(Boolean);
const topLimit = Number(readArgument("top", "20"));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const attributeKey = allowedAttributes.join("-") || "all";
const defaultOutput = path.join(
  projectRoot,
  "reports",
  "character-ratings",
  attributeKey,
  `slot-${position}-cost-${totalCost}`,
);
const outputBase = path.resolve(projectRoot, readArgument("output", path.relative(projectRoot, defaultOutput)));

console.log(`評価開始: ${WORKBOOK_CHARACTERS.length}体 / ${position}枠目 / 総コスト${totalCost}`);
console.time("character-rating");
const report = buildCharacterRatingReport(WORKBOOK_CHARACTERS, {
  position,
  totalCost,
  allowedAttributes,
  topLimit,
});
console.timeEnd("character-rating");

await fs.mkdir(path.dirname(outputBase), { recursive: true });
await Promise.all([
  fs.writeFile(`${outputBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  fs.writeFile(`${outputBase}.csv`, ratingReportToCsv(report), "utf8"),
]);

console.log(`対象キャラ: ${report.context.eligibleCharacterCount}体`);
console.log(`JSON: ${outputBase}.json`);
console.log(`CSV : ${outputBase}.csv`);
console.log("指定コスト上位:");
for (const character of report.characters.slice(0, 10)) {
  const rank = character.selectedCost.rank ?? "-";
  const utility = character.selectedCost.utility ?? "-";
  console.log(`${String(rank).padStart(3)}位  ${character.name}  cost=${character.cost}  評価=${utility}  基礎=${character.baseScore}`);
}
