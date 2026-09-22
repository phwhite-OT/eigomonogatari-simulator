# Project handoff — 英語物語 simulator

This document is the durable project-context note for anyone starting from a fresh session in Codex, ChatGPT, an IDE agent, or another development environment.

## 1. Product intent

The repository implements a browser-based **英語物語対戦 simulator / deck recommender**. Its purpose is to recommend ordered five-character decks under constraints such as allowed attributes and total cost while grounding the recommendation in battle simulation rather than a simple character power score.

The project has several related surfaces:

- ordered five-character PvP deck recommendation
- character search / editing / imported data
- battle simulation and minimum-damage logic
- lightest-cost event clear search
- character/environment/metagame evaluation
- precomputed metagame results exposed to the browser build

The current metagame line is the most computationally expensive part of the repository.

## 2. Repository map

- `src/core/` — battle, deck-generation, rating, metagame logic
- `src/data/` — character catalogue and environment/input definitions
- `scripts/` — batch evaluators, builders, finalization planners, local utilities
- `test/` — Node test suite for battle and application logic
- `.github/workflows/` — long-running cloud recompute/finalization/deploy workflows
- `reports/` — checked-in report data on branches where appropriate
- `docs/` — feature and architecture documentation
- `index.html` — generated single-file browser application
- `README.md` — user/developer overview
- `AGENTS.md` — short operational guide and invariants for coding agents

## 3. Battle-model intent

Do not treat the project as a spreadsheet ranker. Important ranking conclusions are intended to come from simulated battle evidence.

The current model line grew out of older V7/V8/V11 code, so some filenames/export names are historical. Use the explicit model/context version to determine compatibility, not the age implied by a filename.

Current V12.5 context:

- context/model version: `team-battle-v12.5-effective-damage-individual-rank`
- battle semantics: `opportunity-baseline-v5-effective-damage`
- final ranking policy: `full-budget-opportunity-v6-cost-weighted-slot`
- finalization-state schema version: `2`

Key modeling principle: a match is a **team battle made from five player decks against five player decks**. Do not regress to a one-deck-vs-one-deck shortcut merely because it is cheaper.

The ranking system tries to separate a character's own measurable value from the strength of teammates it happened to be tested beside. Static proxy metrics are acceptable for bounded partner selection and search acceleration; they are not a substitute for measured final battle contribution.

## 4. V12.5 representative precompute

The expensive browser-supporting precompute intentionally covers only 28 representative conditions.

Seven attribute groups:

- `fire`
- `water`
- `wind`
- `fire-water`
- `fire-wind`
- `water-wind`
- `fire-water-wind`

Four representative costs:

- `100`
- `200`
- `300`
- `500`

Total: `7 × 4 = 28` conditions.

Do **not** change this into 401 separate cost conditions. Intermediate user-entered costs from 100–500 are intentionally resolved from the representative cost bands during browser-side / deck-generation logic.

The definitions live around `src/data/metagame-v12-sweep-inputs.js` and the V12 input plumbing.

## 5. Durable results and checkpoint policy

Source lives on `master`.

Long-running V12 computation state is persisted on:

`metagame-v12-shared-pool-results`

Report root:

`reports/metagame-ratings-v12-team-opportunity/`

This results branch is effectively a durable computation database in Git form. Treat it carefully.

A current completed condition requires compatible metadata, including the current model/context version, battle semantics, finalization state version, and current ranking-policy marker. A checkpoint with candidate ratings present is not automatically final-ranking complete.

Do not delete or reset the results branch just to solve a normal workflow problem. A clean reset is justified only when a model/semantics change makes prior evidence invalid and the reset is intentional.

## 6. Normal shared-pool recompute workflow

Workflow:

`.github/workflows/metagame-v12-shared-pool-recompute.yml`

High-level flow:

### `select`

- fetch the durable results branch
- scan the 28 conditions in stable order
- skip truly current/complete ones
- choose the first incomplete condition
- determine whether to recover artifacts, rerank/finalize, hand off a finalizing checkpoint, or create candidate shards

This step can take time because it fetches history/results and may inspect previous runs/artifacts. It is not the expensive battle calculation itself.

### `evaluate`

