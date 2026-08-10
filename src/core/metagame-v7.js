import { calculateMinimumDamage } from "./damage.js";
import { estimateSkillPotency } from "./character-rating.js";
import { isSkillTurnAllowedAtPosition } from "./filter.js";
import { buildMetagameDeckCandidates } from "./metagame-deck.js";
import {
  ATTACK_ORDER_POLICIES,
  PLAY_STYLES,
  simulateBattle,
  TARGET_POLICIES,
} from "./simulate.js";
import { createBattleState } from "./battleState.js";
import { DEFAULT_RULES } from "../data/rules.js";

export const METAGAME_V7_MODEL_VERSION = "fixed-environment-v7.3";

const V7_BATTLE_PROFILES = Object.freeze([
  Object.freeze({
    id: "stock-balance",
    targetPolicy: TARGET_POLICIES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  }),
  Object.freeze({
    id: "skill-intercept",
    targetPolicy: TARGET_POLICIES.SKILL_THREAT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
    playStyle: PLAY_STYLES.EXPERT,
  }),
  Object.freeze({
    id: "priority-finish",
    targetPolicy: TARGET_POLICIES.KILL_CONFIRM,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
    playStyle: PLAY_STYLES.EXPERT,
  }),
]);

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function rounded(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function katakanaToHiragana(value) {
  return value.replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
}

function compactName(value) {
  return katakanaToHiragana(String(value ?? "").normalize("NFKC").toLowerCase())
    .replace(/[\s\-ー_、，,／/・+＋|｜!?！？☆★.．。・「」『』【】\[\]()（）]/g, "");
}

function nameVariants(value) {
  const raw = String(value ?? "").normalize("NFKC");
  const withoutAnnotations = raw.replace(/[（(][^）)]*[）)]/g, "");
  const withoutReading = withoutAnnotations.replace(/[ァ-ヶー]+$/u, "");
  return [...new Set([raw, withoutAnnotations, withoutReading].map(compactName).filter(Boolean))];
}

function nameBigrams(value) {
  return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2));
}

function diceSimilarity(left, right) {
  const leftBigrams = nameBigrams(left);
  const rightBigrams = nameBigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return 0;
  const counts = new Map();
  for (const entry of rightBigrams) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  let shared = 0;
  for (const entry of leftBigrams) {
    const count = counts.get(entry) ?? 0;
    if (!count) continue;
    counts.set(entry, count - 1);
    shared += 1;
  }
  return (2 * shared) / (leftBigrams.length + rightBigrams.length);
}

function requestedRarity(value) {
  const match = String(value ?? "").match(/[（(](N|R|CR|ZR|MZR|伝)[）)]/iu);
  return match ? match[1].toUpperCase() : "";
}

function validNameCandidate(character, allowedAttributes, position) {
  return character &&
    !/^\?+$/u.test(String(character.name ?? "")) &&
    (allowedAttributes ?? []).some((attribute) => character.attributes?.includes(attribute)) &&
    (!position || (
      character.allowedPositions?.includes(position) &&
      isSkillTurnAllowedAtPosition(character, position)
    ));
}

function scoreNameMatch(inputName, character) {
  const sourceVariants = nameVariants(inputName);
  const candidate = compactName(character.name);
  if (!candidate) return 0;
  let best = 0;
  for (const source of sourceVariants) {
    if (source === candidate) best = Math.max(best, 1);
    else if (Math.min(source.length, candidate.length) >= 3 && (source.includes(candidate) || candidate.includes(source))) {
      best = Math.max(best, 0.9 + Math.min(source.length, candidate.length) / 1000);
    } else {
      best = Math.max(best, diceSimilarity(source, candidate));
    }
  }
  const rarity = requestedRarity(inputName);
  if (rarity && character.rarity === rarity) best += 0.025;
  return best;
}

/**
 * 略称・読み仮名つきの名前を、火100のような属性縛りを手掛かりに収録キャラへ解決する。
 * 低信頼の照合も記録するので、後から誤対応を追跡・上書きできる。
 */
