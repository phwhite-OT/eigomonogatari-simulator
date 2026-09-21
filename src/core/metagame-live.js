import { createBattleState } from "./battleState.js";
import { simulateBattleSummary } from "./simulate.js";
import { DEFAULT_ENVIRONMENT_BATTLE_PROFILES } from "./environment-rating.js";
import { DEFAULT_RULES } from "../data/rules.js";
import {
  applyMetagameStatBoost,
  metagameBattleScenarios,
  metagameDeckIsLegal,
  metagameFixedSlots,
  metagameV8PrecomputedResults,
  matchesMetagamePositionConstraint,
  normalizeMetagameBoostedCharacterIds,
  resolveMetagameConstraint,
} from "./metagame-deck.js";

const LIVE_BASE_LIMIT = 384;
const LIVE_ANCHORS_PER_POSITION = 8;
const LIVE_FIRST_STAGE_LIMIT = 72;
const LIVE_SECOND_STAGE_LIMIT = 18;
const LIVE_FINAL_STAGE_LIMIT = 6;
const LIVE_COMBINATION_DEPTH = 3;
const LIVE_COMBINATION_IDS = 16;
const LIVE_ANALOG_COUNT = 6;

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (Number(value) - mean) ** 2, 0) / (values.length - 1));
}

function meanLowerBound(values) {
  if (!values.length) return 0;
  const mean = average(values);
  if (values.length === 1) return clampUnit(mean);
  return clampUnit(mean - 1.96 * standardDeviation(values) / Math.sqrt(values.length));
}

