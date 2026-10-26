import fs from "node:fs/promises";
import path from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { createBattleState } from "../src/core/battleState.js";
import { simulateBattleSummary } from "../src/core/simulate.js";
import { DEFAULT_ENVIRONMENT_BATTLE_PROFILES } from "../src/core/environment-rating.js";
import { DEFAULT_RULES } from "../src/data/rules.js";
import {
  buildMetagameDeckCandidates,
  matchesMetagamePositionConstraint,
} from "../src/core/metagame-deck.js";

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(arg(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (Number(value) - mean) ** 2, 0) / (values.length - 1));
}

function lowerBound(values) {
  if (!values.length) return 0;
  const mean = average(values);
  if (values.length <= 1) return mean;
  return mean - 1.28 * stddev(values) / Math.sqrt(values.length);
}

function rounded(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function characterId(character) {
  return String(character?.id ?? "");
}

function deckKey(deck) {
  return (deck ?? []).map(characterId).join("|");
}

function hydrateDeck(ids, byId) {
  const deck = (ids ?? []).map((id) => byId.get(String(id)));
  return deck.length === 5 && deck.every(Boolean) ? deck : null;
}

function totalCost(deck) {
  return (deck ?? []).reduce((sum, character) => sum + Math.max(0, Number(character?.cost) || 0), 0);
}

function roleFromCharacter(character) {
  const type = String(character?.skill?.type ?? "none");
  if (type === "single_attack") return "precision_attack";
  if (type === "aoe_attack" || type === "multi_hit_attack") return "sweep_attack";
  if (type === "damage_reduction" || type === "guard" || type === "attribute_guard") return "defense";
  if (type === "revive") return "revive";
  if (type === "heal") return "recovery";
  if (type === "attack_buff" || type === "attribute_change" || type === "delay" || type === "skill_reduction") return "support";
  return "neutral";
}

function projectedWinValue(result) {
  if (result.outcome === "allies") return 1;
  if (result.outcome === "draw") return 0.5;
  if (result.outcome === "enemies") return 0;
  const initialEnemyCount = Math.max(1, Number(result.initial?.enemies?.remainingCharacters) || 1);
  const initialAllyCount = Math.max(1, Number(result.initial?.allies?.remainingCharacters) || 1);
  const enemyProgress = (Number(result.metrics?.enemyLosses) || 0) / initialEnemyCount;
  const allyProgress = (Number(result.metrics?.allyLosses) || 0) / initialAllyCount;
  const allyHp = Number(result.final?.allies?.totalHp) > 0
    ? Number(result.final?.allies?.remainingHp) / Number(result.final?.allies?.totalHp)
    : 0;
  const enemyHp = Number(result.final?.enemies?.totalHp) > 0
    ? Number(result.final?.enemies?.remainingHp) / Number(result.final?.enemies?.totalHp)
    : 0;
  return clamp01(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function candidateSourceScore(entry) {
  const values = [
    entry?.costAwareScore,
    entry?.practicalValue,
    entry?.individualScore,
    entry?.balancedContribution,
    entry?.robustOpportunityWinGain,
    entry?.marginalWinGainLowerBound,
    entry?.expectedWinLowerBound,
    entry?.expectedWinRate,
  ].map(Number).filter(Number.isFinite);
  if (!values.length) return 0.5;
  const primary = values[0];
  if (primary >= 0 && primary <= 1) return primary;
  return clamp01(0.5 + primary * 2.5);
}

function analogDistance(character, priorCharacter, priorEntry, budget) {
  const skillType = String(character?.skill?.type ?? "none");
  const priorSkillType = String(priorEntry?.skillType ?? priorCharacter?.skill?.type ?? "none");
  const target = String(character?.skill?.target ?? "self");
  const priorTarget = String(priorEntry?.skillTarget ?? priorCharacter?.skill?.target ?? "self");
  const role = roleFromCharacter(character);
  const priorRole = String(priorEntry?.role ?? roleFromCharacter(priorCharacter));
  const turnDelta = Math.abs((Number(character?.skillTurn) || 0) - (Number(priorEntry?.skillTurn ?? priorCharacter?.skillTurn) || 0));
  const costDelta = Math.abs((Number(character?.cost) || 0) - (Number(priorEntry?.cost ?? priorCharacter?.cost) || 0)) / Math.max(1, budget);
  const hpRatio = Math.abs(Math.log(Math.max(1, Number(character?.hp) || 1) / Math.max(1, Number(priorCharacter?.hp) || 1)));
  const powRatio = Math.abs(Math.log(Math.max(1, Number(character?.pow) || 1) / Math.max(1, Number(priorCharacter?.pow) || 1)));
  const attrs = new Set((character?.attributes ?? []).map(String));
  const priorAttrs = (priorCharacter?.attributes ?? []).map(String);
  const attrMismatch = priorAttrs.some((attribute) => attrs.has(attribute)) ? 0 : 1;
  return (
    (skillType === priorSkillType ? 0 : 2.4)
    + (target === priorTarget ? 0 : 0.35)
    + (role === priorRole ? 0 : 0.8)
    + turnDelta * 0.22
    + costDelta * 2.2
    + Math.min(1.5, hpRatio) * 0.25
    + Math.min(1.5, powRatio) * 0.35
    + attrMismatch * 0.7
  );
}

function weightedNumber(analogs, key, fallback) {
  let total = 0;
  let weight = 0;
  for (const analog of analogs) {
    const value = Number(analog.entry?.[key]);
    if (!Number.isFinite(value)) continue;
    total += value * analog.weight;
    weight += analog.weight;
  }
  return weight ? total / weight : fallback;
}

function syntheticRating(character, position, sourceEntries, charactersById, budget) {
  const exact = sourceEntries.find((entry) => String(entry.id) === characterId(character));
  if (exact) {
    return {
      ...exact,
      id: characterId(character),
      name: character.name,
      cost: Number(character.cost) || 0,
      attributes: character.attributes ?? [],
      skillTurn: Number(character.skillTurn) || 0,
      skillType: character.skill?.type ?? exact.skillType ?? "none",
      skillTarget: character.skill?.target ?? exact.skillTarget ?? "self",
      role: exact.role ?? roleFromCharacter(character),
      blindEvidence: "cost100-exact-character",
    };
  }

  const analogs = sourceEntries
    .map((entry) => {
      const priorCharacter = charactersById.get(String(entry.id));
      if (!priorCharacter) return null;
      const distance = analogDistance(character, priorCharacter, entry, budget);
      return { entry, priorCharacter, distance, weight: 1 / (0.25 + distance) };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance || String(left.entry.id).localeCompare(String(right.entry.id)))
    .slice(0, 6);

  const transferred = analogs.length
    ? analogs.reduce((sum, item) => sum + candidateSourceScore(item.entry) * item.weight, 0)
      / analogs.reduce((sum, item) => sum + item.weight, 0)
    : 0.5;

  return {
    id: characterId(character),
    name: character.name,
    attributes: character.attributes ?? [],
    rarity: character.rarity ?? "unknown",
    cost: Number(character.cost) || 0,
    skillTurn: Number(character.skillTurn) || 0,
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    role: roleFromCharacter(character),
    costAwareScore: transferred,
    practicalValue: transferred,
    individualScore: transferred,
    roleFit: weightedNumber(analogs, "roleFit", 0),
    marginalWinGain: weightedNumber(analogs, "marginalWinGain", 0),
    marginalWinGainLowerBound: weightedNumber(analogs, "marginalWinGainLowerBound", 0),
    expectedWinRate: weightedNumber(analogs, "expectedWinRate", transferred),
    expectedWinLowerBound: weightedNumber(analogs, "expectedWinLowerBound", transferred),
    allyRetentionRate: weightedNumber(analogs, "allyRetentionRate", 0),
    enemyPressureRate: weightedNumber(analogs, "enemyPressureRate", 0),
    advantageCreation: weightedNumber(analogs, "advantageCreation", 0),
    counteraction: weightedNumber(analogs, "counteraction", 0),
    balancedContribution: weightedNumber(analogs, "balancedContribution", transferred),
    roleBreakdown: {},
    blindEvidence: "cost100-analogy",
    blindAnalogIds: analogs.map((item) => String(item.entry.id)),
    blindPosition: position,
  };
}

function retainBlindCandidates(entries, sourceIds, limit = 320) {
  const selected = new Map();
  const add = (entry) => {
    const id = String(entry.id);
    if (!selected.has(id)) selected.set(id, entry);
  };

  entries.slice(0, 190).forEach(add);

  [...entries]
    .sort((left, right) => Number(left.cost) - Number(right.cost) || candidateSourceScore(right) - candidateSourceScore(left))
    .slice(0, 36)
    .forEach(add);

  const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"];
  for (const role of roles) {
    entries.filter((entry) => String(entry.role) === role).slice(0, 28).forEach(add);
  }

  for (const entry of entries) {
    if (sourceIds.has(String(entry.id))) add(entry);
  }

  return [...selected.values()]
    .sort((left, right) => candidateSourceScore(right) - candidateSourceScore(left) || Number(left.cost) - Number(right.cost))
    .slice(0, limit);
}

function buildBlindConstraint(sourceReport, attributeKey) {
  const allowedAttributes = sourceReport.context?.allowedAttributes
    ?? attributeKey.split("-").filter(Boolean);
  const turns = Math.max(1, Number(sourceReport.context?.turns) || 12);
  const baseConstraint = {
    id: `${attributeKey}:200:blind-from-cost100`,
    label: `${attributeKey} blind C200`,
    attributeKey,
    allowedAttributes,
    totalCost: 200,
    turns,
    costMode: "at_most",
    modelVersion: sourceReport.model?.version ?? sourceReport.context?.version ?? "team-battle-v12-blind",
  };
  const charactersById = new Map(CHARACTER_CATALOG.map((character) => [characterId(character), character]));
  const slotReports = new Map((sourceReport.rankingsByPosition ?? []).map((slot) => [Number(slot.position), slot]));

  const slots = [];
  for (let position = 1; position <= 5; position += 1) {
    const sourceEntries = slotReports.get(position)?.characters ?? [];
    const sourceIds = new Set(sourceEntries.map((entry) => String(entry.id)));
    const rated = [];
    for (const character of CHARACTER_CATALOG) {
      if (!matchesMetagamePositionConstraint(character, baseConstraint, position)) continue;
      rated.push(syntheticRating(character, position, sourceEntries, charactersById, 200));
    }
    rated.sort((left, right) => (
      candidateSourceScore(right) - candidateSourceScore(left)
      || Number(left.cost) - Number(right.cost)
      || String(left.id).localeCompare(String(right.id))
    ));
    const retained = retainBlindCandidates(rated, sourceIds);
    slots.push({
      position,
      candidates: retained,
      debugRankings: retained.slice(0, 20),
      blindCatalogConsidered: rated.length,
      blindRetained: retained.length,
    });
  }
  return { ...baseConstraint, slots };
}

function chooseDiverseDecks(entries, limit) {
  const selected = [];
  const used = new Set();
  const signatureCount = new Map();
  for (const entry of entries) {
    const key = deckKey(entry.deck);
    if (used.has(key)) continue;
    const roles = entry.deck.map(roleFromCharacter).sort().join(",");
    const count = signatureCount.get(roles) ?? 0;
    if (count >= 8 && selected.length < Math.floor(limit * 0.75)) continue;
    selected.push(entry);
    used.add(key);
    signatureCount.set(roles, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function makeBlindScenarios(environmentDecks, count) {
  if (environmentDecks.length < 9) throw new Error("Blind environment needs at least 9 decks.");
  const decks = environmentDecks.map((entry) => entry.deck ?? entry);
  const scenarios = [];
  let stride = 17;
  const gcd = (a, b) => {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) [x, y] = [y, x % y];
    return x;
  };
  while (gcd(stride, decks.length) !== 1) stride += 2;
  for (let scenarioIndex = 0; scenarioIndex < count; scenarioIndex += 1) {
    const picked = Array.from({ length: 9 }, (_, offset) => (
      decks[(scenarioIndex * 9 * stride + offset * stride) % decks.length]
    ));
    scenarios.push({
      source: "blind-generated-meta",
      scenarioIndex,
      allyDecks: picked.slice(0, 4),
      enemyDecks: picked.slice(4),
    });
  }
  return scenarios;
}

function evaluateDeckAgainstScenarios(deck, scenarios, turns = 12) {
  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const scenarioIndex = Number.isInteger(Number(scenario.scenarioIndex)) ? Number(scenario.scenarioIndex) : index;
    const actorIndex = scenarioIndex % 5;
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(actorIndex, 0, deck);
    const profile = DEFAULT_ENVIRONMENT_BATTLE_PROFILES[scenarioIndex % DEFAULT_ENVIRONMENT_BATTLE_PROFILES.length];
    const result = simulateBattleSummary(
      createBattleState(allyDecks, scenario.enemyDecks),
      DEFAULT_RULES,
      {
        turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: scenarioIndex,
      },
    );
    values.push(projectedWinValue(result));
    outcomes[result.outcome] += 1;
  }
  const divisor = Math.max(1, values.length);
  return {
    mean: average(values),
    lower: lowerBound(values),
    decisiveWinRate: outcomes.allies / divisor,
    decisiveDrawRate: outcomes.draw / divisor,
    decisiveLossRate: outcomes.enemies / divisor,
    ongoingRate: outcomes.ongoing / divisor,
  };
}

function rankBlindSlots(finalDecks) {
  const perSlot = Array.from({ length: 5 }, () => new Map());
  for (let deckIndex = 0; deckIndex < finalDecks.length; deckIndex += 1) {
    const entry = finalDecks[deckIndex];
    const deckWeight = 1 / Math.sqrt(deckIndex + 1);
    for (let position = 0; position < 5; position += 1) {
      const id = characterId(entry.deck[position]);
      const current = perSlot[position].get(id) ?? {
        id,
        name: entry.deck[position].name,
        role: roleFromCharacter(entry.deck[position]),
        appearances: 0,
        weightedAppearances: 0,
        scoreSum: 0,
        bestDeckRank: Infinity,
      };
      current.appearances += 1;
      current.weightedAppearances += deckWeight;
      current.scoreSum += Number(entry.metaScore) || 0;
      current.bestDeckRank = Math.min(current.bestDeckRank, deckIndex + 1);
      perSlot[position].set(id, current);
    }
  }
  return perSlot.map((map, position) => [...map.values()]
    .map((entry) => ({
      ...entry,
      position: position + 1,
      meanDeckScore: entry.scoreSum / Math.max(1, entry.appearances),
      blindRankScore: entry.weightedAppearances + entry.meanDeckScore * 2,
    }))
    .sort((left, right) => (
      right.blindRankScore - left.blindRankScore
      || left.bestDeckRank - right.bestDeckRank
      || String(left.id).localeCompare(String(right.id))
    ))
    .map((entry, index) => ({ ...entry, rank: index + 1 })));
}

async function generateBlind() {
  const sourcePath = arg("source-report");
  const attributeKey = arg("attribute");
  const outputPath = arg("output", "blind-cost200.json");
  if (!sourcePath || !attributeKey) throw new Error("--source-report and --attribute are required.");

  const sourceReport = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  if (Number(sourceReport.context?.totalCost) !== 100) {
    throw new Error(`Blind generation accepts Cost100 evidence only; got ${sourceReport.context?.totalCost}`);
  }

  const constraint = buildBlindConstraint(sourceReport, attributeKey);
  const beamWidth = Math.max(2_000, Math.floor(numberArg("beam-width", 12_000)));
  const candidateLimit = Math.max(80, Math.floor(numberArg("candidate-limit", 180)));
  const rounds = Math.max(2, Math.floor(numberArg("rounds", 3)));
  const scenarioCount = Math.max(12, Math.floor(numberArg("scenario-count", 18)));

  const candidates = buildMetagameDeckCandidates(
    constraint,
    CHARACTER_CATALOG,
    { beamWidth },
  ).slice(0, candidateLimit);

  let environment = chooseDiverseDecks(candidates, Math.min(48, candidates.length));
  const scoreHistory = new Map(candidates.map((entry) => [deckKey(entry.deck), []]));
  const roundSummaries = [];

  for (let round = 0; round < rounds; round += 1) {
    const scenarios = makeBlindScenarios(environment, scenarioCount);
    const evaluated = candidates.map((entry) => {
      const evaluation = evaluateDeckAgainstScenarios(entry.deck, scenarios, constraint.turns);
      const key = deckKey(entry.deck);
      scoreHistory.get(key).push(evaluation.mean);
      return {
        ...entry,
        ...evaluation,
        metaScore: evaluation.mean * 0.72 + evaluation.lower * 0.28,
      };
    }).sort((left, right) => (
      right.metaScore - left.metaScore
      || right.mean - left.mean
      || left.totalCost - right.totalCost
      || deckKey(left.deck).localeCompare(deckKey(right.deck))
    ));
    environment = chooseDiverseDecks(evaluated, Math.min(48, evaluated.length));
    roundSummaries.push({
      round: round + 1,
      bestMean: rounded(evaluated[0]?.mean),
      bestLower: rounded(evaluated[0]?.lower),
      environmentDecks: environment.length,
      topDecks: evaluated.slice(0, 10).map((entry) => ({
        ids: entry.deck.map(characterId),
        totalCost: totalCost(entry.deck),
        mean: rounded(entry.mean),
        lower: rounded(entry.lower),
      })),
    });
  }

  const finalScenarios = makeBlindScenarios(environment, Math.max(24, scenarioCount));
  const finalDecks = candidates.map((entry) => {
    const evaluation = evaluateDeckAgainstScenarios(entry.deck, finalScenarios, constraint.turns);
    const history = scoreHistory.get(deckKey(entry.deck)) ?? [];
    const timeAverage = average([...history, evaluation.mean]);
    return {
      ...entry,
      ...evaluation,
      timeAverage,
      metaScore: timeAverage * 0.58 + evaluation.mean * 0.24 + evaluation.lower * 0.18,
    };
  }).sort((left, right) => (
    right.metaScore - left.metaScore
    || right.mean - left.mean
    || left.totalCost - right.totalCost
    || deckKey(left.deck).localeCompare(deckKey(right.deck))
  )).slice(0, 64);

  const slotRankings = rankBlindSlots(finalDecks);
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    test: "cost200-blind-environment-reconstruction",
    blindGuarantee: {
      generationInputCost: 100,
      requestedCost: 200,
      usesCost200Report: false,
      usesCost200EnvironmentInput: false,
      usesCost200CompletedDecks: false,
      source: "Cost100 report + character catalog + browser deck-generation rules + self-play",
    },
    attributeKey,
    constraint: {
      allowedAttributes: constraint.allowedAttributes,
      totalCost: 200,
      turns: constraint.turns,
      beamWidth,
      candidateLimit,
      rounds,
      scenarioCount,
      catalogCharacters: CHARACTER_CATALOG.length,
      consideredBySlot: constraint.slots.map((slot) => slot.blindCatalogConsidered),
      retainedBySlot: constraint.slots.map((slot) => slot.blindRetained),
    },
    roundSummaries,
    finalEnvironment: finalDecks.map((entry, index) => ({
      rank: index + 1,
      ids: entry.deck.map(characterId),
      names: entry.deck.map((character) => character.name),
      roles: entry.deck.map(roleFromCharacter),
      totalCost: totalCost(entry.deck),
      proxyScore: rounded(entry.proxyScore),
      expectedWinRate: rounded(entry.mean),
      expectedWinLowerBound: rounded(entry.lower),
      timeAverageWinRate: rounded(entry.timeAverage),
      metaScore: rounded(entry.metaScore),
    })),
    slotRankings: slotRankings.map((entries) => entries.slice(0, 50)),
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    attributeKey,
    generatedDecks: output.finalEnvironment.length,
    bestDeck: output.finalEnvironment[0],
    topSlotIds: output.slotRankings.map((entries) => entries.slice(0, 5).map((entry) => entry.id)),
  }, null, 2));
}

function spearmanWithMissing(blindEntries, truthEntries, depth = 30) {
  const blind = new Map(blindEntries.slice(0, depth).map((entry, index) => [String(entry.id), index + 1]));
  const truth = new Map(truthEntries.slice(0, depth).map((entry, index) => [String(entry.id), index + 1]));
  const ids = [...new Set([...blind.keys(), ...truth.keys()])];
  if (ids.length < 2) return 0;
  const missingRank = depth + 1;
  const xs = ids.map((id) => blind.get(id) ?? missingRank);
  const ys = ids.map((id) => truth.get(id) ?? missingRank);
  const mx = average(xs);
  const my = average(ys);
  const numerator = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0);
  const dx = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
  return dx && dy ? numerator / (dx * dy) : 0;
}

function topRecall(blindEntries, truthEntries, depth) {
  const blind = new Set(blindEntries.slice(0, depth).map((entry) => String(entry.id)));
  const truth = new Set(truthEntries.slice(0, depth).map((entry) => String(entry.id)));
  return [...truth].filter((id) => blind.has(id)).length / Math.max(1, truth.size);
}

function extractTrueDecks(report, limit = 60) {
  const unique = new Map();
  for (const slot of report.rankingsByPosition ?? []) {
    for (const entry of (slot.characters ?? []).slice(0, 30)) {
      for (const source of [entry.bestDeck, entry.baselineDeck]) {
        const ids = (source?.ids ?? []).map(String);
        if (ids.length !== 5) continue;
        const key = ids.join("|");
        const score = Number(source?.expectedWinRate) || Number(entry.candidateExpectedWinRate) || 0;
        const current = unique.get(key);
        if (!current || score > current.score) unique.set(key, { ids, score });
      }
    }
  }
  return [...unique.values()]
    .sort((left, right) => right.score - left.score || left.ids.join("|").localeCompare(right.ids.join("|")))
    .slice(0, limit);
}

function deckSimilarity(blindDecks, trueDecks, sample = 30) {
  const blind = blindDecks.slice(0, sample);
  const truth = trueDecks.slice(0, sample);
  if (!blind.length || !truth.length) return 0;
  const scores = truth.map((truthEntry) => {
    const trueIds = new Set(truthEntry.ids.map(String));
    return Math.max(...blind.map((blindEntry) => {
      const overlap = blindEntry.ids.filter((id) => trueIds.has(String(id))).length;
      return overlap / 5;
    }));
  });
  return average(scores);
}

function roleHistogramFromDecks(decks, byId, sample = 30) {
  const counts = new Map();
  let total = 0;
  for (const entry of decks.slice(0, sample)) {
    for (const id of entry.ids ?? []) {
      const character = byId.get(String(id));
      if (!character) continue;
      const role = roleFromCharacter(character);
      counts.set(role, (counts.get(role) ?? 0) + 1);
      total += 1;
    }
  }
  return new Map([...counts].map(([role, count]) => [role, count / Math.max(1, total)]));
}

function roleSimilarity(left, right) {
  const roles = new Set([...left.keys(), ...right.keys()]);
  const totalVariation = [...roles].reduce((sum, role) => sum + Math.abs((left.get(role) ?? 0) - (right.get(role) ?? 0)), 0) / 2;
  return 1 - totalVariation;
}

async function compareBlind() {
  const blindPath = arg("blind");
  const truthPath = arg("truth-report");
  const attributeKey = arg("attribute");
  const outputPath = arg("output", "blind-cost200-metrics.json");
  if (!blindPath || !truthPath || !attributeKey) throw new Error("--blind, --truth-report and --attribute are required.");

  const [blind, truth] = await Promise.all([
    fs.readFile(blindPath, "utf8").then(JSON.parse),
    fs.readFile(truthPath, "utf8").then(JSON.parse),
  ]);
  if (Number(truth.context?.totalCost) !== 200) throw new Error("Comparison truth must be Cost200.");

  const charactersById = new Map(CHARACTER_CATALOG.map((character) => [characterId(character), character]));
  const truthSlots = new Map((truth.rankingsByPosition ?? []).map((slot) => [Number(slot.position), slot.characters ?? []]));
  const perSlot = blind.slotRankings.map((blindEntries, index) => {
    const truthEntries = truthSlots.get(index + 1) ?? [];
    return {
      position: index + 1,
      top10Recall: rounded(topRecall(blindEntries, truthEntries, 10)),
      top30Recall: rounded(topRecall(blindEntries, truthEntries, 30)),
      spearmanTop30: rounded(spearmanWithMissing(blindEntries, truthEntries, 30)),
      blindTop10: blindEntries.slice(0, 10).map((entry) => String(entry.id)),
      truthTop10: truthEntries.slice(0, 10).map((entry) => String(entry.id)),
    };
  });

  const trueDecks = extractTrueDecks(truth, 60);
  const blindDecks = blind.finalEnvironment.map((entry) => ({ ids: entry.ids.map(String), score: entry.metaScore }));
  const blindHydrated = blindDecks.map((entry) => ({ ...entry, deck: hydrateDeck(entry.ids, charactersById) })).filter((entry) => entry.deck);
  const trueHydrated = trueDecks.map((entry) => ({ ...entry, deck: hydrateDeck(entry.ids, charactersById) })).filter((entry) => entry.deck);

  const { METAGAME_V8_COST_200_INPUTS } = await import("../src/data/metagame-v8-cost-200-inputs.js");
  const { resolveMetagameV7Input } = await import("../src/core/metagame-v7.js");
  const {
    createMetagameV12EnvironmentDecks,
    createMetagameV12TeamScenarios,
  } = await import("../src/core/metagame-v12.js");

  const truthInputId = attributeKey === "fire-water-wind" ? "all:200" : `${attributeKey}:200`;
  const exactInput = METAGAME_V8_COST_200_INPUTS.find((entry) => String(entry.id) === truthInputId);
  if (!exactInput) throw new Error(`No Cost200 truth environment for ${attributeKey}`);
  const resolved = resolveMetagameV7Input(exactInput, CHARACTER_CATALOG);
  const environmentDecks = createMetagameV12EnvironmentDecks(resolved, {
    count: Math.max(36, Number(truth.context?.environmentCount) || 72),
    environmentVariants: Math.max(1, Number(truth.context?.environmentVariants) || 2),
  });
  const trueScenarios = createMetagameV12TeamScenarios(resolved, {
    environmentDecks,
    count: Math.max(36, Number(truth.context?.teamScenarioCount) || 72),
  }).map((scenario, index) => ({ ...scenario, scenarioIndex: index }));

  const blindScenarioDecks = blindHydrated.slice(0, Math.min(48, blindHydrated.length));
  const blindScenarios = makeBlindScenarios(blindScenarioDecks.map((entry) => entry.deck), 36);
  const evaluateTop = (entries, scenarios, limit = 20) => entries.slice(0, limit).map((entry) => ({
    ids: entry.ids,
    ...evaluateDeckAgainstScenarios(entry.deck, scenarios, Number(truth.context?.turns) || 12),
  })).sort((left, right) => right.mean - left.mean || right.lower - left.lower);

  const blindOnTrue = evaluateTop(blindHydrated, trueScenarios);
  const trueOnTrue = evaluateTop(trueHydrated, trueScenarios);
  const blindOnBlind = evaluateTop(blindHydrated, blindScenarios);
  const trueOnBlind = evaluateTop(trueHydrated, blindScenarios);

  const bestResponseGap = Math.max(0, (trueOnTrue[0]?.mean ?? 0) - (blindOnTrue[0]?.mean ?? 0));
  const blindTransferDrop = Math.max(0, (blindOnBlind[0]?.mean ?? 0) - (blindOnTrue[0]?.mean ?? 0));
  const trueTransferDrop = Math.max(0, (trueOnTrue[0]?.mean ?? 0) - (trueOnBlind[0]?.mean ?? 0));

  const blindRoles = roleHistogramFromDecks(blindDecks, charactersById);
  const truthRoles = roleHistogramFromDecks(trueDecks, charactersById);

  const metrics = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    attributeKey,
    perSlot,
    summary: {
      meanTop10Recall: rounded(average(perSlot.map((entry) => entry.top10Recall))),
      meanTop30Recall: rounded(average(perSlot.map((entry) => entry.top30Recall))),
      meanSpearmanTop30: rounded(average(perSlot.map((entry) => entry.spearmanTop30))),
      topDeckCharacterSimilarity: rounded(deckSimilarity(blindDecks, trueDecks)),
      roleCompositionSimilarity: rounded(roleSimilarity(blindRoles, truthRoles)),
      bestResponseGap: rounded(bestResponseGap),
      blindBestOnTrue: rounded(blindOnTrue[0]?.mean),
      trueBestOnTrue: rounded(trueOnTrue[0]?.mean),
      blindBestOnBlind: rounded(blindOnBlind[0]?.mean),
      trueBestOnBlind: rounded(trueOnBlind[0]?.mean),
      blindTransferDrop: rounded(blindTransferDrop),
      trueTransferDrop: rounded(trueTransferDrop),
    },
    crossEvaluation: {
      blindOnTrue: blindOnTrue.slice(0, 10),
      trueOnTrue: trueOnTrue.slice(0, 10),
      blindOnBlind: blindOnBlind.slice(0, 10),
      trueOnBlind: trueOnBlind.slice(0, 10),
    },
    roleComposition: {
      blind: Object.fromEntries(blindRoles),
      truth: Object.fromEntries(truthRoles),
    },
    blindTopDecks: blind.finalEnvironment.slice(0, 20),
    truthTopDecks: trueDecks.slice(0, 20),
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ attributeKey, summary: metrics.summary }, null, 2));
}

