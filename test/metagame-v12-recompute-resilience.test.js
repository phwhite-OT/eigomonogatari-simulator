import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/metagame-v12-shared-pool-recompute.yml", "utf8");
const finalizationWorkflow = fs.readFileSync(".github/workflows/metagame-v12-finalization-fanout.yml", "utf8");
const watchdog = fs.readFileSync(".github/workflows/metagame-v12-watchdog.yml", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy-pages.yml", "utf8");
const rateScript = fs.readFileSync("scripts/rate-metagame-v12.mjs", "utf8");
const reopenScript = fs.readFileSync("scripts/reopen-metagame-v12-deep-search.mjs", "utf8");
const metagameV12 = fs.readFileSync("src/core/metagame-v12.js", "utf8");
const equilibrium = fs.readFileSync("src/core/metagame-v12-equilibrium.js", "utf8");

test("V12 finalization is resumable across counterfactual, deep-search and equilibrium phases", () => {
  assert.match(workflow, /max-parallel:\s*19/);
  assert.match(workflow, /metagame-v12-finalization-fanout\.yml/);
  assert.match(workflow, /finalizationState\.phase == "counterfactual"/);
  assert.match(workflow, /finalizationState\.phase == "equilibrium"/);

  assert.match(finalizationWorkflow, /max-parallel:\s*19/);
  assert.match(finalizationWorkflow, /Evaluate assigned unique counterfactual battles/);
  assert.match(finalizationWorkflow, /reopen-metagame-v12-deep-search\.mjs/);
  assert.match(finalizationWorkflow, /Elite neighbourhood converged; handing the resumable equilibrium matrix to the normal runner/);

  assert.match(rateScript, /equilibriumMatchups/);
  assert.match(rateScript, /saveProgress\("finalizing"\)/);
  assert.match(rateScript, /waiting for the distributed elite-neighbourhood convergence check before equilibrium/);
  assert.match(rateScript, /buildMetagameV12EquilibriumMatrix/);
  assert.match(rateScript, /solveMetagameV12Equilibrium/);
  assert.match(rateScript, /finalizationState\.phase = "complete"/);

  assert.match(reopenScript, /finalizationState\.phase = "equilibrium"/);
  assert.match(reopenScript, /deepSearchConverged/);

  const reportWrite = rateScript.indexOf('path.join(outputDirectory, "report.json")');
  const completeSave = rateScript.lastIndexOf('saveProgress("complete")');
  assert.ok(reportWrite >= 0 && completeSave > reportWrite, "progress.json may become complete only after report output exists");
});

test("V12 watchdog routes abandoned work from durable phase state", () => {
  assert.match(watchdog, /schedule:/);
  assert.match(watchdog, /\*\/10 \* \* \* \*/);
  assert.match(watchdog, /actions:\s*write/);
  assert.match(watchdog, /metagame-v12-shared-pool-recompute\.yml/);
  assert.match(watchdog, /metagame-v12-finalization-fanout\.yml/);
  assert.match(watchdog, /finalizationState\.phase == "counterfactual"/);
  assert.match(watchdog, /finalizationState\.version == 3/);
  assert.match(watchdog, /finalizationState\.equilibriumVersion == 1/);
});

test("matched-slot and deep-neighbourhood exploration retain broad role recall", () => {
  assert.match(rateScript, /counterfactual-anchor-limit", "3"/);
  assert.match(rateScript, /replacement-deck-limit", "24"/);
  assert.match(metagameV12, /strongest proxy half/);
  assert.match(metagameV12, /const roles = \["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"\]/);
  assert.match(metagameV12, /const byCost = \[\.\.\.legal\]\.sort/);
});

test("equilibrium model keeps specialist counters and uses no-regret time averaging", () => {
  assert.match(equilibrium, /scenario specialists are explicitly retained/);
  assert.match(equilibrium, /Multiplicative-weights \/ no-regret equilibrium/);
  assert.match(equilibrium, /averageStrategy/);
  assert.match(equilibrium, /metaDependency/);
});

test("Pages promotes only current v8 ranking plus completed equilibrium outputs", () => {
  assert.match(deployWorkflow, /ranking_policy="full-budget-opportunity-v8-mean-primary-slot"/);
  assert.match(deployWorkflow, /finalizationState\.version == 3/);
  assert.match(deployWorkflow, /finalizationState\.equilibriumVersion == 1/);
});