function projectedWinValue(result) {
  if (result.outcome === "allies") return 1;
  if (result.outcome === "draw") return 0.5;
  if (result.outcome === "enemies") return 0;
  const initialEnemyCount = Math.max(1, result.initial.enemies.remainingCharacters);
  const initialAllyCount = Math.max(1, result.initial.allies.remainingCharacters);
  const enemyProgress = result.metrics.enemyLosses / initialEnemyCount;
  const allyProgress = result.metrics.allyLosses / initialAllyCount;
  const allyHp = result.final.allies.totalHp > 0
    ? result.final.allies.remainingHp / result.final.allies.totalHp
    : 0;
  const enemyHp = result.final.enemies.totalHp > 0
    ? result.final.enemies.remainingHp / result.final.enemies.totalHp
    : 0;
  return clampUnit(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function characterKey(character) {
  return String(character?.id ?? "");
}

function deckKey(deck) {
  return (deck ?? []).map(characterKey).join("|");
}

function totalCost(deck) {
  return (deck ?? []).reduce((sum, character) => sum + Math.max(0, Number(character?.cost) || 0), 0);
}

function baseQuality(entry) {
  return (
    (Number(entry?.expectedWinLowerBound ?? entry?.l) || 0) * 0.72 +
    (Number(entry?.expectedWinRate ?? entry?.w) || 0) * 0.28
  );
}

function compareCandidates(left, right) {
  return (
    (Number(right.expectedWinLowerBound) || 0) - (Number(left.expectedWinLowerBound) || 0) ||
    (Number(right.expectedWinRate) || 0) - (Number(left.expectedWinRate) || 0) ||
    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0) ||
    deckKey(left.deck).localeCompare(deckKey(right.deck))
  );
}

function compareProxy(left, right) {
  return (
    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||
    (Number(right.expectedWinLowerBound) || 0) - (Number(left.expectedWinLowerBound) || 0) ||
    (Number(right.expectedWinRate) || 0) - (Number(left.expectedWinRate) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0) ||
    deckKey(left.deck).localeCompare(deckKey(right.deck))
  );
}

function resolveAvailableIds(characters, options) {
  const configured = options.availableCharacterIds;
  if (configured === undefined || configured === null) return null;
  const values = configured instanceof Set ? [...configured] : configured;
  const ids = new Set((Array.isArray(values) ? values : [values]).map(String));
  for (const [, value] of metagameFixedSlots(options.fixedSlots)) ids.add(String(value));
  return ids;
}

function characterFingerprintPayload(character) {
  return [
    characterKey(character),
    Number(character?.cost) || 0,
    Number(character?.hp) || 0,
    Number(character?.pow) || 0,
    Number(character?.skillTurn) || 0,
    String(character?.rarity ?? ""),
    (character?.attributes ?? []).map(String).sort().join(","),
    (character?.allowedPositions ?? []).map(Number).sort((a, b) => a - b).join(","),
    String(character?.skill?.type ?? "none"),
    String(character?.skill?.target ?? "self"),
    Number(character?.skill?.multiplier) || 0,
    Number(character?.skill?.hits) || 0,
    Number(character?.skill?.amount) || 0,
    Number(character?.skill?.duration) || 0,
    JSON.stringify(character?.skill?.conditions ?? []),
    JSON.stringify(character?.skill?.effects ?? []),
  ].join("~");
}

export function metagameLiveCharacterFingerprint(character) {
  let hash = 2_166_136_261;
  for (const symbol of characterFingerprintPayload(character)) {
    hash = Math.imul(hash ^ symbol.charCodeAt(0), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function metagameLiveQueryFingerprint(constraint, characters, liveIds, options = {}) {
  const byId = new Map((characters ?? []).map((character) => [characterKey(character), character]));
  const fixed = [...metagameFixedSlots(options.fixedSlots).entries()]
    .map(([position, id]) => `${position}:${id}`)
    .sort()
    .join(",");
  const boosted = [...normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds)].sort().join(",");
  const live = [...liveIds].sort().map((id) => {
    const character = byId.get(String(id));
    return `${id}:${metagameLiveCharacterFingerprint(character)}`;
  }).join(",");
  const available = options.availableCharacterIds
    ? [...new Set([...options.availableCharacterIds].map(String))].sort().join(",")
    : "*";
  return [
    String(constraint?.id ?? ""),
    Number(options.totalCost ?? constraint?.totalCost) || 0,
    String(options.costMode ?? "at_most"),
    fixed,
    boosted,
    live,
    available,
  ].join("||");
}

function hydrateKnowledgeDeckLibrary(knowledge, charactersById, availableIds, constraint, fixedSlots) {
  if (!Array.isArray(knowledge?.deckLibrary) || !Array.isArray(knowledge?.characterIds)) return [];
  const idsByIndex = knowledge.characterIds.map(String);
  const topQuality = [];
  const cheapestTotal = [];
  const cheapestByPosition = Array.from({ length: 5 }, () => []);

  const retainCheapest = (list, entry, score, limit) => {
    list.push({ entry, score });
    list.sort((left, right) => left.score - right.score || compareProxy(left.entry, right.entry));
    if (list.length > limit) list.length = limit;
  };

  for (const raw of knowledge.deckLibrary) {
    if (!Array.isArray(raw?.i) || raw.i.length !== 5) continue;
    const ids = raw.i.map((value) => {
      const numeric = Number(value);
      return Number.isInteger(numeric) && numeric >= 0 && numeric < idsByIndex.length
        ? idsByIndex[numeric]
        : String(value);
    });
    if (availableIds && ids.some((id) => !availableIds.has(String(id)))) continue;
    const deck = ids.map((id) => charactersById.get(String(id)));
    if (deck.some((character) => !character)) continue;
    if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) continue;
    const entry = {
      deck,
      totalCost: Number(raw.c) || totalCost(deck),
      expectedWinRate: Number(raw.w) || 0,
      expectedWinLowerBound: Number(raw.l) || 0,
      decisiveWinRate: Number(raw.a) || 0,
      proxyScore: baseQuality(raw),
      origin: "browser-knowledge",
      liveCharacterIds: [],
    };
    if (topQuality.length < 192) topQuality.push(entry);
    retainCheapest(cheapestTotal, entry, entry.totalCost, 48);
    for (let position = 0; position < 5; position += 1) {
      retainCheapest(
        cheapestByPosition[position],
        entry,
        Number(deck[position]?.cost) || 0,
        32,
      );
    }
  }

  const selected = new Map();
  const add = (entry) => selected.set(deckKey(entry.deck), entry);
  topQuality.forEach(add);
  cheapestTotal.forEach(({ entry }) => add(entry));
  cheapestByPosition.flat().forEach(({ entry }) => add(entry));
  return [...selected.values()].sort(compareProxy).slice(0, LIVE_BASE_LIMIT);
}

function hydratePublishedBases(constraint, characters, availableIds, fixedSlots) {
  const entries = metagameV8PrecomputedResults(constraint, characters, fixedSlots);
  return entries
    .filter((entry) => !availableIds || entry.deck.every((character) => availableIds.has(characterKey(character))))
    .slice(0, LIVE_BASE_LIMIT)
    .map((entry) => ({
      ...entry,
      totalCost: Number(entry.totalCost) || totalCost(entry.deck),
      proxyScore: baseQuality(entry),
      origin: "published-v12",
      liveCharacterIds: [],
    }));
}

function candidatePriorsByPosition(knowledge) {
  const result = Array.from({ length: 5 }, () => []);
  for (const prior of knowledge?.candidatePriors ?? []) {
    const position = Number(prior?.p);
    if (position < 1 || position > 5) continue;
    result[position - 1].push(prior);
  }
  return result;
}

function roleFromSkill(character) {
  const type = String(character?.skill?.type ?? "none");
  if (type === "single_attack") return "precision_attack";
  if (["aoe_attack", "multi_hit_attack"].includes(type)) return "sweep_attack";
  if (["damage_reduction", "guard", "attribute_guard"].includes(type)) return "defense";
  if (type === "revive") return "revive";
  if (type === "heal") return "recovery";
  if (["attack_buff", "attribute_change", "delay", "skill_reduction"].includes(type)) return "support";
  return "neutral";
}

function analogDistance(character, prior, priorCharacter, budget) {
  const skillType = String(character?.skill?.type ?? "none");
  const target = String(character?.skill?.target ?? "self");
  const priorType = String(prior?.y ?? priorCharacter?.skill?.type ?? "none");
  const priorTarget = String(priorCharacter?.skill?.target ?? "self");
  const role = roleFromSkill(character);
  const priorRole = String(prior?.k ?? roleFromSkill(priorCharacter));
  const turnDelta = Math.abs((Number(character?.skillTurn) || 0) - (Number(prior?.t ?? priorCharacter?.skillTurn) || 0));
  const costDelta = Math.abs((Number(character?.cost) || 0) - (Number(prior?.c ?? priorCharacter?.cost) || 0)) / Math.max(1, budget);
  const hpRatio = Math.abs(Math.log((Math.max(1, Number(character?.hp) || 1)) / Math.max(1, Number(priorCharacter?.hp) || 1)));
  const powRatio = Math.abs(Math.log((Math.max(1, Number(character?.pow) || 1)) / Math.max(1, Number(priorCharacter?.pow) || 1)));
  const attributes = new Set((character?.attributes ?? []).map(String));
  const priorAttributes = (priorCharacter?.attributes ?? []).map(String);
  const attributeMismatch = priorAttributes.some((attribute) => attributes.has(attribute)) ? 0 : 1;
  return (
    (skillType === priorType ? 0 : 2.4) +
    (target === priorTarget ? 0 : 0.35) +
    (role === priorRole ? 0 : 0.8) +
    turnDelta * 0.22 +
    costDelta * 2.2 +
    Math.min(1.5, hpRatio) * 0.25 +
    Math.min(1.5, powRatio) * 0.35 +
    attributeMismatch * 0.7
  );
}

function liveAnalogs(character, position, knowledgePriors, charactersById, liveIds, budget) {
  return (knowledgePriors[position - 1] ?? [])
    .filter((prior) => !liveIds.has(String(prior?.i)))
    .map((prior) => {
      const priorCharacter = charactersById.get(String(prior?.i));
      if (!priorCharacter) return null;
      const distance = analogDistance(character, prior, priorCharacter, budget);
      return { prior, priorCharacter, distance, weight: 1 / (0.25 + distance) };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance || String(left.prior.i).localeCompare(String(right.prior.i)))
    .slice(0, LIVE_ANALOG_COUNT);
}

function transferredPriorScore(analogs) {
  if (!analogs.length) return 0.5;
  const totalWeight = analogs.reduce((sum, entry) => sum + entry.weight, 0);
  const weighted = analogs.reduce((sum, entry) => {
    const score = Number(entry.prior?.s);
    const robust = Number(entry.prior?.r);
    const normalizedRobust = Number.isFinite(robust) ? clampUnit(0.5 + robust * 2.5) : 0.5;
    // s/r are budget-aware individual priors: removing the analogous card
    // re-optimizes all five slots and can re-spend its freed cost anywhere.
    // This keeps individual evidence important without rewarding a card merely
    // for dominating four teammates made weak by its own huge cost.
    const priorScore = Number.isFinite(score)
      ? clampUnit(score * 0.72 + normalizedRobust * 0.28)
      : normalizedRobust;
    return sum + priorScore * entry.weight;
  }, 0);
  return totalWeight > 0 ? weighted / totalWeight : 0.5;
}

function buildPairPriorMap(knowledge) {
  const map = new Map();
  for (const entry of knowledge?.pairPriors ?? []) {
    const key = `${Number(entry.a)}:${String(entry.i)}|${Number(entry.b)}:${String(entry.j)}`;
    map.set(key, Number(entry.d) || 0);
  }
  return map;
}

function transferredPairScore(analogs, position, deck, pairPriors) {
  if (!analogs.length || !pairPriors.size) return 0;
  let total = 0;
  let weight = 0;
  for (const analog of analogs) {
    for (let teammateIndex = 0; teammateIndex < deck.length; teammateIndex += 1) {
      if (teammateIndex === position - 1) continue;
      const teammatePosition = teammateIndex + 1;
      const teammateId = characterKey(deck[teammateIndex]);
      const analogId = String(analog.prior.i);
      const key = position < teammatePosition
        ? `${position}:${analogId}|${teammatePosition}:${teammateId}`
        : `${teammatePosition}:${teammateId}|${position}:${analogId}`;
      if (!pairPriors.has(key)) continue;
      total += pairPriors.get(key) * analog.weight;
      weight += analog.weight;
    }
  }
  return weight > 0 ? total / weight : 0;
}

function syntheticLiveRating(character, position, analogs) {
  const prior = transferredPriorScore(analogs);
  return {
    id: characterKey(character),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
    skillTarget: character.skill?.target ?? "self",
    role: roleFromSkill(character),
    evaluationStatus: "live-incremental",
    costAwareScore: prior,
    practicalValue: prior,
    individualScore: prior,
    roleFit: 0,
    livePosition: position,
  };
}

function publishedRatingsByPosition(constraint) {
  return (constraint?.slots ?? []).map((slot) => new Map(
    (slot?.candidates ?? []).map((entry) => [String(entry.id), entry]),
  ));
}

function ratingForCharacter(character, position, publishedRatings, liveRatings) {
  return publishedRatings[position - 1]?.get(characterKey(character))
    ?? liveRatings.get(`${position}:${characterKey(character)}`)
    ?? syntheticLiveRating(character, position, []);
}

function makeCandidate(deck, proxyScore, origin, liveCharacterIds, publishedRatings, liveRatings) {
  return {
    deck,
    ratings: deck.map((character, index) => ratingForCharacter(
      character,
      index + 1,
      publishedRatings,
      liveRatings,
    )),
    totalCost: totalCost(deck),
    proxyScore,
    synergyScore: 0,
    handoffRisk: 0,
    origin,
    liveCharacterIds: [...new Set(liveCharacterIds.map(String))],
  };
}

function addUniqueCandidate(map, candidate) {
  const key = deckKey(candidate.deck);
  const current = map.get(key);
  if (!current || compareProxy(candidate, current) < 0) map.set(key, candidate);
}

function buildIncrementalCandidates(constraint, charactersById, liveIds, fixedSlots, availableIds, knowledge, baseCandidates) {
  const priors = candidatePriorsByPosition(knowledge);
  const pairPriors = buildPairPriorMap(knowledge);
  const publishedRatings = publishedRatingsByPosition(constraint);
  const liveRatings = new Map();
  const budget = Math.max(1, Number(constraint.totalCost) || 1);
  const liveCharacters = [...liveIds]
    .map((id) => charactersById.get(String(id)))
    .filter(Boolean)
    .filter((character) => !availableIds || availableIds.has(characterKey(character)));
  const analogCache = new Map();
  const analogsFor = (character, position) => {
    const key = `${position}:${characterKey(character)}`;
    if (!analogCache.has(key)) {
      const analogs = liveAnalogs(character, position, priors, charactersById, liveIds, budget);
      analogCache.set(key, analogs);
      liveRatings.set(key, syntheticLiveRating(character, position, analogs));
    }
    return analogCache.get(key);
  };

  const all = new Map();
  const preparedBases = baseCandidates.flatMap((base) => {
    const deck = [...base.deck];
    for (const [position, fixedId] of fixedSlots) {
      if (!liveIds.has(String(fixedId))) continue;
      const character = charactersById.get(String(fixedId));
      if (!character) return [];
      deck[position - 1] = character;
    }
    if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) return [];
    if (availableIds && deck.some((entry) => !availableIds.has(characterKey(entry)))) return [];
    return [{
      ...base,
      deck,
      totalCost: totalCost(deck),
      proxyScore: Number(base.proxyScore) || baseQuality(base),
      liveCharacterIds: deck.filter((entry) => liveIds.has(characterKey(entry))).map(characterKey),
    }];
  });
  const legalBaseControls = preparedBases.slice(0, 24);
  for (const base of legalBaseControls) {
    addUniqueCandidate(all, makeCandidate(
      base.deck,
      base.proxyScore,
      "published-control",
      base.deck.filter((character) => liveIds.has(characterKey(character))).map(characterKey),
      publishedRatings,
      liveRatings,
    ));
  }

  const bestProxyByLiveId = new Map();
  for (const character of liveCharacters) {
    const id = characterKey(character);
    for (let position = 1; position <= 5; position += 1) {
      if (!matchesMetagamePositionConstraint(character, constraint, position)) continue;
      if (fixedSlots.has(position) && String(fixedSlots.get(position)) !== id) continue;
      const analogs = analogsFor(character, position);
      const priorScore = transferredPriorScore(analogs);
      const anchors = [];
      for (const base of preparedBases) {
        const deck = [...base.deck];
        const existingIndex = deck.findIndex((entry) => characterKey(entry) === id);
        if (existingIndex >= 0 && existingIndex !== position - 1) continue;
        deck[position - 1] = character;
        if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) continue;
        if (availableIds && deck.some((entry) => !availableIds.has(characterKey(entry)))) continue;
        const pairScore = transferredPairScore(analogs, position, deck, pairPriors);
        const budgetHeadroom = Math.max(0, Number(constraint.totalCost) - totalCost(deck)) / budget;
        const proxyScore = baseQuality(base) + (priorScore - 0.5) * 0.18 + pairScore * 0.7 + budgetHeadroom * 0.01;
        anchors.push({ deck, proxyScore, base });
      }
      anchors.sort((left, right) => right.proxyScore - left.proxyScore || deckKey(left.deck).localeCompare(deckKey(right.deck)));
      for (const anchor of anchors.slice(0, LIVE_ANCHORS_PER_POSITION)) {
        const liveCharacterIds = anchor.deck.filter((entry) => liveIds.has(characterKey(entry))).map(characterKey);
        const candidate = makeCandidate(
          anchor.deck,
          anchor.proxyScore,
          "live-single",
          liveCharacterIds,
          publishedRatings,
          liveRatings,
        );
        addUniqueCandidate(all, candidate);
        const current = bestProxyByLiveId.get(id);
        if (!current || candidate.proxyScore > current.proxyScore) bestProxyByLiveId.set(id, candidate);
      }
    }
  }

  const promisingIds = [...bestProxyByLiveId.entries()]
    .sort((left, right) => right[1].proxyScore - left[1].proxyScore || left[0].localeCompare(right[0]))
    .slice(0, LIVE_COMBINATION_IDS)
    .map(([id]) => id);
  for (const [, fixedId] of fixedSlots) {
    if (liveIds.has(String(fixedId)) && !promisingIds.includes(String(fixedId))) promisingIds.push(String(fixedId));
  }

  let frontier = [...all.values()]
    .filter((entry) => entry.liveCharacterIds.length >= 1)
    .sort(compareProxy)
    .slice(0, 96);
  for (let depth = 2; depth <= LIVE_COMBINATION_DEPTH && promisingIds.length > 1; depth += 1) {
    const next = new Map();
    for (const seed of frontier.slice(0, 72)) {
      const used = new Set(seed.liveCharacterIds.map(String));
      for (const id of promisingIds) {
        if (used.has(String(id))) continue;
        const character = charactersById.get(String(id));
        if (!character) continue;
        for (let position = 1; position <= 5; position += 1) {
          if (!matchesMetagamePositionConstraint(character, constraint, position)) continue;
          if (fixedSlots.has(position) && String(fixedSlots.get(position)) !== String(id)) continue;
          const replaced = seed.deck[position - 1];
          if (liveIds.has(characterKey(replaced))) continue;
          if (seed.deck.some((entry, index) => index !== position - 1 && characterKey(entry) === String(id))) continue;
          const deck = [...seed.deck];
          deck[position - 1] = character;
          if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) continue;
          if (availableIds && deck.some((entry) => !availableIds.has(characterKey(entry)))) continue;
          const analogs = analogsFor(character, position);
          const priorScore = transferredPriorScore(analogs);
          const pairScore = transferredPairScore(analogs, position, deck, pairPriors);
          const proxyScore = seed.proxyScore + (priorScore - 0.5) * 0.10 + pairScore * 0.55;
          const candidate = makeCandidate(
            deck,
            proxyScore,
            `live-combination-${depth}`,
            [...used, String(id)],
            publishedRatings,
            liveRatings,
          );
          addUniqueCandidate(next, candidate);
        }
      }
    }
    if (!next.size) break;
    frontier = [...next.values()].sort(compareProxy).slice(0, 96);
    for (const candidate of frontier) addUniqueCandidate(all, candidate);
  }

  const selected = new Map();
  for (const candidate of [...all.values()].sort(compareProxy).slice(0, LIVE_FIRST_STAGE_LIMIT)) {
    selected.set(deckKey(candidate.deck), candidate);
  }
  for (const [id, candidate] of bestProxyByLiveId) {
    if (selected.size >= Math.max(LIVE_FIRST_STAGE_LIMIT, liveCharacters.length + 24)) break;
    if (candidate && !selected.has(deckKey(candidate.deck))) selected.set(deckKey(candidate.deck), candidate);
    if (!id) continue;
  }
  return [...selected.values()].sort(compareProxy);
}

