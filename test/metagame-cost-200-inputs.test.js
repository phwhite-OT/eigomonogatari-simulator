import test from "node:test";
import assert from "node:assert/strict";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { resolveMetagameV7Input } from "../src/core/metagame-v7.js";
import { METAGAME_V8_COST_200_INPUTS } from "../src/data/metagame-v8-cost-200-inputs.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";

test("cost-200 environment workbook supplies seven resolvable constraints", () => {
  assert.equal(METAGAME_V8_COST_200_INPUTS.length, 7);
  assert.equal(new Set(METAGAME_V8_INPUTS.map((input) => input.id)).size, METAGAME_V8_INPUTS.length);

  for (const input of METAGAME_V8_COST_200_INPUTS) {
    const resolved = resolveMetagameV7Input(input, CHARACTER_CATALOG);
    assert.equal(input.totalCost, 200);
    assert.equal(input.environmentNamesByPosition.length, 5);
    assert.ok(input.environmentNamesByPosition.every((pool) => pool.length > 0));
    assert.equal(resolved.audit.filter((entry) => !entry.name).length, 0);
    assert.ok(resolved.environmentPools.every((pool) => pool.length > 0));
  }
});
