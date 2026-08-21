import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMetagameStatBoost,
  buildMetagameDeckCandidates,
  calculateMetagameDeckSynergy,
  findBestMetagameDeck,
  inspectMetagameDeckEvidence,
  matchesMetagameFixedConstraint,
  resolveMetagameConstraint,
} from "../src/core/metagame-deck.js";

function metagameTestCharacter(id, cost, rarity = "R", power = 100) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity,
    cost,
    hp: 1000,
    pow: power,
    skillTurn: 99,
    maxUses: 0,
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

function metagameTestRating(character, overallRank) {
  return {
    id: character.id,
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    skillTurn: character.skillTurn,
    skillType: character.skill.type,
    skillName: character.skillName,
    overallRank,
    expectedWinRate: 0.6,
    expectedWinLowerBound: 0.45,
    balancedContribution: 0.5,
    advantageCreation: overallRank % 2,
    counteraction: (overallRank + 1) % 2,
    skillActivationRate: 0,
  };
}

function metagameTestFixture() {
  const candidateCharacters = [];
  const slots = [];
  for (let position = 1; position <= 5; position += 1) {
    const first = metagameTestCharacter(
      `candidate-${position}-a`,
      12,
      position <= 2 ? "伝" : "R",
      300,
    );
    const second = metagameTestCharacter(`candidate-${position}-b`, 8, "R", 240);
    candidateCharacters.push(first, second);
    slots.push({
      position,
      candidates: [metagameTestRating(first, 1), metagameTestRating(second, 2)],
    });
  }
  const environmentCharacters = [1, 2, 3, 4, 5].map((position) => (
    metagameTestCharacter(`environment-${position}`, 5, "N", 100)
  ));
  const environmentDeck = environmentCharacters.map((character) => character.id);
  const constraint = {
    id: "fire:60",
    label: "火・コスト60",
    allowedAttributes: ["fire"],
    totalCost: 60,
    turns: 1,
    scenarioCount: 1,
    slots,
    environmentScenarios: [Array.from({ length: 9 }, () => [...environmentDeck])],
  };
  return {
    characters: [...candidateCharacters, ...environmentCharacters],
    constraint,
    data: { generatedAt: "2026-01-01T00:00:00.000Z", constraints: [constraint] },
  };
}

test("metagame deck candidates obey cost, duplicate, and legend limits", () => {
  const fixture = metagameTestFixture();
  const candidates = buildMetagameDeckCandidates(fixture.constraint, fixture.characters, { beamWidth: 100 });
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(candidate.deck.length, 5);
    assert.ok(candidate.totalCost <= fixture.constraint.totalCost);
    assert.equal(new Set(candidate.deck.map((character) => character.id)).size, 5);
    assert.ok(candidate.deck.filter((character) => character.rarity === "伝").length <= 1);
  }
});

test("fixed slots remain in generated metagame decks", async () => {
  const fixture = metagameTestFixture();
  const fixedSlots = {
    1: "candidate-1-b",
    4: "candidate-4-a",
  };
  const candidates = buildMetagameDeckCandidates(
    fixture.constraint,
    fixture.characters,
    { beamWidth: 100, fixedSlots },
  );
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => (
    candidate.deck[0].id === fixedSlots[1] && candidate.deck[3].id === fixedSlots[4]
  )));

  const result = await findBestMetagameDeck(
    fixture.data,
    fixture.constraint.id,
    fixture.characters,
    { beamWidth: 100, finalistCount: 10, fixedSlots },
  );
  assert.ok(result.results.every((candidate) => (
    candidate.deck[0].id === fixedSlots[1] && candidate.deck[3].id === fixedSlots[4]
  )));
});

test("fixed slots accept every character matching the metagame attribute and cost constraint", () => {
  const fixture = metagameTestFixture();
  const fixedCharacter = fixture.characters.find((character) => character.id === "environment-1");
  assert.ok(matchesMetagameFixedConstraint(fixedCharacter, fixture.constraint));

  const candidates = buildMetagameDeckCandidates(
    fixture.constraint,
    fixture.characters,
    { beamWidth: 100, fixedSlots: { 3: fixedCharacter.id } },
  );
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.deck[2].id === fixedCharacter.id));

  const outsideConstraint = { ...fixedCharacter, attributes: ["water"] };
  assert.equal(matchesMetagameFixedConstraint(outsideConstraint, fixture.constraint), false);
});

