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
const METAGAME_V8_MODEL_VERSION = "team-battle-v8.4-skill-reliability";
const DEFAULT_METAGAME_SOURCES = Object.freeze([
  ...METAGAME_V7_INPUTS.map((input) => Object.freeze({
    type: "v8",
    inputId: input.id,
    statusPath: `reports/metagame-ratings-v8.4-skill-reliability/${input.id.replaceAll(":", "-")}/progress.json`,
    reportPath: `reports/metagame-ratings-v8.4-skill-reliability/${input.id.replaceAll(":", "-")}/report.json`,
    reportRoot: "reports/metagame-ratings-v8.4-skill-reliability",
    requiredModelVersion: METAGAME_V8_MODEL_VERSION,
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

function v8CompletedRunCount(progress) {
  return (progress.resultsByPosition ?? []).filter((ratings, index) => (
    ratings.length > 0 && ratings.length >= (progress.context?.candidateIdsByPosition?.[index]?.length ?? Infinity)
  )).length;
}

function hasCompletedV8BrowserData(data) {
  return data?.sourceStatus === "complete"
    && data?.sourceModelCompatible === true
    && String(data.sourceModelVersion ?? "").startsWith("team-battle-v8.")
    && Array.isArray(data.constraints)
    && data.constraints.length > 0;
}

async function readMetagameV8Source(projectRoot, source) {
  const statusPath = path.resolve(projectRoot, source.statusPath);
  const reportPath = path.resolve(projectRoot, source.reportPath);
  try {
    const progress = await readMetagameJson(statusPath);
    const status = {
      status: progress.status ?? "unknown",
      updatedAt: progress.updatedAt ?? null,
      completedRuns: v8CompletedRunCount(progress),
      totalRuns: 5,
      config: { modelVersion: progress.context?.version ?? "unknown", passes: 1 },
    };
    const modelCompatible = status.config.modelVersion === source.requiredModelVersion;
    const complete = modelCompatible && progress.status === "complete";
    const report = complete ? await readMetagameJson(reportPath) : null;
    if (report && report.model?.version !== source.requiredModelVersion) {
      throw new Error(`v8 report model mismatch: ${report.model?.version ?? "unknown"}`);
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
  if (source.type === "v8") return readMetagameV8Source(projectRoot, source);
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

function compactMetagameV8TeamScenarios(report) {
  return (report.teamScenarios ?? []).map((scenario) => ({
    a: (scenario.allyDecks ?? []).map((deck) => deck.map((entry) => String(entry.id))),
    e: (scenario.enemyDecks ?? []).map((deck) => deck.map((entry) => String(entry.id))),
  })).filter((scenario) => scenario.a.length === 4 && scenario.e.length === 5);
}

function compactMetagameV8Candidate(entry, character) {
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
    strategicClass: "v8-team-battle",
    advantageCreation: defenseTypes.has(skill.type) ? 0.5 : 0,
    counteraction: attackTypes.has(skill.type) ? 0.5 : 0,
    allyPreservationNet: 0,
    enemyRemovalNet: 0,
    skillActivationRate: skill.type && skill.type !== "none" ? 1 : 0,
    v8BestDeck: entry.bestDeck ?? null,
    v8ExampleDeck: entry.exampleDeck ?? null,
  };
}

function compactMetagameV8Rating(entry) {
  if (!entry) return null;
  const breakdown = entry.b ?? entry.roleBreakdown ?? {};
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined;
  const rating = {
    // This is deliberately only the role evidence needed by the deck card;
    // full per-character reports remain in the cloud artifacts.
    k: entry.k ?? entry.role,
    i: finite(entry.i ?? entry.individualScore),
    f: finite(entry.f ?? entry.roleFit),
    b: {
      f: finite(breakdown.f ?? breakdown.frontline),
      h: finite(breakdown.h ?? breakdown.highDurabilityCoverage),
      a: finite(breakdown.a ?? breakdown.boardCoverage),
      d: finite(breakdown.d ?? breakdown.defenseMatchup),
      v: finite(breakdown.v ?? breakdown.reviveMatchup),
      c: finite(breakdown.c ?? breakdown.costEfficiency),
      r: finite(breakdown.r ?? breakdown.skillReadiness),
      l: finite(breakdown.l ?? breakdown.lateSkillRisk),
    },
  };
  const hasEvidence = [rating.i, rating.f, ...Object.values(rating.b)].some(Number.isFinite);
  return hasEvidence ? rating : null;
}

function compactMetagameV8Deck(entry, ratingsByPosition) {
  const source = entry?.v8BestDeck ?? entry?.v7BestDeck ?? entry?.bestDeck ?? entry;
  const ids = source?.i ?? source?.ids;
  if (!Array.isArray(ids) || ids.length !== 5) return null;
  const compactRatings = source.r ?? source.ratings ?? ids.map((id, index) => (
    compactMetagameV8Rating(ratingsByPosition?.[index]?.get(String(id)))
  ));
  const deck = {
    // Short field names keep the browser payload small. They are expanded by
    // metagame-deck.js when a result is displayed.
    i: ids.map(String),
    c: Number(source.c ?? source.totalCost) || 0,
    p: Number(source.p ?? source.proxyScore) || 0,
    y: Number(source.y ?? source.synergyScore) || 0,
    w: Number(source.w ?? source.expectedWinRate) || 0,
    l: Number(source.l ?? source.expectedWinLowerBound) || 0,
    s: Number(source.s ?? source.scenarioCount) || 0,
    a: Number(source.a ?? source.decisiveWinRate) || 0,
    d: Number(source.d ?? source.decisiveDrawRate) || 0,
    e: Number(source.e ?? source.decisiveLossRate) || 0,
    o: Number(source.o ?? source.ongoingRate) || 0,
    x: source.x ?? (source.origin === "example" ? "example" : "automatic"),
  };
  if (compactRatings.some(Boolean)) deck.r = compactRatings;
  return deck;
}

function compactMetagameV8Decks(entries, ratingsByPosition) {
  const unique = new Map();
  for (const entry of entries) {
    const deck = compactMetagameV8Deck(entry, ratingsByPosition);
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

function compactPublishedV8Constraint(constraint) {
  const existingDecks = constraint.precomputedDecks ?? [];
  const rankedCandidates = (constraint.slots ?? []).flatMap((slot) => slot.candidates ?? []);
  return {
    ...constraint,
    slots: (constraint.slots ?? []).map((slot) => ({
      position: slot.position,
      environment: slot.environment ?? [],
    })),
    precomputedDecks: compactMetagameV8Decks([...existingDecks, ...rankedCandidates]),
  };
}

function compactPublishedV8Data(data) {
  return {
    ...data,
    constraints: data.constraints.map((constraint) => (
      String(constraint.modelVersion ?? "").startsWith("team-battle-v8.")
        ? compactPublishedV8Constraint(constraint)
        : constraint
    )),
  };
}

function v8EnvironmentPools(report) {
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

export function buildMetagameV8Constraint(report, charactersById) {
  const rankings = new Map((report.rankingsByPosition ?? []).map((slot) => [Number(slot.position), slot]));
  const pools = v8EnvironmentPools(report);
  const ratingsByPosition = [1, 2, 3, 4, 5].map((position) => (
    new Map((rankings.get(position)?.characters ?? []).map((entry) => [String(entry.id), entry]))
  ));
  const precomputedDecks = compactMetagameV8Decks(
    [...rankings.values()].flatMap((slot) => slot.characters ?? []),
    ratingsByPosition,
  );
  return {
    id: report.context?.inputId ?? "fire:100",
    attributeKey: (report.context?.allowedAttributes ?? []).join("-"),
    label: report.context?.label ?? "火・コスト100",
    allowedAttributes: report.context?.allowedAttributes ?? [],
    totalCost: Number(report.context?.totalCost) || 100,
    turns: Number(report.context?.turns) || 12,
    scenarioCount: Number(report.context?.teamScenarioCount)
      || Number(report.context?.environmentCount)
      || report.environmentDecks?.length
      || 0,
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
    // Preserve the exact 4+5 team split used by the cloud evaluator.  The
    // previous flat nine-deck representation is useful for legacy reports,
    // but cannot reproduce V8's deterministic deck permutation for an audit.
    teamScenarios: compactMetagameV8TeamScenarios(report),
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
  const completedV8Sources = availableSources.filter((candidate) => (
    candidate.type === "v8" && candidate.completedConstraints.length && candidate.report
  ));
  // The public Pages build has no reports/metagame-ratings-v8 directory. Do
  // not replace its already-published completed V8 data with an empty source
  // merely because the reports live on the dedicated results branch.
  if (usesDefaultSources && !completedV8Sources.length && hasCompletedV8BrowserData(EXISTING_METAGAME_SIMULATOR_DATA)) {
    const data = compactPublishedV8Data(EXISTING_METAGAME_SIMULATOR_DATA);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      `export const METAGAME_SIMULATOR_DATA = Object.freeze(${JSON.stringify(data)});\n`,
      "utf8",
    );
    return { outputPath, data };
  }
  const source = completedV8Sources[0]
    ?? availableSources.find((candidate) => candidate.completedConstraints.length)
    ?? availableSources[0]
    ?? {
      statusPath: path.resolve(projectRoot, configuredSources[0].statusPath),
      reportRoot: path.resolve(projectRoot, configuredSources[0].reportRoot),
      legacy: Boolean(configuredSources[0].legacy),
      status: {
        status: "in_progress",
        config: { modelVersion: METAGAME_V8_MODEL_VERSION, passes: 1 },
        completedTaskIds: [],
        completedRuns: 0,
        totalRuns: 5,
      },
      modelCompatible: true,
      completedConstraints: [],
    };
  const { status, completedConstraints } = source;
  const charactersById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
  const constraints = [];
  if (completedV8Sources.length) {
    constraints.push(...completedV8Sources.map((entry) => buildMetagameV8Constraint(entry.report, charactersById)));
  } else if (source.type === "v8" && source.report) {
    constraints.push(buildMetagameV8Constraint(source.report, charactersById));
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
