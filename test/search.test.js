import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_CHARACTERS } from "../src/data/characters.js";
import { DEFAULT_RULES } from "../src/data/rules.js";
import { validateDeck } from "../src/core/filter.js";
import { searchDecks } from "../src/core/search-fast.js";

test("順番付きデッキを生成し全候補が条件を満たす", async () => {
  const required = DEMO_CHARACTERS.find(
    (character) => character.pvpTier === "normal" && character.cost <= 25,
  );
  const constraints = {
    totalCost: 150,
    deckSize: 5,
    allowedAttributes: ["fire", "water", "wind"],
    requiredIds: [required.id],
    allowDuplicates: false,
    includeLow: false,
    mode: "fast",
  };
  const result = await searchDecks(DEMO_CHARACTERS, constraints, DEFAULT_RULES, {
    iterations: 400,
    chunkSize: 100,
    topLimit: 30,
    detailedLimit: 12,
    seed: 42,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.results.length > 0);
  for (const recommendation of result.results) {
    const validation = validateDeck(recommendation.deck, constraints);
    assert.equal(validation.valid, true, validation.errors.join("\n"));
    assert.ok(recommendation.slots.every((slot) => slot.reasons.length > 0));
    recommendation.deck.slice(1).forEach((character, index) => {
      const expectedTurn = index + 1;
      assert.ok(index === 3
        ? character.skillTurn >= expectedTurn
        : [expectedTurn, expectedTurn + 1].includes(character.skillTurn));
    });
  }
});

test("使用できない必須キャラは事前エラーにする", async () => {
  const result = await searchDecks(
    DEMO_CHARACTERS,
    { totalCost: 150, deckSize: 5, requiredIds: ["missing-id"], mode: "fast" },
    DEFAULT_RULES,
    { iterations: 10 },
  );
  assert.equal(result.results.length, 0);
  assert.ok(result.errors.some((error) => error.includes("missing-id")));
});