export function resolveMetagameV7Name(inputName, characters, options = {}) {
  const allowedAttributes = options.allowedAttributes ?? [];
  const position = Number(options.position) || 0;
  const matches = (characters ?? [])
    .filter((character) => validNameCandidate(character, allowedAttributes, position))
    .map((character) => ({ character, score: scoreNameMatch(inputName, character) }))
    .sort((left, right) => (
      right.score - left.score ||
      Number(right.character.cost) - Number(left.character.cost) ||
      String(left.character.id).localeCompare(String(right.character.id))
    ));
  const selected = matches[0];
  const runnerUp = matches[1];
  if (!selected || selected.score < 0.38) {
    return {
      inputName,
      character: null,
      confidence: "unresolved",
      score: selected?.score ?? 0,
      alternatives: matches.slice(0, 3).map(({ character, score }) => ({ id: String(character.id), name: character.name, score: rounded(score, 4) })),
    };
  }
  const difference = selected.score - (runnerUp?.score ?? 0);
  const confidence = selected.score >= 0.98 && difference >= 0.015
    ? "exact"
    : selected.score >= 0.72 && difference >= 0.05
      ? "high"
      : selected.score >= 0.5 && difference >= 0.02
        ? "medium"
        : "low";
  return {
    inputName,
    character: selected.character,
    confidence,
    score: rounded(selected.score, 4),
    alternatives: matches.slice(0, 3).map(({ character, score }) => ({ id: String(character.id), name: character.name, score: rounded(score, 4) })),
  };
}

function resolveDeckNames(names, characters, input, position, enforcePosition = false, options = {}) {
  return names.map((inputName) => {
    const name = input.nameAliases?.[inputName] ?? inputName;
    const allowedAttributes = options.nameAllowedAttributes?.[inputName]
      ?? options.allowedAttributes
      ?? input.allowedAttributes;
    return {
      position,
      ...resolveMetagameV7Name(name, characters, {
        allowedAttributes,
        position: enforcePosition ? position : 0,
      }),
      inputName,
    };
  });
}

function isDeckWithinRules(deck, input) {
  if (deck.length !== 5 || deck.some((character) => !character)) return false;
  if (deck.reduce((sum, character) => sum + (Number(character.cost) || 0), 0) > input.totalCost) return false;
  if (new Set(deck.map((character) => String(character.id))).size !== deck.length) return false;
  return deck.filter((character) => character.rarity === "伝").length <= 1;
}

function isExamplePatternWithinRules(pattern, input) {
  const specified = pattern.filter(Boolean);
  if (!specified.length) return false;
  if (specified.reduce((sum, character) => sum + (Number(character.cost) || 0), 0) > input.totalCost) return false;
  if (new Set(specified.map((character) => String(character.id))).size !== specified.length) return false;
  return specified.filter((character) => character.rarity === "伝").length <= 1;
}

function normalizedExamplePatterns(input) {
  const completeDecks = input.exampleDeckNames ?? [];
  const partialDecks = input.exampleDeckPatterns ?? [];
  return [...completeDecks, ...partialDecks].map((pattern) => (
    [0, 1, 2, 3, 4].map((index) => String(pattern?.[index] ?? "").trim() || null)
  ));
}