function selectLiveEnvironmentDecks(evaluated, liveIds, limit = 8) {
  const selected = new Map();
  const add = (entry) => {
    if (!entry?.deck?.length || Number(entry.expectedWinRate) < 0.5) return;
    const key = deckKey(entry.deck);
    if (!selected.has(key)) {
      selected.set(key, {
        id: `live-incremental:${key}`,
        ids: entry.deck.map(characterKey),
        expectedWinRate: Number(entry.expectedWinRate) || 0,
        expectedWinLowerBound: Number(entry.expectedWinLowerBound) || 0,
      });
    }
  };
  for (const id of liveIds) {
    const representative = evaluated.find((entry) => (
      entry.deck.some((character) => characterKey(character) === String(id))
      && Number(entry.expectedWinRate) >= 0.5
    ));
    if (representative) add(representative);
  }
  for (const entry of evaluated) {
    if (selected.size >= limit) break;
    if (!entry.liveCharacterIds?.length) continue;
    add(entry);
  }
  return [...selected.values()]
    .sort((left, right) => (
      right.expectedWinLowerBound - left.expectedWinLowerBound
      || right.expectedWinRate - left.expectedWinRate
      || left.id.localeCompare(right.id)
    ))
    .slice(0, limit);
}

function evenlySpacedScenarioIndexes(total, count) {
  if (count >= total) return Array.from({ length: total }, (_, index) => index);
  return Array.from({ length: count }, (_, index) => (
    Math.min(total - 1, Math.floor((index + 0.5) * total / count))
  ));
}

