import fs from "node:fs/promises";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length <= 1) return 0;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function meanLowerBound(values, z = 1.96) {
  if (!values.length) return 0;
  if (values.length === 1) return values[0];
  return average(values) - z * standardDeviation(values) / Math.sqrt(values.length);
}

function rounded(value, digits = 5) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function stableHash(value) {
  let hash = 2_166_136_261;
  for (const character of String(value)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return hash >>> 0;
}

function correlation(left, right) {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = average(left);
  const rightMean = average(right);
  let numerator = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftTotal += a * a;
    rightTotal += b * b;
  }
  return leftTotal > 0 && rightTotal > 0 ? numerator / Math.sqrt(leftTotal * rightTotal) : 0;
}

function compactCandidate(entry, position) {
  const robustOpportunity = Number(entry.robustOpportunityWinGain);
  const opportunity = Number(entry.opportunityWinGain);
  const costAwareScore = Number.isFinite(robustOpportunity)
    ? Math.min(1, Math.max(0, 0.5 + 0.5 * Math.tanh(robustOpportunity / 0.15)))
    : Number(entry.costAwareScore ?? entry.individualScore) || 0.5;
  return {
    p: position,
    i: String(entry.id),
    c: Number(entry.cost) || 0,
    w: rounded(entry.expectedWinRate ?? entry.candidateExpectedWinRate),
    l: rounded(entry.expectedWinLowerBound),
    // Browser generation needs cost-aware individual value. Keep the matched
    // same-four-teammate contribution only as a diagnostic, never as the main
    // prior because it cannot re-spend a costly card's freed budget.
    m: rounded(Number.isFinite(opportunity) ? opportunity : entry.marginalWinGain),
    r: rounded(Number.isFinite(robustOpportunity) ? robustOpportunity : entry.marginalWinGainLowerBound),
    s: rounded(costAwareScore),
    x: rounded(entry.counterfactualWinGain),
    q: rounded(entry.counterfactualRobustWinGain),
    f: rounded(entry.roleFit),
    k: entry.role ?? "neutral",
    t: Number(entry.skillTurn) || 0,
    y: entry.skillType ?? "none",
    e: entry.evaluationStatus ?? "complete",
  };
}

function deckSort(left, right) {
  return (
    (Number(right.lower) || 0) - (Number(left.lower) || 0) ||
    (Number(right.mean) || 0) - (Number(left.mean) || 0) ||
    (Number(right.decisive) || 0) - (Number(left.decisive) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0) ||
    left.key.localeCompare(right.key)
  );
}

function chooseTrainingDecks(decks, limit) {
  if (decks.length <= limit) return decks;
  const sorted = [...decks].sort((left, right) => left.mean - right.mean || left.key.localeCompare(right.key));
  return Array.from({ length: limit }, (_, index) => (
    sorted[Math.min(sorted.length - 1, Math.floor((index + 0.5) * sorted.length / limit))]
  ));
}

function representativeScenarioOrder(decks, targetCount) {
  if (!decks.length) return [];
  const scenarioCount = decks[0].scenarioValues.length;
  const fullMeans = decks.map((deck) => deck.mean);
  const runningSums = new Float64Array(decks.length);
  const selected = [];
  const remaining = new Set(Array.from({ length: scenarioCount }, (_, index) => index));
  for (let step = 0; step < Math.min(targetCount, scenarioCount); step += 1) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const scenarioIndex of remaining) {
      const predicted = new Array(decks.length);
      let absoluteError = 0;
      for (let deckIndex = 0; deckIndex < decks.length; deckIndex += 1) {
        const value = (runningSums[deckIndex] + Number(decks[deckIndex].scenarioValues[scenarioIndex])) / (step + 1);
        predicted[deckIndex] = value;
        absoluteError += Math.abs(value - fullMeans[deckIndex]);
      }
      const corr = correlation(predicted, fullMeans);
      const mae = absoluteError / decks.length;
      const score = corr - mae * 0.35;
      if (score > bestScore || (score === bestScore && scenarioIndex < bestIndex)) {
        bestIndex = scenarioIndex;
        bestScore = score;
      }
    }
    if (bestIndex < 0) break;
    selected.push(bestIndex);
    remaining.delete(bestIndex);
    for (let deckIndex = 0; deckIndex < decks.length; deckIndex += 1) {
      runningSums[deckIndex] += Number(decks[deckIndex].scenarioValues[bestIndex]);
    }
  }
  return selected;
}

