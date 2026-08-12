import test from "node:test";
import assert from "node:assert/strict";

import { buildMetagameCandidateShardPlan } from "../src/core/metagame-work-shards.js";

test("candidate shards cover each missing rating exactly once", () => {
  const plan = buildMetagameCandidateShardPlan(
    [["a", "b", "c", "d", "e"], ["f", "g", "h"], ["i"]],
    [[{ id: "a" }, { id: "d" }], [{ id: "g" }], []],
    { maxWorkers: 5 },
  );

  assert.equal(plan.length, 5);
  const assigned = new Map();
  for (const shard of plan) {
    for (const index of shard.candidateIndices) {
      const key = `${shard.position}:${index}`;
      assert.equal(assigned.has(key), false);
      assigned.set(key, true);
    }
  }
  assert.deepEqual([...assigned.keys()].sort(), ["1:1", "1:2", "1:4", "2:0", "2:2", "3:0"]);
});

test("one large unfinished position receives all available workers", () => {
  const candidateIds = Array.from({ length: 37 }, (_, index) => `c${index}`);
  const plan = buildMetagameCandidateShardPlan([candidateIds], [[]], { maxWorkers: 20 });

  assert.equal(plan.length, 20);
  assert.equal(new Set(plan.map(({ position }) => position)).size, 1);
  assert.deepEqual(
    plan.flatMap(({ candidateIndices }) => candidateIndices).sort((left, right) => left - right),
    Array.from({ length: 37 }, (_, index) => index),
  );
});
