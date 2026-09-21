import test from "node:test";
import assert from "node:assert/strict";

import {
  findBestMetagameDeckIncrementalLive,
  metagameLiveCharacterFingerprint,
  metagameLiveQueryFingerprint,
} from "../src/core/metagame-live.js";

function character(id, position, cost = 4, pow = 40) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity: "R",
    cost,
    hp: 1000,
    pow,
    skillTurn: position - 1,
    maxUses: 0,
    allowedPositions: [position],
    preferredPositions: [position],
    skillName: "",
    roleTags: [],
    skill: {
      type: "none",
      multiplier: 1,
      hits: 1,
      amount: 0,
      target: "self",
      targetCount: 1,
      duration: 1,
      conditions: [],
      effects: [],
    },
  };
}

function fixture() {
  const baseDeck = [1, 2, 3, 4, 5].map((position) => character(`base-${position}`, position));
  const ids = baseDeck.map((entry) => entry.id);
  const rating = (entry) => ({
    id: entry.id,
    name: entry.name,
    attributes: entry.attributes,
    rarity: entry.rarity,
    cost: entry.cost,
    skillTurn: entry.skillTurn,
    skillType: "none",
    skillTarget: "self",
    role: "neutral",
    costAwareScore: 0.5,
    practicalValue: 0.5,
    individualScore: 0.5,
    expectedWinRate: 0.5,
    expectedWinLowerBound: 0.4,
  });
  const constraint = {
    id: "fire:100",
    attributeKey: "fire",
    label: "火・コスト100",
    modelVersion: "team-battle-v12.5-effective-damage-individual-rank",
    allowedAttributes: ["fire"],
    totalCost: 100,
    turns: 1,
    scenarioCount: 3,
    slots: baseDeck.map((entry, index) => ({
      position: index + 1,
      candidates: [rating(entry)],
      environment: [],
    })),
    precomputedDecks: [{
      i: ids,
      c: 20,
      p: 0.5,
      w: 0.5,
      l: 0.4,
      s: 3,
      r: baseDeck.map(() => ({ k: "neutral", i: 0.5, f: 0.5, b: {} })),
    }],
    teamScenarios: Array.from({ length: 3 }, () => ({
      a: Array.from({ length: 4 }, () => [...ids]),
      e: Array.from({ length: 5 }, () => [...ids]),
    })),
    environmentScenarios: [],
  };
  return {
    baseDeck,
    constraint,
    data: {
      generatedAt: "2026-09-21T00:00:00.000Z",
      constraints: [constraint],
    },
  };
}

test("live character fingerprints change when battle-relevant DB data changes", () => {
  const original = character("manual-new", 1, 20, 500);
  const edited = { ...original, pow: 501 };
  assert.notEqual(
    metagameLiveCharacterFingerprint(original),
    metagameLiveCharacterFingerprint(edited),
  );

  const fixtureData = fixture();
  const first = metagameLiveQueryFingerprint(
    fixtureData.constraint,
    [...fixtureData.baseDeck, original],
    new Set([original.id]),
    { totalCost: 100 },
  );
  const second = metagameLiveQueryFingerprint(
    fixtureData.constraint,
    [...fixtureData.baseDeck, edited],
    new Set([edited.id]),
    { totalCost: 100 },
  );
  assert.notEqual(first, second);
});

test("an expensive newly added character is incrementally admitted without a V12 full recompute", async () => {
  const source = fixture();
  const added = character("manual-expensive", 1, 84, 100_000);
  const progress = [];

  const result = await findBestMetagameDeckIncrementalLive(
    source.data,
    source.constraint.id,
    [...source.baseDeck, added],
    {
      automaticCharacterIds: [added.id],
      onProgress: (entry) => progress.push(entry),
    },
  );

  assert.equal(result.usedIncrementalLiveEvaluation, true);
  assert.ok(result.candidateDeckCount >= 2);
  assert.deepEqual(result.screenedScenarioCounts, [3, 3, 3]);
  assert.ok(result.results.some((entry) => entry.deck[0].id === added.id));
  assert.ok(result.liveCharacterIds.includes(added.id));
  assert.ok(progress.some((entry) => entry.phase === "simulation" && entry.liveStage === 1));
  assert.ok(progress.some((entry) => entry.phase === "simulation" && entry.liveStage === 3));
});

test("multiple newly added fixed characters survive incremental local search together", async () => {
  const source = fixture();
  const first = character("manual-fixed-1", 1, 20, 20_000);
  const second = character("manual-fixed-2", 2, 20, 20_000);

  const result = await findBestMetagameDeckIncrementalLive(
    source.data,
    source.constraint.id,
    [...source.baseDeck, first, second],
    {
      automaticCharacterIds: [first.id, second.id],
      fixedSlots: { 1: first.id, 2: second.id },
    },
  );

  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((entry) => (
    entry.deck[0].id === first.id && entry.deck[1].id === second.id
  )));
  assert.ok(result.liveCharacterIds.includes(first.id));
  assert.ok(result.liveCharacterIds.includes(second.id));
});