/** Resolve the user-provided environment pools and deck examples without hand-entering IDs. */
export function resolveMetagameV7Input(input, characters) {
  const environmentMatches = input.environmentNamesByPosition.map((names, index) => (
    resolveDeckNames(names, characters, input, index + 1, false, {
      nameAllowedAttributes: input.environmentNameAllowedAttributes,
    })
  ));
  const environmentPools = environmentMatches.map((matches, index) => {
    const unresolved = matches.filter((match) => !match.character);
    if (unresolved.length) {
      throw new Error(`${index + 1}枠目の環境キャラを照合できません: ${unresolved.map((match) => match.inputName).join("、")}`);
    }
    return matches.map((match) => match.character);
  });
  const exampleNamePatterns = normalizedExamplePatterns(input);
  const exampleMatches = exampleNamePatterns.map((names) => names.map((name, index) => (
    name ? resolveDeckNames([name], characters, input, index + 1, false)[0] : null
  )));
  const examplePatterns = exampleMatches.map((matches) => matches.map((match) => match?.character ?? null));
  const invalidExamples = examplePatterns
    .map((pattern, index) => ({ pattern, matches: exampleMatches[index], index }))
    .filter(({ pattern, matches }) => (
      matches.some((match) => match && !match.character) ||
      !isExamplePatternWithinRules(pattern, input) ||
      pattern.some((character, index) => character && (
        !character.allowedPositions?.includes(index + 1) || !isSkillTurnAllowedAtPosition(character, index + 1)
      ))
    ));
  const validExamplePatterns = examplePatterns.filter((_, index) => !invalidExamples.some((entry) => entry.index === index));
  const exampleDecks = validExamplePatterns.filter((pattern) => pattern.every(Boolean) && isDeckWithinRules(pattern, input));
  const audit = [
    ...environmentMatches.flat(),
    ...exampleMatches.flat().filter(Boolean),
  ].map((match) => ({
    inputName: match.inputName,
    position: match.position,
    id: match.character ? String(match.character.id) : null,
    name: match.character?.name ?? null,
    confidence: match.confidence,
    score: match.score,
    alternatives: match.alternatives,
  }));
  return {
    ...input,
    environmentPools,
    environmentMatches,
    exampleDecks,
    examplePatterns: validExamplePatterns,
    exampleMatches,
    invalidExamples: invalidExamples.map(({ index }) => index + 1),
    audit,
  };
}

function seededRandom(seed = 1) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampled(values, random) {
  return values[Math.floor(random() * values.length)];
}

function buildAffordableEnvironmentDeck(pools, pivotPosition, pivot, input, random) {
  const deck = Array(5).fill(null);
  deck[pivotPosition] = pivot;
  const positions = [0, 1, 2, 3, 4]
    .filter((position) => position !== pivotPosition)
    .sort((left, right) => pools[left].length - pools[right].length);
  const usedIds = new Set([String(pivot.id)]);
  const initialLegends = pivot.rarity === "LEGEND" ? 1 : 0;

  function minimumRemainingCost(startIndex, legendCount) {
    return positions.slice(startIndex).reduce((sum, position) => {
      const costs = pools[position]
        .filter((character) => !usedIds.has(String(character.id)))
        .filter((character) => legendCount === 0 || character.rarity !== "LEGEND")
        .map((character) => Number(character.cost) || 0);
      return sum + (costs.length ? Math.min(...costs) : Infinity);
    }, 0);
  }

  function visit(index, currentCost, legendCount) {
    if (index === positions.length) return deck;
    const position = positions[index];
    const ordered = pools[position]
      .map((character) => ({ character, priority: (Number(character.cost) || 0) + random() * 14 }))
      .sort((left, right) => left.priority - right.priority)
      .map(({ character }) => character);
    for (const character of ordered) {
      const id = String(character.id);
      const nextLegendCount = legendCount + (character.rarity === "LEGEND" ? 1 : 0);
      const nextCost = currentCost + (Number(character.cost) || 0);
      if (usedIds.has(id) || nextLegendCount > 1 || nextCost > input.totalCost) continue;
      usedIds.add(id);
      deck[position] = character;
      if (nextCost + minimumRemainingCost(index + 1, nextLegendCount) <= input.totalCost) {
        const completed = visit(index + 1, nextCost, nextLegendCount);
        if (completed) return completed;
      }
      deck[position] = null;
      usedIds.delete(id);
    }
    return null;
  }

  return visit(0, Number(pivot.cost) || 0, initialLegends);
}

/**
 * Creates only decks composed of the supplied environment pools. Each slot is
 * made the pivot in turn, so no listed character disappears behind random sampling.
 */
