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

// This replaces the invalid one-deck-versus-one-deck V7.5 evaluator.  The
// input sheet still describes the five positions within one player's deck,
// but a match is always simulated as five player decks versus five player
// decks (25 characters per team including reserves).
// Combat resolution changed for attack-skill timing and guarded area attacks.
// Keep prior reports visible as historical data, but never mix them into this
// corrected evaluation pass.
// V11 deliberately separates a character's own battle contribution from the
// result of the four allies that happened to be paired with it, prices that
// measured contribution against the constrained deck budget, and verifies
// that its actual skill both fires and changes the five-versus-five outcome.
// Any report made with an earlier model must therefore be treated as
// incompatible input.
export const METAGAME_V8_MODEL_VERSION = "team-battle-v11-skill-execution";
// Keep the export name while the surrounding command and input filenames are
// migrated.  Consumers must use the model version, never the filename, to
// decide whether a report is compatible.
export const METAGAME_V7_MODEL_VERSION = METAGAME_V8_MODEL_VERSION;

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

// A 20-point win-rate swing is already decisive evidence for one slot in a
// multi-player battle.  The transformation is deliberately capped: a very
// expensive card can still be excellent, but it must provide materially more
// proven value than a cheap alternative instead of winning by raw delta alone.
const MARGINAL_CONTRIBUTION_REFERENCE = 0.2;

function marginalContributionScore(value) {
  return clampUnit(Math.max(0, Number(value) || 0) / MARGINAL_CONTRIBUTION_REFERENCE);
}

function marginalCostEfficiencyScore(value, cost, totalCost) {
  const contribution = Math.max(0, Number(value) || 0);
  const budget = Math.max(1, Number(totalCost) || 1);
  const price = Math.max(1, Number(cost) || 1);
  // Soft saturation preserves the ordering of very efficient cheap cards
  // without allowing a tiny result on a cost-1 card to become an automatic 1.
  return clampUnit(1 - Math.exp(-1.1 * contribution * budget / price));
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
  const invalidEnvironmentMatches = environmentMatches.flatMap((matches, index) => matches.filter((match) => (
    match.character && (
      !match.character.allowedPositions?.includes(index + 1) ||
      !isSkillTurnAllowedAtPosition(match.character, index + 1)
    )
  )));
  const environmentPools = environmentMatches.map((matches, index) => {
    const unresolved = matches.filter((match) => !match.character);
    if (unresolved.length) {
      throw new Error(`${index + 1}枠目の環境キャラを照合できません: ${unresolved.map((match) => match.inputName).join("、")}`);
    }
    const usable = matches
      .filter((match) => (
        match.character.allowedPositions?.includes(index + 1) &&
        isSkillTurnAllowedAtPosition(match.character, index + 1)
      ))
      .map((match) => match.character);
    if (!usable.length) {
      throw new Error(`${index + 1}枠目の環境キャラがスキルターン制限を満たしません。`);
    }
    return usable;
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
    usableAsEnvironment: match.character
      ? match.character.allowedPositions?.includes(match.position) && isSkillTurnAllowedAtPosition(match.character, match.position)
      : false,
  }));
  return {
    ...input,
    environmentPools,
    environmentMatches,
    exampleDecks,
    examplePatterns: validExamplePatterns,
    exampleMatches,
    invalidExamples: invalidExamples.map(({ index }) => index + 1),
    invalidEnvironmentCandidates: invalidEnvironmentMatches.map((match) => ({
      position: match.position,
      inputName: match.inputName,
      id: String(match.character.id),
      name: match.character.name,
      skillTurn: match.character.skillTurn,
    })),
    audit,
  };
}

function environmentStrengths(pools) {
  // The first V11 pass establishes full-team evidence. Do not decide that a
  // supplied opponent is common or strong from HP, power, or a hand-written
  // skill proxy before that battle evidence exists. Every supplied pivot is
  // represented; later browser samples weight only measured complete decks.
  return new Map(pools.flatMap((pool) => pool.map((character) => [String(character.id), 0])));
}

function buildStrongEnvironmentDeck(pools, fixedByPosition, input, strengths, variant = 0, usageCounts = new Map()) {
  const deck = Array(5).fill(null);
  for (const [position, character] of fixedByPosition.entries()) deck[position] = character;
  const positions = [0, 1, 2, 3, 4]
    .filter((position) => !deck[position])
    .sort((left, right) => pools[left].length - pools[right].length);
  const fixedCharacters = deck.filter(Boolean);
  const usedIds = new Set(fixedCharacters.map((character) => String(character.id)));
  const initialCost = fixedCharacters.reduce((sum, character) => sum + (Number(character.cost) || 0), 0);
  const initialLegends = fixedCharacters.filter((character) => character.rarity === "LEGEND").length;
  if (initialCost > input.totalCost || initialLegends > 1 || usedIds.size !== fixedCharacters.length) return null;

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
    const orderedByStrength = pools[position]
      .map((character, poolIndex) => ({
        character,
        strength: strengths.get(String(character.id)) ?? 0,
        priorUses: usageCounts.get(String(character.id)) ?? 0,
        poolIndex,
      }))
      .sort((left, right) => (
        (right.strength - Math.min(0.3, right.priorUses * 0.025)) -
          (left.strength - Math.min(0.3, left.priorUses * 0.025)) ||
        left.character.cost - right.character.cost ||
        String(left.character.id).localeCompare(String(right.character.id))
      ));
    // Do not assume an attack/defense archetype or an adoption rate.  Each
    // supplied pivot gets several legal partner combinations by rotating the
    // strongest feasible portion of every other supplied slot.  This keeps
    // every listed character equally represented while avoiding one fixed
    // set of high-proxy fillers in every environment deck.
    const rotation = orderedByStrength.length
      ? (variant * (position + 3)) % orderedByStrength.length
      : 0;
    const ordered = rotation
      ? [...orderedByStrength.slice(rotation), ...orderedByStrength.slice(0, rotation)]
      : orderedByStrength;
    for (const character of ordered) {
      const id = String(character.character.id);
      const nextLegendCount = legendCount + (character.character.rarity === "LEGEND" ? 1 : 0);
      const nextCost = currentCost + (Number(character.character.cost) || 0);
      if (usedIds.has(id) || nextLegendCount > 1 || nextCost > input.totalCost) continue;
      usedIds.add(id);
      deck[position] = character.character;
      if (nextCost + minimumRemainingCost(index + 1, nextLegendCount) <= input.totalCost) {
        const completed = visit(index + 1, nextCost, nextLegendCount);
        if (completed) return completed;
      }
      deck[position] = null;
      usedIds.delete(id);
    }
    return null;
  }

  return visit(0, initialCost, initialLegends);
}

/**
 * Creates only decks composed of the supplied environment pools. Each slot is
 * made the pivot in turn, so no listed character disappears behind random sampling.
 */