- matrix job
- up to 19 runners in parallel
- the 19-runner ceiling is deliberate so one of the normal 20 GitHub-hosted runner slots remains available for lightweight/control work such as reranking
- restores the current condition checkpoint
- computes missing candidate shards via `scripts/rate-metagame-v12.mjs`
- uploads checkpoint artifacts even when a shard later reports failure, allowing safe recovery

When the step named `Recompute V12 candidate shard` is running, candidate battle computation is actually running.

### `publish`

- restore isolated snapshot
- download/recover current shard checkpoints
- merge candidate results
- run bounded finalize-only logic
- write current progress to the durable results branch
- if incomplete, dispatch either the next normal segment or the dedicated finalization fanout

`publish` should not become a multi-hour serial counterfactual engine. Expensive finalization belongs to fanout.

## 7. Distributed finalization workflow

Workflow:

`.github/workflows/metagame-v12-finalization-fanout.yml`

Purpose: finish exact counterfactual/deep-neighbourhood ranking work in parallel after candidate coverage is ready.

High-level flow:

### `select`

Find the first incomplete condition whose checkpoint is already in compatible counterfactual finalization.

### `plan`

Restore the durable checkpoint and build a globally deduplicated work manifest. Current design uses 19 shards and includes deep-search seed work.

### `prefill`

Run up to 19 shards in parallel. The important expensive step is:

`Evaluate assigned unique counterfactual battles`

Each shard emits a finalization-cache delta. The design intentionally tolerates partial shard completion so durable useful work is not lost.

Those shard deltas are the actual output of the expensive fanout. The upload path must use GitHub expression syntax in action inputs (for example `${{ needs.select.outputs.output_directory }}`), not shell-style environment expansion. The merge job must fail rather than silently fall back to serial work if zero cache-delta artifacts are available; otherwise a full 19-runner wave can be wasted.

### `merge`

Merge exact cache deltas back into the checkpoint, advance the frozen finalization cursor/plan, persist results, and continue if needed.

The finalization plan must be resumable and stable. Do not silently regenerate a semantically different plan halfway through a compatible checkpoint unless the code explicitly treats it as invalidated.

## 8. Why matched-slot counterfactual finalization exists

The final ranking is not meant to reward a character merely because it was paired with a strong deck, but matched-slot strength also must not let a very expensive card ignore the opportunity cost it imposes on the other four slots.

The current v6 policy therefore gives every character one transitive contribution score. Full five-slot budget-reallocation opportunity evidence is the primary signal. Same-four-teammate matched-slot contribution is blended in as supporting evidence with weight `0.50 × (1 - cost / total budget)^2`. At cost 26/100 the matched-slot evidence gets about 27% weight; at cost 75/100 it gets only about 3%. If matched-slot evidence is unavailable, the full-budget result is preserved unchanged.

Deep-neighbourhood work still exists to improve the matched-slot evidence around important/high-performing configurations. Ranking-only changes reuse existing battle evidence and should not cancel active computation waves.

The implementation details live primarily in:

- `src/core/metagame-v12.js`
- `src/core/metagame-v12-finalization.js`
- `scripts/plan-metagame-v12-finalization.mjs`
- `scripts/evaluate-metagame-v12-finalization-shard.mjs`
- `scripts/prefill-metagame-v12-finalization.mjs`
- `scripts/reopen-metagame-v12-deep-search.mjs`

When optimizing performance, preserve the meaning of the counterfactual comparison. Faster but semantically different evidence is not a valid optimization unless the model version/ranking policy is deliberately changed.

## 9. Current recovery/self-healing design

### Checkpoint-first behavior

Long computation is expected to be interrupted sometimes. The design saves useful progress rather than assuming one uninterrupted workflow run.

### Watchdog

`.github/workflows/metagame-v12-watchdog.yml`

Scheduled every 10 minutes, plus manual dispatch.

It checks whether the 28-condition computation is complete, whether a current run exists, whether it has exceeded the healthy runtime window, and whether a safe continuation can be dispatched.

Transport/GitHub-service failures around dispatch use bounded retries. Safe saved progress should survive these failures.

### Stale-run preemption

`.github/workflows/metagame-v12-preempt-stale.yml`