test("metagame simulator ranks complete decks by simulated win value", async () => {
  const fixture = metagameTestFixture();
  const result = await findBestMetagameDeck(
    fixture.data,
    fixture.constraint.id,
    fixture.characters,
    { beamWidth: 100, finalistCount: 10 },
  );
  assert.equal(result.constraint.id, fixture.constraint.id);
  assert.ok(result.candidateDeckCount > 0);
  assert.ok(result.simulatedDeckCount > 0);
  assert.equal(result.scenarioCount, 1);
  assert.equal(result.results[0].deck.length, 5);
  assert.ok(result.results[0].expectedWinRate >= 0 && result.results[0].expectedWinRate <= 1);
});

test("metagame simulator applies a requested total-cost cap to generation and validation", async () => {
  const fixture = metagameTestFixture();
  const result = await findBestMetagameDeck(
    fixture.data,
    fixture.constraint.id,
    fixture.characters,
    { beamWidth: 100, finalistCount: 10, totalCost: 45 },
  );

  assert.equal(result.constraint.totalCost, 45);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((candidate) => candidate.totalCost <= 45));
});

test("metagame simulator can require an exact entered total cost", async () => {
  const fixture = metagameTestFixture();
  const result = await findBestMetagameDeck(
    fixture.data,
    fixture.constraint.id,
    fixture.characters,
    { beamWidth: 100, finalistCount: 10, totalCost: 44, costMode: "exact" },
  );

  assert.equal(result.constraint.costMode, "exact");
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((candidate) => candidate.totalCost === 44));
});

test("中間の環境コスト縛りは両側の調査済み帯を併用する", () => {
  const fixture = metagameTestFixture();
  const lower = {
    ...fixture.constraint,
    id: "fire:100",
    attributeKey: "fire",
    totalCost: 100,
    label: "火・コスト100",
    teamScenarios: [],
  };
  const upper = {
    ...fixture.constraint,
    id: "fire:200",
    attributeKey: "fire",
    totalCost: 200,
    label: "火・コスト200",
    teamScenarios: [],
    environmentScenarios: [...fixture.constraint.environmentScenarios, ...fixture.constraint.environmentScenarios],
  };
  const resolved = resolveMetagameConstraint(
    { constraints: [lower, upper] },
    lower.id,
    150,
  );

  assert.equal(resolved.totalCost, 150);
  assert.equal(resolved.interpolation.kind, "between");
  assert.equal(resolved.interpolation.lowerCost, 100);
  assert.equal(resolved.interpolation.upperCost, 200);
  assert.equal(resolved.environmentScenarios.length, 3);
  assert.match(resolved.label, /100\/200/);
});

test("metagame simulator reports candidate and battle progress", async () => {
  const fixture = metagameTestFixture();
  const progress = [];
  await findBestMetagameDeck(
    fixture.data,
    fixture.constraint.id,
    fixture.characters,
    {
      beamWidth: 100,
      finalistCount: 10,
      onProgress: (update) => progress.push(update),
    },
  );

  const candidateProgress = progress.filter((update) => update.phase === "candidate");
  const simulationProgress = progress.filter((update) => update.phase === "simulation");
  assert.ok(candidateProgress.some((update) => update.slot === 1 && update.completed === 0));
  assert.ok(candidateProgress.some((update) => update.slot === 3 && update.completed === 3));
  assert.ok(candidateProgress.some((update) => update.slot === 5 && update.valid > 0));
  assert.ok(simulationProgress.some((update) => update.deck === 1 && update.decks > 0));
  assert.equal(simulationProgress.at(-1).completed, simulationProgress.at(-1).total);
});

test("補正キャラは元データを変えずHP・攻撃力を1.5倍にする", () => {
  const character = metagameTestCharacter("boost-target", 10, "R", 200);
  const boosted = applyMetagameStatBoost(character, [character.id]);

  assert.equal(character.hp, 1000);
  assert.equal(character.pow, 200);
  assert.equal(boosted.hp, 1500);
  assert.equal(boosted.pow, 300);
  assert.equal(boosted.metagameStatBoost.multiplier, 1.5);
});