export function createMetagameV7EnvironmentDecks(resolvedInput, options = {}) {
  const pools = resolvedInput.environmentPools;
  const strengths = environmentStrengths(pools);
  const requiredPivots = pools.flatMap((pool, position) => (
    pool.map((character) => ({ position, character }))
  ));
  const variants = Math.max(1, Math.floor(Number(options.environmentVariants) || 1));
  const count = Math.max(5, Number(options.count) || 72, requiredPivots.length * variants);
  const exampleFixedSlots = resolvedInput.examplePatterns.map((pattern) => (
    new Map(pattern.map((character, position) => character ? [position, character] : null).filter(Boolean))
  ));
  const fixedScenarios = [
    ...exampleFixedSlots.map((fixedByPosition) => ({ fixedByPosition, variant: 0 })),
    ...Array.from({ length: count }, (_, scenarioIndex) => {
      const pivot = requiredPivots[scenarioIndex % requiredPivots.length];
      return {
        fixedByPosition: new Map([[pivot.position, pivot.character]]),
        variant: Math.floor(scenarioIndex / requiredPivots.length),
      };
    }),
  ];
  const decks = [];
  const usageCounts = new Map();
  for (let scenarioIndex = 0; scenarioIndex < fixedScenarios.length; scenarioIndex += 1) {
    const { fixedByPosition, variant } = fixedScenarios[scenarioIndex];
    const scheduledPivot = requiredPivots[(Math.max(0, scenarioIndex - exampleFixedSlots.length)) % requiredPivots.length];
    const pivotPosition = scheduledPivot.position;
    const pivot = fixedByPosition.get(pivotPosition) ?? scheduledPivot.character;
    const deck = buildStrongEnvironmentDeck(pools, fixedByPosition, resolvedInput, strengths, variant, usageCounts);
    if (!deck) {
      // A partial example may itself be under the cap but still leave too
      // little cost to complete its unspecified slots. It is not an
      // environment deck in that case; supplied environment pivots remain
      // mandatory and still fail loudly if they cannot be composed.
      if (scenarioIndex < exampleFixedSlots.length) continue;
      throw new Error(`${pivotPosition + 1}枠目の環境キャラ ${pivot.name} を含むコスト内デッキを作れません。`);
    }
    decks.push(deck);
    deck.forEach((character) => {
      const id = String(character.id);
      usageCounts.set(id, (usageCounts.get(id) ?? 0) + 1);
    });
  }
  return decks;
}

function v8SelectLowOverlapDecks(environmentDecks, orderedIndexes, count = 9) {
  const remaining = [...orderedIndexes];
  const selected = [];
  const characterUses = new Map();
  const take = (choiceIndex) => {
    const [chosenIndex] = remaining.splice(choiceIndex, 1);
    const deck = environmentDecks[chosenIndex];
    selected.push(deck);
    deck.forEach((character) => {
      const id = String(character.id);
      characterUses.set(id, (characterUses.get(id) ?? 0) + 1);
    });
  };
  // The first entry is the scheduled coverage anchor. The remaining eight
  // decks are selected for diversity around it.
  if (remaining.length) take(0);
  while (selected.length < count && remaining.length) {
    const choiceIndex = remaining.reduce((bestIndex, candidateIndex, index) => {
      const overlap = environmentDecks[candidateIndex].reduce((total, character) => (
        total + (characterUses.has(String(character.id)) ? 1 : 0)
      ), 0);
      const repeatedUses = environmentDecks[candidateIndex].reduce((total, character) => (
        total + (characterUses.get(String(character.id)) ?? 0)
      ), 0);
      const best = environmentDecks[remaining[bestIndex]];
      const bestOverlap = best.reduce((total, character) => (
        total + (characterUses.has(String(character.id)) ? 1 : 0)
      ), 0);
      const bestRepeatedUses = best.reduce((total, character) => (
        total + (characterUses.get(String(character.id)) ?? 0)
      ), 0);
      if (overlap !== bestOverlap) return overlap < bestOverlap ? index : bestIndex;
      if (repeatedUses !== bestRepeatedUses) return repeatedUses < bestRepeatedUses ? index : bestIndex;
      return index < bestIndex ? index : bestIndex;
    }, 0);
    take(choiceIndex);
  }
  return selected;
}

/**
 * Build deterministic five-player-versus-five-player match scenarios from the
 * supplied fixed-environment decks.  Four decks form the candidate's allied
 * team; the fifth allied deck is inserted at evaluation time.  Five further
 * decks form the enemy team.  A scenario therefore always starts 5v5, never
 * as the invalid V7.5 one-player-versus-one-player approximation.
 */
export function createMetagameV8TeamScenarios(resolvedInput, options = {}) {
  const environmentDecks = options.environmentDecks ?? createMetagameV7EnvironmentDecks(resolvedInput, options);
  if (environmentDecks.length < 9) {
    throw new Error("5対5環境の作成には、異なる完成デッキが9本以上必要です。");
  }
  const deckCount = environmentDecks.length;
  const minimumCoverageCount = Math.ceil(deckCount / 9);
  const requestedCount = Math.max(minimumCoverageCount, Number(options.count) || deckCount);
  // Make a deterministic permutation so that each nine-deck block is varied,
  // while the first coverage pass still includes every supplied environment
  // deck exactly once.  A stride coprime to the deck count is a permutation.
  let stride = 17;
  const greatestCommonDivisor = (left, right) => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b) [a, b] = [b, a % b];
    return a;
  };
  while (greatestCommonDivisor(stride, deckCount) !== 1) stride += 2;
  const deckOrder = Array.from({ length: deckCount }, (_, index) => (
    (index * stride) % deckCount
  ));
  const scenarios = [];
  for (let scenarioIndex = 0; scenarioIndex < requestedCount; scenarioIndex += 1) {
    const coverageAnchor = scenarioIndex % deckCount;
    const coverageIndexes = Array.from({ length: 9 }, (_, offset) => (
      deckOrder[(scenarioIndex * 9 + offset) % deckCount]
    ));
    const orderedIndexes = [
      coverageAnchor,
      ...Array.from({ length: deckCount - 1 }, (_, offset) => (
        deckOrder[(scenarioIndex * 9 + offset) % deckCount]
      )).filter((index) => index !== coverageAnchor),
    ];
    // The minimum coverage pass preserves every supplied deck. Subsequent
    // scenarios deliberately choose the least-overlapping nine decks so one
    // popular partner does not occupy most players on the same battlefield.
    const decks = requestedCount <= minimumCoverageCount
      ? coverageIndexes.map((index) => environmentDecks[index])
      : v8SelectLowOverlapDecks(environmentDecks, orderedIndexes, 9);
    scenarios.push({
      id: `team-${scenarioIndex + 1}`,
      allyDecks: decks.slice(0, 4),
      enemyDecks: decks.slice(4),
    });
  }
  return scenarios;
}

function characterEligibleAtV7Position(character, input, position) {
  return character &&
    Number(character.cost) <= Number(input.totalCost) &&
    input.allowedAttributes.some((attribute) => character.attributes?.includes(attribute)) &&
    character.allowedPositions?.includes(position) &&
    isSkillTurnAllowedAtPosition(character, position);
}

function attributeConditionCoverage(conditions, type, characters) {
  const relevant = (conditions ?? []).filter((condition) => condition.type === type);
  if (!relevant.length) return 1;
  if (!characters.length) return 0;
  return characters.filter((candidate) => (
    relevant.every((condition) => candidate.attributes?.includes(condition.attribute))
  )).length / characters.length;
}

function allyConditionCoverage(character, skill, allyCandidates) {
  const relevant = (skill?.conditions ?? []).filter((condition) => condition.type === "ally_attribute");
  if (!relevant.length) return 1;
  if (skill?.target === "self") {
    return relevant.every((condition) => character.attributes?.includes(condition.attribute)) ? 1 : 0;
  }
  return attributeConditionCoverage(relevant, "ally_attribute", allyCandidates);
}

function v7CostEfficiency(rating) {
  return (Number(rating.hp) + Number(rating.pow) * 0.75) / Math.max(1, Number(rating.cost));
}

