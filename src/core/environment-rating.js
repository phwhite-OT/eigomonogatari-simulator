import { createBattleState } from "./battleState.js";
import { isSkillTurnAllowedAtPosition } from "./filter.js";
import {
  ATTACK_ORDER_POLICIES,
  PLAY_STYLES,
  simulateBattle,
  TARGET_POLICIES,
} from "./simulate.js";
import { canUseSkill } from "./skills.js";
import { ATTRIBUTES, DEFAULT_RULES, resolveAttributeClass } from "../data/rules.js";

export const DEFAULT_ENVIRONMENT_BATTLE_PROFILES = Object.freeze([
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

export const DEFAULT_STRATEGIC_DECK_PROFILES = Object.freeze([
  Object.freeze({ id: "balanced-1", minimumAdvantage: 1, minimumCounter: 1 }),
  Object.freeze({ id: "advantage-1", minimumAdvantage: 2, minimumCounter: 1 }),
  Object.freeze({ id: "balanced-2", minimumAdvantage: 1, minimumCounter: 1 }),
  Object.freeze({ id: "counter-pressure", minimumAdvantage: 1, minimumCounter: 2 }),
  Object.freeze({ id: "balanced-3", minimumAdvantage: 1, minimumCounter: 1 }),
  Object.freeze({ id: "advantage-2", minimumAdvantage: 2, minimumCounter: 1 }),
]);

function availableBattleProfiles(profiles) {
  return Array.isArray(profiles) && profiles.length
    ? profiles
    : DEFAULT_ENVIRONMENT_BATTLE_PROFILES;
}

function battleProfileAt(profiles, index) {
  const available = availableBattleProfiles(profiles);
  return available[index % available.length];
}

function scenarioBattleOptions(scenario) {
  return {
    targetPolicy: scenario.targetPolicy,
    attackOrderPolicy: scenario.attackOrderPolicy,
    playStyle: scenario.playStyle,
  };
}

function rounded(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function wilsonLowerBound(successes, observations, z = 1.96) {
  if (!observations) return 0;
  const probability = successes / observations;
  const zSquared = z ** 2;
  const center = probability + zSquared / (2 * observations);
  const margin = z * Math.sqrt(
    probability * (1 - probability) / observations + zSquared / (4 * observations ** 2),
  );
  return Math.max(0, (center - margin) / (1 + zSquared / observations));
}

function createRandom(seed = 1) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function selectedAttributes(attributes) {
  const selected = [...new Set((attributes ?? []).map(String))].filter((attribute) => ATTRIBUTES.includes(attribute));
  return selected.length ? selected : [...ATTRIBUTES];
}

export function buildEnvironmentPositionPool(characters, position, options = {}) {
  const allowedAttributes = selectedAttributes(options.allowedAttributes);
  return characters.filter((character) => (
    resolveAttributeClass(character.attributes) &&
    character.attributes.some((attribute) => allowedAttributes.includes(attribute)) &&
    (character.pvpTier !== "exclude" || options.includeExcluded) &&
    (character.pvpTier !== "low" || options.includeLow !== false) &&
    character.allowedPositions?.includes(position) &&
    isSkillTurnAllowedAtPosition(character, position)
  ));
}

function shortlistForCompletion(pool, unavailableCount, remainingPositions) {
  return [...pool]
    .sort((left, right) => left.cost - right.cost || String(left.id).localeCompare(String(right.id)))
    .slice(0, unavailableCount + remainingPositions + 1);
}

export function createDeckCompletionSolver(positionPools, totalCost) {
  const cache = new Map();
  return (fixedPositions) => {
    const fixedEntries = Object.entries(fixedPositions)
      .map(([position, character]) => [Number(position), character])
      .sort(([left], [right]) => left - right);
    const key = fixedEntries.map(([position, character]) => `${position}:${character.id}`).join("|");
    if (cache.has(key)) return cache.get(key);
    const fixedIds = new Set(fixedEntries.map(([, character]) => String(character.id)));
    const fixedLegendCount = fixedEntries.filter(([, character]) => character.rarity === "伝").length;
    if (fixedIds.size !== fixedEntries.length || fixedLegendCount > 1) {
      cache.set(key, null);
      return null;
    }
    const deck = Array(5).fill(null);
    let fixedCost = 0;
    for (const [position, character] of fixedEntries) {
      deck[position - 1] = character;
      fixedCost += Number(character.cost) || 0;
    }
    const remaining = [1, 2, 3, 4, 5].filter((position) => !deck[position - 1]);
    const pools = remaining.map((position) => shortlistForCompletion(
      positionPools[position - 1],
      fixedIds.size,
      remaining.length,
    ));
    let best = null;

    const visit = (index, ids, cost, legendCount) => {
      if (cost > totalCost || (best && cost >= best.cost)) return;
      if (index === remaining.length) {
        best = { cost, deck: [...deck] };
        return;
      }
      const position = remaining[index];
      for (const character of pools[index]) {
        const id = String(character.id);
        const isLegend = character.rarity === "伝";
        if (ids.has(id) || (isLegend && legendCount >= 1)) continue;
        deck[position - 1] = character;
        const nextIds = new Set(ids);
        nextIds.add(id);
        visit(
          index + 1,
          nextIds,
          cost + (Number(character.cost) || 0),
          legendCount + (isLegend ? 1 : 0),
        );
      }
      deck[position - 1] = null;
    };

    visit(0, fixedIds, fixedCost, fixedLegendCount);
    const result = best && best.cost <= totalCost ? best : null;
    cache.set(key, result);
    return result;
  };
}

function sampler(values, random) {
  let items = shuffled(values, random);
  let index = 0;
  return (excludedIds = new Set()) => {
    for (let attempts = 0; attempts < Math.max(1, items.length * 2); attempts += 1) {
      if (index >= items.length) {
        items = shuffled(values, random);
        index = 0;
      }
      const value = items[index];
      index += 1;
      if (!excludedIds.has(String(value.id))) return value;
    }
    return values.find((value) => !excludedIds.has(String(value.id)));
  };
}

function lightweightReserve(character, suffix) {
  return {
    id: `${character.id}:reserve:${suffix}`,
    name: character.name,
    attributes: [...character.attributes],
    cost: character.cost,
    hp: character.hp,
    pow: character.pow,
    skillTurn: 9999,
    maxUses: 0,
    skill: { type: "none", multiplier: 1, hits: 1, duration: 1 },
    roleTags: [],
  };
}

function compactScenarioState(state, options = {}) {
  const next = structuredClone(state);
  const preserveReserveSkills = Boolean(options.preserveReserveSkills);
  for (const side of ["allies", "enemies"]) {
    for (const combatant of next[side]) {
      const environmentPosition = combatant.deckIndex + 1;
      const reserves = combatant.deck
        .slice(combatant.deckIndex + 1)
        .map((character, index) => (preserveReserveSkills
          ? structuredClone(character)
          : lightweightReserve(character, `${side}-${combatant.playerId}-${index}`)));
      combatant.environmentPosition = environmentPosition;
      combatant.deck = [combatant.character, ...reserves];
      combatant.deckIndex = 0;
    }
  }
  return next;
}

function createEnvironmentDecks(count, openerEnvironment, secondEnvironment, solveCompletion, random) {
  const nextOpener = sampler(openerEnvironment, random);
  const nextSecond = sampler(secondEnvironment, random);
  const decks = [];
  for (let deckIndex = 0; deckIndex < count; deckIndex += 1) {
    let completion = null;
    for (let attempts = 0; attempts < 200 && !completion; attempts += 1) {
      const opener = nextOpener();
      const second = nextSecond(new Set([String(opener.id)]));
      completion = second ? solveCompletion({ 1: opener, 2: second }) : null;
    }
    if (!completion) throw new Error("環境用のコスト内デッキを構成できませんでした。");
    decks.push(completion.deck);
  }
  return decks;
}

export function buildOpeningScenarios(options) {
  const {
    count,
    openerEnvironment,
    secondEnvironment,
    solveCompletion,
    battleProfiles = DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
    seed = 101,
  } = options;
  const random = createRandom(seed);
  const scenarios = [];
  for (let scenarioIndex = 0; scenarioIndex < count; scenarioIndex += 1) {
    const decks = createEnvironmentDecks(10, openerEnvironment, secondEnvironment, solveCompletion, random);
    const battleProfile = battleProfileAt(battleProfiles, scenarioIndex);
    scenarios.push({
      state: compactScenarioState(createBattleState(decks.slice(0, 5), decks.slice(5))),
      actorIndex: scenarioIndex % 5,
      position: 1,
      entryCharge: 0,
      entryTurn: 1,
      battleProfile: battleProfile.id,
      targetPolicy: battleProfile.targetPolicy,
      attackOrderPolicy: battleProfile.attackOrderPolicy,
      playStyle: battleProfile.playStyle,
    });
  }
  return scenarios;
}

export function buildSlotEntryScenarios(options) {
  const {
    count,
    openerEnvironment,
    secondEnvironment,
    solveCompletion,
    rules = DEFAULT_RULES,
    battleProfiles = DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
    seed = 202,
    turns = 8,
  } = options;
  const random = createRandom(seed);
  const scenarios = [];
  const selectedProfiles = availableBattleProfiles(battleProfiles);
  const profileTargets = new Map(selectedProfiles.map((profile, index) => [
    profile.id,
    Math.floor(count / selectedProfiles.length) + (index < count % selectedProfiles.length ? 1 : 0),
  ]));
  const profileSamples = new Map(selectedProfiles.map((profile) => [profile.id, 0]));
  let matchIndex = 0;
  const maximumMatches = Math.max(100, count * 20);

  while (scenarios.length < count && matchIndex < maximumMatches) {
    const decks = createEnvironmentDecks(10, openerEnvironment, secondEnvironment, solveCompletion, random);
    const battleProfile = battleProfileAt(selectedProfiles, matchIndex);
    const seen = new Set();
    const state = createBattleState(decks.slice(0, 5), decks.slice(5));
    simulateBattle(state, rules, {
      turns,
      targetPolicy: battleProfile.targetPolicy,
      attackOrderPolicy: battleProfile.attackOrderPolicy,
      playStyle: battleProfile.playStyle,
      onTurnStart: ({ state: turnState }) => {
        for (let actorIndex = 0; actorIndex < turnState.allies.length && scenarios.length < count; actorIndex += 1) {
          if ((profileSamples.get(battleProfile.id) ?? 0) >= profileTargets.get(battleProfile.id)) break;
          const combatant = turnState.allies[actorIndex];
          const key = `${matchIndex}:${actorIndex}`;
          if (combatant.deckIndex !== 1 || seen.has(key)) continue;
          seen.add(key);
          scenarios.push({
            state: compactScenarioState(turnState),
            actorIndex,
            position: 2,
            entryCharge: combatant.skillCounter,
            entryTurn: turnState.turn,
            battleProfile: battleProfile.id,
            targetPolicy: battleProfile.targetPolicy,
            attackOrderPolicy: battleProfile.attackOrderPolicy,
            playStyle: battleProfile.playStyle,
            opener: combatant.deck[0],
          });
          profileSamples.set(battleProfile.id, (profileSamples.get(battleProfile.id) ?? 0) + 1);
        }
      },
    });
    matchIndex += 1;
  }

  if (scenarios.length < count) {
    throw new Error(`2枠目の登場状態を${count}件集められませんでした（${scenarios.length}件）。`);
  }
  return scenarios;
}

function normalizedEnvironmentEntries(values) {
  const byId = new Map();
  for (const value of values ?? []) {
    const character = value?.character ?? value;
    if (!character?.id) continue;
    const id = String(character.id);
    const current = byId.get(id) ?? { character, weight: 0 };
    current.weight += Math.max(0, Number(value?.weight ?? 1) || 0);
    byId.set(id, current);
  }
  const entries = [...byId.values()].filter((entry) => entry.weight > 0);
  if (!entries.length) throw new Error("環境候補が空です。");
  return entries;
}

function sampleWeightedCharacter(entries, random, excludedIds = new Set()) {
  const available = entries.filter(({ character }) => !excludedIds.has(String(character.id)));
  if (!available.length) return undefined;
  const totalWeight = available.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = random() * totalWeight;
  for (const entry of available) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.character;
  }
  return available.at(-1).character;
}

export function strategicDeckComposition(deck) {
  return deck.reduce((composition, character) => {
    const strategicClass = classifyStrategicAction(character);
    if (strategicClass === "advantage_creation") composition.advantage += 1;
    else if (strategicClass === "counteraction") composition.counter += 1;
    else if (strategicClass === "adaptive") {
      composition.advantage += 0.5;
      composition.counter += 0.5;
    } else composition.neutral += 1;
    return composition;
  }, { advantage: 0, counter: 0, neutral: 0 });
}

function strategicDeckProfileMatches(deck, profile) {
  if (!profile) return true;
  const composition = strategicDeckComposition(deck);
  return (
    composition.advantage >= Number(profile.minimumAdvantage ?? 0) &&
    composition.counter >= Number(profile.minimumCounter ?? 0)
  );
}

function createStrategicEnvironmentDeck(
  entriesByPosition,
  solveCompletion,
  random,
  requiredPositions,
  profile,
  maximumAttempts,
) {
  for (let deckAttempt = 0; deckAttempt < maximumAttempts; deckAttempt += 1) {
    const fixedPositions = { ...requiredPositions };
    if (!solveCompletion(fixedPositions)) continue;
    const selectedIds = new Set(Object.values(fixedPositions).map((character) => String(character.id)));
    const openPositions = [1, 2, 3, 4, 5].filter((position) => !fixedPositions[position]);
    const positionOrder = shuffled(openPositions, random).sort((left, right) => (
      entriesByPosition[left - 1].length - entriesByPosition[right - 1].length
    ));
    let failed = false;
    for (const position of positionOrder) {
      const rejectedIds = new Set(selectedIds);
      let selected;
      for (let attempt = 0; attempt < Math.min(120, entriesByPosition[position - 1].length); attempt += 1) {
        const candidate = sampleWeightedCharacter(entriesByPosition[position - 1], random, rejectedIds);
        if (!candidate) break;
        rejectedIds.add(String(candidate.id));
        const trial = { ...fixedPositions, [position]: candidate };
        if (solveCompletion(trial)) {
          selected = candidate;
          fixedPositions[position] = candidate;
          selectedIds.add(String(candidate.id));
          break;
        }
      }
      if (!selected) {
        failed = true;
        break;
      }
    }
    if (failed) {
      const fallbackCompletion = solveCompletion(fixedPositions);
      if (fallbackCompletion && strategicDeckProfileMatches(fallbackCompletion.deck, profile)) {
        return fallbackCompletion;
      }
      continue;
    }
    const completion = solveCompletion(fixedPositions);
    if (completion && strategicDeckProfileMatches(completion.deck, profile)) return completion;
  }
  return null;
}

export function createFullEnvironmentDecks(
  count,
  positionEnvironments,
  solveCompletion,
  random,
  requiredPositions = {},
  options = {},
) {
  const entriesByPosition = positionEnvironments.map(normalizedEnvironmentEntries);
  const profiles = options.deckProfiles ?? [];
  const decks = [];
  for (let deckIndex = 0; deckIndex < count; deckIndex += 1) {
    const profile = profiles.length ? profiles[deckIndex % profiles.length] : null;
    let completion = createStrategicEnvironmentDeck(
      entriesByPosition,
      solveCompletion,
      random,
      requiredPositions,
      profile,
      profile ? 500 : 300,
    );
    if (!completion && profile && !options.strictProfiles) {
      completion = createStrategicEnvironmentDeck(
        entriesByPosition,
        solveCompletion,
        random,
        requiredPositions,
        null,
        300,
      );
    }
    if (!completion) {
      const profileLabel = profile ? `（戦略構成 ${profile.id}）` : "";
      throw new Error(`所持率込み環境からコスト内デッキを構成できませんでした。${profileLabel}`);
    }
    decks.push(completion.deck);
  }
  return decks;
}

export function buildPositionEntryScenarios(options) {
  const {
    count,
    position,
    positionEnvironments,
    solveCompletion,
    rules = DEFAULT_RULES,
    battleProfiles = DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
    seed = 404,
    turns = 12,
  } = options;
  const targetPosition = Math.min(5, Math.max(1, Number(position) || 1));
  const random = createRandom(seed);
  const scenarios = [];
  const selectedProfiles = availableBattleProfiles(battleProfiles);
  const profileTargets = new Map(selectedProfiles.map((profile, index) => [
    profile.id,
    Math.floor(count / selectedProfiles.length) + (index < count % selectedProfiles.length ? 1 : 0),
  ]));
  const profileSamples = new Map(selectedProfiles.map((profile) => [profile.id, 0]));
  let matchIndex = 0;
  const maximumMatches = Math.max(150, count * 40);

  while (scenarios.length < count && matchIndex < maximumMatches) {
    const decks = createFullEnvironmentDecks(
      10,
      positionEnvironments,
      solveCompletion,
      random,
      {},
      { deckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES },
    );
    const battleProfile = battleProfileAt(selectedProfiles, matchIndex);
    if (targetPosition === 1) {
      for (let actorIndex = 0; actorIndex < 5 && scenarios.length < count; actorIndex += 1) {
        if ((profileSamples.get(battleProfile.id) ?? 0) >= profileTargets.get(battleProfile.id)) break;
        scenarios.push({
          state: compactScenarioState(createBattleState(decks.slice(0, 5), decks.slice(5))),
          actorIndex,
          position: 1,
          entryCharge: 0,
          entryTurn: 1,
          prefixCharacters: [],
          suffixCharacters: decks[actorIndex].slice(1),
          battleProfile: battleProfile.id,
          targetPolicy: battleProfile.targetPolicy,
          attackOrderPolicy: battleProfile.attackOrderPolicy,
          playStyle: battleProfile.playStyle,
        });
        profileSamples.set(battleProfile.id, (profileSamples.get(battleProfile.id) ?? 0) + 1);
      }
      matchIndex += 1;
      continue;
    }

    const seen = new Set();
    simulateBattle(createBattleState(decks.slice(0, 5), decks.slice(5)), rules, {
      turns,
      targetPolicy: battleProfile.targetPolicy,
      attackOrderPolicy: battleProfile.attackOrderPolicy,
      playStyle: battleProfile.playStyle,
      onTurnStart: ({ state: turnState }) => {
        for (let actorIndex = 0; actorIndex < turnState.allies.length && scenarios.length < count; actorIndex += 1) {
          if ((profileSamples.get(battleProfile.id) ?? 0) >= profileTargets.get(battleProfile.id)) break;
          const combatant = turnState.allies[actorIndex];
          const key = `${matchIndex}:${actorIndex}`;
          if (combatant.deckIndex !== targetPosition - 1 || seen.has(key)) continue;
          seen.add(key);
          scenarios.push({
            state: compactScenarioState(turnState),
            actorIndex,
            position: targetPosition,
            entryCharge: combatant.skillCounter,
            entryTurn: turnState.turn,
            prefixCharacters: combatant.deck.slice(0, targetPosition - 1),
            suffixCharacters: combatant.deck.slice(targetPosition),
            battleProfile: battleProfile.id,
            targetPolicy: battleProfile.targetPolicy,
            attackOrderPolicy: battleProfile.attackOrderPolicy,
            playStyle: battleProfile.playStyle,
          });
          profileSamples.set(battleProfile.id, (profileSamples.get(battleProfile.id) ?? 0) + 1);
        }
      },
    });
    matchIndex += 1;
  }

  if (scenarios.length < count) {
    throw new Error(`${targetPosition}枠目の登場状態を${count}件集められませんでした（${scenarios.length}件）。`);
  }
  return scenarios;
}

function stableSeedOffset(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildCandidatePositionEntryScenarios(options) {
  const {
    count,
    position,
    character,
    positionEnvironments,
    solveCompletion,
    rules = DEFAULT_RULES,
    battleProfiles = DEFAULT_ENVIRONMENT_BATTLE_PROFILES,
    seed = 909,
    turns = 12,
  } = options;
  const targetPosition = Math.min(5, Math.max(1, Number(position) || 1));
  const selectedProfiles = availableBattleProfiles(battleProfiles);
  const candidateId = String(character.id);
  const conditionedEnvironments = positionEnvironments.map((entries, index) => (
    index === targetPosition - 1
      ? [{ character, weight: 1 }]
      : normalizedEnvironmentEntries(entries).filter((entry) => String(entry.character.id) !== candidateId)
  ));
  const scenarios = [];
  let attemptIndex = 0;
  const maximumAttempts = Math.max(300, count * 120);

  while (scenarios.length < count && attemptIndex < maximumAttempts) {
    const battleProfile = battleProfileAt(selectedProfiles, scenarios.length);
    const actorIndex = attemptIndex % 5;
    const environmentRandom = createRandom(seed + attemptIndex * 1009);
    const candidateRandom = createRandom(seed + stableSeedOffset(candidateId) + attemptIndex * 9176);
    const environmentDecks = createFullEnvironmentDecks(
      9,
      positionEnvironments,
      solveCompletion,
      environmentRandom,
      {},
      { deckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES },
    );
    const candidateDeck = createFullEnvironmentDecks(
      1,
      conditionedEnvironments,
      solveCompletion,
      candidateRandom,
      { [targetPosition]: character },
      { deckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES },
    )[0];
    const allyDecks = environmentDecks.slice(0, 4);
    allyDecks.splice(actorIndex, 0, candidateDeck);
    const enemyDecks = environmentDecks.slice(4);
    const initialState = createBattleState(allyDecks, enemyDecks);

    if (targetPosition === 1) {
      scenarios.push({
        state: compactScenarioState(initialState, { preserveReserveSkills: true }),
        actorIndex,
        position: 1,
        entryCharge: 0,
        entryTurn: 1,
        prefixCharacters: [],
        suffixCharacters: candidateDeck.slice(1),
        battleProfile: battleProfile.id,
        targetPolicy: battleProfile.targetPolicy,
        attackOrderPolicy: battleProfile.attackOrderPolicy,
        playStyle: battleProfile.playStyle,
        candidateConditioned: true,
      });
      attemptIndex += 1;
      continue;
    }

    let captured = null;
    simulateBattle(initialState, rules, {
      turns,
      targetPolicy: battleProfile.targetPolicy,
      attackOrderPolicy: battleProfile.attackOrderPolicy,
      playStyle: battleProfile.playStyle,
      onTurnStart: ({ state: turnState }) => {
        if (captured) return;
        const combatant = turnState.allies[actorIndex];
        if (combatant.deckIndex !== targetPosition - 1) return;
        captured = {
          state: compactScenarioState(turnState, { preserveReserveSkills: true }),
          actorIndex,
          position: targetPosition,
          entryCharge: combatant.skillCounter,
          entryTurn: turnState.turn,
          prefixCharacters: combatant.deck.slice(0, targetPosition - 1),
          suffixCharacters: combatant.deck.slice(targetPosition),
          battleProfile: battleProfile.id,
          targetPolicy: battleProfile.targetPolicy,
          attackOrderPolicy: battleProfile.attackOrderPolicy,
          playStyle: battleProfile.playStyle,
          candidateConditioned: true,
        };
      },
    });
    if (captured) scenarios.push(captured);
    attemptIndex += 1;
  }

  if (scenarios.length < count) {
    throw new Error(character.name + "を固定した" + targetPosition + "枠目の登場状態を" + count + "件集められませんでした（" + scenarios.length + "件）。");
  }
  return scenarios;
}

function withoutUsableSkill(character) {
  return {
    ...character,
    id: `${character.id}:no-skill`,
    name: `${character.name}（スキルなし比較）`,
    skillTurn: 9999,
    maxUses: 0,
    skill: { type: "none", multiplier: 1, hits: 1, duration: 1, target: "enemy_one", targetCount: 1, conditions: [], effects: [] },
    roleTags: [],
  };
}

function prepareCandidateState(scenario, character, solveCompletion, baseline = false, preserveReserveSkills = false) {
  const next = structuredClone(scenario.state);
  const combatant = next.allies[scenario.actorIndex];
  const evaluatedCharacter = baseline ? withoutUsableSkill(character) : character;
  const prefixCharacters = scenario.prefixCharacters ?? (scenario.opener ? [scenario.opener] : []);
  const fixedPositions = Object.fromEntries(prefixCharacters.map((prefixCharacter, index) => [
    index + 1,
    prefixCharacter,
  ]));
  fixedPositions[scenario.position] = character;
  const preferredDeck = [
    ...prefixCharacters,
    character,
    ...(scenario.suffixCharacters ?? []),
  ];
  const preferredPositions = preferredDeck.length === 5
    ? Object.fromEntries(preferredDeck.map((deckCharacter, index) => [index + 1, deckCharacter]))
    : null;
  const completion = (preferredPositions ? solveCompletion(preferredPositions) : null) ?? solveCompletion(fixedPositions);
  if (!completion) return null;
  const futureCharacters = completion.deck
    .slice(scenario.position)
    .map((deckCharacter, index) => (preserveReserveSkills
      ? structuredClone(deckCharacter)
      : lightweightReserve(deckCharacter, `candidate-${character.id}-${index}`)));
  const deck = [evaluatedCharacter, ...futureCharacters];
  next.allies[scenario.actorIndex] = {
    ...combatant,
    deck,
    deckIndex: 0,
    environmentPosition: scenario.position,
    character: evaluatedCharacter,
    activeCharacterId: evaluatedCharacter.id,
    currentHp: evaluatedCharacter.hp,
    maxHp: evaluatedCharacter.hp,
    alive: true,
    isGhost: false,
    reviveUsed: false,
    skillUses: 0,
    buffs: [],
    debuffs: [],
    attributes: [...evaluatedCharacter.attributes],
  };
  return next;
}

function activeDefeated(before, after, side, index) {
  const initial = before[side][index];
  const final = after[side][index];
  return Boolean(
    initial?.alive &&
    !initial.isGhost &&
    (!final?.alive || final.isGhost || final.activeCharacterId !== initial.activeCharacterId)
  );
}

function addMatchup(map, character, defeated) {
  const id = String(character.id);
  const current = map.get(id) ?? { id, name: character.name, appearances: 0, defeats: 0 };
  current.appearances += 1;
  current.defeats += defeated ? 1 : 0;
  map.set(id, current);
}

function summarizeMatchups(matchups) {
  const entries = [...matchups.values()].map((entry) => ({
    ...entry,
    defeatRate: entry.appearances ? entry.defeats / entry.appearances : 0,
  }));
  return {
    distinctEnemies: entries.length,
    macroDefeatRate: average(entries.map((entry) => entry.defeatRate)),
    handledEnemyCount50: entries.filter((entry) => entry.defeatRate >= 0.5).length,
    hardest: [...entries]
      .sort((left, right) => left.defeatRate - right.defeatRate || right.appearances - left.appearances)
      .slice(0, 10),
  };
}

function oneTurnMetrics(initialState, result, actorIndex, position) {
  const finalState = result.state;
  let enemyDefeats = 0;
  let sameSlotEnemyDefeats = 0;
  let sameSlotEnemyUnits = 0;
  let allyDefeats = 0;
  const matchups = [];
  for (let index = 0; index < initialState.enemies.length; index += 1) {
    const defeated = activeDefeated(initialState, finalState, "enemies", index);
    if (defeated) enemyDefeats += 1;
    if ((initialState.enemies[index].environmentPosition ?? initialState.enemies[index].deckIndex + 1) === position) {
      sameSlotEnemyUnits += 1;
      if (defeated) sameSlotEnemyDefeats += 1;
      matchups.push({ character: initialState.enemies[index].character, defeated });
    }
  }
  for (let index = 0; index < initialState.allies.length; index += 1) {
    if (activeDefeated(initialState, finalState, "allies", index)) allyDefeats += 1;
  }
  const selectionEvents = result.history[0]?.phases
    .find((phase) => phase.id === "skill_selection")?.events ?? [];
  const skillUsed = selectionEvents.some((event) => (
    event.side === "allies" && event.actorIndex === actorIndex && event.type === "skill_use"
  ));
  const directDefeats = (result.history[0]?.actions ?? [])
    .filter((action) => action.side === "allies" && action.actorIndex === actorIndex)
    .flatMap((action) => action.hits)
    .filter((hit) => hit.defeated).length;
  return {
    enemyDefeats,
    sameSlotEnemyDefeats,
    sameSlotEnemyUnits,
    allyDefeats,
    candidateSurvived: !activeDefeated(initialState, finalState, "allies", actorIndex),
    skillUsed,
    directDefeats,
    matchups,
  };
}

export function evaluateCandidateInEnvironment(character, scenarios, options) {
  const rules = options.rules ?? DEFAULT_RULES;
  const solveCompletion = options.solveCompletion;
  const entryReady = scenarios.map((scenario) => Number(scenario.entryCharge) >= Number(character.skillTurn));
  const matchupMap = new Map();
  const totals = {
    scenarios: 0,
    enemyUnits: 0,
    enemyDefeats: 0,
    sameSlotEnemyUnits: 0,
    sameSlotEnemyDefeats: 0,
    allyUnits: 0,
    allyDefeats: 0,
    candidateSurvived: 0,
    skillUsed: 0,
    directDefeats: 0,
    favorable: 0,
    tied: 0,
    baselineEnemyDefeats: 0,
    baselineSameSlotEnemyDefeats: 0,
    baselineAllyDefeats: 0,
  };

  for (const scenario of scenarios) {
    const actualState = prepareCandidateState(scenario, character, solveCompletion, false);
    const baselineState = prepareCandidateState(scenario, character, solveCompletion, true);
    if (!actualState || !baselineState) continue;
    const skillCanActivate = canUseSkill(actualState, "allies", scenario.actorIndex);
    const battleOptions = scenarioBattleOptions(scenario);
    const actualResult = simulateBattle(actualState, rules, { turns: 1, ...battleOptions });
    const actual = oneTurnMetrics(actualState, actualResult, scenario.actorIndex, scenario.position);
    const baseline = skillCanActivate
      ? oneTurnMetrics(
          baselineState,
          simulateBattle(baselineState, rules, { turns: 1, ...battleOptions }),
          scenario.actorIndex,
          scenario.position,
        )
      : actual;
    totals.scenarios += 1;
    totals.enemyUnits += actualState.enemies.filter((combatant) => combatant.alive && !combatant.isGhost).length;
    totals.enemyDefeats += actual.enemyDefeats;
    totals.sameSlotEnemyUnits += actual.sameSlotEnemyUnits;
    totals.sameSlotEnemyDefeats += actual.sameSlotEnemyDefeats;
    totals.allyUnits += actualState.allies.filter((combatant) => combatant.alive && !combatant.isGhost).length;
    totals.allyDefeats += actual.allyDefeats;
    totals.candidateSurvived += actual.candidateSurvived ? 1 : 0;
    totals.skillUsed += actual.skillUsed ? 1 : 0;
    totals.directDefeats += actual.directDefeats;
    totals.baselineEnemyDefeats += baseline.enemyDefeats;
    totals.baselineSameSlotEnemyDefeats += baseline.sameSlotEnemyDefeats;
    totals.baselineAllyDefeats += baseline.allyDefeats;
    if (actual.enemyDefeats > actual.allyDefeats) totals.favorable += 1;
    else if (actual.enemyDefeats === actual.allyDefeats) totals.tied += 1;
    for (const matchup of actual.matchups) addMatchup(matchupMap, matchup.character, matchup.defeated);
  }

  const matchups = summarizeMatchups(matchupMap);
  const scenarioCount = Math.max(1, totals.scenarios);
  return {
    character,
    position: Math.min(5, Math.max(1, Number(scenarios[0]?.position) || 5)),
    scenarioCount: totals.scenarios,
    offense: {
      allBoardDefeatRate: totals.enemyUnits ? totals.enemyDefeats / totals.enemyUnits : 0,
      sameSlotEnemyObservations: totals.sameSlotEnemyUnits,
      sameSlotDefeatRate: totals.sameSlotEnemyUnits ? totals.sameSlotEnemyDefeats / totals.sameSlotEnemyUnits : 0,
      sameSlotDefeatLowerBound: wilsonLowerBound(totals.sameSlotEnemyDefeats, totals.sameSlotEnemyUnits),
      macroSameSlotDefeatRate: matchups.macroDefeatRate,
      handledEnemyCount50: matchups.handledEnemyCount50,
      distinctEnemies: matchups.distinctEnemies,
      directDefeatsPerScenario: totals.directDefeats / scenarioCount,
      skillAddedDefeatsPerScenario: (totals.enemyDefeats - totals.baselineEnemyDefeats) / scenarioCount,
      skillAddedSameSlotDefeatsPerScenario: (
        totals.sameSlotEnemyDefeats - totals.baselineSameSlotEnemyDefeats
      ) / scenarioCount,
      hardestEnemies: matchups.hardest,
    },
    defense: {
      allyObservations: totals.allyUnits,
      allyRetentionRate: totals.allyUnits ? 1 - totals.allyDefeats / totals.allyUnits : 0,
      allyRetentionLowerBound: wilsonLowerBound(totals.allyUnits - totals.allyDefeats, totals.allyUnits),
      candidateSurvivalRate: totals.candidateSurvived / scenarioCount,
      skillPreventedDefeatsPerScenario: (totals.baselineAllyDefeats - totals.allyDefeats) / scenarioCount,
    },
    reproduction: {
      skillActivationRate: totals.skillUsed / scenarioCount,
      entryReadyRate: entryReady.filter(Boolean).length / Math.max(1, entryReady.length),
      scenarioCoverageRate: totals.scenarios / Math.max(1, scenarios.length),
    },
    outcome: {
      favorableRate: totals.favorable / scenarioCount,
      tieRate: totals.tied / scenarioCount,
      nonLosingRate: (totals.favorable + totals.tied) / scenarioCount,
      nonLosingLowerBound: wilsonLowerBound(totals.favorable + totals.tied, totals.scenarios),
    },
  };
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

export function projectedMatchWinValue(result) {
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

function meanLowerBound(values, z = 1.96) {
  if (!values.length) return 0;
  const mean = average(values);
  if (values.length === 1) return mean;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return clampUnit(mean - z * Math.sqrt(variance / values.length));
}

function supportsContinuationEvaluation(character) {
  return Number(character?.skill?.duration) > 1 && [
    "attack_buff",
    "damage_reduction",
    "guard",
    "attribute_guard",
    "attribute_change",
    "aoe_attack",
    "multi_hit_attack",
  ].includes(character?.skill?.type);
}

function continuationForSource(result, characterId) {
  return result.metrics?.continuation?.bySource?.[String(characterId)] ?? {
    attackHits: 0,
    carriedAttackHits: 0,
    defenseHits: 0,
    carriedDefenseHits: 0,
  };
}

function weightedBalance(retention, pressure) {
  if (retention <= 0 || pressure <= 0) return 0;
  return 1 / (0.6 / retention + 0.4 / pressure);
}

function candidateSkillUsed(result, characterId) {
  return result.history.some(({ phases }) => phases
    .find((phase) => phase.id === "skill_selection")?.events
    .some((event) => event.actorId === characterId && event.type === "skill_use"));
}

const ADVANTAGE_SKILL_TYPES = new Set([
  "attribute_guard",
  "damage_reduction",
  "guard",
  "heal",
  "revive",
]);
const COUNTERACTION_SKILL_TYPES = new Set([
  "aoe_attack",
  "single_attack",
  "attack_buff",
  "multi_hit_attack",
]);

export function classifyStrategicAction(character) {
  const skillType = character?.skill?.type ?? "none";
  if (ADVANTAGE_SKILL_TYPES.has(skillType)) return "advantage_creation";
  if (COUNTERACTION_SKILL_TYPES.has(skillType)) return "counteraction";
  if (skillType === "attribute_change") return "adaptive";
  if (skillType === "delay" || skillType === "skill_reduction") return "ignored";
  return "none";
}

export function evaluateCandidateMatchOutcome(character, scenarios, options) {
  const rules = options.rules ?? DEFAULT_RULES;
  const solveCompletion = options.solveCompletion;
  const turns = Math.min(12, Math.max(1, Number(options.turns) || 12));
  const winValues = [];
  const baselineWinValues = [];
  const entryReady = scenarios.map((scenario) => Number(scenario.entryCharge) >= Number(character.skillTurn));
  const strategicActionClass = classifyStrategicAction(character);
  const totals = {
    scenarios: 0,
    decisiveWins: 0,
    decisiveDraws: 0,
    decisiveLosses: 0,
    ongoing: 0,
    allyRetention: 0,
    enemyPressure: 0,
    balance: 0,
    advantageCreation: 0,
    counteraction: 0,
    allyPreservationNet: 0,
    enemyRemovalNet: 0,
    skillUsed: 0,
    continuedActionScenarios: 0,
    carriedActionScenarios: 0,
    continuedAttackHits: 0,
    continuedDefenseHits: 0,
    carriedAttackHits: 0,
    carriedDefenseHits: 0,
    continuationWinGain: 0,
  };
  const continuationEligible = supportsContinuationEvaluation(character);
  const tacticalProfiles = new Map();

  for (const scenario of scenarios) {
    const actualState = prepareCandidateState(scenario, character, solveCompletion, false, true);
    const baselineState = prepareCandidateState(scenario, character, solveCompletion, true, true);
    if (!actualState || !baselineState) continue;
    const battleOptions = { turns, ...scenarioBattleOptions(scenario) };
    const actual = simulateBattle(actualState, rules, battleOptions);
    const baseline = simulateBattle(baselineState, rules, battleOptions);
    const actualWinValue = projectedMatchWinValue(actual);
    const baselineWinValue = projectedMatchWinValue(baseline);
    const initialAllyCount = Math.max(1, actual.initial.allies.remainingCharacters);
    const initialEnemyCount = Math.max(1, actual.initial.enemies.remainingCharacters);
    const allyRetention = clampUnit(1 - actual.metrics.allyLosses / initialAllyCount);
    const enemyPressure = clampUnit(actual.metrics.enemyLosses / initialEnemyCount);
    const allyPreservationNet = baseline.metrics.allyLosses - actual.metrics.allyLosses;
    const enemyRemovalNet = actual.metrics.enemyLosses - baseline.metrics.enemyLosses;

    totals.scenarios += 1;
    winValues.push(actualWinValue);
    baselineWinValues.push(baselineWinValue);
    if (actual.outcome === "allies") totals.decisiveWins += 1;
    else if (actual.outcome === "draw") totals.decisiveDraws += 1;
    else if (actual.outcome === "enemies") totals.decisiveLosses += 1;
    else totals.ongoing += 1;
    totals.allyRetention += allyRetention;
    totals.enemyPressure += enemyPressure;
    totals.balance += weightedBalance(allyRetention, enemyPressure);
    if (strategicActionClass === "advantage_creation" || strategicActionClass === "adaptive") {
      totals.advantageCreation += Math.max(0, allyPreservationNet);
    }
    if (strategicActionClass === "counteraction" || strategicActionClass === "adaptive") {
      totals.counteraction += Math.max(0, enemyRemovalNet);
    }
    totals.allyPreservationNet += allyPreservationNet;
    totals.enemyRemovalNet += enemyRemovalNet;
    const profileId = String(scenario.battleProfile ?? "stock-balance");
    const profileTotals = tacticalProfiles.get(profileId) ?? {
      scenarios: 0,
      winValue: 0,
      baselineWinValue: 0,
      skillUsed: 0,
      allyPreservationNet: 0,
      enemyRemovalNet: 0,
    };
    profileTotals.scenarios += 1;
    profileTotals.winValue += actualWinValue;
    profileTotals.baselineWinValue += baselineWinValue;
    const skillUsed = candidateSkillUsed(actual, String(character.id));
    profileTotals.skillUsed += skillUsed ? 1 : 0;
    profileTotals.allyPreservationNet += allyPreservationNet;
    profileTotals.enemyRemovalNet += enemyRemovalNet;
    tacticalProfiles.set(profileId, profileTotals);
    totals.skillUsed += skillUsed ? 1 : 0;
    if (continuationEligible) {
      const continuation = continuationForSource(actual, character.id);
      const continuedHits = continuation.attackHits + continuation.defenseHits;
      const carriedHits = continuation.carriedAttackHits + continuation.carriedDefenseHits;
      totals.continuedActionScenarios += continuedHits > 0 ? 1 : 0;
      totals.carriedActionScenarios += carriedHits > 0 ? 1 : 0;
      totals.continuedAttackHits += continuation.attackHits;
      totals.continuedDefenseHits += continuation.defenseHits;
      totals.carriedAttackHits += continuation.carriedAttackHits;
      totals.carriedDefenseHits += continuation.carriedDefenseHits;
      if (continuedHits > 0) totals.continuationWinGain += Math.max(0, actualWinValue - baselineWinValue);
    }
  }

  const scenarioCount = Math.max(1, totals.scenarios);
  const expectedWinRate = average(winValues);
  const baselineExpectedWinRate = average(baselineWinValues);
  const tacticalProfileResults = Object.fromEntries([...tacticalProfiles.entries()].map(([profileId, profileTotals]) => {
    const profileScenarioCount = Math.max(1, profileTotals.scenarios);
    const profileExpectedWinRate = profileTotals.winValue / profileScenarioCount;
    const profileBaselineWinRate = profileTotals.baselineWinValue / profileScenarioCount;
    return [profileId, {
      scenarioCount: profileTotals.scenarios,
      expectedWinRate: profileExpectedWinRate,
      baselineExpectedWinRate: profileBaselineWinRate,
      skillWinGain: profileExpectedWinRate - profileBaselineWinRate,
      skillActivationRate: profileTotals.skillUsed / profileScenarioCount,
      allyPreservationNetPerScenario: profileTotals.allyPreservationNet / profileScenarioCount,
      enemyRemovalNetPerScenario: profileTotals.enemyRemovalNet / profileScenarioCount,
    }];
  }));
  return {
    character,
    position: Math.min(5, Math.max(1, Number(scenarios[0]?.position) || 5)),
    scenarioCount: totals.scenarios,
    matchOutcome: {
      expectedWinRate,
      expectedWinLowerBound: meanLowerBound(winValues),
      decisiveWinRate: totals.decisiveWins / scenarioCount,
      decisiveDrawRate: totals.decisiveDraws / scenarioCount,
      decisiveLossRate: totals.decisiveLosses / scenarioCount,
      ongoingRate: totals.ongoing / scenarioCount,
      baselineExpectedWinRate,
      skillWinGain: expectedWinRate - baselineExpectedWinRate,
    },
    teamBalance: {
      allyRetentionRate: totals.allyRetention / scenarioCount,
      enemyPressureRate: totals.enemyPressure / scenarioCount,
      balancedContribution: totals.balance / scenarioCount,
    },
    strategicActions: {
      class: strategicActionClass,
      advantageCreationPerScenario: totals.advantageCreation / scenarioCount,
      counteractionPerScenario: totals.counteraction / scenarioCount,
      allyPreservationNetPerScenario: totals.allyPreservationNet / scenarioCount,
      enemyRemovalNetPerScenario: totals.enemyRemovalNet / scenarioCount,
    },
    continuation: {
      eligible: continuationEligible,
      continuedActionRate: totals.continuedActionScenarios / scenarioCount,
      carriedActionRate: totals.carriedActionScenarios / scenarioCount,
      continuedAttackHitsPerScenario: totals.continuedAttackHits / scenarioCount,
      continuedDefenseHitsPerScenario: totals.continuedDefenseHits / scenarioCount,
      carriedAttackHitsPerScenario: totals.carriedAttackHits / scenarioCount,
      carriedDefenseHitsPerScenario: totals.carriedDefenseHits / scenarioCount,
      winGainPerScenario: totals.continuationWinGain / scenarioCount,
    },
    reproduction: {
      skillActivationRate: totals.skillUsed / scenarioCount,
      entryReadyRate: entryReady.filter(Boolean).length / Math.max(1, entryReady.length),
      scenarioCoverageRate: totals.scenarios / Math.max(1, scenarios.length),
    },
    tacticalProfiles: tacticalProfileResults,
  };
}

function assignRanks(results, selector, rankKey) {
  const sorted = [...results].sort(selector);
  sorted.forEach((result, index) => {
    result.ranks ??= {};
    result.ranks[rankKey] = index + 1;
  });
  return sorted;
}

export function rankEnvironmentResults(results) {
  const offense = assignRanks(results, (left, right) => (
    right.offense.sameSlotDefeatLowerBound - left.offense.sameSlotDefeatLowerBound ||
    right.offense.sameSlotDefeatRate - left.offense.sameSlotDefeatRate ||
    right.offense.macroSameSlotDefeatRate - left.offense.macroSameSlotDefeatRate ||
    right.offense.skillAddedDefeatsPerScenario - left.offense.skillAddedDefeatsPerScenario ||
    right.offense.directDefeatsPerScenario - left.offense.directDefeatsPerScenario
  ), "offense");
  const defense = assignRanks(results, (left, right) => (
    right.defense.allyRetentionLowerBound - left.defense.allyRetentionLowerBound ||
    right.defense.allyRetentionRate - left.defense.allyRetentionRate ||
    right.defense.skillPreventedDefeatsPerScenario - left.defense.skillPreventedDefeatsPerScenario ||
    right.defense.candidateSurvivalRate - left.defense.candidateSurvivalRate
  ), "defense");
  const overall = assignRanks(results, (left, right) => (
    right.outcome.nonLosingLowerBound - left.outcome.nonLosingLowerBound ||
    right.outcome.nonLosingRate - left.outcome.nonLosingRate ||
    right.outcome.favorableRate - left.outcome.favorableRate ||
    right.offense.sameSlotDefeatRate - left.offense.sameSlotDefeatRate ||
    right.defense.allyRetentionRate - left.defense.allyRetentionRate
  ), "overall");
  return { offense, defense, overall };
}

export function buildWeightedEnvironment(rankings, options = {}) {
  const overallLimit = options.overallLimit ?? 80;
  const offenseLimit = options.offenseLimit ?? 60;
  const defenseLimit = options.defenseLimit ?? 60;
  const weighted = [];
  const append = (results, limit, copies) => {
    for (const result of results.slice(0, limit)) {
      for (let count = 0; count < copies; count += 1) weighted.push(result.character);
    }
  };
  append(rankings.overall, overallLimit, 3);
  append(rankings.offense, offenseLimit, 2);
  append(rankings.defense, defenseLimit, 2);
  return weighted;
}

function readinessRates(scenarios, maximumTurn) {
  return Object.fromEntries(Array.from({ length: maximumTurn + 1 }, (_, skillTurn) => [
    skillTurn,
    scenarios.filter((scenario) => scenario.entryCharge >= skillTurn).length / Math.max(1, scenarios.length),
  ]));
}

function groupedReadiness(scenarios, keySelector, maximumTurn) {
  const groups = new Map();
  for (const scenario of scenarios) {
    const key = String(keySelector(scenario));
    const group = groups.get(key) ?? [];
    group.push(scenario);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "ja", { numeric: true }))
    .map(([key, group]) => [key, {
      samples: group.length,
      usableRates: readinessRates(group, maximumTurn),
    }]));
}

export function readinessSummary(scenarios, maximumTurn = 5) {
  const counts = new Map();
  for (const scenario of scenarios) counts.set(scenario.entryCharge, (counts.get(scenario.entryCharge) ?? 0) + 1);
  const result = {
    samples: scenarios.length,
    chargeCounts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left - right)),
    usableRates: readinessRates(scenarios, maximumTurn),
  };
  if (scenarios.some((scenario) => scenario.entryTurn !== undefined)) {
    result.entryTurnCounts = Object.fromEntries(Object.entries(groupedReadiness(
      scenarios,
      (scenario) => scenario.entryTurn,
      maximumTurn,
    )).map(([key, group]) => [key, group.samples]));
    result.byEntryTurn = groupedReadiness(scenarios, (scenario) => scenario.entryTurn, maximumTurn);
  }
  if (scenarios.some((scenario) => scenario.battleProfile)) {
    result.byBattleProfile = groupedReadiness(
      scenarios,
      (scenario) => scenario.battleProfile ?? "unspecified",
      maximumTurn,
    );
  }
  return result;
}

export function serializeEnvironmentResult(result) {
  return {
    id: String(result.character.id),
    name: result.character.name,
    attributes: result.character.attributes,
    attributeClass: resolveAttributeClass(result.character.attributes),
    cost: result.character.cost,
    hp: result.character.hp,
    pow: result.character.pow,
    skillTurn: result.character.skillTurn,
    skillType: result.character.skill?.type ?? "none",
    skillName: result.character.skillName ?? "",
    scenarioCount: result.scenarioCount,
    ranks: result.ranks,
    offense: Object.fromEntries(Object.entries(result.offense).map(([key, value]) => [
      key,
      typeof value === "number" ? rounded(value) : value,
    ])),
    defense: Object.fromEntries(Object.entries(result.defense).map(([key, value]) => [key, rounded(value)])),
    reproduction: Object.fromEntries(Object.entries(result.reproduction).map(([key, value]) => [key, rounded(value)])),
    outcome: Object.fromEntries(Object.entries(result.outcome).map(([key, value]) => [key, rounded(value)])),
  };
}