test("V8では補正キャラを候補と代表環境の両方へ入れて再対戦する", async () => {
  const character = (id, position, power) => ({
    ...metagameTestCharacter(id, 10, "R", power),
    hp: 100,
    allowedPositions: [position],
    skillTurn: position - 1,
  });
  const baseDeck = [1, 2, 3, 4, 5].map((position) => character(`base-${position}`, position, 20));
  const boosted = character("boosted-3", 3, 500);
  const enemyDeck = baseDeck.map((entry) => entry.id);
  const constraint = {
    id: "fire:100",
    label: "火・コスト100",
    modelVersion: "team-battle-v8.6-combat-corrections",
    allowedAttributes: ["fire"],
    totalCost: 100,
    turns: 1,
    scenarioCount: 1,
    slots: [1, 2, 3, 4, 5].map((position) => ({ position, candidates: [] })),
    precomputedDecks: [{
      i: enemyDeck,
      c: 50,
      p: 0.6,
      w: 0.5,
      l: 0.45,
      s: 1,
      r: baseDeck.map(() => ({ k: "neutral", i: 0.5, f: 0.5, b: {} })),
    }],
    teamScenarios: [{
      a: Array.from({ length: 4 }, () => enemyDeck),
      e: Array.from({ length: 5 }, () => enemyDeck),
    }],
    environmentScenarios: [],
  };
  const data = { generatedAt: "2026-01-01T00:00:00.000Z", constraints: [constraint] };
  const result = await findBestMetagameDeck(data, constraint.id, [...baseDeck, boosted], {
    boostedCharacterIds: [boosted.id],
    finalistCount: 4,
  });

  assert.equal(result.scenarioCount, 1, "補正キャラ入りデッキを代表環境へ差し込んで評価する");
  assert.ok(result.simulatedDeckCount > 0);
  assert.ok(result.results.some((candidate) => (
    candidate.deck.some((entry) => entry.id === boosted.id && entry.hp === 150 && entry.pow === 750)
  )));
  const evidence = await inspectMetagameDeckEvidence(result.results[0].deck, result.constraint, [...baseDeck, boosted], {
    boostedCharacterIds: [boosted.id],
    automaticEnvironmentCharacterIds: result.automaticEnvironmentCharacterIds,
    interactiveScenarioCount: 1,
  });
  assert.ok(evidence.samples.some((sample) => sample.enemyDecks.flat().some((entry) => entry.id === boosted.id)));
});

test("継続する全体バフは条件を満たす後続アタッカーとの相性を得る", () => {
  const source = metagameTestCharacter("source", 20, "R", 100);
  source.attributes = ["water"];
  source.skillTurn = 1;
  source.skill = {
    ...source.skill,
    type: "attack_buff",
    target: "ally_all",
    duration: 2,
    multiplier: 3,
    conditions: [{ type: "ally_attribute", attribute: "water" }],
  };
  const matchingTarget = metagameTestCharacter("matching", 20, "R", 300);
  matchingTarget.attributes = ["water"];
  const mismatchingTarget = metagameTestCharacter("mismatching", 20, "R", 300);
  mismatchingTarget.attributes = ["fire"];
  const sourceRating = { practicalSkillReliability: 1, powerPreference: 0.2 };
  const targetRating = { powerPreference: 1, counteraction: 1 };

  const matchingScore = calculateMetagameDeckSynergy(
    [source, matchingTarget],
    [sourceRating, targetRating],
  );
  const mismatchingScore = calculateMetagameDeckSynergy(
    [source, mismatchingTarget],
    [sourceRating, targetRating],
  );
  assert.ok(matchingScore > 0);
  assert.equal(mismatchingScore, 0);
});

test("ほどほどの性能でコストを使い切る初手は候補デッキで抑制する", () => {
  const expensive = metagameTestCharacter("expensive", 60, "R", 200);
  const balanced = metagameTestCharacter("balanced", 20, "R", 200);
  const deckTail = [2, 3, 4, 5].map((position) => metagameTestCharacter(`tail-${position}`, 10, "R", 200));
  const rating = (character) => ({
    ...metagameTestRating(character, 1),
    practicalValue: 0.6,
    practicalSkillReliability: 1,
    powerPreference: 0.6,
    enemyPressureRate: 0.6,
  });
  const constraint = {
    totalCost: 100,
    slots: [
      { position: 1, candidates: [rating(expensive), rating(balanced)] },
      ...deckTail.map((character, index) => ({ position: index + 2, candidates: [rating(character)] })),
    ],
  };
  const candidates = buildMetagameDeckCandidates(constraint, [expensive, balanced, ...deckTail], { beamWidth: 50 });
  assert.equal(candidates[0].deck[0].id, "balanced");
});

