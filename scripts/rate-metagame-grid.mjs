import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function parseList(value) {
  return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseCosts(value) {
  const costs = [];
  for (const token of parseList(value)) {
    const range = token.match(/^(\d+):(\d+)(?::(\d+))?$/);
    if (!range) {
      costs.push(Number(token));
      continue;
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    const step = Math.max(1, Number(range[3]) || 1);
    if (start <= end) {
      for (let cost = start; cost <= end; cost += step) costs.push(cost);
    } else {
      for (let cost = start; cost >= end; cost -= step) costs.push(cost);
    }
  }
  return [...new Set(costs)].filter((cost) => Number.isFinite(cost) && cost >= 0);
}

function runNode(scriptPath, argumentsToForward) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...argumentsToForward], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`評価プロセスが停止しました（code=${code}, signal=${signal ?? "none"}）。`));
    });
  });
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const ratingScript = path.join(scriptDirectory, "rate-metagame.mjs");
const attributes = parseList(readArgument("attributes", "fire,water,wind"));
const costs = parseCosts(readArgument("costs", "150"));
const positions = parseList(readArgument("positions", "1,2,3,4,5"))
  .map(Number)
  .filter((position) => Number.isInteger(position) && position >= 1 && position <= 5);
const passes = Math.max(1, Number(readArgument("passes", "2")) || 2);
const firstScenarios = Math.max(4, Number(readArgument("first-scenarios", "4")) || 4);
const finalScenarios = Math.max(12, Number(readArgument("final-scenarios", "30")) || 30);
const finalists = Math.max(1, Math.floor(Number(readArgument("finalists", "40")) || 40));
const turns = Math.min(12, Math.max(1, Number(readArgument("turns", "12")) || 12));
const workers = readArgument("workers", "");

if (!attributes.length || !costs.length || !positions.length) {
  throw new Error("属性・総コスト・枠の指定に有効な値がありません。");
}

const combinations = attributes.flatMap((attribute) => costs.flatMap((cost) => positions.map((position) => ({
  attribute,
  cost,
  position,
}))));
const totalRuns = combinations.length * passes;
let completedRuns = 0;

console.log(`縛り別メタ環境評価: ${attributes.length}属性 × ${costs.length}コスト × ${positions.length}枠 × ${passes}周 = ${totalRuns}回`);
console.log(`コスト値: ${costs.join(", ")}（帯ではなく各値を独立評価）`);

for (let pass = 1; pass <= passes; pass += 1) {
  const passCombinations = pass % 2 === 1 ? combinations : [...combinations].reverse();
  console.log(`\n===== 環境反復 ${pass}/${passes} =====`);
  for (const combination of passCombinations) {
    completedRuns += 1;
    console.log(`\n[${completedRuns}/${totalRuns}] ${combination.attribute} / cost ${combination.cost} / ${combination.position}枠目`);
    const args = [
      `--attributes=${combination.attribute}`,
      `--cost=${combination.cost}`,
      `--position=${combination.position}`,
      `--first-scenarios=${firstScenarios}`,
      `--final-scenarios=${finalScenarios}`,
      `--finalists=${finalists}`,
      `--turns=${turns}`,
    ];
    if (workers) args.push(`--workers=${workers}`);
    await runNode(ratingScript, args);
  }
}

console.log(`\n全${totalRuns}回の縛り別評価が完了しました。`);
