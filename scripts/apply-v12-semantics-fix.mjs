import fs from "node:fs";

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, "utf8");
  if (!source.includes(before)) throw new Error(`Expected snippet not found in ${path}`);
  fs.writeFileSync(path, source.replace(before, after));
}

replaceOnce(
  "scripts/rate-metagame-v12.mjs",
`const checkpointContext = {
  version: METAGAME_V12_MODEL_VERSION,
  inputId,`,
`const METAGAME_V12_BATTLE_SEMANTICS_VERSION = "skill-target-revive-v2";

const checkpointContext = {
  version: METAGAME_V12_MODEL_VERSION,
  battleSemantics: METAGAME_V12_BATTLE_SEMANTICS_VERSION,
  inputId,`,
);

const workflowPath = ".github/workflows/metagame-v12-shared-pool-recompute.yml";
let workflow = fs.readFileSync(workflowPath, "utf8");
const oldCheck = '.status == "complete" and .context.version == "team-battle-v12.2-threshold-proxy"';
const newCheck = '.status == "complete" and .context.version == "team-battle-v12.2-threshold-proxy" and .context.battleSemantics == "skill-target-revive-v2"';
const occurrences = workflow.split(oldCheck).length - 1;
if (occurrences !== 2) throw new Error(`Expected exactly 2 completion checks, found ${occurrences}`);
workflow = workflow.replaceAll(oldCheck, newCheck);
fs.writeFileSync(workflowPath, workflow);

fs.rmSync("scripts/apply-v12-semantics-fix.mjs", { force: true });
fs.rmSync(".github/workflows/apply-v12-semantics-fix.yml", { force: true });
