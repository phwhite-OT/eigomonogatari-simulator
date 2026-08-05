import { createBattleState } from "./battleState.js";
import {
  ATTACK_ORDER_POLICIES,
  simulateBattle,
  TARGET_POLICIES,
} from "./simulate.js";
import { DEFAULT_RULES } from "../data/rules.js";

const METAGAME_DECK_PROFILES = Object.freeze([
  Object.freeze({
    targetPolicy: TARGET_POLICIES.BALANCE,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
  }),
  Object.freeze({
    targetPolicy: TARGET_POLICIES.KILL_CONFIRM,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
  }),
  Object.freeze({
    targetPolicy: TARGET_POLICIES.SKILL_THREAT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,
  }),
]);

function metagameDeckClampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function metagameCandidateScore(rating) {
  const advantage = Math.min(1, Math.max(0, Number(rating.advantageCreation) || 0) / 2);
  const counter = Math.min(1, Math.max(0, Number(rating.counteraction) || 0) / 2);
  return (
    metagameDeckClampUnit(rating.expectedWinLowerBound) * 0.44 +
    metagameDeckClampUnit(rating.expectedWinRate) * 0.34 +
    metagameDeckClampUnit(rating.balancedContribution) * 0.1 +
    advantage * 0.055 +
    counter * 0.035 +
    metagameDeckClampUnit(rating.skillActivationRate) * 0.03
  );
}

function metagameDeckStateScore(state, totalCost) {
  const averageScore = state.proxyTotal / Math.max(1, state.deck.length);
  const roleBonus = state.advantageCount > 0 && state.counterCount > 0 ? 0.012 : 0;
  const partialCostPenalty = state.deck.length < 5
    ? state.totalCost / Math.max(1, totalCost) * 0.012
    : 0;
  return averageScore + roleBonus - partialCostPenalty;
}

function metagameTrimDeckBeam(states, width, totalCost) {
  const byId = new Map();
  for (const state of states) {
    const key = state.deck.map((entry) => entry.character.id).join("|");
    const current = byId.get(key);
    if (!current || metagameDeckStateScore(state, totalCost) > metagameDeckStateScore(current, totalCost)) {
      byId.set(key, state);
    }
  }
  const unique = [...byId.values()];
  const selected = new Map();
  const primaryCount = Math.max(1, Math.floor(width * 0.8));
  const primary = [...unique].sort((left, right) => (
    metagameDeckStateScore(right, totalCost) - metagameDeckStateScore(left, totalCost) ||
    left.totalCost - right.totalCost
  ));
  primary.slice(0, primaryCount).forEach((state) => selected.set(
    state.deck.map((entry) => entry.character.id).join("|"),
    state,
  ));
  const costAware = [...unique].sort((left, right) => (
    metagameDeckStateScore(right, totalCost) - right.totalCost / Math.max(1, totalCost) * 0.05 -
      (metagameDeckStateScore(left, totalCost) - left.totalCost / Math.max(1, totalCost) * 0.05) ||
    left.totalCost - right.totalCost
  ));
  for (const state of costAware) {
    if (selected.size >= width) break;
    selected.set(state.deck.map((entry) => entry.character.id).join("|"), state);
  }
  for (const state of primary) {
    if (selected.size >= width) break;
    selected.set(state.deck.map((entry) => entry.character.id).join("|"), state);
  }
  return [...selected.values()];
}

export function buildMetagameDeckCandidates(constraint, characters, options = {}) {
  const totalCost = Number(constraint?.totalCost) || 0;
  const beamWidth = Math.max(50, Number(options.beamWidth) || 2500);
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  const pools = (constraint?.slots ?? []).map((slot) => slot.candidates.map((rating) => ({
    character: charactersById.get(String(rating.id)),
    rating,
    proxy: metagameCandidateScore(rating),
  })).filter((entry) => entry.character));
  if (pools.length !== 5 || pools.some((pool) => !pool.length)) {
    throw new Error("この縛りは5枠分の詳細評価データが揃っていません。");
  }

  let states = [{
    deck: [],
    ids: new Set(),
    totalCost: 0,
    legendCount: 0,
    proxyTotal: 0,
    advantageCount: 0,
    counterCount: 0,
  }];
  for (const pool of pools) {
    const expanded = [];
    for (const state of states) {
      for (const entry of pool) {
        const id = String(entry.character.id);
        const isLegend = entry.character.rarity === "伝";
        const nextCost = state.totalCost + (Number(entry.character.cost) || 0);
        if (state.ids.has(id) || nextCost > totalCost || (isLegend && state.legendCount >= 1)) continue;
        const ids = new Set(state.ids);
        ids.add(id);
        expanded.push({
          deck: [...state.deck, entry],
          ids,
          totalCost: nextCost,
          legendCount: state.legendCount + (isLegend ? 1 : 0),
          proxyTotal: state.proxyTotal + entry.proxy,
          advantageCount: state.advantageCount + (entry.rating.advantageCreation > 0 ? 1 : 0),
          counterCount: state.counterCount + (entry.rating.counteraction > 0 ? 1 : 0),
        });
      }
    }
    states = metagameTrimDeckBeam(expanded, beamWidth, totalCost);
    if (!states.length) throw new Error("詳細評価候補から総コスト内の5体を構成できませんでした。");
  }
  return states.map((state) => ({
    deck: state.deck.map((entry) => entry.character),
    ratings: state.deck.map((entry) => entry.rating),
    totalCost: state.totalCost,
    proxyScore: metagameDeckStateScore(state, totalCost),
    advantageCount: state.advantageCount,
    counterCount: state.counterCount,
  })).sort((left, right) => right.proxyScore - left.proxyScore || left.totalCost - right.totalCost);
}

