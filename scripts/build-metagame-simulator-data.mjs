import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_SIMULATOR_DATA as EXISTING_METAGAME_SIMULATOR_DATA } from "../src/data/metagame-simulator-data.js";
import { METAGAME_V7_INPUTS } from "../src/data/metagame-v7-inputs.js";
import {
  buildEnvironmentPositionPool,
  DEFAULT_STRATEGIC_DECK_PROFILES,
  createDeckCompletionSolver,
  createFullEnvironmentDecks,
} from "../src/core/environment-rating.js";

const METAGAME_ATTRIBUTE_LABELS = Object.freeze({
  fire: "\u706b",
  water: "\u6c34",
  wind: "\u98a8",
});
const METAGAME_SCENARIO_COUNT = 60;
const METAGAME_MODEL_VERSION = "iterative-metagame-v6-continuation-decks";
const METAGAME_V7_MODEL_VERSION = "fixed-environment-v7.5";
const DEFAULT_METAGAME_SOURCES = Object.freeze([
  ...METAGAME_V7_INPUTS.map((input) => Object.freeze({
    type: "v7",
    inputId: input.id,
    statusPath: `reports/metagame-ratings-v7/${input.id.replaceAll(":", "-")}/progress.json`,
    reportPath: `reports/metagame-ratings-v7/${input.id.replaceAll(":", "-")}/report.json`,
    reportRoot: "reports/metagame-ratings-v7",
    requiredModelVersion: METAGAME_V7_MODEL_VERSION,
    legacy: false,
  })),
  Object.freeze({
    statusPath: "reports/metagame-v6-batch-status.json",
    reportRoot: "reports/metagame-ratings-v6",
    requiredModelVersion: METAGAME_MODEL_VERSION,
    legacy: false,
  }),
]);
function metagameSeededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function readMetagameJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content.replace(/^\uFEFF/, ""));
}

function metagameConstraintIsComplete(completedTaskIds, attributeKey, cost) {
  for (const pass of [1, 2]) {
    for (const position of [1, 2, 3, 4, 5]) {
      if (!completedTaskIds.has(`${pass}:${attributeKey}:${cost}:${position}`)) return false;
    }
  }
  return true;
}

function completedMetagameConstraints(status) {
  const completedTaskIds = new Set(status.completedTaskIds ?? []);
  const completedConstraints = [];
  for (const cost of status.config?.costs ?? []) {
    for (const allowedAttributes of status.config?.attributeGroups ?? []) {
      const attributeKey = allowedAttributes.join("-");
      if (!metagameConstraintIsComplete(completedTaskIds, attributeKey, cost)) continue;
      completedConstraints.push({ allowedAttributes, cost });
    }
  }
  return completedConstraints;
}

function v7CompletedRunCount(progress) {
  return (progress.resultsByPosition ?? []).filter((ratings, index) => (
    ratings.length > 0 && ratings.length >= (progress.context?.candidateIdsByPosition?.[index]?.length ?? Infinity)
  )).length;
}

function hasCompletedV7BrowserData(data) {
  return data?.sourceStatus === "complete"
    && data?.sourceModelCompatible === true
    && /^fixed-environment-v7\./.test(String(data.sourceModelVersion ?? ""))
    && Array.isArray(data.constraints)
    && data.constraints.length > 0;
}