function v8SkillReadiness(character, position) {
  const skillType = character?.skill?.type ?? "none";
  if (["none", "delay", "skill_reduction"].includes(skillType)) return 1;
  const skillTurn = Math.max(0, Number(character?.skillTurn) || 0);
  const expectedTurn = Math.max(0, Number(position) - 1);
  const excessTurns = Math.max(0, skillTurn - expectedTurn);
  if (!excessTurns) return 1;
  // A 2nd-slot 2T skill must survive an additional turn after appearing.
  // The same delay is less severe further back, where charging opportunities
  // are more plentiful. Fifth-slot delays remain legal but decay gradually.
  const perExtraTurn = position <= 1
    ? 0.65
    : position === 2
      ? 0.42
      : position === 3
        ? 0.64
        : position === 4
          ? 0.8
          : 0.9;
  return perExtraTurn ** excessTurns;
}

function v8RoleForCharacter(character) {
  switch (character?.skill?.type) {
    case "single_attack": return "precision_attack";
    case "aoe_attack":
    case "multi_hit_attack": return "sweep_attack";
    case "damage_reduction":
    case "guard":
    case "attribute_guard": return "defense";
    case "revive": return "revive";
    case "heal": return "recovery";
    case "attack_buff":
    case "attribute_change": return "support";
    default: return "neutral";
  }
}

function v8RoleIsAttack(role) {
  return role === "precision_attack" || role === "sweep_attack";
}

function v8DamageRatio(character, enemy, rules, skillMultiplier = 1) {
  const damage = calculateMinimumDamage({ attacker: character, defender: enemy, skillMultiplier, rules }).value;
  return clampUnit(damage / Math.max(1, Number(enemy.hp) || 1));
}

function v8HighDurabilityEnemies(environmentPool) {
  // A single-target finisher is a counter for the genuinely durable part of
  // the field, not a replacement for clearing the whole board.  Restricting
  // this sample to the upper fifth prevents ordinary enemies from making a
  // precision skill look like universal board control.
  const count = Math.max(1, Math.ceil(environmentPool.length * 0.2));
  return [...environmentPool]
    .sort((left, right) => (Number(right.hp) || 0) - (Number(left.hp) || 0))
    .slice(0, count);
}

function v8HardTargetDemand(environmentPool, highDurability) {
  const allAverageHp = average(environmentPool.map((enemy) => Math.max(1, Number(enemy.hp) || 1)));
  const highAverageHp = average(highDurability.map((enemy) => Math.max(1, Number(enemy.hp) || 1)));
  // The demand grows only when the upper HP band is materially harder than
  // the rest of the supplied environment.  This keeps a precision attacker
  // valuable against real walls without granting it a blanket advantage.
  return clampUnit((highAverageHp / Math.max(1, allAverageHp) - 1) / 1.25);
}

function v8RoleFitness(character, environmentPool, rules, { offense, defense, skill, allyCoverage, enemyCoverage }) {
  const role = v8RoleForCharacter(character);
  const skillData = character.skill ?? {};
  const skillMultiplier = Math.max(0, Number(skillData.multiplier) || 0);
  const highDurability = v8HighDurabilityEnemies(environmentPool);
  const hardTargetDemand = v8HardTargetDemand(environmentPool, highDurability);
  const attackShare = average(environmentPool.map((enemy) => (
    v8RoleIsAttack(v8RoleForCharacter(enemy)) ? 1 : 0
  )));
  const nonAttackShare = 1 - attackShare;
  const attackConditionCoverage = clampUnit(allyCoverage * enemyCoverage);
  const perHitCoverage = average(environmentPool.map((enemy) => (
    v8DamageRatio(character, enemy, rules, skillMultiplier)
  )));
  const concentratedCoverage = average(highDurability.map((enemy) => (
    v8DamageRatio(character, enemy, rules, skillMultiplier)
  )));
  const hitCount = Math.max(1, Number(skillData.hits) || 1);
  const multiHitCoverage = average(environmentPool.map((enemy) => (
    v8DamageRatio(character, enemy, rules, skillMultiplier * hitCount)
  )));
  const concentratedMultiHitCoverage = average(highDurability.map((enemy) => (
    v8DamageRatio(character, enemy, rules, skillMultiplier * hitCount)
  )));
  const boardElimination = average(environmentPool.map((enemy) => (
    v8DamageRatio(character, enemy, rules, skillMultiplier) >= 1 ? 1 : 0
  )));

  if (role === "precision_attack") {
    const precisionValue = concentratedCoverage * (0.2 + hardTargetDemand * 0.8);
    return {
      role,
      roleFit: clampUnit(precisionValue * 0.30 + skill * 0.70),
      highDurabilityCoverage: concentratedCoverage,
      boardCoverage: perHitCoverage,
      boardElimination,
      hardTargetDemand,
      defenseMatchup: 0,
      reviveMatchup: 0,
    };
  }
  if (role === "sweep_attack") {
    // AoE evaluates its damage on every target. Multi-hit keeps a lower
    // single-hit score for broad-board flexibility, while retaining a
    // separate concentrated score for the cases where all hits stay put.
    const boardCoverage = skillData.type === "multi_hit_attack"
      ? perHitCoverage * 0.7 + multiHitCoverage * 0.3
      : perHitCoverage;
    // Board attacks gain value from removing several ordinary enemies.  Their
    // value is intentionally capped by actual per-target damage: surplus
    // damage beyond a kill does not become extra score.
    const boardControl = clampUnit(boardCoverage * 0.65 + boardElimination * 0.35);
    return {
      role,
      roleFit: clampUnit(boardControl * 0.30 + skill * 0.70),
      highDurabilityCoverage: skillData.type === "multi_hit_attack" ? concentratedMultiHitCoverage : concentratedCoverage,
      boardCoverage,
      boardElimination,
      hardTargetDemand,
      defenseMatchup: 0,
      reviveMatchup: 0,
    };
  }
  if (role === "defense") {
    const reduction = clampUnit(1 - (Number(skillData.multiplier) || 1));
    // Defense normally wins against non-attack roles.  A high-reduction guard
    // is the exception: it can also absorb an attack-heavy turn, which is the
    // H.F. Woman style of stabilising after a board-clear handoff.
    const exceptionalGuard = skillData.type === "guard" && skillData.target === "self"
      ? reduction * reduction
      : 0;
    const defenseMatchup = clampUnit(
      defense * (0.25 + nonAttackShare * 0.75) + exceptionalGuard * attackShare * 0.4,
    );
    return {
      role,
      roleFit: clampUnit(defense * 0.20 + skill * 0.80),
      highDurabilityCoverage: 0,
      boardCoverage: 0,
      boardElimination: 0,
      hardTargetDemand,
      defenseMatchup,
      reviveMatchup: 0,
    };
  }
  if (role === "revive" || role === "recovery") {
    const reviveMatchup = skill * (0.35 + attackShare * 0.65);
    return {
      role,
      roleFit: reviveMatchup,
      highDurabilityCoverage: 0,
      boardCoverage: 0,
      boardElimination: 0,
      hardTargetDemand,
      defenseMatchup: 0,
      reviveMatchup,
    };
  }
  if (role === "support") {
    // A buff is not a completed win condition on its own.  Its full value is
    // added later only when a reachable successor can actually use it.
    const standaloneSupport = skillData.type === "attack_buff" ? 1 : skillData.target === "ally_all" ? 0.55 : 0.4;
    return {
      role,
      roleFit: skill * standaloneSupport,
      highDurabilityCoverage: 0,
      boardCoverage: 0,
      boardElimination: 0,
      hardTargetDemand,
      defenseMatchup: 0,
      reviveMatchup: 0,
    };
  }
  return {
    role,
    roleFit: (offense + defense) / 2,
    highDurabilityCoverage: 0,
    boardCoverage: 0,
    boardElimination: 0,
    hardTargetDemand,
    defenseMatchup: 0,
    reviveMatchup: 0,
  };
}

