import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/metagame-v12-shared-pool-recompute.yml", "utf8");
const watchdog = fs.readFileSync(".github/workflows/metagame-v12-watchdog.yml", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy-pages.yml", "utf8");
const rateScript = fs.readFileSync("scripts/rate-metagame-v12.mjs", "utf8");
const metagameV12 = fs.readFileSync("src/core/metagame-v12.js", "utf8");

test("V12 recompute finalization is chunked, resumable, and only marks finished reports complete", () => {
  assert.match(workflow, /matched-slot-counterfactual-v3-resumable/);
  assert.match(workflow, /FINALIZE_TIME_BUDGET_SECONDS:\s*"7200"/);
  assert.match(workflow, /--time-budget-seconds="\$FINALIZE_TIME_BUDGET_SECONDS"/);
  assert.match(workflow, /\.status == "complete" or \.status == "finalizing"/);
  assert.match(workflow, /if jq -e '\.status == "complete"' "\$checkpoint_path"/);

  const saveStep = workflow.indexOf("Save isolated recompute progress");
  const continueStep = workflow.indexOf("Continue with the next recompute segment");
  assert.ok(saveStep >= 0 && continueStep > saveStep, "progress must be pushed before continuation is dispatched");

  assert.match(rateScript, /saveProgress\("finalizing"\)/);
  assert.match(rateScript, /finalizationDeadlineReached/);
  assert.match(rateScript, /counterfactualNewEvaluations % 5 === 0/);
  const reportWrite = rateScript.indexOf('path.join(outputDirectory, "report.json")');
  const completeSave = rateScript.lastIndexOf('saveProgress("complete")');
  assert.ok(reportWrite >= 0 && completeSave > reportWrite, "progress.json may become complete only after report output exists");
});

test("V12 watchdog restarts abandoned work and cancels stale or looping runs", () => {
  assert.match(watchdog, /schedule:/);
  assert.match(watchdog, /17,47 \* \* \* \*/);
  assert.match(watchdog, /actions:\s*write/);
  assert.match(watchdog, /actions\/runs\/\$\{run_id\}\/cancel/);
  assert.match(watchdog, /gh workflow run "\$workflow"/);
  assert.match(watchdog, /progress_age_minutes/);
  assert.match(watchdog, /completed_without_progress/);
  assert.match(watchdog, /same-source completed-without-progress/);
});

test("matched-slot exploration is broadened beyond one proxy-top shell", () => {
  assert.match(rateScript, /counterfactual-anchor-limit", "3"/);
  assert.match(rateScript, /replacement-deck-limit", "24"/);
  assert.match(rateScript, /minOtherSlotDifference >= 2/);
  assert.match(metagameV12, /strongest proxy half/);
  assert.match(metagameV12, /const roles = \["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"\]/);
  assert.match(metagameV12, /const byCost = \[\.\.\.legal\]\.sort/);
});

test("Pages only promotes the same resumable ranking policy", () => {
  assert.match(deployWorkflow, /ranking_policy="matched-slot-counterfactual-v3-resumable"/);
  assert.doesNotMatch(deployWorkflow, /matched-slot-counterfactual-v2/);
});
