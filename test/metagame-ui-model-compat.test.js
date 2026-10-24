import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/ui/metagame-simulator.js", "utf8");

test("deck generation accepts current V12 models with skill-execution evidence", () => {
  assert.match(source, /METAGAME_MIN_SKILL_EVIDENCE_MAJOR_VERSION\s*=\s*11/);
  assert.match(source, /version\.match\(\/\^team-battle-v\(\\d\+\)/);
  assert.match(source, />= METAGAME_MIN_SKILL_EVIDENCE_MAJOR_VERSION/);
  assert.doesNotMatch(source, /===\s*["']team-battle-v11-skill-execution["']/);
});
