from pathlib import Path

core_path = Path('src/core/metagame-v12.js')
core = core_path.read_text()
old_version = 'export const METAGAME_V12_MODEL_VERSION = "team-battle-v12.3-defense-outcome";'
new_version = 'export const METAGAME_V12_MODEL_VERSION = "team-battle-v12.4-full-opportunity-baseline";'
if old_version not in core:
    raise SystemExit('V12 model version anchor not found')
core = core.replace(old_version, new_version, 1)

cache_anchor = '''function evaluateCached(deck, teamScenarios, options) {
'''
global_baseline = '''/**
 * Build a shared opportunity-cost baseline from the complete legal candidate
 * set, not the small per-character partner sample. This runs once per
 * cost/attribute condition and its battle results are reused for every card.
 */
export function buildMetagameV12GlobalBaselineDecks(resolvedInput, candidatePools, options = {}) {
  const baselineDeckLimit = Math.max(8, Math.floor(Number(options.baselineDeckLimit) || 32));
  const baselineBeamWidth = Math.max(500, Math.floor(Number(options.baselineBeamWidth) || 2000));
  const allRatingsByPosition = candidatePools?.ratingsByPosition ?? [];
  const slots = allRatingsByPosition.map((ratings, index) => ({
    position: index + 1,
    candidates: [...(ratings?.values?.() ?? [])],
  }));
  if (slots.length !== 5 || slots.some((slot) => !slot.candidates.length)) return [];

  const constraint = {
    totalCost: resolvedInput.totalCost,
    allowedAttributes: resolvedInput.allowedAttributes,
    slots,
  };
  let candidates;
  try {
    candidates = buildMetagameDeckCandidates(
      constraint,
      [...candidatePools.charactersById.values()],
      { beamWidth: baselineBeamWidth },
    );
  } catch (error) {
    if (error instanceof Error && /cost|総コスト|valid complete|legal deck/i.test(error.message)) return [];
    throw error;
  }
  if (!candidates.length) return [];

  const selected = new Map();
  const add = (entry) => selected.set(deckKey(entry.deck), entry);
  const diverseLimit = Math.max(4, Math.ceil(baselineDeckLimit * 0.65));
  selectDiverseDecks(candidates, diverseLimit).forEach(add);

  const totalCost = Math.max(1, Number(resolvedInput.totalCost) || 1);
  [...candidates]
    .sort((left, right) => (
      ((Number(right.proxyScore) || 0) - (Number(right.totalCost) || 0) / totalCost * 0.08) -
      ((Number(left.proxyScore) || 0) - (Number(left.totalCost) || 0) / totalCost * 0.08) ||
      (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
    ))
    .slice(0, Math.max(4, baselineDeckLimit - diverseLimit))
    .forEach(add);

  const protectedIds = new Set(
    candidates.slice(0, Math.min(4, candidates.length))
      .flatMap((entry) => entry.deck.map((character) => String(character.id))),
  );
  for (const id of protectedIds) {
    const replacement = candidates.find((entry) => (
      entry.deck.every((character) => String(character.id) !== id)
    ));
    if (replacement) add(replacement);
  }

  return [...selected.values()].sort((left, right) => (
    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||
    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)
  ));
}

''' + cache_anchor
if cache_anchor not in core:
    raise SystemExit('evaluateCached anchor not found')
core = core.replace(cache_anchor, global_baseline, 1)
core_path.write_text(core)

script_path = Path('scripts/rate-metagame-v12.mjs')
script = script_path.read_text()
old_import = '''  buildMetagameV7CandidatePools,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";'''
new_import = '''  buildMetagameV7CandidatePools,
  evaluateMetagameV7Deck,
  resolveMetagameV7Input,
} from "../src/core/metagame-v7.js";'''
if old_import not in script:
    raise SystemExit('metagame-v7 import anchor not found')
script = script.replace(old_import, new_import, 1)