export function createMetagameV7EnvironmentDecks(resolvedInput, options = {}) {
  const pools = resolvedInput.environmentPools;
  const requiredPivots = pools.flatMap((pool, position) => (
    pool.map((character) => ({ position, character }))
  ));
  const count = Math.max(5, Number(options.count) || 72, requiredPivots.length);
  const random = seededRandom(options.seed ?? 7107);
  const decks = [];
  for (let scenarioIndex = 0; scenarioIndex < count; scenarioIndex += 1) {
    const scheduledPivot = requiredPivots[scenarioIndex];
    const pivotPosition = scheduledPivot?.position ?? scenarioIndex % 5;
    const pivotPool = pools[pivotPosition];
    const pivot = scheduledPivot?.character ?? pivotPool[Math.floor(scenarioIndex / 5) % pivotPool.length];
    let deck = null;
    for (let attempt = 0; attempt < 1_000 && !deck; attempt += 1) {
      const trial = pools.map((pool, position) => (
        position === pivotPosition ? pivot : sampled(pool, random)
      ));
      if (isDeckWithinRules(trial, resolvedInput)) deck = trial;
    }
    if (!deck) {
      deck = buildAffordableEnvironmentDeck(pools, pivotPosition, pivot, resolvedInput, random);
    }
    if (!deck) {
      throw new Error(`${pivotPosition + 1}枠目の環境キャラ ${pivot.name} を含むコスト内デッキを作れません。`);
    }
    decks.push(deck);
  }
  return decks;
}

function characterEligibleAtV7Position(character, input, position) {
  return character &&
    Number(character.cost) <= Number(input.totalCost) &&
    input.allowedAttributes.some((attribute) => character.attributes?.includes(attribute)) &&
    character.allowedPositions?.includes(position) &&
    isSkillTurnAllowedAtPosition(character, position);
}

function characterProxyRating(character, position, environmentPool, maxima, rules) {
  const directScores = environmentPool.map((enemy) => {
    const dealt = calculateMinimumDamage({ attacker: character, defender: enemy, rules }).value;
    const taken = calculateMinimumDamage({ attacker: enemy, defender: character, rules }).value;
    return {
      offense: clampUnit(dealt / Math.max(1, Number(enemy.hp) || 1)),
      defense: clampUnit(1 - taken / Math.max(1, Number(character.hp) || 1)),
    };
  });
  const offense = average(directScores.map((score) => score.offense));
  const defense = average(directScores.map((score) => score.defense));
  const statPower = clampUnit(Number(character.pow) / maxima.pow);
  const statHp = clampUnit(Number(character.hp) / maxima.hp);
  const skillRaw = estimateSkillPotency(character, environmentPool, position, rules);
  const skill = clampUnit(skillRaw / 4);
  const duration = Math.max(1, Number(character.skill?.duration) || 1);
  const continuation = duration > 1 ? clampUnit((duration - 1) / 4) : 0;
  const practicalValue = clampUnit(
    offense * 0.32 + defense * 0.2 + statPower * 0.18 + statHp * 0.12 + skill * 0.14 + continuation * 0.04,
  );
  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
    skillName: character.skillName ?? "",
    expectedWinRate: practicalValue,
    expectedWinLowerBound: practicalValue,
    balancedContribution: clampUnit((offense + defense) / 2),
    practicalValue,
    practicalSkillReliability: skill > 0 ? 1 : 0,
    powerPreference: statPower,
    enemyPressureRate: offense,
    combinationPotential: continuation,
    continuationWinGain: continuation * skill,
    carriedContinuationWinGain: continuation * skill,
    tacticalUpside: skill,
    tacticalRisk: 0,
    allyRetentionRate: defense,
    carriedDefenseRate: continuation * defense,
    advantageCreation: ["damage_reduction", "guard", "attribute_guard", "heal", "revive"].includes(character.skill?.type)
      ? skill : 0,
    counteraction: ["single_attack", "aoe_attack", "attack_buff", "multi_hit_attack"].includes(character.skill?.type)
      ? skill : 0,
    skillActivationRate: skill > 0 ? 1 : 0,
    v7Proxy: { offense, defense, skill, continuation, practicalValue },
  };
}

/**
 * Full candidate coverage is retained; the limited pools here are used only to
 * find affordable partners for a fixed target, never to decide who is rated.
 */
