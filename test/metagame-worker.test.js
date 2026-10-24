import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const workerPath = path.join(root, "src/core/metagame-worker.js");
const workerSource = fs.readFileSync(workerPath, "utf8");
const clientSource = fs.readFileSync(
  path.join(root, "src/ui/metagame-v12-precomputed-first.js"),
  "utf8",
);
const deploySource = fs.readFileSync(
  path.join(root, ".github/workflows/deploy-pages.yml"),
  "utf8",
);

test("metagame worker runs the same core deck search implementation", () => {
  assert.match(
    workerSource,
    /import\s*\{\s*findBestMetagameDeck\s*\}\s*from\s*"\.\/metagame-deck\.js"/,
  );
  assert.match(
    workerSource,
    /await\s+findBestMetagameDeck\(/,
  );
  assert.doesNotMatch(workerSource, /beamWidth\s*[:=]/);
  assert.doesNotMatch(workerSource, /finalistCount\s*[:=]/);
});

test("worker client forwards resolved options and preserves exact fallback", () => {
  assert.match(clientSource, /new Worker\("\.\/src\/core\/metagame-worker\.js", \{ type: "module" \}\)/);
  assert.match(clientSource, /options:\s*workerOptions/);
  assert.match(clientSource, /browserKnowledge:\s*knowledge/);
  assert.match(
    clientSource,
    /workerResult\s*\?\?\s*await\s+findBestMetagameDeckBeforeV12PrecomputedFirst\(/,
  );
});

test("Pages deployment ships every module in the worker dependency closure", () => {
  const expectedFiles = [
    "src/core/metagame-worker.js",
    "src/core/metagame-deck.js",
    "src/core/battleState.js",
    "src/core/simulate.js",
    "src/core/environment-rating.js",
    "src/core/filter.js",
    "src/core/skills.js",
    "src/core/damage.js",
    "src/data/rules.js",
  ];
  for (const file of expectedFiles) assert.match(deploySource, new RegExp(file.replaceAll("/", "\\/")));
});

test("metagame worker module is syntactically valid JavaScript", () => {
  const result = spawnSync(process.execPath, ["--check", workerPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