old_v12_import = '''  METAGAME_V12_MODEL_VERSION,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
  rankMetagameV12Characters,
  rateMetagameV12Character,
} from "../src/core/metagame-v12.js";'''
new_v12_import = '''  METAGAME_V12_MODEL_VERSION,
  buildMetagameV12GlobalBaselineDecks,
  createMetagameV12EnvironmentDecks,
  createMetagameV12TeamScenarios,
  rankMetagameV12Characters,
  rateMetagameV12Character,
} from "../src/core/metagame-v12.js";'''
if old_v12_import not in script:
    raise SystemExit('metagame-v12 import anchor not found')
script = script.replace(old_v12_import, new_v12_import, 1)

beam_anchor = 'const beamWidth = positiveInteger(readArgument("beam-width", "500"), 500, 50);\n'
beam_replacement = beam_anchor + 'const baselineDeckLimit = positiveInteger(readArgument("baseline-deck-limit", "32"), 32, 8);\nconst baselineBeamWidth = positiveInteger(readArgument("baseline-beam-width", "2000"), 2000, 500);\n'
if beam_anchor not in script:
    raise SystemExit('beam width anchor not found')
script = script.replace(beam_anchor, beam_replacement, 1)

old_semantics = 'const METAGAME_V12_BATTLE_SEMANTICS_VERSION = "defense-outcome-v3";'
if old_semantics not in script:
    raise SystemExit('battle semantics anchor not found')
script = script.replace(old_semantics, 'const METAGAME_V12_BATTLE_SEMANTICS_VERSION = "opportunity-baseline-v4";', 1)

context_anchor = '''  beamWidth,
  turns,
'''
context_replacement = '''  beamWidth,
  baselineDeckLimit,
  baselineBeamWidth,
  turns,
'''
if context_anchor not in script:
    raise SystemExit('checkpoint context anchor not found')
script = script.replace(context_anchor, context_replacement, 1)

shared_anchor = '''// Zero-simulation second pass: every deck already evaluated by any candidate
// or shard becomes evidence for every character that occupies the same slot.
// Likewise, any evaluated deck that excludes a character can serve as that
// character's opportunity-cost baseline. Exact scenarioValues are retained,
// so the paired robustness correction is recomputed rather than estimated.
const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
'''
shared_replacement = '''// Seed a shared baseline from all legal candidates before reconciliation.
// This search is paid once per condition, rather than once per character, so
// cheap strong replacements cannot disappear merely because they missed the
// bounded partner sample used by the direct per-character probes.
const globalBaselineCandidates = buildMetagameV12GlobalBaselineDecks(
  resolvedInput,
  candidatePools,
  { baselineDeckLimit, baselineBeamWidth },
);
let globalBaselineNewEvaluations = 0;
for (const entry of globalBaselineCandidates) {
  const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;
  if (evaluationCache.has(key)) continue;
  evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));
  globalBaselineNewEvaluations += 1;
}
if (globalBaselineNewEvaluations) await saveProgress();

const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);
'''
if shared_anchor not in script:
    raise SystemExit('shared pool anchor not found')
script = script.replace(shared_anchor, shared_replacement, 1)

policy_old = '''    costPolicy: "候補を外した際のコストを5枠全体で再配分するため、コスト効率は機会費用比較へ内包する。",
    environmentPolicy: "提示環境だけを使い、10人内の同一キャラ重複を人工的に避けない。伝説判定は『伝』とLEGENDの両方を認識する。",
    performancePolicy: "各候補の直接探索は候補デッキ3本+除外代替3本のまま増やさない。全候補・全shardの計算後、既に72シナリオ評価済みのデッキを共有プール化して全カードを再集計するため、共有処理による追加戦闘は0。checkpointにも評価済みデッキを保存し、再開時の重複戦闘を避ける。",
'''
policy_new = '''    costPolicy: "候補を外した際のコストを5枠全体で再配分し、さらに全合法候補から作る共有基準デッキを比較対象へ追加する。高コストの機会損失を小さなパートナー候補集合だけで過小評価しない。",
    environmentPolicy: "提示環境だけを使い、10人内の同一キャラ重複を人工的に避けない。伝説判定は『伝』とLEGENDの両方を認識する。",
    performancePolicy: "各候補の直接探索は候補デッキ3本+除外代替3本のまま維持する。全shard統合後に各条件1回だけ全合法候補から共有基準デッキを探索・実戦評価し、そのキャッシュを全キャラの機会費用比較へ再利用する。",
'''
if policy_old not in script:
    raise SystemExit('report policy anchor not found')
