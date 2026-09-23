import test from "node:test";
import assert from "node:assert/strict";

import {
  annotateMetagameV12RatingsWithEquilibrium,
  selectMetagameV12EquilibriumDecks,
  solveMetagameV12Equilibrium,
  summarizeMetagameV12Equilibrium,
} from "../src/core/metagame-v12-equilibrium.js";

function poolEntry(id, expectedWinRate, scenarioValues = []) {
  return {
    key: id,
    ids: [id, `${id}-2`, `${id}-3`, `${id}-4`, `${id}-5`],
    names: [id, `${id}-2`, `${id}-3`, `${id}-4`, `${id}-5`],
    totalCost: 100,
    result: {
      expectedWinRate,
      expectedWinLowerBound: expectedWinRate,
      scenarioValues,
    },
  };
}

test("equilibrium deck selection keeps narrow scenario specialists alongside broad generalists", () => {
  const generalist = poolEntry("generalist", 0.8, [0.8, 0.8, 0.8, 0.8]);
  const specialist = poolEntry("specialist", 0.55, [1, 0.2, 0.2, 0.2]);
  const others = Array.from({ length: 12 }, (_, index) => (
    poolEntry(`other-${index}`, 0.79 - index * 0.01, [0.7, 0.7, 0.7, 0.7])
  ));
  const selected = selectMetagameV12EquilibriumDecks(
    [generalist, specialist, ...others],
    { limit: 8 },
  );
  assert.equal(selected.some((entry) => entry.ids[0] === "generalist"), true);
  assert.equal(selected.some((entry) => entry.ids[0] === "specialist"), true);
});

test("no-regret equilibrium converges near one-third usage in a rock-paper-scissors cycle", () => {
  const matrix = [
    [0.5, 0, 1],
    [1, 0.5, 0],
    [0, 1, 0.5],
  ];
  const solution = solveMetagameV12Equilibrium(matrix, {
    iterations: 3000,
    burnIn: 500,
    learningRate: 1.2,
    exploration: 0.001,
  });
  for (const share of solution.usage) assert.ok(Math.abs(share - 1 / 3) < 0.03);
  assert.ok(Math.abs(solution.equilibriumValue - 0.5) < 0.02);
  assert.ok(solution.exploitability < 0.03);
});

test("a narrow counter loses equilibrium share when it only beats one target archetype", () => {
  // generalist is strong against both itself and the narrow counter; target is
  // exploitable by the counter. The counter should not dominate merely because
  // it hard-counters target.
  const matrix = [
    [0.5, 0.65, 0.62],
    [0.35, 0.5, 0.2],
    [0.38, 0.8, 0.5],
  ];
  const solution = solveMetagameV12Equilibrium(matrix, {
    iterations: 3000,
    burnIn: 500,
    learningRate: 1.4,
  });
  assert.ok(solution.usage[0] > solution.usage[2]);
  assert.ok(solution.usage[2] < 0.3);
});

test("equilibrium summary exposes target dependency by removing one opponent from the final mix", () => {
  const entries = [
    poolEntry("generalist", 0.7),
    poolEntry("target", 0.7),
    poolEntry("counter", 0.6),
  ].map((entry) => ({ ...entry, key: entry.ids.join("|") }));
  const matrix = [
    [0.5, 0.55, 0.7],
    [0.45, 0.5, 0.15],
    [0.3, 0.85, 0.5],
  ];
  const solution = {
    usage: [0.45, 0.35, 0.2],
    expectedWinRates: [
      0.45 * 0.5 + 0.35 * 0.55 + 0.2 * 0.7,
      0.45 * 0.45 + 0.35 * 0.5 + 0.2 * 0.15,
      0.45 * 0.3 + 0.35 * 0.85 + 0.2 * 0.5,
    ],
    equilibriumValue: 0.5,
    exploitability: 0.02,
    iterations: 1000,
    converged: false,
  };
  const summary = summarizeMetagameV12Equilibrium(entries, matrix, solution);
  const counter = summary.decks.find((entry) => entry.ids[0] === "counter");
  assert.ok(counter.metaDependency > 0);
  assert.deepEqual(counter.dependencyTargetNames, entries[1].names);
});

test("equilibrium annotations add a separate strategic rank without replacing causal rating fields", () => {
  const results = [
    new Map([
      ["a", { id: "a", opportunityWinGain: 0.1, rank: 1 }],
      ["b", { id: "b", opportunityWinGain: 0.2, rank: 2 }],
    ]),
    new Map(), new Map(), new Map(), new Map(),
  ];
  const equilibrium = {
    version: 1,
    decks: [
      {
        ids: ["a", "x2", "x3", "x4", "x5"],
        usageRate: 0.7,
        expectedWinRate: 0.51,
        metaDependency: 0.01,
        dependencyTargetNames: null,
      },
      {
        ids: ["b", "y2", "y3", "y4", "y5"],
        usageRate: 0.3,
        expectedWinRate: 0.5,
        metaDependency: 0.08,
        dependencyTargetNames: ["target"],
      },
    ],
  };
  const annotated = annotateMetagameV12RatingsWithEquilibrium(results, equilibrium);
  const a = annotated[0].find((entry) => entry.id === "a");
  const b = annotated[0].find((entry) => entry.id === "b");
  assert.equal(a.equilibriumRank, 1);
  assert.equal(b.equilibriumRank, 2);
  assert.equal(a.opportunityWinGain, 0.1);
  assert.equal(b.opportunityWinGain, 0.2);
});
