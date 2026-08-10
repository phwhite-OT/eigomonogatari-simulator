import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMetagameV7CandidatePools,
  buildMetagameV7DeckCandidates,
  createMetagameV7EnvironmentDecks,
  rateMetagameV7Character,
  resolveMetagameV7Input,
  resolveMetagameV7Name,
} from "../src/core/metagame-v7.js";
import { findBestMetagameDeck } from "../src/core/metagame-deck.js";
import { METAGAME_V7_INPUTS } from "../src/data/metagame-v7-inputs.js";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import { buildMetagameV7Constraint } from "../scripts/build-metagame-simulator-data.mjs";

function v7TestCharacter(id, name, position, options = {}) {
  return {
    id,
    name,
    attributes: options.attributes ?? ["fire"],
    rarity: options.rarity ?? "R",
    cost: options.cost ?? 20,
    hp: 1_000,
    pow: 1_000,
    skillTurn: position - 1,
    maxUses: 0,
    allowedPositions: [1, 2, 3, 4, 5],
    skill: { type: "none", multiplier: 1, duration: 1, target: "self", conditions: [] },
  };
}

test("v7の略称照合は属性とレアリティを使って表記ゆれを解消する", () => {
  const fire = v7TestCharacter("fire", "電ドロ白鷺嬢", 1, { rarity: "MZR" });
  const water = v7TestCharacter("water", "電ドロ白鷺嬢", 1, { attributes: ["water"], rarity: "MZR" });
  const result = resolveMetagameV7Name("電ドロ白鷲嬢（MZR）デンシラワシジョウ", [water, fire], {
    allowedAttributes: ["fire"],
  });

  assert.equal(result.character?.id, "fire");
  assert.notEqual(result.confidence, "unresolved");
});

test("v7の固定環境は提示された枠候補だけでコスト内デッキを構成する", () => {
  const characters = [1, 2, 3, 4, 5].map((position) => (
    v7TestCharacter(`slot-${position}`, `slot-${position}`, position)
  ));
  const input = {
    id: "fire:100-test",
    label: "test",
    allowedAttributes: ["fire"],
    totalCost: 100,
    environmentNamesByPosition: characters.map((character) => [character.name]),
    exampleDeckNames: [],
  };
  const resolved = resolveMetagameV7Input(input, characters);
  const decks = createMetagameV7EnvironmentDecks(resolved, { count: 5, seed: 9 });

  assert.equal(decks.length, 5);
  for (const deck of decks) {
    assert.deepEqual(deck.map((character) => character.id), characters.map((character) => character.id));
    assert.equal(deck.reduce((sum, character) => sum + character.cost, 0), 100);
  }
});

test("v7 real environment includes every supplied candidate within the cost cap", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], WORKBOOK_CHARACTERS);
  const decks = createMetagameV7EnvironmentDecks(resolved, { count: 72, seed: 7107 });

  assert.equal(decks.length, 77);
  for (const deck of decks) {
    assert.equal(deck.length, 5);
    assert.ok(deck.reduce((sum, character) => sum + character.cost, 0) <= 100);
  }
  for (let index = 0; index < 5; index += 1) {
    const included = new Set(decks.map((deck) => String(deck[index].id)));
    for (const character of resolved.environmentPools[index]) {
      assert.ok(included.has(String(character.id)), `${index + 1}: ${character.name}`);
    }
  }
});

test("v7 includes affordable partners so high-cost targets cannot stop the batch", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], WORKBOOK_CHARACTERS);
  const pools = buildMetagameV7CandidatePools(resolved, WORKBOOK_CHARACTERS, { partnerLimit: 24 });
  const target = pools.allByPosition[0].find((character) => character.name === "なっとくん様");
  const decks = buildMetagameV7DeckCandidates(target, 1, resolved, pools, {
    beamWidth: 500,
    autoDeckLimit: 8,
  });

  assert.ok(decks.length > 0);
  assert.ok(decks.every((entry) => entry.deck.reduce((sum, character) => sum + character.cost, 0) <= 100));
});

test("v7 records genuinely infeasible cost-100 targets without stopping the batch", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], WORKBOOK_CHARACTERS);
  const pools = buildMetagameV7CandidatePools(resolved, WORKBOOK_CHARACTERS, { partnerLimit: 24 });
  const target = pools.allByPosition[0].find((character) => character.name === "ピンギヌスのたまご");
  const rating = rateMetagameV7Character(target, 1, resolved, pools, [], {
    beamWidth: 500,
    autoDeckLimit: 8,
  });

  assert.equal(rating.infeasible, true);
  assert.equal(rating.evaluatedDeckCount, 0);
  assert.equal(rating.v7Score, 0);
});

test("completed v7 report is converted into a precomputed deck-generator constraint", async () => {
  const characters = WORKBOOK_CHARACTERS.slice(0, 5);
  const report = {
    generatedAt: "2026-08-09T00:00:00.000Z",
    model: { version: "fixed-environment-v7" },
    context: {
      inputId: "fire:100",
      label: "火・コスト100",
      allowedAttributes: ["fire"],
      totalCost: 100,
      turns: 12,
      environmentCount: 1,
    },
    environmentPools: characters.map((character) => [{
      id: String(character.id), name: character.name, cost: character.cost,
    }]),
    environmentDecks: [characters.map((character) => ({
      id: String(character.id), name: character.name, cost: character.cost,
    }))],
    rankingsByPosition: characters.map((character, index) => ({
      position: index + 1,
      characters: [{
        id: String(character.id), name: character.name, attributes: character.attributes,
        rarity: character.rarity, cost: character.cost, skillTurn: character.skillTurn,
        skillType: character.skill?.type ?? "none", skillName: character.skillName,
        rank: 1,
        bestDeck: {
          ids: characters.map((entry) => String(entry.id)),
          names: characters.map((entry) => entry.name),
          totalCost: characters.reduce((sum, entry) => sum + entry.cost, 0),
          expectedWinRate: 0.6,
          expectedWinLowerBound: 0.5,
          scenarioCount: 1,
          decisiveWinRate: 0.2,
          decisiveDrawRate: 0.1,
          decisiveLossRate: 0.3,
          ongoingRate: 0.4,
        },
      }],
    })),
  };

  const constraint = buildMetagameV7Constraint(
    report,
    new Map(characters.map((character) => [String(character.id), character])),
  );

  assert.equal(constraint.id, "fire:100");
  assert.equal(constraint.slots.length, 5);
  assert.equal(constraint.slots[0].candidates[0].expectedWinLowerBound, 0.5);
  assert.equal(constraint.environmentScenarios.length, 1);

  const result = await findBestMetagameDeck(
    { generatedAt: report.generatedAt, constraints: [constraint] },
    constraint.id,
    characters,
  );
  assert.equal(result.simulatedDeckCount, 0);
  assert.equal(result.results[0].expectedWinRate, 0.6);
});