const V12_THRESHOLD_ATTACK_TYPES = new Set([
  "single_attack",
  "aoe_attack",
  "multi_hit_attack",
  "attack_buff",
]);
const V12_THRESHOLD_DEFENSE_TYPES = new Set([
  "damage_reduction",
  "guard",
  "attribute_guard",
]);

function v12UniqueCharacters(characters = []) {
  return [...new Map(characters.filter(Boolean).map((entry) => [String(entry.id), entry])).values()];
}

function v12ThresholdConditionApplies(skill, ally, enemy) {
  return (skill?.conditions ?? []).every((condition) => {
    if (condition.type === "ally_attribute") return ally?.attributes?.includes(condition.attribute);
    if (condition.type === "enemy_attribute") return enemy?.attributes?.includes(condition.attribute);
    return true;
  });
}

function v12Median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 1;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function v12WeightedAverage(entries) {
  const weight = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.weight) || 0), 0);
  if (!weight) return 0;
  return entries.reduce((sum, entry) => sum + (Number(entry.value) || 0) * Math.max(0, Number(entry.weight) || 0), 0) / weight;
}

function v12AttackEnvironmentWeights(environmentPool) {
  const medianHp = Math.max(1, v12Median(environmentPool.map((enemy) => Math.max(1, Number(enemy.hp) || 1))));
  return environmentPool.map((enemy) => {
    const hp = Math.max(1, Number(enemy.hp) || 1);
    const hardness = clampUnit((hp / medianHp - 1) / 1.5);
    const wallSkill = V12_THRESHOLD_DEFENSE_TYPES.has(enemy.skill?.type) ? 1 : 0;
    return 1 + hardness * 0.8 + wallSkill * 0.45;
  });
}

function v12DefenseEnvironmentWeights(environmentPool) {
  const medianPower = Math.max(1, v12Median(environmentPool.map((enemy) => Math.max(1, Number(enemy.pow) || 1))));
  return environmentPool.map((enemy) => {
    const power = Math.max(1, Number(enemy.pow) || 1);
    const pressure = clampUnit((power / medianPower - 1) / 1.5);
    const attackSkill = ["single_attack", "aoe_attack", "multi_hit_attack", "attack_buff"].includes(enemy.skill?.type) ? 1 : 0;
    return 1 + pressure * 0.8 + attackSkill * 0.45;
  });
}

function v12ThresholdRecipients(character, skill, allyCandidates) {
  if (skill?.target === "self") return [character];
  const unique = v12UniqueCharacters(allyCandidates);
  if (skill?.target === "leader") {
    const leaders = unique.filter((ally) => ally.allowedPositions?.includes(1));
    return leaders.length ? leaders : [character];
  }
  return unique.length ? unique : [character];
}

function v12SaturatingCount(value, reference = 1) {
  return clampUnit(1 - Math.exp(-Math.max(0, Number(value) || 0) / Math.max(0.01, reference)));
}

export function evaluateMetagameV12SkillThresholdProxy(character, environmentPool, allyCandidates = [], rules = DEFAULT_RULES) {
  const enemies = (environmentPool ?? []).filter(Boolean);
  if (!character || !enemies.length) {
    return {
      baseAttackValue: 0,
      baseDefenseValue: 0,
      attackImpact: 0,
      defenseImpact: 0,
      guaranteedEliminationGain: 0,
      preventedDeathGain: 0,
      wallBreakerImpact: 0,
    };
  }
  const attackWeights = v12AttackEnvironmentWeights(enemies);
  const defenseWeights = v12DefenseEnvironmentWeights(enemies);
  const baseAttackRows = enemies.map((enemy, index) => {
    const hp = Math.max(1, Number(enemy.hp) || 1);
    const damage = calculateMinimumDamage({ attacker: character, defender: enemy, rules }).value;
    return {
      weight: attackWeights[index],
      kill: Number(damage >= hp),
      progress: clampUnit(damage / hp),
    };
  });
  const baseDefenseRows = enemies.map((enemy, index) => {
    const hp = Math.max(1, Number(character.hp) || 1);
    const damage = calculateMinimumDamage({ attacker: enemy, defender: character, rules }).value;
    return {
      weight: defenseWeights[index],
      survive: Number(damage < hp),
      retention: clampUnit(1 - damage / hp),
    };
  });
  const baseAttackValue = clampUnit(
    v12WeightedAverage(baseAttackRows.map((entry) => ({ value: entry.kill, weight: entry.weight }))) * 0.72 +
    v12WeightedAverage(baseAttackRows.map((entry) => ({ value: entry.progress, weight: entry.weight }))) * 0.28,
  );
  const baseDefenseValue = clampUnit(
    v12WeightedAverage(baseDefenseRows.map((entry) => ({ value: entry.survive, weight: entry.weight }))) * 0.72 +
    v12WeightedAverage(baseDefenseRows.map((entry) => ({ value: entry.retention, weight: entry.weight }))) * 0.28,
  );

  const skill = character.skill ?? {};
  let attackImpact = 0;
  let defenseImpact = 0;
  let guaranteedEliminationGain = 0;
  let preventedDeathGain = 0;
  let wallBreakerImpact = 0;

  if (V12_THRESHOLD_ATTACK_TYPES.has(skill.type)) {
    const recipients = skill.type === "attack_buff"
      ? v12ThresholdRecipients(character, skill, allyCandidates)
      : [character];
    const allyScope = skill.type === "attack_buff" && skill.target === "ally_all" ? 5 : 1;
    const hits = Math.max(1, Number(skill.hits) || 1);
    const enemyScope = skill.type === "aoe_attack"
      ? 5
      : skill.type === "multi_hit_attack"
        ? Math.min(5, 1 + (hits - 1) * 0.35)
        : 1;
    const rows = [];
    for (const ally of recipients) {
      for (let index = 0; index < enemies.length; index += 1) {
        const enemy = enemies[index];
        const weight = attackWeights[index];
        const hp = Math.max(1, Number(enemy.hp) || 1);
        const applies = v12ThresholdConditionApplies(skill, ally, enemy);
        const baseline = calculateMinimumDamage({ attacker: ally, defender: enemy, rules }).value;
        let improved = baseline;
        if (applies) {
          if (skill.type === "attack_buff") {
            improved = calculateMinimumDamage({
              attacker: ally,
              defender: enemy,
              attackMultiplier: Number(skill.multiplier) || 1,
              rules,
            }).value;
          } else {
            improved = calculateMinimumDamage({
              attacker: ally,
              defender: enemy,
              skillMultiplier: (Number(skill.multiplier) || 1) * hits,
              rules,
            }).value;
          }
        }
        const newKill = Number(baseline < hp && improved >= hp);
        const progressGain = Math.max(0, clampUnit(improved / hp) - clampUnit(baseline / hp));
        rows.push({ weight, newKill, progressGain });
        if (newKill) {
          wallBreakerImpact = Math.max(wallBreakerImpact, clampUnit((weight - 1) / 0.35));
        }
      }
    }
    const meanKillGain = v12WeightedAverage(rows.map((entry) => ({ value: entry.newKill, weight: entry.weight })));
    const meanProgressGain = v12WeightedAverage(rows.map((entry) => ({ value: entry.progressGain, weight: entry.weight })));
    guaranteedEliminationGain = meanKillGain * allyScope * enemyScope;
    const expectedProgressGain = meanProgressGain * allyScope * enemyScope;
    attackImpact = clampUnit(
      v12SaturatingCount(guaranteedEliminationGain, 0.8) * 0.55 +
      v12SaturatingCount(expectedProgressGain, 1.5) * 0.15 +
      wallBreakerImpact * 0.30,
    );
  }

  if (V12_THRESHOLD_DEFENSE_TYPES.has(skill.type)) {
    const isGuard = ["guard", "attribute_guard"].includes(skill.type);
    const recipients = isGuard
      ? v12UniqueCharacters(allyCandidates)
      : v12ThresholdRecipients(character, skill, allyCandidates);
    const protectedAllies = recipients.length ? recipients : [character];
    const allyScope = isGuard || skill.target === "ally_all" ? 5 : 1;
    let guardCapacity = 1;
    if (isGuard) {
      const guardRows = enemies.map((enemy, index) => {
        const applies = v12ThresholdConditionApplies(skill, character, enemy);
        const damage = applies
          ? calculateMinimumDamage({
            attacker: enemy,
            defender: character,
            defenseMultiplier: Number(skill.multiplier) || 1,
            rules,
          }).value
          : 0;
        return { value: damage, weight: applies ? defenseWeights[index] : 0 };
      });
      const averageGuardDamage = v12WeightedAverage(guardRows);
      guardCapacity = averageGuardDamage > 0
        ? clampUnit((Number(character.hp) || 0) / (averageGuardDamage * 5))
        : 0;
    }
    const rows = [];
    for (const ally of protectedAllies) {
      for (let index = 0; index < enemies.length; index += 1) {
        const enemy = enemies[index];
        const weight = defenseWeights[index];
        const allyHp = Math.max(1, Number(ally.hp) || 1);
        const applies = v12ThresholdConditionApplies(skill, isGuard ? character : ally, enemy);
        const baseline = calculateMinimumDamage({ attacker: enemy, defender: ally, rules }).value;
        let improved = baseline;
        let capacity = 1;
        if (applies) {
          if (isGuard) {
            improved = 0;
            capacity = guardCapacity;
          } else {
            improved = calculateMinimumDamage({
              attacker: enemy,
              defender: ally,
              defenseMultiplier: Number(skill.multiplier) || 1,
              rules,
            }).value;
          }
        }
        const prevented = applies && baseline >= allyHp && improved < allyHp ? capacity : 0;
        const retentionGain = applies
          ? Math.max(0, clampUnit(baseline / allyHp) - clampUnit(improved / allyHp)) * capacity
          : 0;
        rows.push({ weight, prevented, retentionGain });
      }
    }
    const meanPrevented = v12WeightedAverage(rows.map((entry) => ({ value: entry.prevented, weight: entry.weight })));
    const meanRetentionGain = v12WeightedAverage(rows.map((entry) => ({ value: entry.retentionGain, weight: entry.weight })));
    preventedDeathGain = meanPrevented * allyScope;
    const expectedRetentionGain = meanRetentionGain * allyScope;
    defenseImpact = clampUnit(
      v12SaturatingCount(preventedDeathGain, 0.8) * 0.78 +
      v12SaturatingCount(expectedRetentionGain, 1.8) * 0.22,
    );
  }

  return {
    baseAttackValue,
    baseDefenseValue,
    attackImpact,
    defenseImpact,
    guaranteedEliminationGain,
    preventedDeathGain,
    wallBreakerImpact,
  };
}

