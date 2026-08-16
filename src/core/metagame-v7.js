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
export const METAGAME_V8_MODEL_VERSION = "team-battle-v8.6-combat-corrections";
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

function environmentStrengths(pools, rules) {
  const all = pools.flat();
  const maxHp = Math.max(1, ...all.map((character) => Number(character.hp) || 0));
  const maxPow = Math.max(1, ...all.map((character) => Number(character.pow) || 0));
  return new Map(pools.flatMap((pool, index) => pool.map((character) => {
    const skill = clampUnit(estimateSkillPotency(character, all, index + 1, rules) / 4);
    const value = clampUnit(
      Number(character.pow) / maxPow * 0.44 +
      Number(character.hp) / maxHp * 0.36 +
      skill * 0.20,
    );
    return [String(character.id), value];
  })));
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
  const rules = options.rules ?? DEFAULT_RULES;
  const strengths = environmentStrengths(pools, rules);
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
      roleFit: precisionValue * attackConditionCoverage,
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
      roleFit: boardControl * attackConditionCoverage,
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
      roleFit: defenseMatchup * 0.45 + skill * 0.55,
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
    const standaloneSupport = skillData.target === "ally_all" ? 0.55 : 0.4;
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

function characterProxyRating(character, position, environmentPool, maxima, rules, allyCandidates = []) {
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
  const allyCoverage = allyConditionCoverage(character, character.skill, allyCandidates);
  const enemyCoverage = attributeConditionCoverage(character.skill?.conditions, "enemy_attribute", environmentPool);
  const skillReadiness = v8SkillReadiness(character, position);
  const skillRaw = estimateSkillPotency(character, environmentPool, position, rules) * allyCoverage * enemyCoverage * skillReadiness;
  const skill = clampUnit(skillRaw / 4);
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
  const frontline = clampUnit(
    statPower * 0.3 + statHp * 0.3 + offense * 0.2 + defense * 0.14 + costEfficiency * 0.06,
  );
  const rawPracticalValue = position === 1
    ? frontline
    : clampUnit(
      roleProfile.roleFit * 0.46 + skill * 0.14 + costEfficiency * 0.16 +
      ((offense + defense) / 2) * 0.14 + continuation * 0.05 + (statPower + statHp) / 2 * 0.05,
    );
  // This is applied before beam pruning. A strong but delayed 2nd/3rd-slot
  // skill must not eliminate a reproducible earlier skill from consideration.
  const practicalValue = clampUnit(rawPracticalValue * (0.65 + skillReadiness * 0.35));
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
    },
    expectedWinRate: practicalValue,
    expectedWinLowerBound: practicalValue,
    balancedContribution: clampUnit((offense + defense) / 2),
    practicalValue,
    practicalSkillReliability: skill > 0 && allyCoverage > 0 && enemyCoverage > 0 ? skillReadiness : 1,
    powerPreference: statPower,
    enemyPressureRate: offense,
    combinationPotential: continuation,
    continuationWinGain: continuation * skill * (roleProfile.role === "support" ? 0.55 : 1),
    carriedContinuationWinGain: continuation * skill * (roleProfile.role === "support" ? 0.55 : 1),
    tacticalUpside: skill * (roleProfile.role === "support" ? 0.65 : 1),
    tacticalRisk: 1 - skillReadiness,
    allyRetentionRate: defense,
    carriedDefenseRate: continuation * defense,
    advantageCreation: ["damage_reduction", "guard", "attribute_guard", "heal", "revive"].includes(character.skill?.type)
      ? skill : 0,
    counteraction: ["single_attack", "aoe_attack", "multi_hit_attack"].includes(character.skill?.type)
      ? skill : 0,
    skillActivationRate: skill > 0 && allyCoverage > 0 && enemyCoverage > 0 ? skillReadiness : 1,
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
    const listed = [...ratings.values()].sort((left, right) => (
      right.practicalValue - left.practicalValue ||
      left.cost - right.cost ||
      left.id.localeCompare(right.id)
    ));
    const exampleRatings = [...exampleIdsByPosition[index]].map((id) => ratings.get(id)).filter(Boolean);
    const remainingLimit = Math.max(1, partnerLimit - exampleRatings.length);
    const strengthLimit = Math.max(1, Math.ceil(remainingLimit * 0.35));
    const costLimit = Math.max(1, Math.ceil(remainingLimit * 0.20));
    const efficiencyLimit = Math.max(6, Math.ceil(remainingLimit * 0.25));
    const utilityLimit = Math.max(6, remainingLimit - strengthLimit - costLimit - efficiencyLimit);
    const selected = new Map();
    listed.slice(0, strengthLimit).forEach((rating) => selected.set(rating.id, rating));
    listed.sort((left, right) => (
      (right.practicalValue - right.cost / Math.max(1, resolvedInput.totalCost) * 0.24) -
        (left.practicalValue - left.cost / Math.max(1, resolvedInput.totalCost) * 0.24) ||
      left.cost - right.cost
    )).slice(0, costLimit).forEach((rating) => selected.set(rating.id, rating));
    listed.sort((left, right) => (
      v7CostEfficiency(right) - v7CostEfficiency(left) ||
      right.practicalValue - left.practicalValue ||
      left.id.localeCompare(right.id)
    )).slice(0, efficiencyLimit).forEach((rating) => selected.set(rating.id, rating));
    listed.filter((rating) => rating.skillType !== "none").sort((left, right) => (
      (Number(right.tacticalUpside) + Number(right.combinationPotential) + Number(right.advantageCreation)) -
        (Number(left.tacticalUpside) + Number(left.combinationPotential) + Number(left.advantageCreation)) ||
      right.practicalValue - left.practicalValue ||
      left.cost - right.cost
    )).slice(0, utilityLimit).forEach((rating) => selected.set(rating.id, rating));
    // Keep at least one strong representative of every practical role. This
    // prevents a broad high-stat proxy cut from erasing revivers, defenders,
    // precision attackers, or board-clear attackers before deck generation.
    ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support"].forEach((role) => {
      const representative = listed.filter((rating) => rating.role === role).sort((left, right) => (
        Number(right.roleFit) - Number(left.roleFit) ||
        right.practicalValue - left.practicalValue ||
        left.cost - right.cost
      ))[0];
      if (representative) selected.set(representative.id, representative);
    });
    exampleRatings.forEach((rating) => selected.set(rating.id, rating));
    return [...selected.values()];
  });
  const anchorRatingsByPosition = partnerRatingsByPosition.map((ratings) => {
    const selected = new Map();
    [...ratings].sort((left, right) => (
      v7CostEfficiency(right) - v7CostEfficiency(left) ||
      right.practicalValue - left.practicalValue
    )).slice(0, 1).forEach((rating) => selected.set(rating.id, rating));
    [...ratings].filter((rating) => rating.skillType !== "none").sort((left, right) => (
      (Number(right.tacticalUpside) + Number(right.combinationPotential) + Number(right.advantageCreation)) -
        (Number(left.tacticalUpside) + Number(left.combinationPotential) + Number(left.advantageCreation)) ||
      right.practicalValue - left.practicalValue
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
  if (entries.length <= maximum) return entries;
  const selected = [entries[0]];
  const remaining = entries.slice(1);
  while (selected.length < maximum && remaining.length) {
    const bestIndex = remaining.reduce((best, entry, index) => {
      const distinction = Math.min(...selected.map((chosen) => (
        entry.deck.reduce((count, character, position) => (
          count + Number(String(character.id) !== String(chosen.deck[position]?.id))
        ), 0)
      )));
      const costDistance = Math.min(...selected.map((chosen) => (
        Math.abs((entry.totalCost ?? 0) - (chosen.totalCost ?? 0)) / 10
      )));
      const score = distinction * 10 + Math.min(1, costDistance) + (entry.proxyScore ?? 0) * 0.001;
      return score > best.score ? { index, score } : best;
    }, { index: 0, score: -Infinity });
    selected.push(remaining.splice(bestIndex.index, 1)[0]);
  }
  return selected;
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

/** Evaluates a completed deck as one player within a 5v5 team battle. */
export function evaluateMetagameV7Deck(deck, teamScenarios, options = {}) {
  const rules = options.rules ?? DEFAULT_RULES;
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const values = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (let index = 0; index < teamScenarios.length; index += 1) {
    const profile = V7_BATTLE_PROFILES[index % V7_BATTLE_PROFILES.length];
    const scenario = teamScenarios[index];
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

export function rateMetagameV7Character(character, position, resolvedInput, candidatePools, teamScenarios, options = {}) {
  const individual = candidatePools.ratingsByPosition[position - 1]?.get(String(character.id)) ?? {};
  const individualScore = rounded(individual.individualScore ?? individual.practicalValue ?? 0);
  const roleFit = rounded(individual.roleFit ?? 0);
  const roleBreakdown = Object.fromEntries(Object.entries(individual.roleBreakdown ?? {}).map(([key, value]) => (
    [key, rounded(value)]
  )));
  const deckCandidates = buildMetagameV7DeckCandidates(character, position, resolvedInput, candidatePools, options);
  const evaluatedDecks = deckCandidates.map((candidate) => ({
    ...candidate,
    totalCost: candidate.deck.reduce((sum, entry) => sum + (Number(entry.cost) || 0), 0),
    result: evaluateMetagameV7Deck(candidate.deck, teamScenarios, options),
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
      skillTarget: character.skill?.target ?? "self",
      skillName: character.skillName ?? "",
      role: individual.role ?? v8RoleForCharacter(character),
      individualScore,
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
  const individualWeight = position === 1 ? 0.3 : 0.4;
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
    individualScore,
    roleFit,
    roleBreakdown,
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
    deckScore,
    // First position keeps a larger stat component. From the second position
    // onward, a character's own role fit remains 40% of its ranking rather
    // than disappearing behind the single best supporting deck.
    v7Score: rounded(deckScore * (1 - individualWeight) + individualScore * individualWeight),
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