test("継続ガードは後続の高耐久キャラへ引き継ぐ価値を持つ", () => {
  const guard = metagameTestCharacter("guard", 12, "R", 20);
  guard.hp = 120;
  guard.skillTurn = 2;
  guard.skill = {
    ...guard.skill,
    type: "guard",
    target: "self",
    duration: 4,
    multiplier: 0.1,
  };
  const durable = metagameTestCharacter("durable", 20, "R", 120);
  durable.hp = 9_000;
  const fragile = metagameTestCharacter("fragile", 20, "R", 120);
  fragile.hp = 250;
  const guardRating = {
    practicalSkillReliability: 1,
    carriedDefenseRate: 1,
    continuationWinGain: 0.25,
    carriedContinuationWinGain: 0.25,
  };
  const durableRating = { allyRetentionRate: 0.95, powerPreference: 0.6 };
  const fragileRating = { allyRetentionRate: 0.1, powerPreference: 0.6 };

  const durableScore = calculateMetagameDeckSynergy(
    [guard, durable],
    [guardRating, durableRating],
  );
  const fragileScore = calculateMetagameDeckSynergy(
    [guard, fragile],
    [guardRating, fragileRating],
  );
  const unmeasuredScore = calculateMetagameDeckSynergy(
    [guard, durable],
    [{ practicalSkillReliability: 1, carriedDefenseRate: 1 }, durableRating],
  );

  assert.ok(durableScore > fragileScore);
  assert.ok(durableScore > unmeasuredScore);
  assert.ok(durableScore > 0.1);
});

test("継続ガードの直後には、単体評価より受け先耐久を優先する", () => {
  const guard = metagameTestCharacter("guard", 12, "R", 20);
  guard.skillTurn = 2;
  guard.skill = {
    ...guard.skill,
    type: "guard",
    target: "self",
    duration: 4,
    multiplier: 0.1,
  };
  const durable = metagameTestCharacter("durable", 12, "R", 100);
  durable.hp = 9_000;
  const fragile = metagameTestCharacter("fragile", 12, "R", 500);
  fragile.hp = 150;
  const tail = [3, 4, 5].map((position) => metagameTestCharacter(`tail-${position}`, 12, "R", 180));
  const guardRating = {
    ...metagameTestRating(guard, 1),
    expectedWinRate: 0.4,
    expectedWinLowerBound: 0.35,
    practicalSkillReliability: 1,
    carriedDefenseRate: 1,
    carriedContinuationWinGain: 0.25,
  };
  const durableRating = {
    ...metagameTestRating(durable, 2),
    expectedWinRate: 0.55,
    expectedWinLowerBound: 0.5,
    practicalValue: 0.55,
    allyRetentionRate: 0.95,
  };
  const fragileRating = {
    ...metagameTestRating(fragile, 1),
    expectedWinRate: 0.9,
    expectedWinLowerBound: 0.85,
    practicalValue: 0.9,
    allyRetentionRate: 0.1,
  };
  const tailRatings = tail.map((character) => ({
    ...metagameTestRating(character, 1),
    expectedWinRate: 0.6,
    expectedWinLowerBound: 0.55,
    practicalValue: 0.6,
    allyRetentionRate: 0.6,
  }));
  const constraint = {
    totalCost: 100,
    slots: [
      { position: 1, candidates: [guardRating] },
      { position: 2, candidates: [fragileRating, durableRating] },
      ...tailRatings.map((rating, index) => ({ position: index + 3, candidates: [rating] })),
    ],
  };

  const candidates = buildMetagameDeckCandidates(constraint, [guard, durable, fragile, ...tail], { beamWidth: 50 });
  const durableCandidate = candidates.find((candidate) => candidate.deck[1].id === durable.id);
  const fragileCandidate = candidates.find((candidate) => candidate.deck[1].id === fragile.id);

  assert.equal(candidates[0].deck[1].id, durable.id);
  assert.ok(fragileCandidate.handoffRisk > durableCandidate.handoffRisk);
});