When source changes, old-source calculations should not continue consuming runners and eventually overwrite/mix incompatible state. The preemptor cancels obsolete work.

### What is intentionally *not* automatic

A deterministic code bug should not be retried forever. If the same code/data failure occurs repeatedly, the workflow should surface it instead of burning runner-hours indefinitely.

Self-healing means **resume known-safe interrupted work**, not **invent a code fix automatically**.

## 10. Recent incident and fix: zero missing candidate shards

On 2026-09-16, `fire:100` reached a state where its durable checkpoint already contained every candidate rating needed by the ordinary shard planner, but the overall condition was still not complete under the current finalization policy.

The selector attempted to build a missing-candidate work matrix. Because no candidate was missing, the matrix was empty and the workflow failed with:

`No candidate shards selected for incomplete input fire:100`

This exposed an important state distinction:

**candidate coverage complete != current finalization complete**

The fix is in:

`scripts/build-metagame-v12-work-matrix.mjs`

If a compatible saved checkpoint exists and the normal planner returns no missing candidate shards, the script creates one deterministic handoff shard using the first available candidate:

`<position>-finalize-handoff`

The handoff shard re-evaluates one already-covered candidate. It is intentionally not new search work. Its purpose is to emit a normal checkpoint artifact so the existing `publish` path can merge the checkpoint, run finalize-only transition logic, persist the updated finalization state, and dispatch the 19-runner finalization workflow.

This is a bridge around the current workflow contract. If a future refactor allows `publish` to operate directly on the durable checkpoint with no evaluate artifact, this workaround may be removable. Until then, do not “simplify” it away just because the candidate was already rated.

## 11. Live state at the time this document was created

Date: **2026-09-16 JST**.

The fix above was committed and a new V12 shared-pool run progressed successfully through `select`. At the time of documentation, the active job was:

`evaluate (fire:100, fire-100, 1, 1-finalize-handoff, 0)`

with the step:

`Recompute V12 candidate shard`

running.

This live-state paragraph is only a historical handoff marker. Do not assume it is still current later. Always inspect the newest GitHub Actions runs before reporting live status.

## 12. How to read GitHub Actions status correctly

Do not say “the calculation is running” solely because a workflow is `in_progress`.

Use the actual job/step:

- shared-pool `select` active → preparation/selection only
- shared-pool `evaluate` / `Recompute V12 candidate shard` active → candidate computation is running
- finalization `plan` active → work-plan creation, not expensive battle fanout yet
- finalization `prefill` / `Evaluate assigned unique counterfactual battles` active → expensive distributed finalization is running
- `publish` or `merge` active → checkpoint consolidation / transition

This distinction matters because users may be explicitly asking whether expensive battle calculation has begun.

## 13. Source files worth reading before a V12 change

Start here:

- `AGENTS.md`
- `README.md`
- `src/core/simulate.js`
- `src/core/skills.js`
- `src/core/metagame-v7.js`
- `src/core/metagame-v12.js`
- `src/core/metagame-v12-finalization.js`
- `src/core/metagame-v12-shared-pool.js`
- `src/core/metagame-work-shards.js`
- `src/data/metagame-v12-sweep-inputs.js`
- `scripts/rate-metagame-v12.mjs`
- `scripts/build-metagame-v12-work-matrix.mjs`
- `scripts/plan-metagame-v12-finalization.mjs`
- `scripts/evaluate-metagame-v12-finalization-shard.mjs`
- `.github/workflows/metagame-v12-shared-pool-recompute.yml`
- `.github/workflows/metagame-v12-finalization-fanout.yml`
- `.github/workflows/metagame-v12-watchdog.yml`
- `.github/workflows/metagame-v12-preempt-stale.yml`

Some names are legacy. Read behavior, model-version constants, and comments before renaming or removing old-looking code.

## 14. Testing and validation expectations

Base checks:

```bash
npm test
npm run build
```

For Node scripts:

```bash
node --check path/to/script.mjs
```

For expensive-workflow changes, prefer local/synthetic verification of:

- checkpoint compatibility
- work-matrix generation
- empty/missing-candidate behavior
- finalizing-state handoff
- resume behavior
- merge behavior

