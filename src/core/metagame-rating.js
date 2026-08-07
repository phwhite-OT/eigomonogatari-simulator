import { resolveAttributeClass } from "../data/rules.js";

export const METAGAME_USAGE_MIX = Object.freeze({
  overall: 0.44,
  advantage: 0.19,
  counter: 0.3,
  continuation: 0.07,
});

export const RARITY_OWNERSHIP_MODEL = Object.freeze({
  N: Object.freeze({ base: 0.97, strongCap: 1 }),
  R: Object.freeze({ base: 0.95, strongCap: 1 }),
  CR: Object.freeze({ base: 0.9, strongCap: 0.99 }),
  ZR: Object.freeze({ base: 0.76, strongCap: 0.97 }),
  MZR: Object.freeze({ base: 0.55, strongCap: 0.92 }),
  伝: Object.freeze({ base: 0.1, strongCap: 0.4 }),
});

function rounded(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

export function estimateOwnershipProbability(character, strengthPercentile = 0.5) {
  const model = RARITY_OWNERSHIP_MODEL[character?.rarity] ?? { base: 0.7, strongCap: 0.95 };
  const strength = clampUnit(strengthPercentile);
  return model.base + (model.strongCap - model.base) * strength ** 0.6;
}

function normalizedStatScore(character, maximumHp, maximumPower, position) {
  const hp = Math.max(0, Number(character.hp) || 0) / Math.max(1, maximumHp);
  const power = Math.max(0, Number(character.pow) || 0) / Math.max(1, maximumPower);
  const expectedCharge = Math.max(0, position - 1);
  const skillReach = position === 1
    ? Number(character.skillTurn) === 0 ? 1 : 0
    : Number(character.skillTurn) <= expectedCharge + 1 ? 1 : 0;
  return hp * 0.5 + power * 0.45 + skillReach * 0.05;
}

export function blendUsageEnvironments(baseEnvironment, priorEnvironment, priorWeight = 0.25) {
  const priorRatio = clampUnit(Number(priorWeight));
  const baseRatio = 1 - priorRatio;
  const normalize = (entries) => {
    const normalized = (entries ?? []).map((value) => ({
      character: value.character ?? value,
      weight: Math.max(0, Number(value.weight ?? value.projectedUsageShare ?? 1) || 0),
    })).filter((entry) => entry.character?.id && entry.weight > 0);
    const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
    return normalized.map((entry) => ({ ...entry, share: total > 0 ? entry.weight / total : 0 }));
  };
  const combined = new Map();
  for (const [entries, ratio] of [
    [normalize(baseEnvironment), baseRatio],
    [normalize(priorEnvironment), priorRatio],
  ]) {
    for (const entry of entries) {
      const id = String(entry.character.id);
      const current = combined.get(id) ?? { character: entry.character, weight: 0 };
      current.weight += entry.share * ratio;
      combined.set(id, current);
    }
  }
  return [...combined.values()].filter((entry) => entry.weight > 0).map((entry) => ({
    ...entry,
    source: "blended-warm-start",
  }));
}

export function buildBootstrapEnvironment(characters, position) {
  const maximumHp = Math.max(1, ...characters.map((character) => Number(character.hp) || 0));
  const maximumPower = Math.max(1, ...characters.map((character) => Number(character.pow) || 0));
  const ranked = characters.map((character) => ({
    character,
    score: normalizedStatScore(character, maximumHp, maximumPower, position),
  })).sort((left, right) => right.score - left.score || String(left.character.id).localeCompare(String(right.character.id)));
  const denominator = Math.max(1, ranked.length - 1);
  return ranked.map((entry, index) => {
    const qualityPercentile = 1 - index / denominator;
    const ownershipProbability = estimateOwnershipProbability(entry.character, qualityPercentile);
    return {
      character: entry.character,
      weight: ownershipProbability * (0.03 + 0.97 * qualityPercentile ** 3),
      ownershipProbability,
      qualityPercentile,
      source: "bootstrap",
    };
  });
}

function scenarioCoverage(result) {
  return Number(result.reproduction?.scenarioCoverageRate ?? 1);
}

function resultPosition(result) {
  return Math.min(5, Math.max(1, Number(result.practical?.position ?? result.position) || 5));
}

function hasActionableSkill(result) {
  const skillType = result.character?.skill?.type ?? "none";
  return !["none", "delay", "skill_reduction"].includes(skillType);
}

export function calculatePracticalMetagameMetrics(result, maximumPower = 1) {
  const position = resultPosition(result);
  const skillTurn = Math.max(0, Number(result.character?.skillTurn) || 0);
  const entryReadyRate = clampUnit(Number(result.reproduction?.entryReadyRate) || 0);
  const skillActivationRate = clampUnit(Number(result.reproduction?.skillActivationRate) || 0);
  const actionableSkill = hasActionableSkill(result);
  const expectedCharge = position - 1;
  const excessSkillTurn = Math.max(0, skillTurn - expectedCharge);
  const earlyExposure = position === 1
    ? skillTurn === 0 ? 0.92 : 0.28
    : position === 2 ? 0.72
      : position === 3 ? 0.86
        : 1;
  const timingFactor = excessSkillTurn ? 0.42 ** excessSkillTurn : 1;
  const practicalSkillReliability = actionableSkill
    ? clampUnit(Math.min(entryReadyRate, skillActivationRate) * earlyExposure * timingFactor)
    : 1;
  const skillValue = Math.max(0, Number(result.matchOutcome?.skillWinGain) || 0) + (
    Math.max(0, Number(result.strategicActions?.advantageCreationPerScenario) || 0) +
    Math.max(0, Number(result.strategicActions?.counteractionPerScenario) || 0)
  ) * 0.06;
  const earlySkillLiability = actionableSkill
    ? Math.min(0.24, (1 - practicalSkillReliability) * (0.09 + skillValue * 0.3))
    : 0;
  const powerPreference = clampUnit((Number(result.character?.pow) || 0) / Math.max(1, maximumPower));
  const enemyPressure = clampUnit(Number(result.teamBalance?.enemyPressureRate) || 0);
  const continuationValue = clampUnit(Number(result.continuation?.winGainPerScenario) || 0);
  const practicalValue = clampUnit(
    clampUnit(Number(result.matchOutcome?.expectedWinLowerBound) || 0) * 0.38 +
    clampUnit(Number(result.matchOutcome?.expectedWinRate) || 0) * 0.2 +
    clampUnit(Number(result.teamBalance?.balancedContribution) || 0) * 0.08 +
    enemyPressure * 0.1 +
    powerPreference * 0.12 +
    continuationValue * 0.04 +
    practicalSkillReliability * 0.08 -
    earlySkillLiability
  );
  return {
    position,
    practicalSkillReliability,
    earlySkillLiability,
    powerPreference,
    practicalValue,
  };
}

function preparePracticalMetagameMetrics(results) {
  const maximumPower = Math.max(1, ...results.map((result) => Number(result.character?.pow) || 0));
  results.forEach((result) => {
    result.practical = calculatePracticalMetagameMetrics(result, maximumPower);
  });
}

function assignRanks(results, selector, key) {
  const sorted = [...results].sort(selector);
  sorted.forEach((result, index) => {
    result.ranks ??= {};
    result.ranks[key] = index + 1;
  });
  return sorted;
}

export function rankMetagameResults(results) {
  preparePracticalMetagameMetrics(results);
  const overall = assignRanks(results, (left, right) => (
    scenarioCoverage(right) - scenarioCoverage(left) ||
    right.practical.practicalValue - left.practical.practicalValue ||
    right.matchOutcome.expectedWinLowerBound - left.matchOutcome.expectedWinLowerBound ||
    right.matchOutcome.expectedWinRate - left.matchOutcome.expectedWinRate ||
    right.teamBalance.balancedContribution - left.teamBalance.balancedContribution ||
    right.strategicActions.advantageCreationPerScenario - left.strategicActions.advantageCreationPerScenario ||
    right.strategicActions.counteractionPerScenario - left.strategicActions.counteractionPerScenario
  ), "overall");
  const advantage = assignRanks(results, (left, right) => (
    right.strategicActions.advantageCreationPerScenario - left.strategicActions.advantageCreationPerScenario ||
    right.practical.practicalValue - left.practical.practicalValue ||
    right.matchOutcome.expectedWinLowerBound - left.matchOutcome.expectedWinLowerBound ||
    right.teamBalance.balancedContribution - left.teamBalance.balancedContribution ||
    right.strategicActions.counteractionPerScenario - left.strategicActions.counteractionPerScenario
  ), "advantage");
  const counter = assignRanks(results, (left, right) => (
    right.strategicActions.counteractionPerScenario - left.strategicActions.counteractionPerScenario ||
    right.practical.practicalValue - left.practical.practicalValue ||
    right.matchOutcome.expectedWinLowerBound - left.matchOutcome.expectedWinLowerBound ||
    right.teamBalance.balancedContribution - left.teamBalance.balancedContribution ||
    right.strategicActions.advantageCreationPerScenario - left.strategicActions.advantageCreationPerScenario
  ), "counter");
  const continuation = assignRanks(results, (left, right) => (
    Number(right.continuation?.winGainPerScenario) - Number(left.continuation?.winGainPerScenario) ||
    right.practical.practicalValue - left.practical.practicalValue ||
    Number(right.continuation?.carriedActionRate) - Number(left.continuation?.carriedActionRate) ||
    Number(right.continuation?.continuedActionRate) - Number(left.continuation?.continuedActionRate) ||
    right.matchOutcome.expectedWinLowerBound - left.matchOutcome.expectedWinLowerBound
  ), "continuation");
  return { overall, advantage, counter, continuation };
}

export function selectDetailedCandidates(rankings, limit = 150) {
  const maximum = Math.max(0, Math.min(
    Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 150,
    rankings.overall.length,
  ));
  if (maximum === 0) return [];

  const selected = new Map();
  const add = (result) => {
    if (selected.size >= maximum) return;
    selected.set(String(result.character.id), result.character);
  };
  const specialistQuota = Math.max(1, Math.floor(maximum * 0.2));
  const continuation = rankings.continuation ?? [];
  rankings.advantage.slice(0, specialistQuota).forEach(add);
  rankings.counter.slice(0, specialistQuota).forEach(add);
  continuation.slice(0, specialistQuota).forEach(add);
  rankings.overall.forEach(add);
  rankings.advantage.forEach(add);
  rankings.counter.forEach(add);
  continuation.forEach(add);
  return [...selected.values()];
}

export function buildUsageEnvironment(rankings, options = {}) {
  const temperature = Math.max(5, Number(options.temperature) || 35);
  const exploration = Math.max(0, Number(options.exploration) || 0.01);
  const mix = { ...METAGAME_USAGE_MIX, ...(options.mix ?? {}) };
  const results = rankings.overall;
  const denominator = Math.max(1, results.length - 1);
  const advantageRanks = new Map(rankings.advantage.map((result, index) => [String(result.character.id), index]));
  const counterRanks = new Map(rankings.counter.map((result, index) => [String(result.character.id), index]));
  const continuationRanks = new Map((rankings.continuation ?? []).map((result, index) => [String(result.character.id), index]));
  const entries = results.map((result, index) => {
    const qualityPercentile = 1 - index / denominator;
    const ownershipProbability = estimateOwnershipProbability(result.character, qualityPercentile);
    const advantageRank = advantageRanks.get(String(result.character.id)) ?? results.length;
    const counterRank = counterRanks.get(String(result.character.id)) ?? results.length;
    const continuationRank = continuationRanks.get(String(result.character.id)) ?? results.length;
    const rankPreference = (
      mix.overall * Math.exp(-index / temperature) +
      mix.advantage * Math.exp(-advantageRank / temperature) +
      mix.counter * Math.exp(-counterRank / temperature) +
      (Number(mix.continuation) || 0) * Math.exp(-continuationRank / temperature)
    );
    const advantage = Number(result.strategicActions?.advantageCreationPerScenario) || 0;
    const counter = Number(result.strategicActions?.counteractionPerScenario) || 0;
    const strategicClass = result.strategicActions?.class ?? (
      advantage > counter ? "advantage_creation" : counter > advantage ? "counteraction" : "none"
    );
    const weight = ownershipProbability * (exploration + rankPreference);
    return {
      character: result.character,
      weight,
      ownershipProbability,
      qualityPercentile,
      battleRank: index + 1,
      strategicClass,
    };
  });
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  entries.forEach((entry) => {
    entry.projectedUsageShare = totalWeight > 0 ? entry.weight / totalWeight : 0;
  });
  entries.sort((left, right) => right.projectedUsageShare - left.projectedUsageShare);
  entries.forEach((entry, index) => {
    entry.usageRank = index + 1;
  });
  return entries;
}

export function summarizeStrategicUsage(entries) {
  const summary = {
    advantage_creation: 0,
    counteraction: 0,
    adaptive: 0,
    ignored: 0,
    none: 0,
  };
  for (const entry of entries) {
    const strategicClass = entry.strategicClass ?? "none";
    summary[strategicClass] ??= 0;
    summary[strategicClass] += Number(entry.projectedUsageShare) || 0;
  }
  return summary;
}

export function serializeMetagameResult(result, usageById = new Map()) {
  const usage = usageById.get(String(result.character.id));
  const serializeNumbers = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === "number" ? rounded(item) : item,
  ]));
  return {
    id: String(result.character.id),
    name: result.character.name,
    attributes: result.character.attributes,
    attributeClass: resolveAttributeClass(result.character.attributes),
    rarity: result.character.rarity,
    cost: result.character.cost,
    hp: result.character.hp,
    pow: result.character.pow,
    skillTurn: result.character.skillTurn,
    skillType: result.character.skill?.type ?? "none",
    skillName: result.character.skillName ?? "",
    scenarioCount: result.scenarioCount,
    ranks: result.ranks,
    usage: usage ? {
      rank: usage.usageRank,
      ownershipProbability: rounded(usage.ownershipProbability),
      projectedUsageShare: rounded(usage.projectedUsageShare, 6),
    } : null,
    matchOutcome: serializeNumbers(result.matchOutcome),
    teamBalance: serializeNumbers(result.teamBalance),
    strategicActions: serializeNumbers(result.strategicActions),
    continuation: serializeNumbers(result.continuation ?? {}),
    reproduction: serializeNumbers(result.reproduction),
    practical: serializeNumbers(result.practical ?? {}),
  };
}