function metagameSelectFinalists(candidates, limit) {
  const maximum = Math.min(candidates.length, Math.max(10, Number(limit) || 12));
  const selected = new Map();
  const add = (candidate) => selected.set(candidate.deck.map((character) => character.id).join("|"), candidate);
  candidates.slice(0, Math.ceil(maximum * 0.55)).forEach(add);
  const selectors = [
    (left, right) => right.advantageCount - left.advantageCount || right.proxyScore - left.proxyScore,
    (left, right) => right.counterCount - left.counterCount || right.proxyScore - left.proxyScore,
    (left, right) => left.totalCost - right.totalCost || right.proxyScore - left.proxyScore,
  ];
  for (const selector of selectors) {
    for (const candidate of [...candidates].sort(selector)) {
      if (selected.size >= maximum) break;
      add(candidate);
    }
  }
  for (const candidate of candidates) {
    if (selected.size >= maximum) break;
    add(candidate);
  }
  return [...selected.values()];
}

function metagameProjectedWinValue(result) {
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
  return metagameDeckClampUnit(0.5 + (enemyProgress - allyProgress) * 0.35 + (allyHp - enemyHp) * 0.15);
}

function metagameMeanLowerBound(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return mean;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return metagameDeckClampUnit(mean - 1.96 * Math.sqrt(variance / values.length));
}

function metagameAbortError() {
  const error = new Error("デッキシミュレーションを中止しました。");
  error.name = "AbortError";
  return error;
}

function metagameHydrateEnvironment(constraint, charactersById) {
  return constraint.environmentScenarios.map((scenario) => scenario.map((deck) => deck.map((id) => {
    const character = charactersById.get(String(id));
    if (!character) throw new Error(`環境キャラID ${id} がキャラクターデータにありません。`);
    return character;
  })));
}

async function metagameEvaluateDeck(candidate, scenarios, constraint, rules, options) {
  const winValues = [];
  const outcomes = { allies: 0, draw: 0, enemies: 0, ongoing: 0 };
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    if (options.signal?.aborted) throw metagameAbortError();
    const environmentDecks = scenarios[scenarioIndex];
    const actorIndex = scenarioIndex % 5;
    const allyDecks = environmentDecks.slice(0, 4);
    allyDecks.splice(actorIndex, 0, candidate.deck);
    const profile = METAGAME_DECK_PROFILES[scenarioIndex % METAGAME_DECK_PROFILES.length];
    const result = simulateBattle(
      createBattleState(allyDecks, environmentDecks.slice(4)),
      rules,
      {
        turns: constraint.turns,
        targetPolicy: profile.targetPolicy,
        attackOrderPolicy: profile.attackOrderPolicy,
      },
    );
    winValues.push(metagameProjectedWinValue(result));
    outcomes[result.outcome] += 1;
    options.onScenarioCompleted?.();
    if ((scenarioIndex + 1) % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const expectedWinRate = winValues.reduce((sum, value) => sum + value, 0) / Math.max(1, winValues.length);
  return {
    ...candidate,
    expectedWinRate,
    expectedWinLowerBound: metagameMeanLowerBound(winValues),
    scenarioCount: winValues.length,
    decisiveWinRate: outcomes.allies / Math.max(1, winValues.length),
    decisiveDrawRate: outcomes.draw / Math.max(1, winValues.length),
    decisiveLossRate: outcomes.enemies / Math.max(1, winValues.length),
    ongoingRate: outcomes.ongoing / Math.max(1, winValues.length),
  };
}

export async function findBestMetagameDeck(data, constraintId, characters, options = {}) {
  const constraint = data?.constraints?.find((entry) => entry.id === constraintId);
  if (!constraint) throw new Error("選択した縛りの調査データがありません。");
  const charactersById = new Map(characters.map((character) => [String(character.id), character]));
  options.onProgress?.({ phase: "candidate", completed: 0, total: 1 });
  const candidates = buildMetagameDeckCandidates(constraint, characters, options);
  const finalists = metagameSelectFinalists(candidates, options.finalistCount);
  const scenarios = metagameHydrateEnvironment(constraint, charactersById);
  options.onProgress?.({ phase: "candidate", completed: 1, total: 1, valid: candidates.length });
  const evaluated = [];
  let completedSimulations = 0;
  const totalSimulations = finalists.length * scenarios.length;
  for (let index = 0; index < finalists.length; index += 1) {
    evaluated.push(await metagameEvaluateDeck(
      finalists[index],
      scenarios,
      constraint,
      options.rules ?? DEFAULT_RULES,
      {
        ...options,
        onScenarioCompleted: () => {
          completedSimulations += 1;
          options.onProgress?.({
            phase: "simulation",
            completed: completedSimulations,
            total: totalSimulations,
            valid: candidates.length,
          });
        },
      },
    ));
  }
  evaluated.sort((left, right) => (
    right.expectedWinRate - left.expectedWinRate ||
    right.expectedWinLowerBound - left.expectedWinLowerBound ||
    right.proxyScore - left.proxyScore ||
    left.totalCost - right.totalCost
  ));
  return {
    constraint,
    generatedAt: data.generatedAt,
    candidateDeckCount: candidates.length,
    simulatedDeckCount: finalists.length,
    scenarioCount: scenarios.length,
    results: evaluated.slice(0, 3),
  };
}