async function aggregate() {
  const inputDirectory = arg("input-directory");
  const outputPath = arg("output", "blind-cost200-summary.json");
  if (!inputDirectory) throw new Error("--input-directory is required.");
  const files = (await fs.readdir(inputDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const conditions = [];
  for (const name of files) {
    conditions.push(JSON.parse(await fs.readFile(path.join(inputDirectory, name), "utf8")));
  }
  if (!conditions.length) throw new Error("No blind-test metric files found.");

  const averageMetric = (key) => average(conditions.map((entry) => Number(entry.summary?.[key]) || 0));
  const overall = {
    meanTop10Recall: rounded(averageMetric("meanTop10Recall")),
    meanTop30Recall: rounded(averageMetric("meanTop30Recall")),
    meanSpearmanTop30: rounded(averageMetric("meanSpearmanTop30")),
    topDeckCharacterSimilarity: rounded(averageMetric("topDeckCharacterSimilarity")),
    roleCompositionSimilarity: rounded(averageMetric("roleCompositionSimilarity")),
    bestResponseGap: rounded(averageMetric("bestResponseGap")),
    worstBestResponseGap: rounded(Math.max(...conditions.map((entry) => Number(entry.summary?.bestResponseGap) || 0))),
    blindTransferDrop: rounded(averageMetric("blindTransferDrop")),
  };

  // These thresholds operationalize the previously qualitative requirement:
  // high-ish rank agreement, rediscovery of most important structures, and no
  // large collapse when the blind result is carried into the true Cost200 field.
  const checks = {
    top10Recall: overall.meanTop10Recall >= 0.45,
    rankCorrelation: overall.meanSpearmanTop30 >= 0.40,
    deckStructure: overall.topDeckCharacterSimilarity >= 0.68,
    roleStructure: overall.roleCompositionSimilarity >= 0.80,
    bestResponseGap: overall.bestResponseGap <= 0.06 && overall.worstBestResponseGap <= 0.10,
    transferStability: overall.blindTransferDrop <= 0.08,
  };
  const passed = Object.values(checks).every(Boolean);

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    test: "cost200-blind-environment-reconstruction",
    passed,
    checks,
    overall,
    conditions: conditions.map((entry) => ({
      attributeKey: entry.attributeKey,
      summary: entry.summary,
      perSlot: entry.perSlot,
    })),
    nextStep: passed
      ? "Cost300 zero-from-scratch generation is eligible to start; do not reuse old Cost300 win rates or rankings."
      : "Do not start Cost300. Improve blind environment reconstruction and rerun this test.",
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

const mode = arg("mode", "generate");
if (mode === "generate") {
  await generateBlind();
} else if (mode === "compare") {
  await compareBlind();
} else if (mode === "aggregate") {
  await aggregate();
} else {
  throw new Error(`Unknown --mode=${mode}`);
}
