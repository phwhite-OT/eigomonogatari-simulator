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
const workMatrixScript = fs.readFileSync("scripts/build-metagame-v12-work-matrix.mjs", "utf8");
const finalizationPlanScript = fs.readFileSync("scripts/plan-metagame-v12-finalization.mjs", "utf8");
const finalizationShardScript = fs.readFileSync("scripts/evaluate-metagame-v12-finalization-shard.mjs", "utf8");
const finalizationAdvanceScript = fs.readFileSync("scripts/advance-metagame-v12-finalization-cache.mjs", "utf8");
const browserKnowledgePlanScript = fs.readFileSync("scripts/plan-metagame-v12-browser-knowledge.mjs", "utf8");
const sharedPoolScript = fs.readFileSync("src/core/metagame-v12-shared-pool.js", "utf8");
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

test("V12 control-plane selection uses compact progress summaries", () => {
  assert.match(workflow, /progress-summary\.json/);
  assert.match(workflow, /read_progress_state/);
  assert.match(workflow, /has_current_ranking "\$output_directory" \|\| return 1/);
  assert.match(fanout, /progress-summary\.json/);
  assert.match(watchdog, /progress-summary\.json/);
  assert.match(workflow, /schemaVersion:\s*1/);
  assert.match(fanout, /schemaVersion:\s*1/);
  assert.match(watchdog, /Legacy fallback|summary_path/);
});

test("V12 heavy work remains resumable and capped at nineteen parallel runners", () => {
  assert.match(workflow, /max-parallel:\s*19/);
  assert.match(fanout, /max-parallel:\s*19/);
  assert.match(rateScript, /saveProgress\("finalizing"\)/);
  assert.match(rateScript, /finalizationDeadlineReached/);
  assert.match(rateScript, /finalizationState\.cursor/);
  assert.match(rateScript, /MetagameV12EvaluationPool/);
});

test("finalize-handoff shards stop before serial counterfactual work", () => {
  assert.match(workMatrixScript, /finalizeHandoff:\s*true/);
  assert.match(workMatrixScript, /finalize_handoff:\s*Boolean\(finalizeHandoff\)/);
  assert.match(workflow, /--stop-after-finalization-plan=/);
  assert.match(rateScript, /stopAfterFinalizationPlan/);
  assert.match(rateScript, /stopping before serial counterfactual work so distributed fanout can take over/);
});

test("distributed fanout merge never falls back to serial counterfactual battles", () => {
  assert.match(rateScript, /distributedCacheMerge = finalizeOnly && mergeCheckpointPaths\.length > 0/);
  assert.match(rateScript, /advancing the frozen plan through cached exact battles only/);
  assert.match(rateScript, /if \(!evaluationCache\.has\(key\)\) \{\s*stoppedEarly = true;\s*break counterfactualAudit;/);
  assert.match(rateScript, /if \(evaluationPool\) await evaluationPool\.close\(\)/);
  assert.match(fanout, /timeout-minutes:\s*60/);
  assert.match(fanout, /must never run missing battles itself/);
});

test("V12 fanout workers use lightweight manifests and dynamic shard counts", () => {
  assert.match(finalizationPlanScript, /evaluationContext:/);
  assert.match(finalizationPlanScript, /compactShardThreshold/);
  assert.match(finalizationPlanScript, /uniqueItems\.length <= compactShardThreshold/);
  assert.match(finalizationShardScript, /lightweightManifest/);
  assert.match(finalizationShardScript, /Legacy finalization manifests require --input-checkpoint/);
  assert.doesNotMatch(fanout, /--input-checkpoint="\$RUNNER_TEMP\/v12-finalize-work\/checkpoint\.json"/);
  assert.match(fanout, /path: \$\{\{ runner\.temp \}\}\/v12-finalize-work\/manifest\.json/);
  assert.match(fanout, /fromJSON\(needs\.plan\.outputs\.shard_matrix\)/);
  assert.match(fanout, /--compact-shard-threshold=3800/);
});

test("intermediate V12 fanout merges defer expensive reconciliation", () => {
  assert.match(finalizationAdvanceScript, /evaluationCache\.has\(key\)/);
  assert.match(finalizationAdvanceScript, /finalizationState\.phase = "complete"/);
  assert.match(fanout, /without rebuilding rankings/);
  assert.match(fanout, /skipping full shared-pool reconciliation for this intermediate wave/);
  assert.match(fanout, /Frozen counterfactual plan is fully cached; running the expensive reconcile\/adaptive pass once/);
  const mergeDeltas = fanout.indexOf("merge-metagame-v12-finalization-deltas.mjs");
  const advance = fanout.indexOf("advance-metagame-v12-finalization-cache.mjs");
  const fullReconcile = fanout.indexOf("rate-metagame-v12.mjs", advance);
  assert.ok(mergeDeltas >= 0 && advance > mergeDeltas && fullReconcile > advance);
});

test("V12 durable battle vectors use lossless compact storage with legacy hydration", () => {
  assert.match(sharedPoolScript, /scenarioValuesPackedV1/);
  assert.match(sharedPoolScript, /value === 0\.5/);
  assert.match(sharedPoolScript, /view\.setFloat64\(offset, value, true\)/);
  assert.match(sharedPoolScript, /decodeScenarioValuesF64/);
  assert.match(sharedPoolScript, /Array\.isArray\(storedResult\.scenarioValues\)/);
  assert.match(browserKnowledgePlanScript, /hydrateMetagameV12EvaluationCache/);
  assert.doesNotMatch(browserKnowledgePlanScript, /for \(const entry of checkpoint\.evaluatedDeckPool/);
});

test("V12 finalization recovery unions artifacts across interrupted runs", () => {
  assert.match(fanout, /recovery_run_ids:/);
  assert.match(fanout, /recovery_run_ids\+=\("\$candidate_run_id"\)/);
  assert.match(fanout, /gh run download "\$run_id"/);
  assert.match(fanout, /v12-finalize-recovery\/\$run_id/);
  assert.match(fanout, /find "\$RUNNER_TEMP\/v12-finalize-recovery" -type f/);
  assert.match(fanout, /Recovering \$\{#delta_files\[@\]\} cache delta file\(s\) across prior interrupted waves/);
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
