import { METAGAME_V12_SWEEP_INPUTS } from "../src/data/metagame-v12-sweep-inputs.js";

const preferredCostOrder = [200, 300, 500, 100];
const costPriority = new Map(preferredCostOrder.map((cost, index) => [cost, index]));

const ordered = [...METAGAME_V12_SWEEP_INPUTS].sort((left, right) => {
  const leftPriority = costPriority.get(Number(left.totalCost)) ?? preferredCostOrder.length;
  const rightPriority = costPriority.get(Number(right.totalCost)) ?? preferredCostOrder.length;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return METAGAME_V12_SWEEP_INPUTS.indexOf(left) - METAGAME_V12_SWEEP_INPUTS.indexOf(right);
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(ordered.map((input) => input.id)));
} else if (process.argv.includes("--costs-json")) {
  console.log(JSON.stringify([...new Set(ordered.map((input) => Number(input.totalCost)))].sort((left, right) => left - right)));
} else {
  for (const input of ordered) console.log(input.id);
}