function characterProxyRating(character, position, environmentPool, maxima, rules, allyCandidates = []) {
  const threshold = evaluateMetagameV12SkillThresholdProxy(character, environmentPool, allyCandidates, rules);
  const offense = threshold.baseAttackValue;
  const defense = threshold.baseDefenseValue;
  const allyCoverage = allyConditionCoverage(character, character.skill, allyCandidates);
  const enemyCoverage = attributeConditionCoverage(character.skill?.conditions, "enemy_attribute", environmentPool);
  const skillReadiness = v8SkillReadiness(character, position);
  const fallbackSkillRaw = estimateSkillPotency(character, environmentPool, position, rules) * allyCoverage * enemyCoverage;
  const fallbackSkill = clampUnit(fallbackSkillRaw / 4);
  const skillType = character.skill?.type ?? "none";
  const thresholdSkill = V12_THRESHOLD_ATTACK_TYPES.has(skillType)
    ? threshold.attackImpact
    : V12_THRESHOLD_DEFENSE_TYPES.has(skillType)
      ? threshold.defenseImpact
      : fallbackSkill;
  const skill = clampUnit(thresholdSkill * skillReadiness);
  const duration = Math.max(1, Number(character.skill?.duration) || 1);
  const continuation = duration > 1 ? clampUnit((duration - 1) / 4) : 0;
  const costEfficiency = clampUnit(v7CostEfficiency(character) / Math.max(1, maxima.costEfficiency));
  const roleProfile = v8RoleFitness(character, environmentPool, rules, {
    offense,
    defense,
    skill,
    allyCoverage,
    enemyCoverage,
  });
  const frontline = clampUnit(offense * 0.40 + defense * 0.36 + skill * 0.16 + costEfficiency * 0.08);
  const practicalValue = position === 1
    ? frontline
    : clampUnit(roleProfile.roleFit * 0.50 + skill * 0.24 + costEfficiency * 0.16 + ((offense + defense) / 2) * 0.10);
  return {
    id: String(character.id),
    name: character.name,
    attributes: character.attributes,
    rarity: character.rarity,
    cost: character.cost,
    hp: character.hp,
    pow: character.pow,
    skillTurn: character.skillTurn,
    skillType,
    skillTarget: character.skill?.target ?? "self",
    skillName: character.skillName ?? "",
    role: roleProfile.role,
    individualScore: practicalValue,
    roleFit: roleProfile.roleFit,
    roleBreakdown: {
      frontline,
      highDurabilityCoverage: roleProfile.highDurabilityCoverage,
      boardCoverage: roleProfile.boardCoverage,
      boardElimination: roleProfile.boardElimination,
      hardTargetDemand: roleProfile.hardTargetDemand,
      defenseMatchup: roleProfile.defenseMatchup,
      reviveMatchup: roleProfile.reviveMatchup,
      costEfficiency,
      skillReadiness,
      lateSkillRisk: 1 - skillReadiness,
      guaranteedEliminationGain: threshold.guaranteedEliminationGain,
      preventedDeathGain: threshold.preventedDeathGain,
      wallBreakerImpact: threshold.wallBreakerImpact,
      attackThresholdImpact: threshold.attackImpact,
      defenseThresholdImpact: threshold.defenseImpact,
    },
    expectedWinRate: practicalValue,
    expectedWinLowerBound: practicalValue,
    balancedContribution: clampUnit((offense + defense) / 2),
    practicalValue,
    practicalSkillReliability: thresholdSkill > 0 ? skillReadiness : 1,
    powerPreference: offense,
    enemyPressureRate: offense,
    combinationPotential: continuation,
    continuationWinGain: continuation * skill * (roleProfile.role === "support" ? 0.55 : 1),
    carriedContinuationWinGain: continuation * skill * (roleProfile.role === "support" ? 0.55 : 1),
    tacticalUpside: skill,
    tacticalRisk: 1 - skillReadiness,
    allyRetentionRate: defense,
    carriedDefenseRate: continuation * defense,
    advantageCreation: V12_THRESHOLD_DEFENSE_TYPES.has(skillType) ? threshold.defenseImpact : 0,
    counteraction: V12_THRESHOLD_ATTACK_TYPES.has(skillType) ? threshold.attackImpact : 0,
    skillActivationRate: thresholdSkill > 0 ? skillReadiness : 1,
    v7Proxy: {
      offense,
      defense,
      skill,
      continuation,
      allyCoverage,
      enemyCoverage,
      skillReadiness,
      frontline,
      role: roleProfile.role,
      roleFit: roleProfile.roleFit,
      practicalValue,
      guaranteedEliminationGain: threshold.guaranteedEliminationGain,
      preventedDeathGain: threshold.preventedDeathGain,
      wallBreakerImpact: threshold.wallBreakerImpact,
    },
  };
}

