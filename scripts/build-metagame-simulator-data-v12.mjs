import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";
import { METAGAME_V8_INPUTS } from "../src/data/metagame-v8-inputs.js";
import { resolveMetagameV7Input } from "../src/core/metagame-v7.js";
import {
  METAGAME_V12_MODEL_VERSION,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
} from "../src/core/metagame-v12.js";
import { buildMetagameSimulatorData } from "./build-metagame-simulator-data.mjs";

const V12_BROWSER_POOL_LIMIT = 96;
const V12_REPORT_ROOT = "reports/metagame-ratings-v12-team-opportunity";

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content.replace(/^\uFEFF/, ""));
}

function compactV12Candidate(entry, character) {
  const bestDeck = entry.bestDeck ?? {};
  const baselineDeck = entry.baselineDeck ?? {};
  return {
    id: String(entry.id),
    name: entry.name ?? character?.name ?? String(entry.id),
    attributes: entry.attributes ?? character?.attributes ?? [],
    rarity: entry.rarity ?? character?.rarity ?? "unknown",
    cost: Number(entry.cost ?? character?.cost) || 0,
    skillTurn: Number(entry.skillTurn ?? character?.skillTurn) || 0,
    skillType: entry.skillType ?? character?.skill?.type ?? "none",
    skillTarget: entry.skillTarget ?? character?.skill?.target ?? "self",
    skillName: entry.skillName ?? character?.skillName ?? "",
    overallRank: Number(entry.rank) || null,
    role: entry.role ?? "neutral",
    evaluationStatus: entry.evaluationStatus ?? "complete",
    evaluationWarning: entry.evaluationWarning ?? null,
    opportunityWinGain: Number(entry.opportunityWinGain) || 0,
    robustOpportunityWinGain: Number(entry.robustOpportunityWinGain) || 0,
    marginalWinGain: Number(entry.marginalWinGain ?? entry.opportunityWinGain) || 0,
    marginalWinGainLowerBound: Number(entry.marginalWinGainLowerBound ?? entry.robustOpportunityWinGain) || 0,
    candidateExpectedWinRate: Number(entry.candidateExpectedWinRate ?? bestDeck.expectedWinRate) || 0,
    benchmarkExpectedWinRate: Number(entry.benchmarkExpectedWinRate ?? baselineDeck.expectedWinRate) || 0,
    expectedWinRate: Number(entry.expectedWinRate ?? entry.candidateExpectedWinRate ?? bestDeck.expectedWinRate) || 0,
    expectedWinLowerBound: Number(entry.expectedWinLowerBound ?? bestDeck.expectedWinLowerBound) || 0,
    costAwareScore: Number(entry.costAwareScore) || 0,
    practicalValue: Number(entry.practicalValue ?? entry.costAwareScore) || 0,
    individualScore: Number(entry.individualScore ?? entry.costAwareScore) || 0,
    roleFit: Number(entry.roleFit) || 0,
    roleBreakdown: entry.roleBreakdown ?? {},
    scenarioCount: Number(bestDeck.scenarioCount) || 0,
    evaluatedDeckCount: Number(entry.evaluatedDeckCount) || 0,
    alternativeDeckCount: Number(entry.alternativeDeckCount) || 0,
    battleEvaluationCount: Number(entry.battleEvaluationCount) || 0,
    bestDeck: {
      ids: (bestDeck.ids ?? []).map(String),
      names: bestDeck.names ?? [],
      totalCost: Number(bestDeck.totalCost) || 0,
      expectedWinRate: Number(bestDeck.expectedWinRate) || 0,
      expectedWinLowerBound: Number(bestDeck.expectedWinLowerBound) || 0,
      decisiveWinRate: Number(bestDeck.decisiveWinRate) || 0,
      scenarioCount: Number(bestDeck.scenarioCount) || 0,
    },
    baselineDeck: {
      ids: (baselineDeck.ids ?? []).map(String),
      names: baselineDeck.names ?? [],
      totalCost: Number(baselineDeck.totalCost) || 0,
      expectedWinRate: Number(baselineDeck.expectedWinRate) || 0,
      expectedWinLowerBound: Number(baselineDeck.expectedWinLowerBound) || 0,
      decisiveWinRate: Number(baselineDeck.decisiveWinRate) || 0,
      scenarioCount: Number(baselineDeck.scenarioCount) || 0,
    },
  };
}

function compactTeamScenarios(scenarios) {
  return scenarios.map((scenario) => ({
    a: scenario.allyDecks.map((deck) => deck.map((character) => String(character.id))),
    e: scenario.enemyDecks.map((deck) => deck.map((character) => String(character.id))),
  }));
}

function compactEnvironmentScenarios(environmentDecks) {
  const compactDecks = environmentDecks.map((deck) => deck.map((character) => String(character.id)));
  const groups = [];
  for (let index = 0; index < compactDecks.length; index += 9) {
    groups.push(compactDecks.slice(index, index + 9));
  }
  return groups;
}

function compactEnvironmentPool(pool) {
  const share = 1 / Math.max(1, pool.length);
  return pool.map((character) => ({
    id: String(character.id),
    name: character.name,
    attributes: character.attributes ?? [],
    rarity: character.rarity ?? "unknown",
    cost: Number(character.cost) || 0,
    battleRank: null,
    usageRank: null,
    projectedUsageShare: share,
  }));
}