function representativeIndexes(knowledge, total, count) {
  const raw = knowledge?.representativeScenarios?.[String(count)]?.indices
    ?? knowledge?.representativeScenarios?.[count]?.indices;
  const valid = Array.isArray(raw)
    ? [...new Set(raw.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < total))]
    : [];
  return valid.length >= Math.min(count, total)
    ? valid.slice(0, Math.min(count, total))
    : evenlySpacedScenarioIndexes(total, Math.min(count, total));
}

async function evaluateCandidate(candidate, scenarios, indices, constraint, rules, onScenario) {
  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (const selectedIndex of indices) {
    const scenario = scenarios[selectedIndex];
    if (!scenario) continue;
    const scenarioIndex = Number.isInteger(Number(scenario.scenarioIndex))
      ? Number(scenario.scenarioIndex)
      : selectedIndex;
    const actorIndex = scenarioIndex % 5;
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(actorIndex, 0, candidate.deck);
    const profile = DEFAULT_ENVIRONMENT_BATTLE_PROFILES[
      scenarioIndex % DEFAULT_ENVIRONMENT_BATTLE_PROFILES.length
    ];
    const result = simulateBattleSummary(
      createBattleState(allyDecks, scenario.enemyDecks),
      rules,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
        playStyle: profile.playStyle,
        randomSeed: scenarioIndex,
      },
    );
    values.push(projectedWinValue(result));
    outcomes[result.outcome] += 1;
    onScenario?.();
  }
  const divisor = Math.max(1, values.length);
  return {
    ...candidate,
    expectedWinRate: average(values),
    expectedWinLowerBound: meanLowerBound(values),
    scenarioCount: values.length,
    decisiveWinRate: outcomes.allies / divisor,
    decisiveDrawRate: outcomes.draw / divisor,
    decisiveLossRate: outcomes.enemies / divisor,
    ongoingRate: outcomes.ongoing / divisor,
    scenarioValues: values,
  };
}

