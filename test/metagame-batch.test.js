import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMetagameBatchTasks,
  DEFAULT_ATTRIBUTE_GROUPS,
  DEFAULT_REPRESENTATIVE_COSTS,
} from "../src/core/metagame-batch.js";

test("7 attribute groups and 4 representative costs create 28 constraints", () => {
  const tasks = buildMetagameBatchTasks();
  const constraints = new Set(tasks.map((task) => task.constraintId));

  assert.equal(DEFAULT_ATTRIBUTE_GROUPS.length, 7);
  assert.deepEqual(DEFAULT_REPRESENTATIVE_COSTS, [100, 200, 300, 500]);
  assert.equal(constraints.size, 28);
  assert.equal(tasks.length, 280);
});

test("each attribute and cost constraint completes all slots before the next", () => {
  const tasks = buildMetagameBatchTasks({
    attributeGroups: [["fire"], ["fire", "water"]],
    costs: [100],
    positions: [1, 2, 3],
    passes: 2,
  });

  assert.deepEqual(tasks.slice(0, 6).map((task) => task.id), [
    "1:fire:100:1",
    "1:fire:100:2",
    "1:fire:100:3",
    "2:fire:100:3",
    "2:fire:100:2",
    "2:fire:100:1",
  ]);
  assert.ok(tasks.slice(0, 6).every((task) => task.constraintId === "fire:100"));
  assert.ok(tasks.slice(6).every((task) => task.constraintId === "fire-water:100"));
});
