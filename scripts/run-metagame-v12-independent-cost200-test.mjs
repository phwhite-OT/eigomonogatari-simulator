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
  metagameDeckIsLegal,
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

function isLegend(character) {
  const rarity = String(character?.rarity ?? "");
  return rarity === "伝" || rarity.toUpperCase() === "LEGEND";
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function blindCostBand(cost, budget, bandCount = 6) {
  const share = Math.max(0, Math.min(0.999999, (Number(cost) || 0) / Math.max(1, budget)));
  return Math.min(bandCount - 1, Math.floor(share * bandCount));
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

function makeScenarios(environmentEntries, count) {
  const decks = environmentEntries.map((entry) => entry.deck ?? entry).filter((deck) => Array.isArray(deck) && deck.length === 5);
  if (decks.length < 9) throw new Error(`Independent Cost200 environment needs at least 9 decks; got ${decks.length}.`);
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
      source: "independent-cost200-self-play",
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

function evaluateEntries(entries, scenarios, turns, label) {
  const evaluated = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const evaluation = evaluateDeckAgainstScenarios(entry.deck, scenarios, turns);
    evaluated.push({
      ...entry,
      ...evaluation,
      metaScore: evaluation.mean * 0.72 + evaluation.lower * 0.28,
    });
    if ((index + 1) % 100 === 0 || index + 1 === entries.length) {
      console.log(`${label}: ${index + 1}/${entries.length} decks evaluated`);
    }
  }
  return evaluated.sort((left, right) => (
    right.metaScore - left.metaScore
    || right.mean - left.mean
    || deckKey(left.deck).localeCompare(deckKey(right.deck))
  ));
}

function structuralSignature(deck) {
  return deck.map(roleFromCharacter).sort().join(",");
}

function entryScore(entry) {
  const candidates = [entry?.metaScore, entry?.mean, entry?.searchScore, entry?.proxyScore];
  for (const value of candidates) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0.5;
}

function chooseDiverseDecks(entries, limit, budget = 200, performanceFirst = true) {
  const sorted = [...entries].sort((left, right) => (
    (performanceFirst ? entryScore(right) - entryScore(left) : 0)
    || hashString(deckKey(left.deck)) - hashString(deckKey(right.deck))
  ));
  const selected = [];
  const used = new Set();
  const signatureCounts = new Map();
  const add = (entry, roleCap = Infinity) => {
    const key = deckKey(entry.deck);
    if (!key || used.has(key)) return false;
    const signature = structuralSignature(entry.deck);
    const count = signatureCounts.get(signature) ?? 0;
    if (count >= roleCap) return false;
    used.add(key);
    selected.push(entry);
    signatureCounts.set(signature, count + 1);
    return true;
  };

  const strongTarget = performanceFirst ? Math.floor(limit * 0.58) : 0;
  for (const entry of sorted) {
    if (selected.length >= strongTarget) break;
    add(entry, 8);
  }

  const bands = Array.from({ length: 6 }, () => []);
  for (const entry of sorted) {
    bands[blindCostBand(totalCost(entry.deck), budget, bands.length)].push(entry);
  }
  const offsets = Array(bands.length).fill(0);
  let active = bands.filter((band) => band.length).length;
  let cursor = 0;
  while (selected.length < limit && active > 0) {
    const index = cursor % bands.length;
    cursor += 1;
    const offset = offsets[index];
    const band = bands[index];
    if (offset >= band.length) continue;
    add(band[offset], performanceFirst ? 12 : Infinity);
    offsets[index] = offset + 1;
    if (offsets[index] >= band.length) active -= 1;
  }

  for (const entry of sorted) {
    if (selected.length >= limit) break;
    add(entry);
  }
  return selected;
}

function buildBaseConstraint(attributeKey, turns) {
  return {
    id: `${attributeKey}:200:independent-zero-start`,
    label: `${attributeKey} independent C200`,
    attributeKey,
    allowedAttributes: attributeKey.split("-").filter(Boolean),
    totalCost: 200,
    turns,
    costMode: "at_most",
    modelVersion: "team-battle-v12-independent-cost200-multiround",
  };
}

function eligibleCharactersByPosition(constraint) {
  return Array.from({ length: 5 }, (_, index) => (
    CHARACTER_CATALOG.filter((character) => matchesMetagamePositionConstraint(character, constraint, index + 1))
  ));
}

function candidateChoiceScore(character, targetCost, usedRoles, variant, salt) {
  const cost = Math.max(0, Number(character?.cost) || 0);
  const role = roleFromCharacter(character);
  const rolePenalty = usedRoles.has(role) ? 15 : 0;
  const jitter = (hashString(`${salt}:${characterId(character)}`) % 1000) / 1000;
  if (variant === 0) return cost * 2 + rolePenalty + jitter;
  if (variant === 1) return Math.abs(cost - targetCost) + rolePenalty * 0.6 + jitter;
  return Math.abs(cost - targetCost * 1.25) + rolePenalty * 0.8 + jitter;
}

function completeAnchorDeck(anchor, anchorPosition, eligibleByPosition, constraint, attempt = 0) {
  const deck = Array(5).fill(null);
  deck[anchorPosition - 1] = anchor;
  let currentCost = Math.max(0, Number(anchor.cost) || 0);
  let legendCount = isLegend(anchor) ? 1 : 0;
  const usedIds = new Set([characterId(anchor)]);
  const usedRoles = new Set([roleFromCharacter(anchor)]);
  const positions = [1, 2, 3, 4, 5].filter((position) => position !== anchorPosition);
  const salt = `${characterId(anchor)}:${anchorPosition}:${attempt}`;

  for (let cursor = 0; cursor < positions.length; cursor += 1) {
    const position = positions[cursor];
    const remainingSlots = positions.length - cursor;
    const remainingBudget = constraint.totalCost - currentCost;
    const targetCost = Math.max(0, remainingBudget / Math.max(1, remainingSlots));
    let best = null;
    let bestScore = Infinity;
    for (const character of eligibleByPosition[position - 1]) {
      const id = characterId(character);
      const cost = Math.max(0, Number(character.cost) || 0);
      if (usedIds.has(id)) continue;
      if (isLegend(character) && legendCount >= 1) continue;
      if (currentCost + cost > constraint.totalCost) continue;
      const score = candidateChoiceScore(character, targetCost, usedRoles, attempt % 3, `${salt}:${position}`);
      if (score < bestScore) {
        best = character;
        bestScore = score;
      }
    }
    if (!best) return null;
    deck[position - 1] = best;
    currentCost += Math.max(0, Number(best.cost) || 0);
    legendCount += isLegend(best) ? 1 : 0;
    usedIds.add(characterId(best));
    usedRoles.add(roleFromCharacter(best));
  }

  return metagameDeckIsLegal(deck, constraint) ? deck : null;
}

function buildBroadSeedDecks(eligibleByPosition, constraint) {
  const unique = new Map();
  const feasibleAnchorIdsByPosition = Array.from({ length: 5 }, () => new Set());

  for (let position = 1; position <= 5; position += 1) {
    for (const anchor of eligibleByPosition[position - 1]) {
      let deck = null;
      for (let attempt = 0; attempt < 6 && !deck; attempt += 1) {
        deck = completeAnchorDeck(anchor, position, eligibleByPosition, constraint, attempt);
      }
      if (!deck) continue;
      feasibleAnchorIdsByPosition[position - 1].add(characterId(anchor));
      const key = deckKey(deck);
      if (!unique.has(key)) {
        unique.set(key, {
          deck,
          source: "zero-start-anchor-cover",
          anchorPosition: position,
          anchorId: characterId(anchor),
          searchScore: 0.5,
        });
      }
    }
  }

  const entries = [...unique.values()];
  if (entries.length < 9) throw new Error(`Only ${entries.length} legal zero-start seed decks were constructed.`);
  return {
    entries,
    coverage: feasibleAnchorIdsByPosition.map((set, index) => ({
      position: index + 1,
      eligible: eligibleByPosition[index].length,
      feasibleAnchors: set.size,
    })),
  };
}

function createEvidence() {
  return Array.from({ length: 5 }, () => new Map());
}

function updateEvidence(evidence, entries, weight = 1) {
  for (const entry of entries) {
    const score = clamp01(entry.metaScore ?? entry.mean ?? 0.5);
    for (let position = 0; position < 5; position += 1) {
      const id = characterId(entry.deck[position]);
      const current = evidence[position].get(id) ?? { weightedSum: 0, weight: 0, best: 0, appearances: 0 };
      current.weightedSum += score * weight;
      current.weight += weight;
      current.best = Math.max(current.best, score);
      current.appearances += 1;
      evidence[position].set(id, current);
    }
  }
}

function evidenceScore(evidence, position, id) {
  const item = evidence[position - 1].get(String(id));
  if (!item || item.weight <= 0) return 0.5;
  const mean = item.weightedSum / item.weight;
  const raw = mean * 0.68 + item.best * 0.32;
  const confidence = Math.min(1, item.weight / 4);
  return clamp01(0.5 + (raw - 0.5) * confidence);
}

function neutralMeasuredRating(character, position, score) {
  const hp = Math.max(0, Number(character?.hp) || 0);
  const pow = Math.max(0, Number(character?.pow) || 0);
  const role = roleFromCharacter(character);
  return {
    id: characterId(character),
    name: character.name,
    attributes: character.attributes ?? [],
    rarity: character.rarity ?? "unknown",
    cost: Math.max(0, Number(character.cost) || 0),
    skillTurn: Math.max(0, Number(character.skillTurn) || 0),
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    role,
    costAwareScore: score,
    practicalValue: score,
    individualScore: score,
    roleFit: score,
    expectedWinRate: score,
    expectedWinLowerBound: Math.max(0, score - 0.04),
    balancedContribution: score,
    allyRetentionRate: clamp01(hp / (hp + 3500)),
    enemyPressureRate: clamp01(pow / (pow + 3500)),
    powerPreference: role === "precision_attack" || role === "sweep_attack" ? clamp01(pow / (pow + 2500)) : 0.25,
    practicalSkillReliability: 0.75,
    skillActivationRate: 0.75,
    advantageCreation: 0,
    counteraction: 0,
    combinationPotential: 0,
    continuationWinGain: 0,
    carriedContinuationWinGain: 0,
    tacticalUpside: 0,
    tacticalRisk: 0,
    budgetSpecificIndividualEvidence: true,
    independentEvidence: true,
    independentPosition: position,
  };
}

function retainRatedCandidates(entries, budget, limit) {
  const sorted = [...entries].sort((left, right) => (
    Number(right.costAwareScore) - Number(left.costAwareScore)
    || hashString(left.id) - hashString(right.id)
  ));
  const selected = new Map();
  const add = (entry) => {
    if (selected.size < limit && !selected.has(String(entry.id))) selected.set(String(entry.id), entry);
  };

  sorted.slice(0, Math.floor(limit * 0.48)).forEach(add);

  const costBands = Array.from({ length: 6 }, () => []);
  for (const entry of sorted) {
    costBands[blindCostBand(entry.cost, budget, costBands.length)].push(entry);
  }
  for (const band of costBands) {
    band.slice(0, Math.max(8, Math.floor(limit / 15))).forEach(add);
  }

  const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"];
  for (const role of roles) {
    sorted.filter((entry) => entry.role === role).slice(0, Math.max(6, Math.floor(limit / 22))).forEach(add);
  }

  for (const entry of sorted) {
    if (selected.size >= limit) break;
    add(entry);
  }
  return [...selected.values()];
}

function buildMeasuredConstraint(baseConstraint, eligibleByPosition, evidence, slotLimit) {
  const slots = eligibleByPosition.map((characters, index) => {
    const position = index + 1;
    const rated = characters.map((character) => (
      neutralMeasuredRating(character, position, evidenceScore(evidence, position, characterId(character)))
    ));
    const retained = retainRatedCandidates(rated, baseConstraint.totalCost, slotLimit);
    return {
      position,
      candidates: retained,
      blindCatalogConsidered: rated.length,
      blindRetained: retained.length,
    };
  });
  return { ...baseConstraint, slots };
}

function buildMutationCandidates(frontier, eligibleByPosition, evidence, constraint, perBucketLimit = 16) {
  const buckets = new Map();
  const push = (bucketKey, entry) => {
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(entry);
    buckets.set(bucketKey, bucket);
  };

  for (const base of frontier.slice(0, 24)) {
    for (let position = 1; position <= 5; position += 1) {
      for (const replacement of eligibleByPosition[position - 1]) {
        if (characterId(replacement) === characterId(base.deck[position - 1])) continue;
        if (base.deck.some((character, index) => index !== position - 1 && characterId(character) === characterId(replacement))) continue;
        const deck = [...base.deck];
        deck[position - 1] = replacement;
        if (!metagameDeckIsLegal(deck, constraint)) continue;
        const replacementScore = evidenceScore(evidence, position, characterId(replacement));
        const score = entryScore(base) * 0.58 + replacementScore * 0.42;
        const band = blindCostBand(totalCost(deck), constraint.totalCost, 6);
        const bucketKey = `${position}:${band}:${roleFromCharacter(replacement)}`;
        push(bucketKey, {
          deck,
          source: "measured-frontier-one-slot-replacement",
          searchScore: score,
          parentKey: deckKey(base.deck),
          replacementPosition: position,
          replacementId: characterId(replacement),
        });
      }
    }
  }

  const unique = new Map();
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => (
      right.searchScore - left.searchScore
      || hashString(deckKey(left.deck)) - hashString(deckKey(right.deck))
    ));
    for (const entry of bucket.slice(0, perBucketLimit)) {
      const key = deckKey(entry.deck);
      const current = unique.get(key);
      if (!current || entry.searchScore > current.searchScore) unique.set(key, entry);
    }
  }
  return [...unique.values()].sort((left, right) => right.searchScore - left.searchScore);
}