async function readMetagameV7Source(projectRoot, source) {
  const statusPath = path.resolve(projectRoot, source.statusPath);
  const reportPath = path.resolve(projectRoot, source.reportPath);
  try {
    const progress = await readMetagameJson(statusPath);
    const status = {
      status: progress.status ?? "unknown",
      updatedAt: progress.updatedAt ?? null,
      completedRuns: v7CompletedRunCount(progress),
      totalRuns: 5,
      config: { modelVersion: progress.context?.version ?? "unknown", passes: 1 },
    };
    const modelCompatible = status.config.modelVersion === source.requiredModelVersion;
    const complete = modelCompatible && progress.status === "complete";
    const report = complete ? await readMetagameJson(reportPath) : null;
    if (report && report.model?.version !== source.requiredModelVersion) {
      throw new Error(`v7 report model mismatch: ${report.model?.version ?? "unknown"}`);
    }
    return {
      ...source,
      statusPath,
      reportPath,
      reportRoot: path.resolve(projectRoot, source.reportRoot),
      status,
      report,
      modelCompatible,
      completedConstraints: complete && report ? [report] : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function readMetagameSource(projectRoot, source) {
  if (source.type === "v7") return readMetagameV7Source(projectRoot, source);
  const statusPath = path.resolve(projectRoot, source.statusPath);
  try {
    const status = await readMetagameJson(statusPath);
    const modelVersion = status.config?.modelVersion ?? "unknown";
    const modelCompatible = !source.requiredModelVersion || modelVersion === source.requiredModelVersion;
    return {
      ...source,
      statusPath,
      reportRoot: path.resolve(projectRoot, source.reportRoot),
      status,
      modelCompatible,
      completedConstraints: modelCompatible ? completedMetagameConstraints(status) : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function compactMetagameCandidate(entry) {
  return {
    id: String(entry.id),
    name: entry.name,
    attributes: entry.attributes,
    rarity: entry.rarity,
    cost: entry.cost,
    skillTurn: entry.skillTurn,
    skillType: entry.skillType,
    skillName: entry.skillName,
    overallRank: entry.ranks?.overall ?? null,
    scenarioCount: entry.scenarioCount ?? 0,
    expectedWinRate: entry.matchOutcome?.expectedWinRate ?? 0,
    expectedWinLowerBound: entry.matchOutcome?.expectedWinLowerBound ?? 0,
    baselineExpectedWinRate: entry.matchOutcome?.baselineExpectedWinRate ?? 0,
    skillWinGain: entry.matchOutcome?.skillWinGain ?? 0,
    allyRetentionRate: entry.teamBalance?.allyRetentionRate ?? 0,
    enemyPressureRate: entry.teamBalance?.enemyPressureRate ?? 0,
    balancedContribution: entry.teamBalance?.balancedContribution ?? 0,
    practicalValue: entry.practical?.practicalValue ?? 0,
    practicalSkillReliability: entry.practical?.practicalSkillReliability ?? entry.reproduction?.skillActivationRate ?? 0,
    powerPreference: entry.practical?.powerPreference ?? 0,
    combinationPotential: entry.combinationPotential ?? 0,
    tacticalUpside: entry.tactical?.tacticalUpside ?? 0,
    tacticalRisk: entry.tactical?.tacticalRisk ?? 0,
    carriedDefenseRate: entry.continuation?.carriedDefenseHitsPerScenario ?? 0,
    continuationWinGain: entry.continuation?.winGainPerScenario ?? 0,
    carriedContinuationWinGain: entry.continuation?.carriedWinGainPerScenario ?? 0,
    strategicClass: entry.strategicActions?.class ?? "none",
    advantageCreation: entry.strategicActions?.advantageCreationPerScenario ?? 0,
    counteraction: entry.strategicActions?.counteractionPerScenario ?? 0,
    allyPreservationNet: entry.strategicActions?.allyPreservationNetPerScenario ?? 0,
    enemyRemovalNet: entry.strategicActions?.enemyRemovalNetPerScenario ?? 0,
    skillActivationRate: entry.reproduction?.skillActivationRate ?? 0,
  };
}

function detailedMetagameCandidates(report) {
  const finalScenarioCount = Number(report.context?.finalScenarioCount) || 30;
  return report.rankings.overall
    .filter((entry) => (
      entry.evaluationStage === "detailed" ||
      Number(entry.scenarioCount) >= finalScenarioCount
    ))
    .map(compactMetagameCandidate);
}

function metagameUsageEnvironment(report, charactersById) {
  return report.environment.finalUsage.map((entry) => ({
    character: charactersById.get(String(entry.id)),
    weight: Number(entry.projectedUsageShare ?? entry.weight) || 0,
  })).filter((entry) => entry.character && entry.weight > 0);
}

function compactMetagameEnvironment(report, charactersById) {
  return report.environment.finalUsage.slice(0, 10).map((entry) => {
    const character = charactersById.get(String(entry.id));
    return {
      id: String(entry.id),
      name: entry.name,
      attributes: character?.attributes ?? [],
      rarity: entry.rarity,
      cost: character?.cost ?? null,
      battleRank: entry.battleRank,
      usageRank: entry.usageRank,
      projectedUsageShare: entry.projectedUsageShare,
    };
  });
}

function metagameEnvironmentScenarios(decks) {
  const scenarios = [];
  for (let index = 0; index < decks.length; index += 9) {
    scenarios.push(decks.slice(index, index + 9).map((deck) => deck.map((character) => String(character.id))));
  }
  return scenarios;
}

function compactMetagameV7Candidate(entry, character) {
  const skill = character?.skill ?? {};
  const duration = Math.max(1, Number(skill.duration) || 1);
  const defenseTypes = new Set(["damage_reduction", "guard", "attribute_guard", "heal", "revive"]);
  const attackTypes = new Set(["single_attack", "aoe_attack", "attack_buff", "multi_hit_attack"]);
  return {
    id: String(entry.id),
    name: entry.name,
    attributes: entry.attributes,
    rarity: entry.rarity,
    cost: entry.cost,
    skillTurn: entry.skillTurn,
    skillType: entry.skillType,
    skillName: entry.skillName,
    overallRank: entry.rank ?? null,
    scenarioCount: entry.bestDeck?.scenarioCount ?? 0,
    expectedWinRate: entry.bestDeck?.expectedWinRate ?? 0,
    expectedWinLowerBound: entry.bestDeck?.expectedWinLowerBound ?? 0,
    baselineExpectedWinRate: entry.bestDeck?.expectedWinRate ?? 0,
    skillWinGain: 0,
    allyRetentionRate: 0,
    enemyPressureRate: 0,
    balancedContribution: 0,
    practicalValue: entry.bestDeck?.expectedWinRate ?? 0,
    practicalSkillReliability: skill.type && skill.type !== "none" ? 1 : 0,
    powerPreference: 0,
    combinationPotential: duration > 1 ? Math.min(1, (duration - 1) / 4) : 0,
    tacticalUpside: attackTypes.has(skill.type) ? 0.5 : 0,
    tacticalRisk: 0,
    carriedDefenseRate: defenseTypes.has(skill.type) && duration > 1 ? 0.5 : 0,
    continuationWinGain: duration > 1 ? 0.25 : 0,
    carriedContinuationWinGain: duration > 1 ? 0.25 : 0,
    strategicClass: "v7-fixed-environment",
    advantageCreation: defenseTypes.has(skill.type) ? 0.5 : 0,
    counteraction: attackTypes.has(skill.type) ? 0.5 : 0,
    allyPreservationNet: 0,
    enemyRemovalNet: 0,
    skillActivationRate: skill.type && skill.type !== "none" ? 1 : 0,
    v7BestDeck: entry.bestDeck ?? null,
    v7ExampleDeck: entry.exampleDeck ?? null,
  };
}

function compactMetagameV7Deck(entry) {
  const ids = entry?.i ?? entry?.ids;
  if (!Array.isArray(ids) || ids.length !== 5) return null;
  return {
    // Short field names keep the browser payload small. They are expanded by
    // metagame-deck.js when a result is displayed.
    i: ids.map(String),
    c: Number(entry.c ?? entry.totalCost) || 0,
    p: Number(entry.p ?? entry.proxyScore) || 0,
    y: Number(entry.y ?? entry.synergyScore) || 0,
    w: Number(entry.w ?? entry.expectedWinRate) || 0,
    l: Number(entry.l ?? entry.expectedWinLowerBound) || 0,
    s: Number(entry.s ?? entry.scenarioCount) || 0,
    a: Number(entry.a ?? entry.decisiveWinRate) || 0,
    d: Number(entry.d ?? entry.decisiveDrawRate) || 0,
    e: Number(entry.e ?? entry.decisiveLossRate) || 0,
    o: Number(entry.o ?? entry.ongoingRate) || 0,
    x: entry.x ?? (entry.origin === "example" ? "example" : "automatic"),
  };
}

function compactMetagameV7Decks(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const deck = compactMetagameV7Deck(entry?.v7BestDeck ?? entry?.bestDeck ?? entry);
    if (!deck) continue;
    const key = deck.i.join("|");
    const current = unique.get(key);
    if (!current || deck.l > current.l || (deck.l === current.l && deck.w > current.w)) {
      unique.set(key, deck);
    }
  }
  return [...unique.values()].sort((left, right) => (
    right.l - left.l || right.w - left.w || left.c - right.c
  ));
}

function compactPublishedV7Constraint(constraint) {
  const existingDecks = constraint.precomputedDecks ?? [];
  const rankedCandidates = (constraint.slots ?? []).flatMap((slot) => slot.candidates ?? []);
  return {
    ...constraint,
    slots: (constraint.slots ?? []).map((slot) => ({
      position: slot.position,
      environment: slot.environment ?? [],
    })),
    precomputedDecks: compactMetagameV7Decks([...existingDecks, ...rankedCandidates]),
  };
}

function compactPublishedV7Data(data) {
  return {
    ...data,
    constraints: data.constraints.map((constraint) => (
      String(constraint.modelVersion ?? "").startsWith("fixed-environment-v7")
        ? compactPublishedV7Constraint(constraint)
        : constraint
    )),
  };
}

function v7EnvironmentPools(report) {
  if (report.environmentPools?.length === 5) return report.environmentPools;
  return [0, 1, 2, 3, 4].map((index) => {
    const seen = new Set();
    return report.environmentDecks.reduce((pool, deck) => {
      const entry = deck[index];
      if (entry && !seen.has(String(entry.id))) {
        seen.add(String(entry.id));
        pool.push(entry);
      }
      return pool;
    }, []);
  });
}

export function buildMetagameV7Constraint(report, charactersById) {
  const rankings = new Map((report.rankingsByPosition ?? []).map((slot) => [Number(slot.position), slot]));
  const pools = v7EnvironmentPools(report);
  const precomputedDecks = compactMetagameV7Decks(
    [...rankings.values()].flatMap((slot) => slot.characters ?? []),
  );
  return {
    id: report.context?.inputId ?? "fire:100",
    attributeKey: (report.context?.allowedAttributes ?? []).join("-"),
    label: report.context?.label ?? "火・コスト100",
    allowedAttributes: report.context?.allowedAttributes ?? [],
    totalCost: Number(report.context?.totalCost) || 100,
    turns: Number(report.context?.turns) || 12,
    scenarioCount: Number(report.context?.environmentCount) || report.environmentDecks?.length || 0,
    modelVersion: report.model?.version ?? "unknown",
    reportGeneratedAt: report.generatedAt ?? null,
    slots: [1, 2, 3, 4, 5].map((position) => ({
      position,
      environment: (pools[position - 1] ?? []).map((entry) => {
        const character = charactersById.get(String(entry.id));
        return {
          id: String(entry.id),
          name: entry.name ?? character?.name ?? String(entry.id),
          attributes: character?.attributes ?? [],
          rarity: character?.rarity ?? "unknown",
          cost: entry.cost ?? character?.cost ?? null,
          battleRank: null,
          usageRank: null,
          projectedUsageShare: 1 / Math.max(1, (pools[position - 1] ?? []).length),
        };
      }),
    })),
    precomputedDecks,
    environmentScenarios: metagameEnvironmentScenarios(report.environmentDecks ?? []),
  };
}

async function buildMetagameConstraint(config, charactersById, seed, reportRoot) {
  const attributeKey = config.allowedAttributes.join("-");
  const reportDirectory = path.join(reportRoot, attributeKey);
  const reports = await Promise.all([1, 2, 3, 4, 5].map((position) => (
    readMetagameJson(path.join(reportDirectory, `slot-${position}-cost-${config.cost}.json`))
  )));
  const positionPools = [1, 2, 3, 4, 5].map((position) => buildEnvironmentPositionPool(
    CHARACTER_CATALOG,
    position,
    { allowedAttributes: config.allowedAttributes },
  ));
  const solveCompletion = createDeckCompletionSolver(positionPools, config.cost);
  const positionEnvironments = reports.map((report) => metagameUsageEnvironment(report, charactersById));
  const environmentDecks = createFullEnvironmentDecks(
    METAGAME_SCENARIO_COUNT * 9,
    positionEnvironments,
    solveCompletion,
    metagameSeededRandom(seed),
    {},
    { deckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES, strictProfiles: false },
  );
  return {
    id: `${attributeKey}:${config.cost}`,
    attributeKey,
    label: `${config.allowedAttributes.map((attribute) => METAGAME_ATTRIBUTE_LABELS[attribute]).join("")}\u30fb\u30b3\u30b9\u30c8${config.cost}`,
    allowedAttributes: config.allowedAttributes,
    totalCost: config.cost,
    turns: Math.max(...reports.map((report) => Number(report.context?.turns) || 12)),
    scenarioCount: METAGAME_SCENARIO_COUNT,
    modelVersion: reports[0].model?.version ?? "unknown",
    reportGeneratedAt: reports.map((report) => report.generatedAt).sort().at(-1),
    slots: reports.map((report, index) => ({
      position: index + 1,
      candidates: detailedMetagameCandidates(report),
      environment: compactMetagameEnvironment(report, charactersById),
    })),
    environmentScenarios: metagameEnvironmentScenarios(environmentDecks),
  };
}

export async function buildMetagameSimulatorData(options = {}) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDirectory, "..");
  const outputPath = path.resolve(projectRoot, options.outputPath ?? "src/data/metagame-simulator-data.js");
  const usesDefaultSources = !options.statusPath && !options.reportRoot;
  const configuredSources = !usesDefaultSources
    ? [{
      statusPath: options.statusPath ?? DEFAULT_METAGAME_SOURCES[0].statusPath,
      reportRoot: options.reportRoot ?? DEFAULT_METAGAME_SOURCES[0].reportRoot,
      legacy: Boolean(options.legacy),
    }]
    : DEFAULT_METAGAME_SOURCES;
  const availableSources = (await Promise.all(
    configuredSources.map((source) => readMetagameSource(projectRoot, source)),
  )).filter(Boolean);
  const completedV7Sources = availableSources.filter((candidate) => (
    candidate.type === "v7" && candidate.completedConstraints.length && candidate.report
  ));
  // The public Pages build has no reports/metagame-ratings-v7 directory. Do
  // not replace its already-published completed V7 data with an empty source
  // merely because the reports live on the dedicated results branch.
  if (usesDefaultSources && !completedV7Sources.length && hasCompletedV7BrowserData(EXISTING_METAGAME_SIMULATOR_DATA)) {
    const data = compactPublishedV7Data(EXISTING_METAGAME_SIMULATOR_DATA);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      `export const METAGAME_SIMULATOR_DATA = Object.freeze(${JSON.stringify(data)});\n`,
      "utf8",
    );
    return { outputPath, data };
  }
  const source = completedV7Sources[0]
    ?? availableSources.find((candidate) => candidate.completedConstraints.length)
    ?? availableSources[0]
    ?? {
      statusPath: path.resolve(projectRoot, configuredSources[0].statusPath),
      reportRoot: path.resolve(projectRoot, configuredSources[0].reportRoot),
      legacy: Boolean(configuredSources[0].legacy),
      status: { config: {}, completedTaskIds: [], completedRuns: 0, totalRuns: 0 },
      completedConstraints: [],
    };
  const { status, completedConstraints } = source;
  const charactersById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
  const constraints = [];
  if (completedV7Sources.length) {
    constraints.push(...completedV7Sources.map((entry) => buildMetagameV7Constraint(entry.report, charactersById)));
  } else if (source.type === "v7" && source.report) {
    constraints.push(buildMetagameV7Constraint(source.report, charactersById));
  } else {
    for (let index = 0; index < completedConstraints.length; index += 1) {
      constraints.push(await buildMetagameConstraint(
        completedConstraints[index],
        charactersById,
        7301 + index * 100003,
        source.reportRoot,
      ));
    }
  }
  const data = {
    generatedAt: new Date().toISOString(),
    sourceCompletedRuns: Number(status.completedRuns) || 0,
    sourceTotalRuns: Number(status.totalRuns) || 0,
    sourceStatus: status.status ?? "unknown",
    sourceUpdatedAt: status.updatedAt ?? null,
    sourcePauseReason: status.pauseReason ?? null,
    sourcePasses: Number(status.config?.passes) || 0,
    sourceModelVersion: constraints[0]?.modelVersion ?? status.config?.modelVersion ?? "unknown",
    sourceStatusPath: path.relative(projectRoot, source.statusPath).replaceAll("\\", "/"),
    sourceReportRoot: path.relative(projectRoot, source.reportRoot).replaceAll("\\", "/"),
    sourceIsLegacy: source.legacy,
    sourceModelCompatible: Boolean(source.modelCompatible),
    constraints,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `export const METAGAME_SIMULATOR_DATA = Object.freeze(${JSON.stringify(data)});\n`,
    "utf8",
  );
  return { outputPath, data };
}

const directPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directPath === fileURLToPath(import.meta.url)) {
  const result = await buildMetagameSimulatorData();
  console.log(`Built ${path.relative(process.cwd(), result.outputPath)} (${result.data.constraints.length} constraints)`);
}
