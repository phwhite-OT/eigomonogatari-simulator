import fs from "node:fs/promises";

import { rankMetagameV12Characters } from "../src/core/metagame-v12.js";

function readArgument(name, fallback = "") {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function rounded(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function signedOpportunityScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, 0.5 + 0.5 * Math.tanh(number / 0.15)));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rerankCharacter(character, totalCost) {
  const robust = Number(character?.robustOpportunityWinGain);
  const mean = Number(character?.opportunityWinGain);
  const score = signedOpportunityScore(robust);
  const budgetShare = totalCost > 0 ? (Number(character?.cost) || 0) / totalCost : 0;

  return {
    ...character,
    // The primary individual value is the full-budget opportunity result.
    // Removing the character permits all five slots to be rebuilt and the
    // freed cost to be spent anywhere in the deck.
    marginalWinGain: Number.isFinite(mean) ? rounded(mean) : character.marginalWinGain,
    marginalWinGainLowerBound: Number.isFinite(robust) ? rounded(robust) : character.marginalWinGainLowerBound,
    costAwareScore: rounded(score),
    practicalValue: rounded(score),
    individualScore: rounded(score),
    roleBreakdown: {
      ...(character.roleBreakdown ?? {}),
      opportunityCostScore: rounded(score),
      costAwareOpportunityScore: rounded(score),
      budgetShare: rounded(budgetShare, 6),
      // Keep the same-four-teammate result as a separate pure slot diagnostic.
      counterfactualContributionScore: Number.isFinite(Number(character?.counterfactualRobustWinGain))
        ? rounded(signedOpportunityScore(character.counterfactualRobustWinGain))
        : character?.roleBreakdown?.counterfactualContributionScore ?? null,
    },
  };
}

function rankingCsv(report) {
  const headers = [
    "枠", "実戦採用順位", "単体コスパ順位", "キャラID", "名前", "コスト", "予算占有率", "HP", "Power",
    "スキルターン", "スキル種類", "全5枠再配分・機会勝率差", "全5枠再配分・安定補正後差",
    "総合勝率差", "不確実性補正後差", "枠内証拠補正", "枠内補正上限",
    "同一4枠差し替え勝率差", "同一4枠差し替え安定補正後差", "候補勝率", "全再最適化代替勝率",
    "候補デッキ", "全再最適化代替デッキ", "同一4枠差し替えデッキ", "評価状態",
  ];
  const totalCost = Number(report.context?.totalCost) || 0;
  const rows = (report.rankingsByPosition ?? []).flatMap((slot) => (
    (slot.characters ?? []).map((character) => [
      slot.position,
      character.practicalRank ?? character.rank,
      character.individualRank ?? "",
      character.id,
      character.name,
      character.cost,
      totalCost > 0 ? rounded((Number(character.cost) || 0) / totalCost, 6) : "",
      character.hp,
      character.pow,
      character.skillTurn,
      character.skillType,
      character.opportunityWinGain,
      character.robustOpportunityWinGain,
      character.rankingContributionMean ?? "",
      character.rankingContributionRobust ?? "",
      character.matchedSlotEvidenceCorrection ?? "",
      character.matchedSlotCorrectionCap ?? "",
      character.counterfactualWinGain ?? "",
      character.counterfactualRobustWinGain ?? "",
      character.candidateExpectedWinRate,
      character.benchmarkExpectedWinRate,
      character.bestDeck?.names?.join(" / ") ?? "",
      character.baselineDeck?.names?.join(" / ") ?? "",
      character.counterfactualReplacementDeck?.names?.join(" / ") ?? "",
      character.evaluationStatus,
    ])
  ));
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const inputPath = readArgument("report");
const outputPath = readArgument("output", inputPath);
const csvPath = readArgument("csv");
if (!inputPath) throw new Error("--report is required.");

const report = JSON.parse(await fs.readFile(inputPath, "utf8"));
const totalCost = Math.max(1, Number(report.context?.totalCost) || 1);
const rankingsByPosition = (report.rankingsByPosition ?? []).map((slot) => ({
  ...slot,
  characters: rankMetagameV12Characters(
    (slot.characters ?? []).map((character) => rerankCharacter(character, totalCost)),
  ),
}));

const updated = {
  ...report,
  rerankedAt: new Date().toISOString(),
  rankingPolicy: "full-budget-opportunity-v7-budget-neutral-slot",
  model: {
    ...(report.model ?? {}),
    objective: "対象キャラを外して浮くコストを5枠全体へ再配分し、再構築後の最善デッキとの差からコスト制約込みの単体価値を評価する。",
    scoringPolicy: "単体コスパ順位は全5枠再最適化の機会勝率差を主成分にする。同一4枠差し替えは、全5枠評価の平均値と安定補正後値の間にある不確実性幅の範囲だけ補正に使い、コスト比率では重み付けしない。",
    costPolicy: "総コストは上限であって目標値ではない。候補を外した際に浮くコストを5枠全体へ再配分できるため、高コストの機会損失はそこで自然に評価する。未使用コストそのものには減点も加点もしない。",
  },
  rankingsByPosition,
};

await fs.writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
if (csvPath) await fs.writeFile(csvPath, rankingCsv(updated), "utf8");

console.log(JSON.stringify({
  inputId: updated.context?.inputId,
  totalCost,
  rankingPolicy: updated.rankingPolicy,
  positions: rankingsByPosition.map((slot) => ({
    position: slot.position,
    count: slot.characters.length,
    topIndividual: slot.characters
      .slice()
      .sort((a, b) => Number(a.individualRank) - Number(b.individualRank))
      .slice(0, 5)
      .map((entry) => ({ id: entry.id, name: entry.name, cost: entry.cost, rank: entry.individualRank })),
  })),
}, null, 2));