export function metagameReportToCsv(report) {
  const headers = [
    "総合順位", "有利獲得順位", "対抗順位", "予測使用順位", "ID", "名前", "属性", "レア度", "コスト",
    "HP", "Power", "スキルターン", "スキル名", "行動区分", "評価盤面数", "予測勝率", "勝率信頼下限",
    "実発動率", "登場時発動可能率", "盤面充足率", "味方維持率", "敵進行率", "攻守均衡", "有利獲得/盤面", "対抗/盤面", "推定所持率", "予測使用率",
  ];
  const rows = report.rankings.overall.map((entry) => [
    entry.ranks.overall,
    entry.ranks.advantage,
    entry.ranks.counter,
    entry.usage?.rank,
    entry.id,
    entry.name,
    entry.attributeClass,
    entry.rarity,
    entry.cost,
    entry.hp,
    entry.pow,
    entry.skillTurn,
    entry.skillName,
    entry.strategicActions.class,
    entry.scenarioCount,
    entry.matchOutcome.expectedWinRate,
    entry.matchOutcome.expectedWinLowerBound,
    entry.reproduction.skillActivationRate,
    entry.reproduction.entryReadyRate,
    entry.reproduction.scenarioCoverageRate,
    entry.teamBalance.allyRetentionRate,
    entry.teamBalance.enemyPressureRate,
    entry.teamBalance.balancedContribution,
    entry.strategicActions.advantageCreationPerScenario,
    entry.strategicActions.counteractionPerScenario,
    entry.usage?.ownershipProbability,
    entry.usage?.projectedUsageShare,
  ]);
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}