Do not trigger a full 28-environment recompute merely as a syntax test.

When battle semantics actually change, tests passing is necessary but not sufficient: decide explicitly whether old V12 checkpoints are semantically compatible. If not, bump/invalidate the appropriate model/battle-semantic marker rather than silently mixing old and new evidence.

## 15. Common failure modes to watch for

### “Incomplete” but zero candidate shards

Likely candidate coverage is complete while finalization/ranking policy is not. Check the checkpoint state before treating it as an impossible condition.

### Results branch looks older/different than master

Expected. It is a durable computation branch, not a source-development branch.

### Endless repeated run failures

Do not merely increase retries. Determine whether the failure is transport/transient or deterministic code/data logic.

### Finalization starved by normal recompute

Heavy recompute/finalization workflows still share `metagame-v12-shared-pool-recompute` so two expensive battle waves cannot duplicate the same durable work. Lightweight ranking refresh is intentionally outside that heavy-wave mutex so it can use the reserved 20th runner. To keep that safe, every job that writes `metagame-v12-shared-pool-results` must use the short job-level `metagame-v12-result-writer` lock.

### Browser costs tempt expansion to every cost

Do not create hundreds of cloud precompute conditions. Representative bands are an intentional performance architecture.

### Proxy score looks easier than exact battle evidence

Do not swap the final ranking back to HP/power/skill heuristics for convenience. If a proxy is used, keep it constrained to search acceleration/partner selection unless a deliberate model redesign says otherwise.

## 16. Documentation maintenance contract

If a future change alters any of the following, update this file and `AGENTS.md` in the same change:

- product-level purpose
- battle semantics
- V12 model/context version
- ranking policy
- finalization-state schema
- representative precompute conditions
- results-branch/checkpoint strategy
- workflow topology or concurrency
- automatic recovery behavior
- interpretation of “complete”

The intended outcome is simple: a fresh coding agent should be able to open the repository, read two files, inspect the latest workflow state, and continue the project without needing the original chat history.


## 17. Rolling worklog rule

This document is also the canonical rolling handoff log for future Codex/ChatGPT sessions.

**After every source/workflow/evaluation fix, update this document in the same working session.** Do not rely on chat history alone. A useful entry should state, as applicable:

- what changed
- why it changed / what user-observed problem it addresses
- whether battle semantics changed or only ranking/reporting changed
- checkpoint/recompute compatibility
- current validation / workflow state
- what should be checked next
- any sanity-check examples that motivated the change

For small fixes, a dated entry in the rolling log below is sufficient. If the change alters architecture, battle semantics, ranking policy, checkpoint format, workflow topology/recovery, or the meaning of V12 outputs, also update the relevant explanatory sections above and `AGENTS.md`.

## 18. Rolling handoff log

### 2026-09-22 — cost-aware transitive ranking correction

Latest known master commit at the time of this entry: `8ba71b32f94e636572a4499c97721a2e9bcdbf69` (`fix: make V12 ranking transitive and cost-weighted`).

Current ranking marker:

`full-budget-opportunity-v6-cost-weighted-slot`

The correction addresses a ranking failure mode where a character could look excellent in isolation or in a fixed-slot comparison while consuming too much of a cost-100 deck budget to belong in the strongest actual five-card decks.

The intended interpretation is:

- keep one transitive contribution score per character
- make full five-slot budget reallocation the primary evidence, so the evaluator accounts for what the other four slots can become when this character's cost changes
- use same-four-teammate matched-slot evidence only as supporting evidence
- weight that supporting evidence by `0.50 × (1 - character cost / total budget)^2`
- preserve the full-budget result unchanged when matched-slot evidence is missing
- ranking-only changes should reuse existing battle evidence rather than invalidating/restarting expensive battle waves unless battle semantics themselves changed

User-observed sanity checks that should remain visible to future agents:

