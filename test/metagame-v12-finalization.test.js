import test from "node:test";
import assert from "node:assert/strict";

import {
  createMetagameV12FinalizationState,
  isMetagameV12FinalizationStateCompatible,
  metagameV12FinalizationCursorSignature,
} from "../src/core/metagame-v12-finalization.js";

function deck(ids, score) {
  return { ids, expectedWinLowerBound: score, expectedWinRate: score };
}

function rating(id, bestDeckIds) {
  return { id, bestDeck: { ids: bestDeckIds } };
}

test("V12 finalization freezes a bounded anchor plan instead of expanding with later audit decks", () => {
  const results = [
    new Map([["target", rating("target", ["target", "a", "b", "c", "d"])]]),
    new Map(), new Map(), new Map(), new Map(),
  ];
  const initialPool = [
    deck(["target", "a", "b", "c", "d"], 0.9),
    deck(["target", "e", "f", "c", "d"], 0.8),
    deck(["target", "g", "h", "i", "d"], 0.7),
    deck(["target", "j", "k", "l", "m"], 0.6),
  ];
  const options = {
    counterfactualAnchorLimit: 3,
    replacementDeckLimit: 24,
    replacementBeamWidth: 4000,
  };
  const state = createMetagameV12FinalizationState(results, initialPool, options);

  assert.equal(state.plan.length, 3);
  assert.deepEqual(state.plan.map((entry) => entry.anchorIds), initialPool.slice(0, 3).map((entry) => entry.ids));
  assert.equal(isMetagameV12FinalizationStateCompatible(state, options), true);

  initialPool.unshift(deck(["target", "new", "strong", "audit", "deck"], 1));
  assert.equal(state.plan.length, 3);
  assert.equal(state.plan.some((entry) => entry.anchorIds.includes("new")), false);
});

test("V12 finalization state rejects tuning changes and exposes a resumable cursor", () => {
  const results = [
    new Map([["target", rating("target", ["target", "a", "b", "c", "d"])]]),
    new Map(), new Map(), new Map(), new Map(),
  ];
  const options = {
    counterfactualAnchorLimit: 1,
    replacementDeckLimit: 12,
    replacementBeamWidth: 1000,
  };
  const state = createMetagameV12FinalizationState(results, [], options);
  assert.equal(state.plan.length, 1);
  assert.equal(metagameV12FinalizationCursorSignature(state), "0:0");

  state.cursor = { planIndex: 1, replacementIndex: 7 };
  assert.equal(metagameV12FinalizationCursorSignature(state), "1:7");
  assert.equal(isMetagameV12FinalizationStateCompatible(state, options), true);
  assert.equal(isMetagameV12FinalizationStateCompatible(state, { ...options, replacementDeckLimit: 13 }), false);
});