export function buildMetagameV7CandidatePools(resolvedInput, characters, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const partnerLimit = Math.max(8, Number(options.partnerLimit) || 24);
  const allByPosition = [1, 2, 3, 4, 5].map((position) => (
    characters.filter((character) => characterEligibleAtV7Position(character, resolvedInput, position))
  ));
  const maxima = {
    hp: Math.max(1, ...allByPosition.flat().map((character) => Number(character.hp) || 0)),
    pow: Math.max(1, ...allByPosition.flat().map((character) => Number(character.pow) || 0)),
  };
  const ratingsByPosition = allByPosition.map((pool, index) => new Map(pool.map((character) => [
    String(character.id),
    characterProxyRating(character, index + 1, resolvedInput.environmentPools[index], maxima, rules),
  ])));
  const exampleIdsByPosition = [0, 1, 2, 3, 4].map((index) => new Set(
    resolvedInput.examplePatterns.map((deck) => deck[index]).filter(Boolean).map((character) => String(character.id)),
  ));
  const partnerRatingsByPosition = ratingsByPosition.map((ratings, index) => {
    const listed = [...ratings.values()].sort((left, right) => (
      right.practicalValue - left.practicalValue ||
      left.cost - right.cost ||
      left.id.localeCompare(right.id)
    ));
    const exampleRatings = [...exampleIdsByPosition[index]].map((id) => ratings.get(id)).filter(Boolean);
    const remainingLimit = Math.max(1, partnerLimit - exampleRatings.length);
    const strengthLimit = Math.max(1, Math.ceil(remainingLimit * 0.6));
    const costLimit = Math.max(1, remainingLimit - strengthLimit);
    const affordableLimit = Math.max(8, Math.ceil(partnerLimit * 0.5));
    const selected = new Map();
    listed.slice(0, strengthLimit).forEach((rating) => selected.set(rating.id, rating));
    listed.sort((left, right) => (
      (right.practicalValue - right.cost / Math.max(1, resolvedInput.totalCost) * 0.24) -
        (left.practicalValue - left.cost / Math.max(1, resolvedInput.totalCost) * 0.24) ||
      left.cost - right.cost
    )).slice(0, costLimit).forEach((rating) => selected.set(rating.id, rating));
    listed.sort((left, right) => (
      left.cost - right.cost ||
      right.practicalValue - left.practicalValue ||
      left.id.localeCompare(right.id)
    )).slice(0, affordableLimit).forEach((rating) => selected.set(rating.id, rating));
    exampleRatings.forEach((rating) => selected.set(rating.id, rating));
    return [...selected.values()];
  });
  return {
    allByPosition,
    ratingsByPosition,
    partnerRatingsByPosition,
    charactersById: new Map(characters.map((character) => [String(character.id), character])),
  };
}

function v7DeckKey(deck) {
  return deck.map((character) => String(character.id)).join("|");
}

function isV7DeckInfeasibility(error) {
  return error instanceof Error && error.message.includes("総コスト内の5体を構成できませんでした");
}

function buildV7AutomaticDecks(constraint, character, position, candidatePools, options, fixedRatingsByPosition = []) {
  const characters = [...candidatePools.charactersById.values()];
  const build = (candidateConstraint) => buildMetagameDeckCandidates(candidateConstraint, characters, {
    beamWidth: options.beamWidth ?? 500,
  });
  try {
    return build(constraint);
  } catch (error) {
    if (!isV7DeckInfeasibility(error)) throw error;
  }

  const fallbackPartnerLimit = Math.max(32, Number(options.fallbackPartnerLimit) || 48);
  const targetRating = candidatePools.ratingsByPosition[position - 1].get(String(character.id));
  const fallbackConstraint = {
    ...constraint,
    slots: candidatePools.ratingsByPosition.map((ratings, index) => ({
      position: index + 1,
      candidates: fixedRatingsByPosition[index]
        ? [fixedRatingsByPosition[index]]
        : index + 1 === position
        ? [targetRating]
        : [...ratings.values()].sort((left, right) => (
          left.cost - right.cost || right.practicalValue - left.practicalValue || left.id.localeCompare(right.id)
        )).slice(0, fallbackPartnerLimit),
    })),
  };
  try {
    return build(fallbackConstraint);
  } catch (error) {
    if (!isV7DeckInfeasibility(error)) throw error;
    return [];
  }
}

