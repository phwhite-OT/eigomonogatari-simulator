import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKBOOK_CHARACTERS } from "../src/data/workbook-characters.js";
import {
  buildEnvironmentPositionPool,
  DEFAULT_STRATEGIC_DECK_PROFILES,
  createDeckCompletionSolver,
  createFullEnvironmentDecks,
} from "../src/core/environment-rating.js";

const METAGAME_ATTRIBUTE_LABELS = Object.freeze({
  fire: "火",
  water: "水",
  wind: "風",
});
const METAGAME_SCENARIO_COUNT = 30;
const DEFAULT_METAGAME_SOURCES = Object.freeze([
  Object.freeze({
    statusPath: "reports/metagame-v4-batch-status.json",
    reportRoot: "reports/metagame-ratings-v4",
    legacy: false,
  }),
  Object.freeze({
    statusPath: "reports/metagame-v3-batch-status.json",
    reportRoot: "reports/metagame-ratings-v3",
    legacy: true,
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

async function readMetagameSource(projectRoot, source) {
  const statusPath = path.resolve(projectRoot, source.statusPath);
  try {
    const status = await readMetagameJson(statusPath);
    return {
      ...source,
      statusPath,
      reportRoot: path.resolve(projectRoot, source.reportRoot),
      status,
      completedConstraints: completedMetagameConstraints(status),
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

async function buildMetagameConstraint(config, charactersById, seed, reportRoot) {
  const attributeKey = config.allowedAttributes.join("-");
  const reportDirectory = path.join(reportRoot, attributeKey);
  const reports = await Promise.all([1, 2, 3, 4, 5].map((position) => (
    readMetagameJson(path.join(reportDirectory, `slot-${position}-cost-${config.cost}.json`))
  )));
  const positionPools = [1, 2, 3, 4, 5].map((position) => buildEnvironmentPositionPool(
    WORKBOOK_CHARACTERS,
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
    { deckProfiles: DEFAULT_STRATEGIC_DECK_PROFILES, strictProfiles: true },
  );
  return {
    id: `${attributeKey}:${config.cost}`,
    attributeKey,
    label: `${config.allowedAttributes.map((attribute) => METAGAME_ATTRIBUTE_LABELS[attribute]).join("")}・コスト${config.cost}`,
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
  const configuredSources = options.statusPath || options.reportRoot
    ? [{
      statusPath: options.statusPath ?? DEFAULT_METAGAME_SOURCES[0].statusPath,
      reportRoot: options.reportRoot ?? DEFAULT_METAGAME_SOURCES[0].reportRoot,
      legacy: Boolean(options.legacy),
    }]
    : DEFAULT_METAGAME_SOURCES;
  const availableSources = (await Promise.all(
    configuredSources.map((source) => readMetagameSource(projectRoot, source)),
  )).filter(Boolean);
  const source = availableSources.find((candidate) => candidate.completedConstraints.length)
    ?? availableSources[0]
    ?? {
      statusPath: path.resolve(projectRoot, configuredSources[0].statusPath),
      reportRoot: path.resolve(projectRoot, configuredSources[0].reportRoot),
      legacy: Boolean(configuredSources[0].legacy),
      status: { config: {}, completedTaskIds: [], completedRuns: 0, totalRuns: 0 },
      completedConstraints: [],
    };
  const { status, completedConstraints } = source;
  const charactersById = new Map(WORKBOOK_CHARACTERS.map((character) => [String(character.id), character]));
  const constraints = [];
  for (let index = 0; index < completedConstraints.length; index += 1) {
    constraints.push(await buildMetagameConstraint(
      completedConstraints[index],
      charactersById,
      7301 + index * 100003,
      source.reportRoot,
    ));
  }
  const data = {
    generatedAt: new Date().toISOString(),
    sourceCompletedRuns: Number(status.completedRuns) || 0,
    sourceTotalRuns: Number(status.totalRuns) || 0,
    sourceModelVersion: constraints[0]?.modelVersion ?? status.config?.modelVersion ?? "unknown",
    sourceStatusPath: path.relative(projectRoot, source.statusPath).replaceAll("\\", "/"),
    sourceReportRoot: path.relative(projectRoot, source.reportRoot).replaceAll("\\", "/"),
    sourceIsLegacy: source.legacy,
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
