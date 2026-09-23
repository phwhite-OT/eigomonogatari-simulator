import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/metagame-v12-shared-pool-recompute.yml", "utf8");
const fanout = fs.readFileSync(".github/workflows/metagame-v12-finalization-fanout.yml", "utf8");
const watchdog = fs.readFileSync(".github/workflows/metagame-v12-watchdog.yml", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy-pages.yml", "utf8");
const rerankWorkflow = fs.readFileSync(".github/workflows/v12-cost100-rerank.yml", "utf8");
const rerankScript = fs.readFileSync("scripts/rerank-metagame-v12-report.mjs", "utf8");
const rateScript = fs.readFileSync("scripts/rate-metagame-v12.mjs", "utf8");
const metagameV12 = fs.readFileSync("src/core/metagame-v12.js", "utf8");

const rankingPolicy = "full-budget-opportunity-v9-adaptive-metagame";

test("V12 ranking-only upgrades reuse durable battle evidence", () => {
  assert.match(workflow, /src\/core\/metagame-v12-adaptive\.js/);
  assert.match(workflow, new RegExp(rankingPolicy));
  assert.match(workflow, /--finalize-only=true/);
  assert.match(workflow, /Refreshing .* completed battle evidence under the current adaptive ranking policy/);

  assert.match(rateScript, /buildAdaptiveMetagameV12Equilibrium/);
  assert.match(rateScript, /reconcileAdaptiveMetagameV12RatingsByPosition/);
  assert.match(rateScript, /adaptiveMetagame/);
  const reportWrite = rateScript.indexOf('path.join(outputDirectory, "report.json")');
  const completeSave = rateScript.lastIndexOf('saveProgress("complete")');
  assert.ok(reportWrite >= 0 && completeSave > reportWrite, "progress.json may become complete only after adaptive report output exists");
});

test("V12 heavy work remains resumable and capped at nineteen parallel runners", () => {
  assert.match(workflow, /max-parallel:\s*19/);
  assert.match(fanout, /max-parallel:\s*19/);
  assert.match(rateScript, /saveProgress\("finalizing"\)/);
  assert.match(rateScript, /finalizationDeadlineReached/);
  assert.match(rateScript, /finalizationState\.cursor/);
  assert.match(rateScript, /MetagameV12EvaluationPool/);
});

test("V12 publish hands off only counterfactual finalization to fanout", () => {
  assert.match(workflow, /Condition entered counterfactual finalization/);
  assert.match(workflow, /Condition still needs candidate\/baseline finalization work/);
  assert.match(workflow, /\.finalizationState\.phase == "counterfactual"/);
  assert.match(workflow, /\.finalizationState\.cursor\.planIndex < \(\.finalizationState\.plan \| length\)/);
});

test("V12 watchdog recognizes adaptive policy and safely heals pending concurrency stalls", () => {
  assert.match(watchdog, /schedule:/);
  assert.match(watchdog, /\*\/10 \* \* \* \*/);
  assert.match(watchdog, /actions:\s*write/);
  assert.match(watchdog, new RegExp(rankingPolicy));
  assert.match(watchdog, /v12-recompute-runs\.json/);
  assert.match(watchdog, /jq -c -s/);
  assert.doesNotMatch(watchdog, /--argjson rr/);
  assert.match(watchdog, /running=.*status == "in_progress"/);
  assert.match(watchdog, /desired_pending=/);
  assert.match(watchdog, /waiting behind healthy owner/);
  assert.match(watchdog, /orphan-pending/);
  assert.match(watchdog, /actions\/runs\/\$\{running_id\}\/cancel/);
  assert.match(watchdog, /actions\/runs\/\$\{pending_id\}\/cancel/);
  assert.match(watchdog, /gh workflow run "\$workflow"/);
});

test("legacy reports cannot be relabeled as adaptive reports", () => {
  assert.match(rerankScript, /adaptiveMetagame\?\.version/);
  assert.match(rerankScript, /Adaptive V12 rerank requires a report already finalized/);
  assert.match(rerankWorkflow, /adaptiveMetagame\.version == 2/);
  assert.match(fanout, /adaptiveMetagame\.version == 2/);
});

test("matched-slot exploration remains broad while adaptive aggregation is added", () => {
  assert.match(rateScript, /counterfactual-anchor-limit", "3"/);
  assert.match(rateScript, /replacement-deck-limit", "24"/);
  assert.match(metagameV12, /strongest proxy half/);
  assert.match(metagameV12, /const roles = \["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"\]/);
  assert.match(metagameV12, /const byCost = \[\.\.\.legal\]\.sort/);
});

test("Pages only publishes fully adaptive V12 conditions", () => {
  assert.match(deployWorkflow, new RegExp(rankingPolicy));
  assert.match(deployWorkflow, /\.adaptiveMetagame\.version == 2/);
  assert.match(deployWorkflow, /\.adaptiveMetagame\.version == 2'/);
  assert.doesNotMatch(deployWorkflow, /full-budget-opportunity-v8-mean-primary-slot/);
});