function v7ExampleDecksFor(character, position, resolvedInput, candidatePools, options) {
  const targetRating = candidatePools.ratingsByPosition[position - 1].get(String(character.id));
  if (!targetRating) return [];
  const exampleDeckLimit = Math.max(1, Number(options.exampleDeckLimit) || 1);
  return resolvedInput.examplePatterns
    .filter((pattern) => String(pattern[position - 1]?.id) === String(character.id))
    .flatMap((pattern) => {
      const fixedRatings = pattern.map((entry, index) => (
        entry ? candidatePools.ratingsByPosition[index].get(String(entry.id)) ?? null : null
      ));
      if (fixedRatings.some((rating, index) => pattern[index] && !rating)) return [];
      const constraint = {
        totalCost: resolvedInput.totalCost,
        allowedAttributes: resolvedInput.allowedAttributes,
        slots: candidatePools.partnerRatingsByPosition.map((ratings, index) => ({
          position: index + 1,
          candidates: fixedRatings[index]
            ? [fixedRatings[index]]
            : index + 1 === position ? [targetRating] : ratings,
        })),
      };
      return buildV7AutomaticDecks(constraint, character, position, candidatePools, options, fixedRatings)
        .slice(0, exampleDeckLimit)
        .map((entry) => ({
          deck: entry.deck,
          origin: "example",
          proxyScore: entry.proxyScore,
          synergyScore: entry.synergyScore,
        }));
    });
}

export function buildMetagameV7DeckCandidates(character, position, resolvedInput, candidatePools, options = {}) {
  const targetRating = candidatePools.ratingsByPosition[position - 1].get(String(character.id));
  if (!targetRating) return [];
  const constraint = {
    totalCost: resolvedInput.totalCost,
    allowedAttributes: resolvedInput.allowedAttributes,
    slots: candidatePools.partnerRatingsByPosition.map((ratings, index) => ({
      position: index + 1,
      candidates: index + 1 === position ? [targetRating] : ratings,
    })),
  };
  const automatic = buildV7AutomaticDecks(constraint, character, position, candidatePools, options)
    .slice(0, Math.max(1, Number(options.autoDeckLimit) || 10)).map((entry) => ({
    deck: entry.deck,
    origin: "automatic",
    proxyScore: entry.proxyScore,
    synergyScore: entry.synergyScore,
  }));
  const examples = v7ExampleDecksFor(character, position, resolvedInput, candidatePools, options);
  const unique = new Map();
  for (const entry of [...automatic, ...examples]) {
    const key = v7DeckKey(entry.deck);
    const current = unique.get(key);
    if (!current || entry.origin === "example") unique.set(key, entry);
  }
  return [...unique.values()];
}