function scenarioSubsetMetrics(decks, indices) {
  if (!decks.length || !indices.length) return { correlation: 0, mae: 0, rmse: 0, topOverlap: 0 };
  const full = decks.map((deck) => deck.mean);
  const predicted = decks.map((deck) => average(indices.map((index) => Number(deck.scenarioValues[index]))));
  const errors = predicted.map((value, index) => value - full[index]);
  const topCount = Math.min(1000, Math.max(50, Math.floor(decks.length * 0.01)));
  const fullTop = new Set([...decks.keys()].sort((a, b) => full[b] - full[a]).slice(0, topCount));
  const predictedTop = [...decks.keys()].sort((a, b) => predicted[b] - predicted[a]).slice(0, topCount);
  const overlap = predictedTop.filter((index) => fullTop.has(index)).length / Math.max(1, topCount);
  return {
    correlation: rounded(correlation(predicted, full), 6),
    mae: rounded(average(errors.map(Math.abs)), 6),
    rmse: rounded(Math.sqrt(average(errors.map((value) => value ** 2))), 6),
    topOverlap: rounded(overlap, 6),
  };
}

function buildPairPriors(decks, maximumEntries) {
  const globalMean = average(decks.map((deck) => deck.mean));
  const slotStats = Array.from({ length: 5 }, () => new Map());
  for (const deck of decks) {
    for (let position = 0; position < 5; position += 1) {
      const id = deck.ids[position];
      const current = slotStats[position].get(id) ?? { sum: 0, count: 0 };
      current.sum += deck.mean;
      current.count += 1;
      slotStats[position].set(id, current);
    }
  }
  const slotLift = slotStats.map((stats) => new Map([...stats.entries()].map(([id, entry]) => [
    id,
    (entry.sum / entry.count - globalMean) * (entry.count / (entry.count + 6)),
  ])));
  const pairs = new Map();
  for (const deck of decks) {
    for (let left = 0; left < 5; left += 1) {
      for (let right = left + 1; right < 5; right += 1) {
        const leftId = deck.ids[left];
        const rightId = deck.ids[right];
        const predicted = globalMean + (slotLift[left].get(leftId) ?? 0) + (slotLift[right].get(rightId) ?? 0);
        const residual = deck.mean - predicted;
        const key = `${left}:${leftId}|${right}:${rightId}`;
        const current = pairs.get(key) ?? { left, right, leftId, rightId, sum: 0, sumSq: 0, count: 0 };
        current.sum += residual;
        current.sumSq += residual * residual;
        current.count += 1;
        pairs.set(key, current);
      }
    }
  }
  return [...pairs.values()]
    .filter((entry) => entry.count >= 3)
    .map((entry) => {
      const mean = entry.sum / entry.count;
      const shrunk = mean * entry.count / (entry.count + 8);
      return {
        a: entry.left + 1,
        i: entry.leftId,
        b: entry.right + 1,
        j: entry.rightId,
        n: entry.count,
        d: rounded(shrunk),
      };
    })
    .sort((left, right) => (
      Math.abs(right.d) * Math.log1p(right.n) - Math.abs(left.d) * Math.log1p(left.n) ||
      right.n - left.n ||
      left.a - right.a ||
      String(left.i).localeCompare(String(right.i)) ||
      left.b - right.b ||
      String(left.j).localeCompare(String(right.j))
    ))
    .slice(0, maximumEntries);
}

function pairedDelta(baseValues, alternativeValues) {
  const deltas = baseValues.map((value, index) => Number(alternativeValues[index]) - Number(value));
  const mean = average(deltas);
  const se = deltas.length > 1 ? standardDeviation(deltas) / Math.sqrt(deltas.length) : 0;
  return { mean: rounded(mean), robust: rounded(mean - 1.28 * se) };
}

const inputId = readArgument("input", "fire:100");
const checkpointPath = readArgument("checkpoint", "");
const reportPath = readArgument("report", "");
const outputManifest = readArgument("output-manifest", "browser-knowledge-manifest.json");
const outputBase = readArgument("output-base", "browser-knowledge-base.json");
const shardCount = positiveInteger(readArgument("shard-count", "38"), 38, 1);
const anchorLimit = positiveInteger(readArgument("anchor-limit", "2"), 2, 1);
const deckLibraryLimit = positiveInteger(readArgument("deck-library-limit", "60000"), 60000, 1000);
const neighborDeckLimit = positiveInteger(readArgument("neighbor-deck-limit", "20000"), 20000, 1000);
const pairLimit = positiveInteger(readArgument("pair-limit", "120000"), 120000, 1000);
const trainingLimit = positiveInteger(readArgument("training-limit", "12000"), 12000, 1000);
if (!checkpointPath || !reportPath) throw new Error("--checkpoint and --report are required.");