- At cost 100, very expensive characters such as アマテラス / フヒッティ should not rank near the top merely because their standalone battle contribution is strong if spending roughly 70+ cost on one slot prevents the resulting five-card deck from being competitive.
- Conversely, cheap utility cards must not be crushed simply because a fixed-slot or partner-sensitive metric undervalues them. パプアさん is an important example: at cost 26, a near-reliable one-turn stall can be highly valuable because four other slots still retain substantial budget.
- Be suspicious if a restriction-irrelevant effect wins mainly through teammate/context leakage rather than genuine opportunity value. The user's example was 水蘇生のちび丸 being rewarded in a way that seemed disconnected from the actual restriction.
- These examples are regression/sanity checks, not hard-coded desired ranks. If simulation evidence genuinely contradicts them, inspect the actual decks, opponents, slot contribution, opportunity result, and cost allocation before changing the formula again.

What to inspect next when results look strange:

1. Compare the character's full-budget opportunity result against matched-slot evidence.
2. Inspect the actual best five-card decks containing and excluding the character, not only the character's scalar score.
3. Check whether partner selection or a restriction-specific interaction is leaking unrelated value into the ranking.
4. Verify that cost-heavy cards pay the opportunity cost of weakening the remaining four slots.
5. Verify that cheap stall/support cards receive credit when they create a real turn/deck-level advantage.
6. Prefer fixing the evidence/aggregation problem over adding character-specific exceptions.


### 2026-09-22 — cost100 rerank completion-detection fix

Observed problem: completed cost-100 result sets such as `fire-100` still had the old ranking marker `full-budget-opportunity-v5-slot-tiebreak` even after the v6 cost-weighted ranking change. The refresh job incorrectly logged that no completed cost-100 ranking needed a refresh.

Root cause: V12 durable checkpoints intentionally store a compact checkpoint context that includes `inputId`, model version, and battle-semantics version, but **does not include `context.totalCost`**. Both cost-100 rerank workflows tested `.context.totalCost == 100`, so every completed checkpoint was skipped.

Fix:

- `.github/workflows/metagame-v12-finalization-fanout.yml`
- `.github/workflows/v12-cost100-rerank.yml`

now identify the target via the directory-derived `inputId` (for example `fire-100 -> fire:100`) and require the current model version, battle semantics, finalization-state version, and `status == "complete"`.
They also inspect `ranking-policy.txt` and skip reports that already use `full-budget-opportunity-v6-cost-weighted-slot`, preventing repeated reranks whose only change would otherwise be a fresh `rerankedAt` timestamp.

This is a ranking/report refresh fix only. It does **not** change battle semantics and must not invalidate or restart completed battle evidence.


### 2026-09-22 — reserve the 20th runner for lightweight reranking

Observed problem: the cost-100 rerank workflow was placed in the same workflow-level concurrency group as the long 19-runner battle/finalization wave. That meant the deliberately unused 20th runner could not be used by the reranker at all; the rerank stayed `pending` until the entire heavy wave finished.

Architecture correction:

- keep the expensive shared-pool/finalization workflows serialized by `metagame-v12-shared-pool-recompute`
- add a separate short writer mutex, `metagame-v12-result-writer`, to the shared-pool `publish` job and finalization `refresh_rankings` / `merge` jobs
- move the lightweight cost-100 reranker to its own workflow concurrency group and give its job the same result-writer mutex
- this lets reranking occupy the intentionally reserved 20th runner while 19 battle workers are busy, while durable result-branch writes remain serialized

This is workflow scheduling/recovery only. Battle semantics, ranking formula, checkpoint compatibility, and existing battle evidence are unchanged.

Transition safety: the first lock-aware rerank includes a bounded migration guard keyed to commit `6f4785e904879f5cbdbce736fb917c297a408eb5`. It waits only for heavy V12 runs whose head commit predates the shared result-writer lock, preventing the already-running legacy merge from racing the first spare-slot rerank. Lock-aware heavy runs do not block the reranker; after legacy runs disappear this guard becomes an immediate no-op.

### 2026-09-22 — spare-slot rerank workflow syntax repair

The first migration-guard edit accidentally corrupted the rerank YAML because a JavaScript replacement string interpreted the shell fragment `$'	'` as replacement syntax and duplicated the remainder of the workflow. The workflow failed before creating any jobs, so no result data was changed. The file was rebuilt from the last valid rerank workflow, the guard now uses space-delimited `jq` output instead of `$'\t'`, and the self-trigger was restored.