function projectedWinValue(result) {
  if (result.outcome === "allies") return 1;
  if (result.outcome === "draw") return 0.5;
  if (result.outcome === "enemies") return 0;
  const initialEnemyCount = Math.max(1, result.initial.enemies.remainingCharacters);
  const initialAllyCount = Math.max(1, result.initial.allies.remainingCharacters);
  const enemyProgress = result.metrics.enemyLosses / initialEnemyCount;
  const allyProgress = result.metrics.allyLosses / initialAllyCount;
  const allyHp = result.final.allies.totalHp > 0 ? result.final.allies.remainingHp / result.final.allies.totalHp : 0;
  const enemyHp = result.final.enemies.totalHp > 0 ? result.final.enemies.remainingHp / result.final.enemies.totalHp : 0;
  return clampUnit(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function meanLowerBound(values) {
  if (!values.length) return 0;
  const mean = average(values);
  if (values.length === 1) return mean;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return clampUnit(mean - 1.96 * Math.sqrt(variance / values.length));
}

/** Evaluates a completed user deck directly against the supplied fixed environment decks. */
export function evaluateMetagameV7Deck(deck, environmentDecks, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (let index = 0; index < environmentDecks.length; index += 1) {
    const profile = V7_BATTLE_PROFILES[index % V7_BATTLE_PROFILES.length];
    const result = simulateBattle(createBattleState([deck], [environmentDecks[index]]), rules, {
      turns,
      targetPolicy: profile.targetPolicy,
      attackOrderPolicy: profile.attackOrderPolicy,
      playStyle: profile.playStyle,
    });
    values.push(projectedWinValue(result));
    outcomes[result.outcome] += 1;
  }
  const total = Math.max(1, values.length);
  return {
    expectedWinRate: average(values),
    expectedWinLowerBound: meanLowerBound(values),
    scenarioCount: values.length,
    decisiveWinRate: outcomes.allies / total,
    decisiveDrawRate: outcomes.draw / total,
    decisiveLossRate: outcomes.enemies / total,
    ongoingRate: outcomes.ongoing / total,
  };
}

export function rateMetagameV7Character(character, position, resolvedInput, candidatePools, environmentDecks, options = {}) {
  const deckCandidates = buildMetagameV7DeckCandidates(character, position, resolvedInput, candidatePools, options);
  const evaluatedDecks = deckCandidates.map((candidate) => ({
    ...candidate,
    totalCost: candidate.deck.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0),
    result: evaluateMetagameV7Deck(candidate.deck, environmentDecks, options),
  })).sort((left, right) => (
    right.result.expectedWinLowerBound - left.result.expectedWinLowerBound ||
    right.result.expectedWinRate - left.result.expectedWinRate ||
    left.totalCost - right.totalCost ||
    (right.origin === "example") - (left.origin === "example")
  ));
  const best = evaluatedDecks[0];
  if (!best) {
    return {
      id: String(character.id),
      name: character.name,
      attributes: character.attributes,
      rarity: character.rarity,
      cost: character.cost,
      hp: character.hp,
      pow: character.pow,
      skillTurn: character.skillTurn,
      skillType: character.skill?.type ?? "none",
      skillName: character.skillName ?? "",
      position,
      evaluatedDeckCount: 0,
      infeasible: true,
      bestDeck: {
        origin: "infeasible",
        totalCost: resolvedInput.totalCost + 1,
        remainingCost: 0,
        ids: [],
        names: [],
        proxyScore: 0,
        synergyScore: 0,
        expectedWinRate: 0,
        expectedWinLowerBound: 0,
        scenarioCount: 0,
        decisiveWinRate: 0,
        decisiveDrawRate: 0,
        decisiveLossRate: 0,
        ongoingRate: 0,
      },
      exampleDeck: null,
      v7Score: 0,
    };
  }
  const example = evaluatedDecks.find((entry) => entry.origin === "example");
  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    hp: character.hp,
    pow: character.pow,
    skillTurn: character.skillTurn,
    skillType: character.skill?.type ?? "none",
    skillName: character.skillName ?? "",
    position,
    evaluatedDeckCount: evaluatedDecks.length,
    bestDeck: {
      origin: best.origin,
      totalCost: best.totalCost,
      remainingCost: Math.max(0, resolvedInput.totalCost - best.totalCost),
      ids: best.deck.map((entry) => String(entry.id)),
      names: best.deck.map((entry) => entry.name),
      proxyScore: rounded(best.proxyScore ?? 0),
      synergyScore: rounded(best.synergyScore ?? 0),
      ...Object.fromEntries(Object.entries(best.result).map(([key, value]) => [key, typeof value === "number" ? rounded(value) : value])),
    },
    exampleDeck: example ? {
      totalCost: example.totalCost,
      ids: example.deck.map((entry) => String(entry.id)),
      names: example.deck.map((entry) => entry.name),
      ...Object.fromEntries(Object.entries(example.result).map(([key, value]) => [key, typeof value === "number" ? rounded(value) : value])),
    } : null,
    // コストは単体で割らず、残り4枠を含む完成デッキの下限勝率で評価する。
    v7Score: rounded(best.result.expectedWinLowerBound),
  };
}

export function rankMetagameV7Characters(ratings) {
  const ranked = [...ratings].sort((left, right) => (
    right.v7Score - left.v7Score ||
    right.bestDeck.expectedWinRate - left.bestDeck.expectedWinRate ||
    left.bestDeck.totalCost - right.bestDeck.totalCost ||
    left.cost - right.cost ||
    left.id.localeCompare(right.id)
  ));
  return ranked.map((rating, index) => ({ ...rating, rank: index + 1 }));
}
