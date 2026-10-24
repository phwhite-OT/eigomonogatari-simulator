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


test("browser metagame search preserves full candidate breadth", () => {
  const core = fs.readFileSync("src/core/metagame-deck.js", "utf8");
  assert.match(core, /options\.browserKnowledge\s*\?\s*20_000\s*:\s*10_000/);
  assert.match(core, /options\.browserKnowledge\s*\?\s*56\s*:\s*40/);
  assert.match(core, /metagameCreatePairEvaluationCache/);
});
