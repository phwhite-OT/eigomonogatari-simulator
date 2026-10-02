import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const compatSource = await fs.readFile(new URL("../src/ui/metagame-v12-compat.js", import.meta.url), "utf8");

function createHarness({ precomputed = [{ scenarioCount: 72, deck: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }] } = {}) {
  let fallbackCalls = 0;
  const context = vm.createContext({
    console,
    metagameUiHasCurrentSkillEvidence: () => false,
    metagameUiCalculationState: () => "legacy",
    renderMetagameCalculationStatus: () => {},
    renderMetagameDebugRankings: () => {},
    metagameUiImpactReasons: () => [],
    renderMetagameSimulatorResult: () => {},
    metagameUiElement: () => ({}),
    metagameUiSigned: (value) => String(value),
    metagameUiPercent: (value) => String(value),
    attributeClassLabel: () => "火",
    resolveMetagameConstraint: (_data, constraintId, totalCost) => ({
      id: constraintId,
      totalCost,
      modelVersion: "team-battle-v12.5-effective-damage-individual-rank",
      precomputedDecks: [{ i: ["a", "b", "c", "d", "e"] }],
      scenarioCount: 72,
      slots: [],
    }),
    normalizeMetagameBoostedCharacterIds: (values) => new Set((values ?? []).map(String)),
    metagameFixedSlots: (values) => new Map(Object.entries(values ?? {}).map(([position, id]) => [Number(position), String(id)])),
    metagameV8PrecomputedResults: () => precomputed,
    findBestMetagameDeck: async () => {
      fallbackCalls += 1;
      return { fallback: true };
    },
  });
  vm.runInContext(compatSource, context, { filename: "metagame-v12-compat.js" });
  return { context, fallbackCalls: () => fallbackCalls };
}

test("V12 browser does not short-circuit exact costs to a finished-deck cache", async () => {
  const harness = createHarness();
  const result = await harness.context.findBestMetagameDeck(
    { generatedAt: "2026-08-31T00:00:00Z" },
    "fire:100",
    [],
    { totalCost: 100 },
  );

  assert.equal(result.fallback, true);
  assert.equal(harness.fallbackCalls(), 1);
});

test("V12 browser falls back to live calculation when a boosted character changes battle stats", async () => {
  const harness = createHarness();
  const result = await harness.context.findBestMetagameDeck(
    {},
    "fire:100",
    [],
    { totalCost: 100, boostedCharacterIds: ["boosted"] },
  );

  assert.equal(result.fallback, true);
  assert.equal(harness.fallbackCalls(), 1);
});

test("V12 browser sends fixed-slot searches through live reconstruction instead of requiring a saved deck", async () => {
  const harness = createHarness({ precomputed: [] });
  const result = await harness.context.findBestMetagameDeck(
    {},
    "fire:100",
    [],
    { totalCost: 100, fixedSlots: { 1: "missing" } },
  );

  assert.equal(result.fallback, true);
  assert.equal(harness.fallbackCalls(), 1);
});
