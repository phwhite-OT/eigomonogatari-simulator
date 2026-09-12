import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Wrapper for the two finalize command shapes in the production workflow.
const originalPath = "scripts/apply-v12-resilience-fix.mjs";
let patcher = await fs.readFile(originalPath, "utf8");
const strictNeedle = '    2,\n    "finalize time budget args",';
if (!patcher.includes(strictNeedle)) throw new Error("Could not relax finalize invocation patch count");
patcher = patcher.replace(strictNeedle, '    1,\n    "finalize time budget args",');
const temporaryPatcher = "/tmp/apply-v12-resilience-fix-runtime.mjs";
await fs.writeFile(temporaryPatcher, patcher, "utf8");
await import(pathToFileURL(temporaryPatcher));

const workflowPath = ".github/workflows/metagame-v12-shared-pool-recompute.yml";
let workflow = await fs.readFile(workflowPath, "utf8");
const before = '                --merge-checkpoint-paths="$checkpoint_paths" \\\n                --finalize-only=true';
const after = '                --merge-checkpoint-paths="$checkpoint_paths" \\\n                --time-budget-seconds="$FINALIZE_TIME_BUDGET_SECONDS" \\\n                --finalize-only=true';
if (!workflow.includes(before)) throw new Error("Merge-checkpoint finalize invocation was not found");
workflow = workflow.replace(before, after);
await fs.writeFile(workflowPath, workflow, "utf8");
console.log("Applied second finalize invocation budget patch.");