/**
 * Full candidate coverage is retained; the limited pools here are used only to
 * find affordable partners for a fixed target, never to decide who is rated.
 */
export function buildMetagameV7CandidatePools(resolvedInput, characters, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  // A narrow partner pool made the advertised "highest win-rate" deck depend
  // on an early proxy cut. Keep a deliberately diverse pool, while retaining
  // a bounded search size for the batch job.
  const partnerLimit = Math.max(32, Number(options.partnerLimit) || 32);
  const allByPosition = [1, 2, 3, 4, 5].map((position) => (
    characters.filter((character) => characterEligibleAtV7Position(character, resolvedInput, position))
  ));
  const maxima = {
    hp: Math.max(1, ...allByPosition.flat().map((character) => Number(character.hp) || 0)),
    pow: Math.max(1, ...allByPosition.flat().map((character) => Number(character.pow) || 0)),
    costEfficiency: Math.max(1, ...allByPosition.flat().map((character) => v7CostEfficiency(character))),
  };
  const allyCandidates = allByPosition.flat();
  const broadEnvironment = resolvedInput.environmentPools.flat();
  const ratingsByPosition = allByPosition.map((pool, index) => new Map(pool.map((character) => [
    String(character.id),
    characterProxyRating(character, index + 1, broadEnvironment, maxima, rules, allyCandidates),
  ])));
  const exampleIdsByPosition = [0, 1, 2, 3, 4].map((index) => new Set(
    resolvedInput.examplePatterns.map((deck) => deck[index]).filter(Boolean).map((character) => String(character.id)),
  ));
  const partnerRatingsByPosition = ratingsByPosition.map((ratings, index) => {
    // These are only *partners used to probe a character*.  Do not put the
    // old HP / power / proxy ranking back into this gate: doing so made a
    // character look good merely because it was tested next to a strong team.
    // Instead, cover the legal cost range and every tactical role evenly.
    const listed = [...ratings.values()].sort((left, right) => (
      left.cost - right.cost ||
      left.skillTurn - right.skillTurn ||
      left.id.localeCompare(right.id)
    ));
    const exampleRatings = [...exampleIdsByPosition[index]].map((id) => ratings.get(id)).filter(Boolean);
    const selected = new Map();
    exampleRatings.forEach((rating) => selected.set(rating.id, rating));
    const capacity = Math.max(0, partnerLimit - selected.size);
    const addEvenly = (entries, count) => {
      const sorted = [...entries].sort((left, right) => (
        left.cost - right.cost ||
        left.skillTurn - right.skillTurn ||
        left.id.localeCompare(right.id)
      ));
      const take = Math.min(sorted.length, Math.max(0, count));
      for (let pick = 0; pick < take && selected.size < partnerLimit; pick += 1) {
        const entry = sorted[Math.min(sorted.length - 1, Math.floor((pick + 0.5) * sorted.length / take))];
        selected.set(entry.id, entry);
      }
    };
    const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support"];
    const perRole = Math.max(1, Math.floor(capacity * 0.5 / roles.length));
    roles.forEach((role) => addEvenly(listed.filter((rating) => rating.role === role), perRole));
    // Fill the remaining places from evenly-spaced cost bands, rather than
    // always choosing the cheapest end of the table.
    addEvenly(listed.filter((rating) => !selected.has(rating.id)), partnerLimit - selected.size);
    return [...selected.values()];
  });
  const anchorRatingsByPosition = partnerRatingsByPosition.map((ratings) => {
    const selected = new Map();
    [...ratings].sort((left, right) => (
      left.cost - right.cost ||
      left.id.localeCompare(right.id)
    )).slice(0, 1).forEach((rating) => selected.set(rating.id, rating));
    [...ratings].filter((rating) => rating.skillType !== "none").sort((left, right) => (
      left.skillTurn - right.skillTurn ||
      left.cost - right.cost ||
      left.id.localeCompare(right.id)
    )).slice(0, 1).forEach((rating) => selected.set(rating.id, rating));
    return [...selected.values()];
  });
  return {
    allByPosition,
    ratingsByPosition,
    partnerRatingsByPosition,
    anchorRatingsByPosition,
    charactersById: new Map(characters.map((character) => [String(character.id), character])),
  };
}

function v7DeckKey(deck) {
  return deck.map((character) => String(character.id)).join("|");
}