function selectRoundCandidates(generatedPool, mutations, previousEnvironment, broadSeeds, limit, budget) {
  const selected = new Map();
  const add = (entry) => {
    const key = deckKey(entry.deck);
    if (key && !selected.has(key) && selected.size < limit) selected.set(key, entry);
  };

  mutations.slice(0, Math.floor(limit * 0.30)).forEach(add);
  generatedPool.slice(0, Math.floor(limit * 0.30)).forEach((entry) => add({ ...entry, source: "measured-beam" }));
  previousEnvironment.slice(0, Math.floor(limit * 0.15)).forEach(add);

  const exploration = chooseDiverseDecks(
    broadSeeds.map((entry) => ({ ...entry, searchScore: 0.5 })),
    Math.min(broadSeeds.length, Math.floor(limit * 0.20)),
    budget,
    false,
  );
  exploration.forEach(add);

  const combined = [
    ...mutations,
    ...generatedPool.map((entry) => ({ ...entry, source: "measured-beam" })),
    ...previousEnvironment,
    ...broadSeeds,
  ];
  for (const entry of chooseDiverseDecks(combined, limit, budget, true)) {
    if (selected.size >= limit) break;
    add(entry);
  }
  return [...selected.values()];
}

function frontierOverlap(left, right) {
  if (!left?.length || !right?.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((key) => b.has(key)).length;
  return intersection / Math.max(1, Math.min(a.size, b.size));
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

async function main() {
  const attributeKey = arg("attribute");
  const outputPath = arg("output", "independent-cost200.json");
  if (!attributeKey) throw new Error("--attribute is required.");

  const turns = Math.max(1, Math.min(12, Math.floor(numberArg("turns", 12))));
  const probeScenarioCount = Math.max(3, Math.floor(numberArg("probe-scenario-count", 4)));
  const scenarioCount = Math.max(12, Math.floor(numberArg("scenario-count", 18)));
  const minRounds = Math.max(3, Math.floor(numberArg("min-rounds", 5)));
  const maxRounds = Math.max(minRounds, Math.floor(numberArg("max-rounds", 7)));
  const candidateLimit = Math.max(180, Math.floor(numberArg("candidate-limit", 300)));
  const beamWidth = Math.max(3000, Math.floor(numberArg("beam-width", 10000)));
  const slotLimit = Math.max(120, Math.floor(numberArg("slot-limit", 260)));

  const baseConstraint = buildBaseConstraint(attributeKey, turns);
  const eligibleByPosition = eligibleCharactersByPosition(baseConstraint);
  if (eligibleByPosition.some((pool) => pool.length === 0)) {
    throw new Error(`No legal characters for at least one slot: ${eligibleByPosition.map((pool) => pool.length).join(",")}`);
  }

  const broad = buildBroadSeedDecks(eligibleByPosition, baseConstraint);
  console.log(`Independent Cost200 ${attributeKey}: ${broad.entries.length} zero-start seed decks, slot coverage ${broad.coverage.map((x) => `${x.feasibleAnchors}/${x.eligible}`).join(", ")}`);

  const initialEnvironment = chooseDiverseDecks(broad.entries, Math.min(72, broad.entries.length), baseConstraint.totalCost, false);
  const probeScenarios = makeScenarios(initialEnvironment, probeScenarioCount);
  const probeEvaluated = evaluateEntries(broad.entries, probeScenarios, turns, "broad-probe");

  const evidence = createEvidence();
  updateEvidence(evidence, probeEvaluated, 0.35);

  let environment = chooseDiverseDecks(probeEvaluated, Math.min(60, probeEvaluated.length), baseConstraint.totalCost, true);
  const archive = new Map(probeEvaluated.map((entry) => [deckKey(entry.deck), entry]));
  const roundSummaries = [];
  let previousFrontierKeys = null;
  let previousBest = null;
  let stableRounds = 0;
  let roundsCompleted = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    const measuredConstraint = buildMeasuredConstraint(baseConstraint, eligibleByPosition, evidence, slotLimit);
    const generatedPool = buildMetagameDeckCandidates(
      measuredConstraint,
      CHARACTER_CATALOG,
      {
        beamWidth,
        budgetNeutralExploration: true,
      },
    );
    const mutations = buildMutationCandidates(environment, eligibleByPosition, evidence, baseConstraint, 16);
    const roundCandidates = selectRoundCandidates(
      generatedPool,
      mutations,
      environment,
      broad.entries,
      candidateLimit,
      baseConstraint.totalCost,
    );
    const scenarios = makeScenarios(environment, scenarioCount);
    const evaluated = evaluateEntries(roundCandidates, scenarios, turns, `round-${round}`);
    updateEvidence(evidence, evaluated, 1);

    for (const entry of evaluated) archive.set(deckKey(entry.deck), entry);
    environment = chooseDiverseDecks(evaluated, Math.min(60, evaluated.length), baseConstraint.totalCost, true);

    const frontierKeys = environment.slice(0, 24).map((entry) => deckKey(entry.deck));
    const overlap = frontierOverlap(frontierKeys, previousFrontierKeys);
    const best = Number(evaluated[0]?.mean) || 0;
    const improvement = previousBest === null ? null : best - previousBest;
    const convergedThisRound = round >= minRounds
      && overlap >= 0.65
      && improvement !== null
      && Math.abs(improvement) <= 0.015;
    stableRounds = convergedThisRound ? stableRounds + 1 : 0;

    roundSummaries.push({
      round,
      candidateCount: evaluated.length,
      generatedPool: generatedPool.length,
      mutationPool: mutations.length,
      bestMean: rounded(evaluated[0]?.mean),
      bestLower: rounded(evaluated[0]?.lower),
      bestCost: totalCost(evaluated[0]?.deck),
      frontierOverlap: rounded(overlap),
      bestImprovement: improvement === null ? null : rounded(improvement),
      stableRounds,
      topDecks: evaluated.slice(0, 10).map((entry) => ({
        ids: entry.deck.map(characterId),
        names: entry.deck.map((character) => character.name),
        totalCost: totalCost(entry.deck),
        mean: rounded(entry.mean),
        lower: rounded(entry.lower),
        source: entry.source ?? "unknown",
      })),
    });

    roundsCompleted = round;
    console.log(JSON.stringify({
      attributeKey,
      round,
      bestMean: rounded(best),
      bestCost: totalCost(evaluated[0]?.deck),
      frontierOverlap: rounded(overlap),
      bestImprovement: improvement === null ? null : rounded(improvement),
      stableRounds,
    }));

    previousFrontierKeys = frontierKeys;
    previousBest = best;
    if (round >= minRounds && stableRounds >= 2) {
      console.log(`Independent Cost200 ${attributeKey} converged after ${round} rounds.`);
      break;
    }
  }

  const archived = [...archive.values()].sort((left, right) => (
    entryScore(right) - entryScore(left)
    || deckKey(left.deck).localeCompare(deckKey(right.deck))
  ));
  const finalCandidates = chooseDiverseDecks(
    archived,
    Math.min(420, archived.length),
    baseConstraint.totalCost,
    true,
  );
  const finalScenarios = makeScenarios(environment, Math.max(30, scenarioCount));
  const finalDecks = evaluateEntries(finalCandidates, finalScenarios, turns, "final")
    .slice(0, 64);
  const slotRankings = rankBlindSlots(finalDecks);

  const output = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    test: "cost200-independent-zero-start-multiround",
    blindGuarantee: {
      generationInputCost: null,
      requestedCost: 200,
      usesCost100Report: false,
      usesCost100Environment: false,
      usesCost100Rankings: false,
      usesCost100CompletedDecks: false,
      usesCost200Report: false,
      usesCost200EnvironmentInput: false,
      usesCost200CompletedDecks: false,
      source: "Character catalog + Cost200 legality only; broad zero-start probes followed by iterative self-play and measured one-slot deep search.",
    },
    attributeKey,
    constraint: {
      allowedAttributes: baseConstraint.allowedAttributes,
      totalCost: 200,
      turns,
      probeScenarioCount,
      scenarioCount,
      minRounds,
      maxRounds,
      roundsCompleted,
      candidateLimit,
      beamWidth,
      slotLimit,
      catalogCharacters: CHARACTER_CATALOG.length,
      eligibleBySlot: eligibleByPosition.map((pool) => pool.length),
      broadSeedDecks: broad.entries.length,
      broadAnchorCoverage: broad.coverage,
    },
    roundSummaries,
    finalEnvironment: finalDecks.map((entry, index) => ({
      rank: index + 1,
      ids: entry.deck.map(characterId),
      names: entry.deck.map((character) => character.name),
      roles: entry.deck.map(roleFromCharacter),
      totalCost: totalCost(entry.deck),
      expectedWinRate: rounded(entry.mean),
      expectedWinLowerBound: rounded(entry.lower),
      metaScore: rounded(entry.metaScore),
      source: entry.source ?? "archive",
    })),
    slotRankings: slotRankings.map((entries) => entries.slice(0, 50)),
  };

  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    attributeKey,
    broadSeedDecks: broad.entries.length,
    roundsCompleted,
    bestDeck: output.finalEnvironment[0],
    topSlotIds: output.slotRankings.map((entries) => entries.slice(0, 5).map((entry) => entry.id)),
  }, null, 2));
}

await main();