const [checkpoint, report] = await Promise.all([
  fs.readFile(checkpointPath, "utf8").then(JSON.parse),
  fs.readFile(reportPath, "utf8").then(JSON.parse),
]);
if (checkpoint.status !== "complete") throw new Error(`Expected complete checkpoint, got ${checkpoint.status}.`);
if (String(report.context?.inputId) !== inputId) throw new Error(`Report input mismatch: ${report.context?.inputId}`);

const turns = Math.min(12, Math.max(1, Number(report.context?.turns ?? checkpoint.context?.turns) || 12));
const scenarioCount = Math.max(1, Number(report.context?.teamScenarioCount ?? report.context?.scenarioCount) || 72);
const charactersById = new Map(CHARACTER_CATALOG.map((character) => [String(character.id), character]));
const prefix = `${turns}:`;
const decks = [];
for (const entry of checkpoint.evaluatedDeckPool ?? []) {
  if (!entry || typeof entry.key !== "string" || !entry.key.startsWith(prefix)) continue;
  const result = entry.result;
  if (!Array.isArray(result?.scenarioValues) || result.scenarioValues.length !== scenarioCount) continue;
  const ids = entry.key.slice(prefix.length).split("|");
  if (ids.length !== 5 || ids.some((id) => !charactersById.has(String(id)))) continue;
  const scenarioValues = result.scenarioValues.map(Number);
  if (scenarioValues.some((value) => !Number.isFinite(value))) continue;
  const mean = Number.isFinite(Number(result.expectedWinRate)) ? Number(result.expectedWinRate) : average(scenarioValues);
  const lower = Number.isFinite(Number(result.expectedWinLowerBound)) ? Number(result.expectedWinLowerBound) : meanLowerBound(scenarioValues);
  decks.push({
    key: entry.key,
    ids: ids.map(String),
    scenarioValues,
    mean,
    lower,
    decisive: Number(result.decisiveWinRate) || 0,
    totalCost: ids.reduce((sum, id) => sum + (Number(charactersById.get(String(id))?.cost) || 0), 0),
  });
}
if (!decks.length) throw new Error("No complete evaluated decks were found in the checkpoint.");
decks.sort(deckSort);

const trainingDecks = chooseTrainingDecks(decks, Math.min(trainingLimit, decks.length));
const representativeOrder = representativeScenarioOrder(trainingDecks, 18);
const representative = {};
for (const size of [6, 12, 18]) {
  const selected = representativeOrder.slice(0, Math.min(size, representativeOrder.length));
  representative[size] = {
    indices: selected,
    validation: scenarioSubsetMetrics(decks, selected),
  };
}

const selectedDeckKeys = new Set(decks.slice(0, Math.min(deckLibraryLimit, decks.length)).map((deck) => deck.key));
const coverage = new Map();
for (const deck of decks) {
  let keep = selectedDeckKeys.has(deck.key);
  for (let position = 0; position < 5; position += 1) {
    const key = `${position + 1}:${deck.ids[position]}`;
    const count = coverage.get(key) ?? 0;
    if (count < 2) keep = true;
  }
  if (!keep) continue;
  selectedDeckKeys.add(deck.key);
  for (let position = 0; position < 5; position += 1) {
    const key = `${position + 1}:${deck.ids[position]}`;
    coverage.set(key, (coverage.get(key) ?? 0) + 1);
  }
}
const selectedDecks = decks.filter((deck) => selectedDeckKeys.has(deck.key)).slice(0, Math.max(deckLibraryLimit, selectedDeckKeys.size));
const candidatePriors = (report.rankingsByPosition ?? []).flatMap((slot) => (
  (slot.characters ?? []).map((entry) => compactCandidate(entry, Number(slot.position)))
));
const characterIds = [...new Set([
  ...decks.flatMap((deck) => deck.ids),
  ...candidatePriors.map((entry) => entry.i),
])].sort();
const characterIndex = new Map(characterIds.map((id, index) => [id, index]));
const deckIndexByKey = new Map(selectedDecks.map((deck, index) => [deck.key, index]));
const deckLibrary = selectedDecks.map((deck) => ({
  i: deck.ids.map((id) => characterIndex.get(id)),
  c: deck.totalCost,
  w: rounded(deck.mean),
  l: rounded(deck.lower),
  a: rounded(deck.decisive),
}));