function selectDiverseAutomaticDecks(entries, limit) {
  const maximum = Math.max(1, Number(limit) || 1);
  return [...entries].sort((left, right) => (
    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||
    (Number(right.synergyScore) || 0) - (Number(left.synergyScore) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
  )).slice(0, maximum);
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

function v7AnchorDecksFor(character, position, resolvedInput, candidatePools, options) {
  const targetRating = candidatePools.ratingsByPosition[position - 1].get(String(character.id));
  const anchorDeckLimit = Math.max(0, Number(options.anchorDeckLimit) || 1);
  if (!targetRating || !anchorDeckLimit) return [];

  return candidatePools.anchorRatingsByPosition.flatMap((anchors, index) => {
    if (index + 1 === position) return [];
    return anchors.slice(0, anchorDeckLimit).flatMap((anchor) => {
      const constraint = {
        totalCost: resolvedInput.totalCost,
        allowedAttributes: resolvedInput.allowedAttributes,
        slots: candidatePools.partnerRatingsByPosition.map((ratings, slotIndex) => ({
          position: slotIndex + 1,
          candidates: slotIndex + 1 === position
            ? [targetRating]
            : slotIndex === index
              ? [anchor]
              : ratings,
        })),
      };
      return buildV7AutomaticDecks(constraint, character, position, candidatePools, options)
        .slice(0, 1)
        .map((entry) => ({
          deck: entry.deck,
          origin: "anchor",
          proxyScore: entry.proxyScore,
          synergyScore: entry.synergyScore,
        }));
    });
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
  const automatic = selectDiverseAutomaticDecks(
    buildV7AutomaticDecks(constraint, character, position, candidatePools, options),
    Math.max(1, Number(options.autoDeckLimit) || 10),
  ).map((entry) => ({
    deck: entry.deck,
    origin: "automatic",
    proxyScore: entry.proxyScore,
    synergyScore: entry.synergyScore,
  }));
  const anchors = v7AnchorDecksFor(character, position, resolvedInput, candidatePools, options);
  const examples = v7ExampleDecksFor(character, position, resolvedInput, candidatePools, options);
  const unique = new Map();
  for (const entry of [...automatic, ...anchors, ...examples]) {
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

function meanSignedLowerBound(values) {
  if (!values.length) return 0;
  const mean = average(values);
  if (values.length === 1) return mean;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return mean - 1.28 * Math.sqrt(variance / values.length);
}

const V11_ACTIONABLE_SKILL_TYPES = new Set([
  "single_attack",
  "aoe_attack",
  "multi_hit_attack",
  "attack_buff",
  "damage_reduction",
  "guard",
  "attribute_guard",
  "heal",
  "revive",
  "attribute_change",
]);

const V11_ATTACK_SKILL_TYPES = new Set(["single_attack", "aoe_attack", "multi_hit_attack"]);

function v11HasActionableSkill(character) {
  return V11_ACTIONABLE_SKILL_TYPES.has(character?.skill?.type);
}

function v11WithoutUsableSkill(character) {
  return {
    ...character,
    id: `${character.id}:metagame-v11-no-skill`,
    name: `${character.name}（スキルなし比較）`,
    skillTurn: 99,
    maxUses: 0,
    roleTags: [],
    skill: {
      type: "none",
      multiplier: 1,
      hits: 1,
      amount: 0,
      target: "self",
      targetCount: 1,
      duration: 1,
      priority: "normal",
      conditions: [],
      effects: [],
    },
  };
}

function v11TrackSkillEvidence(result, characterId, actorIndex) {
  const id = String(characterId);
  const directDefeats = new Map();
  let used = false;
  let uses = 0;
  for (const turn of result.history ?? []) {
    const selection = turn.phases?.find((phase) => phase.id === "skill_selection");
    const usedThisTurn = (selection?.events ?? []).filter((event) => (
      event.type === "skill_use" &&
      event.side === "allies" &&
      event.actorIndex === actorIndex &&
      String(event.actorId) === id
    ));
    if (!usedThisTurn.length) continue;
    used = true;
    uses += usedThisTurn.length;
    if (!usedThisTurn.some((event) => V11_ATTACK_SKILL_TYPES.has(event.skillType))) continue;
    for (const action of turn.actions ?? []) {
      if (action.side !== "allies" || action.actorIndex !== actorIndex || String(action.actorId) !== id) continue;
      for (const hit of action.hits ?? []) {
        if (!hit.defeated) continue;
        const name = String(hit.targetName ?? "不明");
        directDefeats.set(name, (directDefeats.get(name) ?? 0) + 1);
      }
    }
  }
  return { used, uses, directDefeats };
}

/** Evaluates a completed deck as one player within a 5v5 team battle. */
export function evaluateMetagameV7Deck(deck, teamScenarios, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  const trackedCharacterId = options.trackedCharacterId === undefined ? null : String(options.trackedCharacterId);
  const trackedDirectDefeats = new Map();
  let trackedActivatedScenarios = 0;
  let trackedSkillUses = 0;
  const minimumRandomMultiplier = Math.min(1, Math.max(0, Number(rules.damage?.randomMinimum) || 0.9));
  const damageMultipliers = [minimumRandomMultiplier, (minimumRandomMultiplier + 1) / 2, 1];
  for (let index = 0; index < teamScenarios.length; index += 1) {
    const profile = V7_BATTLE_PROFILES[index % V7_BATTLE_PROFILES.length];
    const scenario = teamScenarios[index];
      const damageMultiplier = damageMultipliers[Math.floor(index / V7_BATTLE_PROFILES.length) % damageMultipliers.length];
      if (!Array.isArray(scenario?.allyDecks) || scenario.allyDecks.length !== 4 ||
      !Array.isArray(scenario?.enemyDecks) || scenario.enemyDecks.length !== 5) {
      throw new Error("5対5環境シナリオが不正です。");
    }
    const allyDecks = [...scenario.allyDecks];
    allyDecks.splice(index % 5, 0, deck);
    const result = simulateBattle(createBattleState(allyDecks, scenario.enemyDecks), rules, {
      turns,
      targetPolicy: profile.targetPolicy,
      attackOrderPolicy: profile.attackOrderPolicy,
      playStyle: profile.playStyle,
      randomSeed: index,
      damageMultiplier,
    });
    if (trackedCharacterId !== null) {
      const tracked = v11TrackSkillEvidence(result, trackedCharacterId, index % 5);
      if (tracked.used) trackedActivatedScenarios += 1;
      trackedSkillUses += tracked.uses;
      for (const [name, count] of tracked.directDefeats) {
        trackedDirectDefeats.set(name, (trackedDirectDefeats.get(name) ?? 0) + count);
      }
    }
    values.push(projectedWinValue(result));
    outcomes[result.outcome] += 1;
  }
  const total = Math.max(1, values.length);
  return {
    expectedWinRate: average(values),
    expectedWinLowerBound: meanLowerBound(values),
    scenarioValues: [...values],
    scenarioCount: values.length,
    decisiveWinRate: outcomes.allies / total,
    decisiveDrawRate: outcomes.draw / total,
    decisiveLossRate: outcomes.enemies / total,
    ongoingRate: outcomes.ongoing / total,
    skillActivationRate: trackedCharacterId === null ? undefined : trackedActivatedScenarios / total,
    skillUsesPerScenario: trackedCharacterId === null ? undefined : trackedSkillUses / total,
    skillDefeatedTargets: trackedCharacterId === null ? undefined : [...trackedDirectDefeats.entries()]
      .map(([name, defeats]) => ({ name, defeats }))
      .sort((left, right) => right.defeats - left.defeats || left.name.localeCompare(right.name))
      .slice(0, 6),
  };
}

export function rateMetagameV7Character(character, position, resolvedInput, candidatePools, teamScenarios, options = {}) {
  const individual = candidatePools.ratingsByPosition[position - 1]?.get(String(character.id)) ?? {};
  const individualScore = rounded(individual.individualScore ?? individual.practicalValue ?? 0);
  const roleFit = rounded(individual.roleFit ?? 0);
  const roleBreakdown = Object.fromEntries(Object.entries(individual.roleBreakdown ?? {}).map(([key, value]) => (
    [key, rounded(value)]
  )));
  const deckCandidates = buildMetagameV7DeckCandidates(character, position, resolvedInput, candidatePools, options);
  // Compare every evaluated deck with the exact same four allies and an inert
  // fifth member. This is the measured marginal value of the candidate; the
  // full team's result must not be attributed to one character.
  const benchmark = {
    id: `metagame-v11-empty-slot-${position}`,
    name: "評価用空枠",
    attributes: [],
    rarity: "N",
    cost: 0,
    hp: 1,
    pow: 1,
    skillTurn: 0,
    maxUses: 0,
    allowedPositions: [position],
    skillName: "",
    skill: {
      type: "none",
      multiplier: 1,
      hits: 1,
      amount: 0,
      target: "self",
      targetCount: 1,
      duration: 1,
      priority: "normal",
      conditions: [],
      effects: [],
    },
  };
  const actionableSkill = v11HasActionableSkill(character);
  const evaluatedDecks = deckCandidates.map((candidate) => {
    const deck = candidate.deck;
    const result = evaluateMetagameV7Deck(deck, teamScenarios, {
      ...options,
      trackedCharacterId: character.id,
    });
    const benchmarkDeck = deck.map((entry, index) => (index === position - 1 ? benchmark : entry));
    const benchmarkResult = evaluateMetagameV7Deck(benchmarkDeck, teamScenarios, options);
    const noSkillCharacter = v11WithoutUsableSkill(character);
    const noSkillDeck = deck.map((entry, index) => (index === position - 1 ? noSkillCharacter : entry));
    const noSkillResult = actionableSkill
      ? evaluateMetagameV7Deck(noSkillDeck, teamScenarios, options)
      : result;
    return {
      ...candidate,
      totalCost: deck.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0),
      result,
      benchmarkResult,
      noSkillResult,
      marginalWinGain: result.expectedWinRate - benchmarkResult.expectedWinRate,
      skillWinGain: actionableSkill ? result.expectedWinRate - noSkillResult.expectedWinRate : 0,
    };
  }).sort((left, right) => (
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
      skillTarget: character.skill?.target ?? "self",
      skillName: character.skillName ?? "",
      role: individual.role ?? v8RoleForCharacter(character),
      individualScore: 0,
      roleFit,
      roleBreakdown,
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
      deckScore: 0,
      v7Score: 0,
    };
  }
  const example = evaluatedDecks.find((entry) => entry.origin === "example");
  const deckScore = rounded(best.result.expectedWinLowerBound);
  const marginalValues = evaluatedDecks.map((entry) => Number(entry.marginalWinGain) || 0);
  const marginalWinGain = average(marginalValues);
  const marginalVariance = marginalValues.length > 1
    ? marginalValues.reduce((sum, value) => sum + (value - marginalWinGain) ** 2, 0) / (marginalValues.length - 1)
    : 0;
  const marginalWinGainLowerBound = marginalWinGain - 1.28 * Math.sqrt(marginalVariance / Math.max(1, marginalValues.length));
  const skillWinGains = evaluatedDecks.map((entry) => Number(entry.skillWinGain) || 0);
  const skillWinGain = average(skillWinGains);
  const skillWinGainLowerBound = meanSignedLowerBound(skillWinGains);
  const actualSkillActivationRate = actionableSkill
    ? average(evaluatedDecks.map((entry) => Number(entry.result.skillActivationRate) || 0))
    : 1;
  const skillUsesPerScenario = actionableSkill
    ? average(evaluatedDecks.map((entry) => Number(entry.result.skillUsesPerScenario) || 0))
    : 0;
  const skillDefeatCounts = new Map();
  for (const entry of evaluatedDecks) {
    for (const target of entry.result.skillDefeatedTargets ?? []) {
      const name = String(target.name ?? "不明");
      skillDefeatCounts.set(name, (skillDefeatCounts.get(name) ?? 0) + (Number(target.defeats) || 0));
    }
  }
  const skillDefeatedTargets = [...skillDefeatCounts.entries()]
    .map(([name, defeats]) => ({ name, defeats }))
    .sort((left, right) => right.defeats - left.defeats || left.name.localeCompare(right.name))
    .slice(0, 6);
  const individualBattleScore = clampUnit(0.5 + marginalWinGain);
  const individualBattleLowerBound = clampUnit(0.5 + marginalWinGainLowerBound);
  const measuredContribution = marginalContributionScore(marginalWinGain);
  const reliableContribution = marginalContributionScore(marginalWinGainLowerBound);
  const skillImpact = actionableSkill
    ? clampUnit(Math.max(0, skillWinGainLowerBound) / 0.12)
    : 1;
  // This is intentionally measured from the actual 5v5 logs.  A 2T skill in
  // slot 2 is not ruled out solely by its text, but it receives almost no
  // role credit if the selected opener causes it to die before activation.
  const skillExecution = actionableSkill
    ? clampUnit(actualSkillActivationRate * 0.5 + skillImpact * 0.5)
    : 1;
  const role = individual.role ?? v8RoleForCharacter(character);
  const staticHardTargetCoverage = clampUnit(Number(roleBreakdown.highDurabilityCoverage) || 0);
  // A damage skill is a finisher only if it can actually be used in this slot.
  // Its static damage reach is retained as the definition of the hard part of
  // the supplied environment, but an unreachable skill contributes no reach.
  const actualHardTargetCoverage = v8RoleIsAttack(role) && actionableSkill
    ? staticHardTargetCoverage * skillExecution
    : staticHardTargetCoverage;
  // Later slots are selected for a job.  For an actionable role this has to
  // combine that job's environment coverage with measured activation and the
  // no-skill counterfactual.  A raw-stat character remains eligible through
  // the controlled battle contribution instead of being forced to fake a
  // skill role.
  const actualRoleExecution = actionableSkill
    ? clampUnit(roleFit * skillExecution * (v8RoleIsAttack(role)
      ? 0.55 + actualHardTargetCoverage * 0.45
      : 1))
    : clampUnit(roleFit);
  const actualCostEfficiency = marginalCostEfficiencyScore(
    marginalWinGainLowerBound,
    character.cost,
    resolvedInput.totalCost,
  );
  // The controlled battle delta remains the dominant evidence, but the
  // budget is a first-class part of the score. From the second slot onward,
  // the role must also be executed in combat: delayed skill text alone cannot
  // beat a character whose skill actually fires and changes the battle.
  const firstAttackPressure = clampUnit(individual.enemyPressureRate);
  const v11Score = rounded(position === 1
    ? reliableContribution * 0.28 + measuredContribution * 0.12 + firstAttackPressure * 0.17 + actualCostEfficiency * 0.27 + actualRoleExecution * 0.16
    : reliableContribution * 0.25 + measuredContribution * 0.10 + actualCostEfficiency * 0.22 + actualRoleExecution * 0.30 + skillExecution * 0.13);
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
    skillTarget: character.skill?.target ?? "self",
    skillName: character.skillName ?? "",
    role,
    // Published as the cost-aware, skill-execution result. The raw controlled
    // battle score is retained below for audit/debug purposes.
    individualScore: v11Score,
    roleFit,
    roleBreakdown: {
      ...roleBreakdown,
      costEfficiency: rounded(actualCostEfficiency),
      measuredContribution: rounded(measuredContribution),
      reliableContribution: rounded(reliableContribution),
      actualSkillActivationRate: rounded(actualSkillActivationRate),
      skillWinGain: rounded(skillWinGain),
      skillWinGainLowerBound: rounded(skillWinGainLowerBound),
      skillExecution: rounded(skillExecution),
      actualRoleExecution: rounded(actualRoleExecution),
      actualHardTargetCoverage: rounded(actualHardTargetCoverage),
    },
    position,
    evaluatedDeckCount: evaluatedDecks.length,
    contributionProbeCount: evaluatedDecks.length,
    marginalWinGain: rounded(marginalWinGain),
    marginalWinGainLowerBound: rounded(marginalWinGainLowerBound),
    skillWinGain: rounded(skillWinGain),
    skillWinGainLowerBound: rounded(skillWinGainLowerBound),
    skillActivationRate: rounded(actualSkillActivationRate),
    skillUsesPerScenario: rounded(skillUsesPerScenario),
    skillDefeatedTargets,
    rawIndividualBattleScore: rounded(individualBattleScore),
    rawIndividualBattleLowerBound: rounded(individualBattleLowerBound),
    costAwareScore: v11Score,
    evaluationCostCap: Number(resolvedInput.totalCost) || 0,
    benchmarkExpectedWinRate: rounded(average(evaluatedDecks.map((entry) => entry.benchmarkResult.expectedWinRate))),
    candidateExpectedWinRate: rounded(average(evaluatedDecks.map((entry) => entry.result.expectedWinRate))),
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
    // 完成デッキ勝率は個体順位に混ぜない。残り4枠を固定した実戦差分と、
    // この縛りの総コストに対する効率だけを個体評価へ使う。
    deckScore,
    // Later positions reserve a substantial score share for role execution
    // verified in the actual team battle, rather than for text-only skill
    // potential or the strongest supporting deck.
    v7Score: v11Score,
  };
}

export function rankMetagameV7Characters(ratings) {
  const ranked = [...ratings].sort((left, right) => (
    right.v7Score - left.v7Score ||
    Number(right.roleBreakdown?.costEfficiency) - Number(left.roleBreakdown?.costEfficiency) ||
    left.cost - right.cost ||
    Number(right.marginalWinGainLowerBound) - Number(left.marginalWinGainLowerBound) ||
    Number(right.marginalWinGain) - Number(left.marginalWinGain) ||
    left.id.localeCompare(right.id)
  ));
  return ranked.map((rating, index) => ({ ...rating, rank: index + 1 }));
}
