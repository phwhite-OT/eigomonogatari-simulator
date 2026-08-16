import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/metagame-v7-cloud.yml", import.meta.url);

test("v8.5 queue restores reports without rebasing the result branch", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /Restore the v8\.5-role-balance report snapshot/);
  assert.match(workflow, /git checkout "\$results_ref" -- reports\/metagame-ratings-v8\.5-role-balance/);
  assert.doesNotMatch(workflow, /git rebase \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /git add src\/data\/metagame-simulator-data\.js/);
});

test("v8.5 queue schedules the next segment after recoverable failures", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /echo "should_continue=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /steps\.recovery\.outputs\.should_continue == 'true'/);
  assert.match(workflow, /needs_attention=\$needs_attention/);
  assert.doesNotMatch(workflow, /Mark unrecoverable evaluation failure/);
  assert.doesNotMatch(workflow, /retry_exhausted/);
});