script = script.replace(policy_old, policy_new, 1)

report_context_anchor = '''    beamWidth,
    sharedEvaluatedDeckCount: sharedDeckPool.length,
'''
report_context_replacement = '''    beamWidth,
    baselineDeckLimit,
    baselineBeamWidth,
    globalBaselineCandidateCount: globalBaselineCandidates.length,
    globalBaselineNewEvaluationCount: globalBaselineNewEvaluations,
    sharedEvaluatedDeckCount: sharedDeckPool.length,
'''
if report_context_anchor not in script:
    raise SystemExit('report context anchor not found')
script = script.replace(report_context_anchor, report_context_replacement, 1)

log_anchor = 'console.log(`V12 shared pool: ${sharedDeckPool.length} evaluated decks / ${sharedPoolImprovementCount} ratings changed.`);\n'
if log_anchor not in script:
    raise SystemExit('report log anchor not found')
script = script.replace(log_anchor, 'console.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated).`);\n' + log_anchor, 1)
script_path.write_text(script)

test_path = Path('test/metagame-v12.test.js')
tests = test_path.read_text()
tests = tests.replace(
    '  buildMetagameV12AlternativeDecks,\n',
    '  buildMetagameV12AlternativeDecks,\n  buildMetagameV12GlobalBaselineDecks,\n',
    1,
)
tests = tests.replace(
    'assert.equal(METAGAME_V12_MODEL_VERSION, "team-battle-v12.3-defense-outcome");',
    'assert.equal(METAGAME_V12_MODEL_VERSION, "team-battle-v12.4-full-opportunity-baseline");',
    1,
)
marker = 'V12.4 global opportunity baseline searches outside the sampled partner pool'
if marker not in tests:
    anchor = 'test("V12 ranking keeps harmful team contribution below neutral instead of clipping it", () => {\n'
    if anchor not in tests:
        raise SystemExit('V12 test insertion anchor not found')
    new_test = '''test("V12.4 global opportunity baseline searches outside the sampled partner pool", () => {
  const sampled = character("sampled-1", 1, { cost: 40 });
  const outside = character("outside-sample", 1, { cost: 10 });
  const fixed = [2, 3, 4, 5].map((position) => character(`fixed-${position}`, position, { cost: 10 }));
  const all = [sampled, outside, ...fixed];
  const ratingsByPosition = [1, 2, 3, 4, 5].map((position) => new Map(
    all.filter((entry) => entry.allowedPositions.includes(position)).map((entry) => [
      entry.id,
      rating(entry, entry.id === "outside-sample" ? 0.98 : entry.id === "sampled-1" ? 0.1 : 0.7),
    ]),
  ));
  const candidatePools = {
    ratingsByPosition,
    partnerRatingsByPosition: ratingsByPosition.map((entries, index) => (
      index === 0 ? [entries.get("sampled-1")] : [...entries.values()]
    )),
    charactersById: new Map(all.map((entry) => [entry.id, entry])),
  };
  const decks = buildMetagameV12GlobalBaselineDecks({
    totalCost: 100,
    allowedAttributes: ["fire"],
  }, candidatePools, { baselineDeckLimit: 8, baselineBeamWidth: 500 });

  assert.ok(decks.length >= 1);
  assert.ok(decks.some((entry) => entry.deck[0].id === "outside-sample"));
});

'''
    tests = tests.replace(anchor, new_test + anchor, 1)
test_path.write_text(tests)