async function buildConstraint(input, projectRoot, charactersById) {
  const directory = input.id.replaceAll(":", "-");
  const reportDirectory = path.resolve(projectRoot, V12_REPORT_ROOT, directory);
  let progress;
  let report;
  try {
    [progress, report] = await Promise.all([
      readJson(path.join(reportDirectory, "progress.json")),
      readJson(path.join(reportDirectory, "report.json")),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (progress.status !== "complete") return null;
  if (progress.context?.version !== METAGAME_V12_MODEL_VERSION) return null;
  if (report.model?.version !== METAGAME_V12_MODEL_VERSION) return null;

  const resolvedInput = resolveMetagameV7Input(input, CHARACTER_CATALOG);
  const environmentCount = Math.max(9, Number(report.context?.environmentCount ?? progress.context?.environmentCount) || 72);
  const environmentVariants = Math.max(1, Number(report.context?.environmentVariants ?? progress.context?.environmentVariants) || 2);
  const teamScenarioCount = Math.max(1, Number(report.context?.teamScenarioCount ?? progress.context?.teamScenarioCount) || 72);
  const environmentDecks = createMetagameV12EnvironmentDecks(resolvedInput, {
    count: environmentCount,
    environmentVariants,
  });
  const teamScenarios = createMetagameV12TeamScenarios(resolvedInput, {
    environmentDecks,
    count: teamScenarioCount,
  });
  const rankings = new Map((report.rankingsByPosition ?? []).map((slot) => [Number(slot.position), slot.characters ?? []]));

  return {
    id: report.context?.inputId ?? input.id,
    attributeKey: (report.context?.allowedAttributes ?? resolvedInput.allowedAttributes ?? []).join("-"),
    label: report.context?.label ?? resolvedInput.label,
    allowedAttributes: report.context?.allowedAttributes ?? resolvedInput.allowedAttributes ?? [],
    totalCost: Number(report.context?.totalCost ?? resolvedInput.totalCost) || 100,
    turns: Number(report.context?.turns) || 12,
    scenarioCount: teamScenarios.length,
    modelVersion: METAGAME_V12_MODEL_VERSION,
    reportGeneratedAt: report.generatedAt ?? progress.updatedAt ?? null,
    slots: [1, 2, 3, 4, 5].map((position) => {
      const candidates = (rankings.get(position) ?? [])
        .map((entry) => compactV12Candidate(entry, charactersById.get(String(entry.id))))
        .slice(0, V12_BROWSER_POOL_LIMIT);
      return {
        position,
        candidates,
        debugRankings: candidates.slice(0, 12),
        environment: compactEnvironmentPool(resolvedInput.environmentPools[position - 1] ?? []),
      };
    }),
    teamScenarios: compactTeamScenarios(teamScenarios),
    environmentScenarios: compactEnvironmentScenarios(environmentDecks),
    v12Context: {
      environmentCount,
      environmentVariants,
      teamScenarioCount,
      partnerLimit: Number(report.context?.partnerLimit ?? progress.context?.partnerLimit) || null,
      autoDeckLimit: Number(report.context?.autoDeckLimit ?? progress.context?.autoDeckLimit) || null,
      alternativeDeckLimit: Number(report.context?.alternativeDeckLimit ?? progress.context?.alternativeDeckLimit) || null,
      beamWidth: Number(report.context?.beamWidth ?? progress.context?.beamWidth) || null,
    },
  };
}

export async function buildMetagameSimulatorDataV12(options = {}) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDirectory, "..");
  const outputPath = path.resolve(projectRoot, options.outputPath ?? "src/data/metagame-simulator-data.js");
  const charactersById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
  const constraints = (await Promise.all(
    METAGAME_V8_INPUTS.map((input) => buildConstraint(input, projectRoot, charactersById)),
  )).filter(Boolean);

  if (!constraints.length) {
    return buildMetagameSimulatorData(options);
  }

  const updatedAt = constraints
    .map((constraint) => constraint.reportGeneratedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const data = {
    generatedAt: new Date().toISOString(),
    sourceCompletedRuns: constraints.length,
    sourceTotalRuns: METAGAME_V8_INPUTS.length,
    sourceStatus: constraints.length === METAGAME_V8_INPUTS.length ? "complete" : "paused",
    sourceUpdatedAt: updatedAt,
    sourcePauseReason: constraints.length === METAGAME_V8_INPUTS.length
      ? null
      : "V12.2の完了済み条件のみ公開。未完了条件は候補生成・対戦に使用しません。",
    sourcePasses: 1,
    sourceModelVersion: METAGAME_V12_MODEL_VERSION,
    sourceStatusPath: `${V12_REPORT_ROOT}/<condition>/progress.json`,
    sourceReportRoot: V12_REPORT_ROOT,
    sourceIsLegacy: false,
    sourceModelCompatible: true,
    showPublishedV8Cache: false,
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
  const { outputPath, data } = await buildMetagameSimulatorDataV12();
  console.log(`Built ${path.relative(process.cwd(), outputPath)} with ${data.constraints.length} V12.2 conditions.`);
}