test("a carried area attack values a durable successor", () => {
  const openingSweep = metagameTestCharacter("opening-sweep", 15, "R", 2_400);
  openingSweep.hp = 1;
  openingSweep.skill = {
    ...openingSweep.skill,
    type: "aoe_attack",
    target: "enemy_all",
    duration: 3,
  };
  const durableGuard = metagameTestCharacter("durable-guard", 45, "R", 3_700);
  durableGuard.hp = 6_300;
  durableGuard.skill = {
    ...durableGuard.skill,
    type: "guard",
    target: "self",
    multiplier: 0.12,
  };
  const fragileSuccessor = metagameTestCharacter("fragile-successor", 15, "R", 800);
  fragileSuccessor.hp = 300;
  const sourceRating = { practicalSkillReliability: 1, allyRetentionRate: 0.02 };
  const durableRating = {
    powerPreference: 0.8,
    enemyPressureRate: 0.75,
    allyRetentionRate: 0.95,
  };
  const fragileRating = {
    powerPreference: 0.25,
    enemyPressureRate: 0.2,
    allyRetentionRate: 0.05,
  };

  const durableScore = calculateMetagameDeckSynergy(
    [openingSweep, durableGuard],
    [sourceRating, durableRating],
  );
  const fragileScore = calculateMetagameDeckSynergy(
    [openingSweep, fragileSuccessor],
    [sourceRating, fragileRating],
  );

  assert.ok(durableScore > fragileScore);
  assert.ok(durableScore > 0);
});

test("a self-targeted continuous buff uses handoff likelihood", () => {
  const buff = metagameTestCharacter("self-buff", 20, "R", 1_500);
  buff.skill = {
    ...buff.skill,
    type: "attack_buff",
    target: "self",
    multiplier: 2,
    duration: 4,
  };
  const successor = metagameTestCharacter("successor", 20, "R", 2_500);
  const targetRating = { powerPreference: 0.8, enemyPressureRate: 0.7, allyRetentionRate: 0.8 };
  const fragileSourceScore = calculateMetagameDeckSynergy(
    [buff, successor],
    [{ practicalSkillReliability: 1, allyRetentionRate: 0.1 }, targetRating],
  );
  const durableSourceScore = calculateMetagameDeckSynergy(
    [buff, successor],
    [{ practicalSkillReliability: 1, allyRetentionRate: 0.95 }, targetRating],
  );

  assert.ok(fragileSourceScore > durableSourceScore);
  assert.ok(durableSourceScore > 0);
});

test("V8 search automatically evaluates an edited catalogue character in both deck candidates and environment", async () => {
  const character = (id, position, power) => ({
    ...metagameTestCharacter(id, 10, "R", power),
    hp: 100,
    allowedPositions: [position],
    skillTurn: position - 1,
  });
  const baseDeck = [1, 2, 3, 4, 5].map((position) => character(`base-${position}`, position, 20));
  const added = character("manual-added-3", 3, 900);
  const deckIds = baseDeck.map((entry) => entry.id);
  const constraint = {
    id: "fire:100",
    modelVersion: "team-battle-v8.6-combat-corrections",
    allowedAttributes: ["fire"],
    totalCost: 100,
    turns: 1,
    scenarioCount: 1,
    slots: [1, 2, 3, 4, 5].map((position) => ({ position, candidates: [] })),
    precomputedDecks: [{ i: deckIds, c: 50, p: 0.6, w: 0.5, l: 0.45, s: 1, r: [] }],
    teamScenarios: [{
      a: Array.from({ length: 4 }, () => deckIds),
      e: Array.from({ length: 5 }, () => deckIds),
    }],
    environmentScenarios: [],
  };
  const data = { generatedAt: "2026-01-01T00:00:00.000Z", constraints: [constraint] };
  const result = await findBestMetagameDeck(data, constraint.id, [...baseDeck, added], {
    automaticCharacterIds: [added.id],
    finalistCount: 4,
    interactiveScenarioCount: 1,
  });

  assert.equal(result.scenarioCount, 1);
  assert.ok(result.results.some((candidate) => candidate.deck.some((entry) => entry.id === added.id)));
  assert.ok(result.automaticCharacterIds.includes(added.id));
  assert.ok(result.automaticEnvironmentCharacterIds.includes(added.id));
  const evidence = await inspectMetagameDeckEvidence(result.results[0].deck, result.constraint, [...baseDeck, added], {
    automaticEnvironmentCharacterIds: result.automaticEnvironmentCharacterIds,
    interactiveScenarioCount: 1,
  });
  assert.ok(evidence.samples.some((sample) => sample.enemyDecks.flat().some((entry) => entry.id === added.id)));
});