function retainLiveCoverage(entries, liveIds, limit) {
  const selected = new Map();
  for (const entry of entries.slice(0, Math.min(limit, entries.length))) {
    selected.set(deckKey(entry.deck), entry);
  }
  for (const id of liveIds) {
    const representative = entries.find((entry) => (
      entry.deck.some((character) => characterKey(character) === String(id))
    ));
    if (representative) selected.set(deckKey(representative.deck), representative);
  }
  return [...selected.values()].sort(compareCandidates);
}

async function evaluateStage(candidates, scenarios, indices, constraint, rules, options, stage, totalStages) {
  let completed = 0;
  const total = candidates.length * indices.length;
  options.onProgress?.({
    phase: "simulation",
    liveStage: stage,
    liveStages: totalStages,
    completed: 0,
    total,
    deck: 1,
    decks: candidates.length,
    scenarios: indices.length,
  });
  const evaluated = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (options.signal?.aborted) {
      const error = new Error("デッキシミュレーションを中止しました。");
      error.name = "AbortError";
      throw error;
    }
    evaluated.push(await evaluateCandidate(
      candidates[index],
      scenarios,
      indices,
      constraint,
      options.rules ?? DEFAULT_RULES,
      () => {
        completed += 1;
        options.onProgress?.({
          phase: "simulation",
          liveStage: stage,
          liveStages: totalStages,
          completed,
          total,
          deck: index + 1,
          decks: candidates.length,
          scenarios: indices.length,
        });
      },
    ));
    if ((index + 1) % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return evaluated.sort(compareCandidates);
}

export function hasMetagameLiveCharacters(characters, automaticCharacterIds) {
  const ids = normalizeMetagameBoostedCharacterIds(automaticCharacterIds);
  if (!ids.size) return false;
  const charactersById = new Map((characters ?? []).map((character) => [characterKey(character), character]));
  return [...ids].some((id) => charactersById.has(String(id)));
}

export async function findBestMetagameDeckIncrementalLive(
  data,
  constraintId,
  characters,
  options = {},
) {
  const requestedTotalCost = Number(options.totalCost);
  const constraint = {
    ...resolveMetagameConstraint(data, constraintId, requestedTotalCost),
    costMode: options.costMode === "exact" ? "exact" : "at_most",
  };
  const liveIds = normalizeMetagameBoostedCharacterIds(options.automaticCharacterIds);
  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const fixedSlots = metagameFixedSlots(options.fixedSlots);
  const availableIds = resolveAvailableIds(characters, options);
  const rawCharactersById = new Map((characters ?? []).map((character) => [characterKey(character), character]));
  const charactersById = new Map((characters ?? []).map((character) => [
    characterKey(character),
    applyMetagameStatBoost(character, boostedIds),
  ]));
  const activeLiveIds = new Set([...liveIds].filter((id) => charactersById.has(String(id))));
  const knowledge = options.browserKnowledge ?? null;

  const baseFixedSlots = new Map(
    [...fixedSlots.entries()].filter(([, id]) => !activeLiveIds.has(String(id))),
  );
  let bases = hydrateKnowledgeDeckLibrary(
    knowledge,
    charactersById,
    availableIds,
    constraint,
    baseFixedSlots,
  );
  if (!bases.length) {
    bases = hydratePublishedBases(
      constraint,
      [...charactersById.values()],
      availableIds,
      baseFixedSlots,
    );
  }
  if (!bases.length) {
    throw new Error("現在の所持キャラ・固定条件では、増分評価の土台にできる計算済みデッキがありません。");
  }

  options.onProgress?.({
    phase: "candidate",
    completed: 0,
    total: 5,
    slot: 1,
    slots: 5,
    checked: 0,
    stageTotal: bases.length,
    retained: bases.length,
  });
  const candidates = buildIncrementalCandidates(
    constraint,
    charactersById,
    activeLiveIds,
    fixedSlots,
    availableIds,
    knowledge,
    bases,
  );
  if (!candidates.length) {
    throw new Error("追加・編集キャラを含め、現在の条件を満たす候補デッキを構成できませんでした。");
  }
  options.onProgress?.({
    phase: "candidate",
    completed: 5,
    total: 5,
    slot: 5,
    slots: 5,
    checked: candidates.length,
    stageTotal: candidates.length,
    retained: candidates.length,
    valid: candidates.length,
  });

  const baseScenarioSet = metagameBattleScenarios(
    constraint,
    charactersById,
    boostedIds,
    {
      environmentCharacterIds: [],
      includeLiveFallback: false,
      maxAdditionalEnvironmentDecks: 0,
      maxPrecomputedEnvironmentDecks: options.maxPrecomputedEnvironmentDecks,
    },
  );
  const baseScenarios = baseScenarioSet.scenarios;
  if (!baseScenarios.length) throw new Error("増分評価に使える5対5環境シナリオがありません。");

  const firstIndexes = representativeIndexes(knowledge, baseScenarios.length, 12);
  const first = await evaluateStage(
    candidates,
    baseScenarios,
    firstIndexes,
    constraint,
    options.rules ?? DEFAULT_RULES,
    options,
    1,
    3,
  );

  // A genuinely strong new character should also enter the opponent metagame.
  // Use only battle-proven live decks from stage 1, then replay the narrower
  // stage-2 and full stage-3 evaluations against the updated environment.
  const liveEnvironmentDecks = selectLiveEnvironmentDecks(
    first,
    activeLiveIds,
    Math.max(1, Math.min(8, activeLiveIds.size * 2)),
  );
  const scenarioSet = liveEnvironmentDecks.length
    ? metagameBattleScenarios(
        constraint,
        charactersById,
        boostedIds,
        {
          environmentCharacterIds: [],
          includeLiveFallback: false,
          maxAdditionalEnvironmentDecks: liveEnvironmentDecks.length,
          maxPrecomputedEnvironmentDecks: options.maxPrecomputedEnvironmentDecks,
          liveEnvironmentDecks,
        },
      )
    : baseScenarioSet;
  const scenarios = scenarioSet.scenarios;
  const secondIndexes = representativeIndexes(knowledge, scenarios.length, 24);
  const finalIndexes = Array.from({ length: scenarios.length }, (_, index) => index);

  const secondCandidates = retainLiveCoverage(
    first,
    activeLiveIds,
    LIVE_SECOND_STAGE_LIMIT,
  );
  const second = await evaluateStage(
    secondCandidates,
    scenarios,
    secondIndexes,
    constraint,
    options.rules ?? DEFAULT_RULES,
    options,
    2,
    3,
  );
  const finalCandidates = retainLiveCoverage(
    second,
    activeLiveIds,
    LIVE_FINAL_STAGE_LIMIT,
  );
  const final = await evaluateStage(
    finalCandidates,
    scenarios,
    finalIndexes,
    constraint,
    options.rules ?? DEFAULT_RULES,
    options,
    3,
    3,
  );

  return {
    constraint,
    generatedAt: data.generatedAt,
    candidateDeckCount: candidates.length,
    simulatedDeckCount: candidates.length + second.length + final.length,
    scenarioCount: scenarios.length,
    screenedScenarioCounts: [firstIndexes.length, secondIndexes.length, finalIndexes.length],
    excludedScenarioCount: scenarioSet.excludedScenarioCount,
    boostedCharacterIds: [...boostedIds],
    automaticCharacterIds: [...activeLiveIds],
    automaticEnvironmentCharacterIds: [...activeLiveIds],
    automaticEnvironmentDecks: scenarioSet.liveEnvironmentDecks,
    liveCharacterIds: [...activeLiveIds],
    environmentCharacterIds: scenarioSet.environmentCharacterIds,
    environmentCombatants: scenarioSet.environmentCombatants,
    environmentMix: {
      baselineScenarioCount: scenarioSet.baselineScenarioCount,
      precomputedTopDeckCount: scenarioSet.precomputedTopDeckCount,
      liveEnvironmentDeckCount: scenarioSet.liveEnvironmentDeckCount,
    },
    usedIncrementalLiveEvaluation: true,
    cachePolicy: "v12-live-incremental-v1",
    browserKnowledgeSchemaVersion: knowledge?.schemaVersion ?? null,
    browserKnowledgeGeneratedAt: knowledge?.generatedAt ?? null,
    results: final.slice(0, 3).map((entry) => ({
      ...entry,
      boostedCharacterIds: [...boostedIds],
      automaticCharacterIds: [...activeLiveIds],
      automaticEnvironmentCharacterIds: [...activeLiveIds],
      automaticEnvironmentDecks: scenarioSet.liveEnvironmentDecks,
      liveCharacterIds: [...activeLiveIds],
      environmentCharacterIds: scenarioSet.environmentCharacterIds,
      environmentCombatants: scenarioSet.environmentCombatants,
      environmentMix: {
        baselineScenarioCount: scenarioSet.baselineScenarioCount,
        precomputedTopDeckCount: scenarioSet.precomputedTopDeckCount,
        liveEnvironmentDeckCount: scenarioSet.liveEnvironmentDeckCount,
      },
      usedIncrementalLiveEvaluation: true,
      cachePolicy: "v12-live-incremental-v1",
      browserKnowledgeSchemaVersion: knowledge?.schemaVersion ?? null,
    })),
    rawCharacterCount: rawCharactersById.size,
  };
}
