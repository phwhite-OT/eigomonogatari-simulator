import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMetagameV7CandidatePools,
  buildMetagameV7DeckCandidates,
  createMetagameV7EnvironmentDecks,
  createMetagameV8TeamScenarios,
  evaluateMetagameV7Deck,
  rateMetagameV7Character,
  resolveMetagameV7Input,
  resolveMetagameV7Name,
} from "../src/core/metagame-v7.js";
import { findBestMetagameDeck } from "../src/core/metagame-deck.js";
import { METAGAME_V7_INPUTS } from "../src/data/metagame-v7-inputs.js";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { buildMetagameV8Constraint } from "../scripts/build-metagame-simulator-data.mjs";

function v7TestCharacter(id, name, position, options = {}) {
  return {
    id,
    name,
    attributes: options.attributes ?? ["fire"],
    rarity: options.rarity ?? "R",
    cost: options.cost ?? 20,
    hp: options.hp ?? 1_000,
    pow: options.pow ?? 1_000,
    skillTurn: options.skillTurn ?? position - 1,
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
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], CHARACTER_CATALOG);
  const decks = createMetagameV7EnvironmentDecks(resolved, { count: 72, seed: 7107 });

  assert.ok(decks.length >= resolved.environmentPools.flat().length);
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

test("v7 completes each environment pivot with strong feasible partners instead of cheap fillers", () => {
  const characters = [1, 2, 3, 4, 5].flatMap((position) => [
    v7TestCharacter(`low-${position}`, `low-${position}`, position, { cost: 10, hp: 100, pow: 100 }),
    v7TestCharacter(`high-${position}`, `high-${position}`, position, { cost: 20, hp: 2_000, pow: 2_000 }),
  ]);
  const input = {
    id: "fire:100-strong-environment-test",
    label: "strong environment test",
    allowedAttributes: ["fire"],
    totalCost: 100,
    environmentNamesByPosition: [1, 2, 3, 4, 5].map((position) => [
      `low-${position}`,
      `high-${position}`,
    ]),
    exampleDeckNames: [],
  };
  const resolved = resolveMetagameV7Input(input, characters);
  const decks = createMetagameV7EnvironmentDecks(resolved, { count: 5 });

  for (const deck of decks) {
    const weakPivot = deck.findIndex((character) => character.id.startsWith("low-"));
    if (weakPivot < 0) continue;
    assert.ok(deck.every((character, index) => index === weakPivot || character.id.startsWith("high-")));
  }
});

test("v8 evaluates a candidate deck within a 5v5 team scenario", () => {
  const teams = [0, 1, 2, 3, 4].map((team) => [1, 2, 3, 4, 5].map((position) => (
    v7TestCharacter(`team-${team}-slot-${position}`, `team-${team}-slot-${position}`, position, {
      cost: 20,
      hp: 1_000,
      pow: 1_000,
    })
  )));
  const scenarios = createMetagameV8TeamScenarios({
    environmentPools: teams[0].map((character) => [character]),
    examplePatterns: [],
  }, { environmentDecks: teams.concat(teams), count: 2 });
  const result = evaluateMetagameV7Deck(teams[0], scenarios, { turns: 1 });

  assert.equal(scenarios.length, 2);
  assert.ok(scenarios.every((scenario) => scenario.allyDecks.length === 4));
  assert.ok(scenarios.every((scenario) => scenario.enemyDecks.length === 5));
  assert.equal(result.scenarioCount, 2);
  assert.ok(Number.isFinite(result.expectedWinRate));
});

test("v8 team scenarios cover every supplied environment deck", () => {
  const decks = Array.from({ length: 23 }, (_, team) => [1, 2, 3, 4, 5].map((position) => (
    v7TestCharacter(`coverage-${team}-${position}`, `coverage-${team}-${position}`, position)
  )));
  const scenarios = createMetagameV8TeamScenarios({ environmentPools: [], examplePatterns: [] }, {
    environmentDecks: decks,
    count: 3,
  });
  const included = new Set(scenarios.flatMap((scenario) => [
    ...scenario.allyDecks,
    ...scenario.enemyDecks,
  ]).map((deck) => deck[0].id));

  assert.equal(scenarios.length, 3);
  assert.deepEqual(included, new Set(decks.map((deck) => deck[0].id)));
});

test("v8 removes environment candidates that violate their supplied deck position", () => {
  const legal = [1, 2, 3, 4, 5].map((position) => (
    v7TestCharacter(`legal-${position}`, `legal-${position}`, position)
  ));
  const illegal = v7TestCharacter("illegal", "illegal", 2, { skillTurn: 0 });
  const input = {
    id: "fire:100-position-audit-test",
    label: "position audit",
    allowedAttributes: ["fire"],
    totalCost: 100,
    environmentNamesByPosition: [["legal-1"], ["legal-2", "illegal"], ["legal-3"], ["legal-4"], ["legal-5"]],
    exampleDeckNames: [],
  };
  const resolved = resolveMetagameV7Input(input, [...legal, illegal]);

  assert.deepEqual(resolved.environmentPools[1].map((character) => character.id), ["legal-2"]);
  assert.equal(resolved.invalidEnvironmentCandidates.length, 1);
  assert.equal(resolved.invalidEnvironmentCandidates[0].id, "illegal");
});

