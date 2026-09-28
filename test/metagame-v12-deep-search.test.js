import test from "node:test";
import assert from "node:assert/strict";

import {
  assessMetagameV12DeepFrontierConvergence,
  buildMetagameV12MeasuredSlotStrength,
  selectMetagameV12DeepReplacementCandidates,
} from "../src/core/metagame-v12-deep-search.js";

test("bounded deep search keeps evidence leaders plus role and cost diversity", () => {
  const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"];
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    id: `c${index}`,
    cost: 2 + index,
  }));
  const proxy = new Map(candidates.map((candidate, index) => [
    candidate.id,
    {
      id: candidate.id,
      role: roles[index % roles.length],
      practicalValue: 0.45 + (index % 10) * 0.01,
    },
  ]));
  const finals = new Map(candidates.map((candidate, index) => [
    candidate.id,
    {
      id: candidate.id,
      role: roles[index % roles.length],
      individualScore: 0.4 + index * 0.005,
    },
  ]));
  const measured = new Map([["c2", 0.95], ["c35", 0.9]]);

  const selected = selectMetagameV12DeepReplacementCandidates(candidates, {
    limit: 20,
    finalRatingsById: finals,
    proxyRatingsById: proxy,
    measuredStrengthById: measured,
  });

  assert.equal(selected.length, 20);
  assert.equal(new Set(selected.map((entry) => entry.id)).size, 20);
  assert.ok(selected.some((entry) => entry.id === "c2"));
  assert.ok(selected.some((entry) => entry.id === "c35"));
  const selectedRoles = new Set(selected.map((entry) => proxy.get(entry.id).role));
  roles.forEach((role) => assert.ok(selectedRoles.has(role), `missing role ${role}`));
  const selectedCosts = selected.map((entry) => entry.cost);
  assert.ok(Math.min(...selectedCosts) <= 6);
  assert.ok(Math.max(...selectedCosts) >= 35);
});

test("measured slot strength uses the strongest exact deck seen for each slot", () => {
  const pool = [
    {
      ids: ["a", "b", "c", "d", "e"],
      result: { expectedWinRate: 0.7, expectedWinLowerBound: 0.6 },
    },
    {
      ids: ["a", "x", "y", "z", "q"],
      result: { expectedWinRate: 0.8, expectedWinLowerBound: 0.7 },
    },
  ];
  const strengths = buildMetagameV12MeasuredSlotStrength(pool);
  assert.ok(strengths[0].get("a") > 0.7);
  assert.ok(strengths[1].has("b"));
  assert.ok(strengths[1].has("x"));
});

test("deep frontier stops only when measured leaders are stable and no meaningful gain remains", () => {
  const previous = Array.from({ length: 24 }, (_, index) => `d${index}`);
  const stable = [...previous.slice(0, 22), "new-a", "new-b"];
  const converged = assessMetagameV12DeepFrontierConvergence(
    previous,
    stable,
    0.72,
    0.721,
    { overlapThreshold: 0.875, improvementThreshold: 0.0025 },
  );
  assert.equal(converged.converged, true);

  const improved = assessMetagameV12DeepFrontierConvergence(
    previous,
    stable,
    0.72,
    0.73,
    { overlapThreshold: 0.875, improvementThreshold: 0.0025 },
  );
  assert.equal(improved.converged, false);

  const churned = assessMetagameV12DeepFrontierConvergence(
    previous,
    Array.from({ length: 24 }, (_, index) => `x${index}`),
    0.72,
    0.721,
    { overlapThreshold: 0.875, improvementThreshold: 0.0025 },
  );
  assert.equal(churned.converged, false);
});
