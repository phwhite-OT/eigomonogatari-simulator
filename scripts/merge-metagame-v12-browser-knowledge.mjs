import fs from "node:fs/promises";
import path from "node:path";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function rounded(value, digits = 5) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

const basePath = readArgument("base", "");
const shardDirectory = readArgument("shard-directory", "");
const outputPath = readArgument("output", "browser-knowledge.json");
if (!basePath || !shardDirectory) throw new Error("--base and --shard-directory are required.");

const base = JSON.parse(await fs.readFile(basePath, "utf8"));
const names = (await fs.readdir(shardDirectory)).filter((name) => name.endsWith(".json")).sort();
const anchorResults = [];
for (const name of names) {
  const shard = JSON.parse(await fs.readFile(path.join(shardDirectory, name), "utf8"));
  if (shard.inputId !== base.inputId) throw new Error(`Input mismatch in ${name}.`);
  anchorResults.push(...(shard.results ?? []));
}

const byCandidate = new Map();
for (const result of anchorResults) {
  const key = `${result.p}:${result.i}`;
  const entries = byCandidate.get(key) ?? [];
  entries.push(result);
  byCandidate.set(key, entries);
}
const boostedPriors = [...byCandidate.entries()].map(([key, entries]) => {
  entries.sort((left, right) => (
    Number(right.l) - Number(left.l) ||
    Number(right.w) - Number(left.w) ||
    Number(right.r) - Number(left.r) ||
    Number(left.a) - Number(right.a)
  ));
  const best = entries[0];
  return {
    p: best.p,
    i: best.i,
    n: entries.length,
    w: best.w,
    l: best.l,
    m: rounded(average(entries.map((entry) => Number(entry.m) || 0))),
    r: rounded(average(entries.map((entry) => Number(entry.r) || 0))),
    q: [
      rounded(Math.min(...entries.map((entry) => Number(entry.r) || 0))),
      rounded(Math.max(...entries.map((entry) => Number(entry.r) || 0))),
    ],
    a: entries.slice(0, 3).map((entry) => ({
      d: entry.d,
      w: entry.w,
      l: entry.l,
      m: entry.m,
      r: entry.r,
    })),
  };
}).sort((left, right) => left.p - right.p || String(left.i).localeCompare(String(right.i)));

const output = {
  ...base,
  generatedAt: new Date().toISOString(),
  boostModel: {
    multiplier: 1.5,
    anchorResultCount: anchorResults.length,
    candidateCount: boostedPriors.length,
    priors: boostedPriors,
  },
};
await fs.writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({
  inputId: output.inputId,
  deckLibraryCount: output.deckLibrary?.length ?? 0,
  pairPriorCount: output.pairPriors?.length ?? 0,
  neighborhoodCount: output.neighborhoods?.length ?? 0,
  boostedAnchorResults: anchorResults.length,
  boostedCandidatePriors: boostedPriors.length,
  outputPath,
}, null, 2));