test("v7 includes affordable partners so high-cost targets cannot stop the batch", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], CHARACTER_CATALOG);
  const pools = buildMetagameV7CandidatePools(resolved, CHARACTER_CATALOG, { partnerLimit: 24 });
  const target = pools.allByPosition[0].find((character) => character.name === "なっとくん様");
  const decks = buildMetagameV7DeckCandidates(target, 1, resolved, pools, {
    beamWidth: 500,
    autoDeckLimit: 8,
  });

  assert.ok(decks.length > 0);
  assert.ok(decks.every((entry) => entry.deck.reduce((sum, character) => sum + character.cost, 0) <= 100));
});

test("v7 keeps high-efficiency affordable partners out of the early proxy cut", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], CHARACTER_CATALOG);
  const pools = buildMetagameV7CandidatePools(resolved, CHARACTER_CATALOG, { partnerLimit: 32 });
  const nanako = pools.partnerRatingsByPosition[0]
    .find((rating) => rating.name === "ハリウッドナナコ師匠");

  assert.ok(nanako);
});

test("v7 completes partial deck examples before evaluating their specified character", () => {
  const characters = [1, 2, 3, 4, 5].map((position) => (
    v7TestCharacter(`pattern-${position}`, `pattern-${position}`, position)
  ));
  const input = {
    id: "fire:100-pattern-test",
    label: "pattern test",
    allowedAttributes: ["fire"],
    totalCost: 100,
    environmentNamesByPosition: characters.map((character) => [character.name]),
    exampleDeckNames: [],
    exampleDeckPatterns: [["pattern-1", null, null, "pattern-4", null]],
  };
  const resolved = resolveMetagameV7Input(input, characters);
  const pools = buildMetagameV7CandidatePools(resolved, characters, { partnerLimit: 8 });
  const decks = buildMetagameV7DeckCandidates(characters[0], 1, resolved, pools, {
    beamWidth: 500,
    autoDeckLimit: 1,
    exampleDeckLimit: 1,
  });
  const example = decks.find((entry) => entry.origin === "example");

  assert.equal(resolved.examplePatterns.length, 1);
  assert.equal(resolved.invalidExamples.length, 0);
  assert.ok(example);
  assert.equal(example.deck[0].id, "pattern-1");
  assert.equal(example.deck[3].id, "pattern-4");
});

test("v7 registers every supplied fixed environment", () => {
  for (const input of METAGAME_V7_INPUTS) {
    const resolved = resolveMetagameV7Input(input, CHARACTER_CATALOG);
    const decks = createMetagameV7EnvironmentDecks(resolved, { count: 5 });
    assert.ok(resolved.environmentPools.every((pool) => pool.length > 0));
    assert.equal(
      resolved.environmentPools.flat().length + resolved.invalidEnvironmentCandidates.length,
      input.environmentNamesByPosition.flat().length,
    );
    assert.ok(resolved.examplePatterns.length > 0);
    assert.equal(resolved.audit.filter((entry) => !entry.name).length, 0);
    assert.ok(decks.every((deck) => deck.reduce((sum, character) => sum + character.cost, 0) <= 100));
    for (let position = 0; position < 5; position += 1) {
      for (const character of resolved.environmentPools[position]) {
        assert.ok(decks.some((deck) => String(deck[position].id) === String(character.id)));
      }
    }
  }
});

test("v7 resolves 二条嬢浴衣モード as its own fire-water character", () => {
  const input = METAGAME_V7_INPUTS.find((entry) => entry.id === "water-wind:100");
  const resolved = resolveMetagameV7Input(input, CHARACTER_CATALOG);
  const character = resolved.environmentMatches[1]
    .find((entry) => entry.inputName === "二条嬢浴衣モードニジョウジョウユカタ")
    ?.character;

  assert.equal(character?.id, "manual-nijo-yukata-mode");
  assert.deepEqual(character?.attributes, ["fire", "water"]);
  assert.equal(character?.cost, 19);
  assert.equal(character?.skillTurn, 1);
  assert.equal(character?.skill?.type, "attribute_guard");
  assert.equal(character?.skill?.multiplier, 0.2);
});

test("character catalog corrects ラパヌイ先生 to water-wind", () => {
  const character = CHARACTER_CATALOG.find((entry) => entry.id === "em-c87499b64151");

  assert.equal(character?.name, "ラパヌイ先生");
  assert.deepEqual(character?.attributes, ["water", "wind"]);
});

test("v7 records genuinely infeasible cost-100 targets without stopping the batch", () => {
  const resolved = resolveMetagameV7Input(METAGAME_V7_INPUTS[0], CHARACTER_CATALOG);
  const pools = buildMetagameV7CandidatePools(resolved, CHARACTER_CATALOG, { partnerLimit: 24 });
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
  const characters = CHARACTER_CATALOG.slice(0, 5);
  const report = {
    generatedAt: "2026-08-09T00:00:00.000Z",
    model: { version: "team-battle-v8.0" },
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

  const constraint = buildMetagameV8Constraint(
    report,
    new Map(characters.map((character) => [String(character.id), character])),
  );

  assert.equal(constraint.id, "fire:100");
  assert.equal(constraint.slots.length, 5);
  assert.equal(constraint.slots[0].candidates, undefined);
  assert.equal(constraint.precomputedDecks[0].l, 0.5);
  assert.equal(constraint.environmentScenarios.length, 1);

  const result = await findBestMetagameDeck(
    { generatedAt: report.generatedAt, constraints: [constraint] },
    constraint.id,
    characters,
  );
  assert.equal(result.simulatedDeckCount, 0);
  assert.equal(result.results[0].expectedWinRate, 0.6);
});