const neighborBases = selectedDecks.slice(0, Math.min(neighborDeckLimit, selectedDecks.length));
const wantedSignatures = Array.from({ length: 5 }, () => new Set());
for (const deck of neighborBases) {
  for (let position = 0; position < 5; position += 1) {
    wantedSignatures[position].add(deck.ids.filter((_, index) => index !== position).join("|"));
  }
}
const signatureBuckets = Array.from({ length: 5 }, () => new Map());
for (const deck of decks) {
  for (let position = 0; position < 5; position += 1) {
    const signature = deck.ids.filter((_, index) => index !== position).join("|");
    if (!wantedSignatures[position].has(signature)) continue;
    const bucket = signatureBuckets[position].get(signature) ?? [];
    bucket.push(deck);
    bucket.sort(deckSort);
    if (bucket.length > 8) bucket.length = 8;
    signatureBuckets[position].set(signature, bucket);
  }
}
const neighborhoods = [];
for (const base of neighborBases) {
  const baseIndex = deckIndexByKey.get(base.key);
  if (baseIndex === undefined) continue;
  for (let position = 0; position < 5; position += 1) {
    const signature = base.ids.filter((_, index) => index !== position).join("|");
    const alternatives = (signatureBuckets[position].get(signature) ?? [])
      .filter((entry) => entry.ids[position] !== base.ids[position])
      .slice(0, 5)
      .map((entry) => {
        const delta = pairedDelta(base.scenarioValues, entry.scenarioValues);
        return [
          characterIndex.has(entry.ids[position]) ? characterIndex.get(entry.ids[position]) : entry.ids[position],
          delta.mean,
          delta.robust,
          rounded(entry.mean),
        ];
      });
    if (alternatives.length) neighborhoods.push([baseIndex, position + 1, alternatives]);
  }
}

const candidateKeys = new Set(candidatePriors.map((entry) => `${entry.p}:${entry.i}`));
const anchors = new Map();
for (const deck of decks) {
  for (let position = 0; position < 5; position += 1) {
    const candidateKey = `${position + 1}:${deck.ids[position]}`;
    if (!candidateKeys.has(candidateKey)) continue;
    const entries = anchors.get(candidateKey) ?? [];
    if (entries.length < anchorLimit) {
      entries.push(deck);
      anchors.set(candidateKey, entries);
    }
  }
}
const shards = Array.from({ length: shardCount }, () => []);
let taskCount = 0;
for (const prior of candidatePriors) {
  const key = `${prior.p}:${prior.i}`;
  for (const [anchorIndex, deck] of (anchors.get(key) ?? []).entries()) {
    const task = {
      n: taskCount,
      p: prior.p,
      i: prior.i,
      a: anchorIndex,
      d: deck.ids,
      b: deck.scenarioValues.map((value) => rounded(value, 6)),
      w: rounded(deck.mean),
      l: rounded(deck.lower),
    };
    const shardIndex = stableHash(`${task.p}:${task.i}:${task.a}:${task.d.join("|")}`) % shardCount;
    shards[shardIndex].push(task);
    taskCount += 1;
  }
}
for (const shard of shards) shard.sort((left, right) => left.n - right.n);

const baseKnowledge = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputId,
  sourceGeneratedAt: report.generatedAt ?? checkpoint.updatedAt ?? null,
  modelVersion: report.model?.version ?? checkpoint.context?.version ?? null,
  context: {
    totalCost: Number(report.context?.totalCost) || 0,
    allowedAttributes: report.context?.allowedAttributes ?? [],
    turns,
    scenarioCount,
    sourceEvaluatedDeckCount: decks.length,
    deckLibraryCount: deckLibrary.length,
    candidatePriorCount: candidatePriors.length,
  },
  representativeScenarios: representative,
  characterIds,
  candidatePriors,
  deckLibrary,
  neighborhoods,
  pairPriors: buildPairPriors(decks, pairLimit),
};

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputId,
  modelVersion: baseKnowledge.modelVersion,
  context: {
    turns,
    environmentCount: Number(report.context?.environmentCount) || 72,
    environmentVariants: Number(report.context?.environmentVariants) || 2,
    teamScenarioCount: scenarioCount,
    boostMultiplier: 1.5,
    anchorLimit,
    shardCount,
  },
  taskCount,
  shards,
};

await Promise.all([
  fs.writeFile(outputManifest, `${JSON.stringify(manifest)}\n`, "utf8"),
  fs.writeFile(outputBase, `${JSON.stringify(baseKnowledge)}\n`, "utf8"),
]);
console.log(JSON.stringify({
  inputId,
  evaluatedDecks: decks.length,
  deckLibrary: deckLibrary.length,
  pairPriors: baseKnowledge.pairPriors.length,
  neighborhoods: neighborhoods.length,
  boostTasks: taskCount,
  shardSizes: shards.map((shard) => shard.length),
  representativeScenarios: representative,
}, null, 2));
