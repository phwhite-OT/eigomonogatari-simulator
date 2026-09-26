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
- battle semantics: `opportunity-baseline-v6-target-priority`
- final ranking policy: `full-budget-opportunity-v9-adaptive-metagame`
- adaptive-metagame schema version: `2`
- finalization-state schema version: `2`

Key modeling principle: a match is a **team battle made from five player decks against five player decks**. Do not regress to a one-deck-vs-one-deck shortcut merely because it is cheaper.

Target-selection semantics now deliberately model two tactical priorities:
- **Ghost guard breaker:** ghosts already bypass guard/attribute-guard redirection and defensive mitigation. They now directly target the active guard carrier before normal stock balancing, so a ghost can remove a late wall such as ネオけいび instead of wasting its piercing hit elsewhere.
- **Revive threat:** after normal attackers choose the enemy group with the highest remaining stock, equal-stock targets with unused revive capacity are always preferred before killability, damage efficiency, or ordinary skill timing. A revive user that has exhausted all allowed skill uses is no longer treated as a revive threat.

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

The current v8 policy ranks central battle evidence before confidence penalties. The primary signal is the **mean** full five-slot budget-reallocation opportunity result, which already prices cost because removing a candidate frees that cost for all five slots. When that mean ties, the controlled same-four-teammate **mean** result is the next direct-attribution signal. Only after both mean signals does robust/lower-bound evidence act as a confidence tie-break.

The existing conservative diagnostic is still retained: matched-slot robust evidence may adjust the robust full-budget result only inside the uncertainty band `max(0, opportunity mean - robust opportunity)`. That correction is not scaled by character cost or budget share and cannot push the conservative contribution beyond the full-budget mean. The crucial v8 change is that this conservative value no longer outranks a larger measured mean merely because the larger mean has higher variance. If matched-slot evidence is unavailable, the full-budget mean is reused for the matched-mean tie-break rather than treating the missing comparison as negative evidence.

Total cost is a hard ceiling, not a fill target. Unused budget receives no direct score adjustment. Candidate search must not prefer a deck merely because it spends more; when proxy score and synergy are tied, the lower-cost legal deck is retained so strong spare-budget decks remain eligible for real battle evaluation.

Deep-neighbourhood work still exists to improve the matched-slot evidence around important/high-performing configurations. Ranking-only changes reuse existing battle evidence and should not cancel active computation waves.

The implementation details live primarily in:

- `src/core/metagame-v12.js`
- `src/core/metagame-v12-adaptive.js`
- `src/core/metagame-v12-finalization.js`
- `scripts/plan-metagame-v12-finalization.mjs`
- `scripts/evaluate-metagame-v12-finalization-shard.mjs`
- `scripts/prefill-metagame-v12-finalization.mjs`
- `scripts/reopen-metagame-v12-deep-search.mjs`

When optimizing performance, preserve the meaning of the counterfactual comparison. Faster but semantically different evidence is not a valid optimization unless the model version/ranking policy is deliberately changed.

## 8.5 Adaptive metagame equilibrium (v9)

The user-observed problem with the previous v8 aggregation was that every completed deck was still judged against a fixed, uniformly weighted set of 72 supplied 5v5 scenarios. That is useful for broad coverage, but it does not represent the strategic feedback loop of real PvP:

**strong construction → players bring counters → those counters create new weaknesses → counter-counters become useful → the field settles into a mixed environment**

Examples discussed during the redesign include H・F-style durable defense causing more firepower to appear, and パプアさん → 水変 → 水シールド → パプアさん-style counter cycles. These examples are sanity checks only; no character-specific matchup table or hard-coded bonus is added.

Current v9 behavior:

- the shared pool of **actually measured complete five-card decks** is the strategy population
- every strategy keeps its exact per-scenario values from the existing V12.5 battle cache
- a multiplicative-weights update raises adoption for complete decks that perform well under the current scenario distribution
- the environment side updates in the opposite direction: scenarios where the currently popular strategy mixture underperforms receive more weight, representing counter-pressure entering the field
- strategy and scenario updates repeat for multiple rounds and the final result uses the **time-averaged mixture**, not the final iteration
- a uniform scenario floor prevents a narrow current metagame from permanently deleting broad supplied-environment coverage
- the strategy frontier keeps high-performing decks plus structurally different decks so a counter archetype is not pruned solely because several near-identical decks rank just above it under the old uniform mean

The implementation lives in:

- `src/core/metagame-v12-adaptive.js`
- final application in `scripts/rate-metagame-v12.mjs`

This is a **ranking/report aggregation change, not a battle-semantics change**. The model/context version and battle semantics stay at:

- `team-battle-v12.5-effective-damage-individual-rank`
- `opportunity-baseline-v6-target-priority`

Compatible existing V12.5 checkpoints already contain the per-scenario battle vectors required by v9, so heavy 19-runner battle work does not need to be replayed merely to adopt the adaptive distribution. Completed legacy reports are upgraded with `rate-metagame-v12.mjs --finalize-only=true`, rebuilding the adaptive distribution from the durable cache.

Safety rule: `scripts/rerank-metagame-v12-report.mjs` may only rerank a report that already contains `adaptiveMetagame.version == 2`. It must never relabel a fixed-uniform legacy report as v9. Pages likewise requires both the v9 ranking marker and adaptive schema before publishing a shared-pool condition.

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

## 14.5 Progressive public-site publication

Workflow:

`.github/workflows/deploy-pages.yml`

The public site is rebuilt on pushes to `master`, `metagame-v12-shared-pool-results`, and `metagame-v12-browser-knowledge-results`.

Application source must always come from the latest `master`. The durable results branch is computation state and can lag or differ structurally from source development, so a Pages run triggered by a results-branch push must **not** build the application source from that results branch.

Report data is published progressively:

1. restore the last broadly complete fallback V12 report snapshot
2. fetch `metagame-v12-shared-pool-results`
3. scan the 28 representative conditions independently
4. for every condition whose checkpoint is truly `complete` and whose model version, battle semantics, finalization schema, ranking-policy marker, and report file are current, overlay that one condition directory
5. build the browser bundle from the mixed snapshot

Therefore one completed result becomes visible immediately without waiting for unrelated conditions. Unfinished conditions remain usable from the previous public snapshot until their current result completes. Do not reintroduce an all-or-nothing gate across cost-100 or all 28 conditions.

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

### 2026-09-26 — corrected compact-cache encoding after Git push rejection

Observed after the first compact-cache rollout:

- the next fire:100 merge finished computation but `git push` failed because `progress.json` grew to 192.76 MB, and the following retry still produced 186.72 MB
- root cause: the first compact encoding stored every scenario as fixed 8-byte Float64 base64; V12 vectors contain many exact 0 / 0.5 / 1 outcomes that were much shorter in JSON, so the attempted compaction expanded the checkpoint
- durable results branch was not corrupted because both oversized commits were rejected by GitHub before push

Correction:

- current encoding uses one-byte tags for exact 0 / 0.5 / 1 and appends an 8-byte Float64 payload only for non-decisive projected values
- the representation is lossless; there is no rounding or scenario reduction
- hydration remains backward-compatible with legacy JSON arrays and the temporary all-Float64 base64 field
- tests now assert exact round-trip equality and that a decisive-heavy 72-scenario vector serializes to less than 60% of its legacy JSON size

Recovery:

- no recomputation reset is needed; the failed fanout artifacts can be reused
- after this fix reaches master, re-run the failed merge job so it can merge the existing shard artifacts and push the now-smaller checkpoint

### 2026-09-26 — lossless compact V12 checkpoint vectors

Risk found while reviewing the finalization optimization:

- live fire:100 push logs showed `progress.json` at 91.39 MB, already close to GitHub's normal large-file rejection threshold
- the current round planned another 5,726 exact evaluations, so a later merge could finish all computation and then fail only at `git push`, losing that wave's durable progress
- most of the checkpoint bulk is repeated 72-scenario floating-point vectors stored as decimal JSON arrays

Correction:

- `serializeMetagameV12EvaluationCache` now stores each scenario vector losslessly as the exact little-endian Float64 bytes encoded in base64 under `scenarioValuesF64`
- `hydrateMetagameV12EvaluationCache` accepts both legacy `scenarioValues: [...]` checkpoints and the new compact field, restoring ordinary Number arrays before any ranking/finalization logic sees them
- no rounding, quantization, scenario removal, battle replay, or ranking-policy change is involved
- `plan-metagame-v12-browser-knowledge.mjs`, the one direct checkpoint reader found during review, now hydrates through the shared cache helper instead of assuming raw JSON arrays
- tests cover exact round-trip equality for nontrivial doubles plus legacy-array compatibility

Compatibility / rollout:

- existing 91 MB checkpoints remain readable and are compacted automatically on the next normal checkpoint rewrite
- shard delta files produced before this change remain readable
- battle semantics, finalization-state schema, adaptive-metagame schema, and ranking policy are unchanged

### 2026-09-26 — lightweight fanout workers and cheap intermediate merge

Efficiency work after the fire:100 timeout-loop fix:

- planner now embeds a compact evaluator context in the finalization manifest, so distributed prefill workers no longer need the giant durable `progress.json` just to reconstruct scenarios and filter work that the planner already deduplicated
- workflow uploads only `manifest.json` to the 19/38 prefill jobs; the full checkpoint stays local to planner/merge control-plane jobs
- small waves dynamically use at most 19 shards; only larger waves retain 38 chunks for long-tail balancing under the same `max-parallel: 19` ceiling
- new `scripts/advance-metagame-v12-finalization-cache.mjs` advances the frozen counterfactual cursor using cached exact battles only
- intermediate merge waves now merge deltas + advance cursor and skip the expensive shared-pool/rating/adaptive rebuild
- the expensive `rate-metagame-v12.mjs --finalize-only=true` reconcile/adaptive pass runs only when the frozen plan is fully cached; deep-search convergence is checked after that pass and can reopen the next distributed round

Why this is safe:

- battle semantics, candidate generation, exact scenario vectors, ranking policy, and finalization-state schema are unchanged
- counterfactual replacement generation depends on the frozen anchor IDs plus static candidate pools, not on a newly reconciled rating every wave
- lightweight manifests contain only work the planner already proved missing against the durable/recovered cache
- legacy manifests with a full checkpoint remain accepted as a fallback by the shard evaluator

Expected effect:

- remove repeated full-checkpoint download/JSON parse/cache hydration from every prefill runner
- remove repeated full shared-pool/rating/adaptive reconciliation from intermediate merge waves
- avoid a second GitHub job-startup round for small waves such as the 1,216-item fire:100 wave
- no durable checkpoint reset or battle replay is required

### 2026-09-26 — fanout merge 30-minute cancellation loop

Observed live failure:

- multiple distributed-finalization runs completed all 38 prefill shards successfully, then the `merge` job was cancelled almost exactly 30 minutes after it started
- examples included runs 36187411197, 36167368697, 36134459923, 36104208096, and 36088369889
- every sampled merge resumed at the same durable cursor, `4704/6846`, then logged `V12 counterfactual battle pool: 4 worker(s)` and was killed by the merge job's `timeout-minutes: 30`
- because the cancellation happened before `Save distributed finalization progress`, the 38 successful shard deltas and any cursor movement were never pushed to the results branch; the next watchdog wave therefore repeated the same work from 4704
- this was not a shard-computation error and not a watchdog cancellation: it was a deterministic orchestration bug in merge

Correction:

- `rate-metagame-v12.mjs` now automatically enters distributed-cache-merge mode whenever it is called with `--finalize-only=true` and merged checkpoint paths
- in that mode it never starts `MetagameV12EvaluationPool` for missing counterfactual battles
- it walks the frozen plan one replacement at a time, advances through exact battles already present in the merged cache, and stops/persists immediately at the first missing battle so the next fanout planner can assign it
- a zero-cursor-advance merge is valid in this mode because importing exact deltas can still change the next globally deduplicated plan; it must not be treated as a serial no-progress failure
- future merge job timeout is raised from 30 to 60 minutes as headroom for parsing/serializing very large checkpoint and delta files, not for running battles

Compatibility:

- no battle semantics, ranking policy, finalization-state schema, or exact battle results change
- already uploaded shard artifacts remain reusable
- the live current fanout can pick up the script fix because its jobs checkout `master`; no durable checkpoint reset is required

### 2026-09-23 — immediate finalize-handoff to 19-runner fanout

Observed problem:

- after `select` was fixed, the live fire:100 run correctly entered the synthetic `1-finalize-handoff` evaluate shard
- that shard reused the normal 8400-second candidate time budget; once global baseline finished and the counterfactual plan was frozen, `rate-metagame-v12.mjs` continued into its local four-worker counterfactual loop instead of returning control immediately
- the computation was therefore still making progress, but it could hold the shared heavy-work mutex for up to about 140 minutes while doing work that the 19-runner distributed finalization workflow is designed to parallelize

Correction:

- synthetic finalize-handoff matrix entries now carry `finalize_handoff: true`
- the workflow passes that as `--stop-after-finalization-plan=true`
- after global baseline is complete and a compatible counterfactual finalization plan exists, the rate script persists the checkpoint and exits before starting local counterfactual evaluation
- publish can then detect the counterfactual phase and hand the durable checkpoint to the 19-runner finalization fanout

Compatibility:

- no battle semantics, ranking policy, checkpoint schema, or already-computed evidence changes
- ordinary candidate shards and explicit finalize-only/fanout work keep their existing behavior
- the already-running pre-fix shard is allowed to finish and persist its work; the fix applies to subsequent handoff shards without discarding current progress

### 2026-09-23 — lightweight select/watchdog progress state

Observed problem:

- live shared-pool `select` was not deadlocked, but the quiet queue-selection section consistently took about 105–137 seconds across five recent runs
- the selector inflated the large durable `progress.json` into a shell variable just to decide whether a condition was complete, then inflated the same checkpoint again when the condition actually needed work
- as more representative conditions become complete, scanning every earlier condition this way would make the control plane progressively slower and continue to look like a stuck `select`

Correction:

- durable result writers now emit a compact `progress-summary.json` next to each checkpoint with only status, model/battle identifiers, finalization phase/cursor/plan length, and adaptive-schema version
- normal shared-pool selection, distributed-finalization selection, and the watchdog read the compact summary first
- legacy result snapshots without the summary still fall back to deriving the same state from `progress.json`, so no existing checkpoint or battle cache is invalidated
- the normal selector also checks the tiny ranking-policy marker before touching legacy `progress.json`; a ranking mismatch no longer causes an unnecessary first full-checkpoint read
- workers that actually resume calculation still restore the full checkpoint exactly as before

Compatibility / validation:

- battle semantics, adaptive ranking, checkpoint contents, and finalization schema are unchanged
- this is control-plane performance/reliability only
- the first run after deployment may still pay one legacy full-checkpoint read; once its writer publishes the summary, subsequent selects for that condition use the compact path

### 2026-09-23 — watchdog pending/concurrency recovery repair

Observed problem:

- the V12 watchdog had been failing deterministically with `/usr/bin/jq: Argument list too long` because it captured two full GitHub Actions workflow-run payloads into shell variables and passed both through `jq --argjson`
- scheduled watchdog delivery was also not reliable enough to mask that bug; recent scheduled runs were hours apart and the sampled runs failed before healing anything
- the recovery selector preferred the newest desired run even when that run was only workflow-level `pending`, which could cause a healthy older heavy run that actually owned the shared concurrency mutex to be cancelled
- this is especially dangerous during ranking-only upgrades such as v9, where an older battle wave is intentionally allowed to finish because its exact per-scenario evidence is reusable

Correction:

- workflow-run payloads are now written to `$RUNNER_TEMP` JSON files and combined with `jq -s`, avoiding shell argument-size limits
- the watchdog now treats an in-progress heavy run as the concurrency owner and preserves it while it has recent GitHub activity; pending continuations waiting behind that owner are left intact
- stale detection uses the run's last `updated_at` activity rather than total run age, so a long but progressing wave is not killed merely for exceeding three hours end-to-end
- if no heavy owner exists and the desired run remains `pending`/queued for more than 15 minutes, only that orphaned pending run is recycled and a fresh continuation is dispatched
- obsolete queued work is removed only when there is no healthy owner and no usable desired pending continuation
- a second live stall was found immediately after fire:100 candidate completion: `publish` dispatched the fanout for any `status == "finalizing"`, but the saved checkpoint was still in the bounded global-baseline phase; fanout intentionally accepts only `finalizationState.phase == "counterfactual"`, so it exited successfully without doing work and no continuation remained
- `publish` now dispatches fanout only for counterfactual checkpoints with a remaining frozen plan; baseline/other pre-counterfactual finalization stays on the normal shared-pool workflow until it reaches the fanout-compatible phase

Compatibility / validation:

- no battle semantics, ranking formula, checkpoint schema, or cached battle evidence changed
- this is scheduling/recovery logic only
- the resilience test now guards against reintroducing full Actions JSON through `--argjson` and checks the healthy-owner/orphan-pending paths
- immediate live follow-up should verify that the current old fire:100 owner completes publish and that the v9 continuation leaves `pending` automatically afterward

### 2026-09-23 — adaptive counter-cycle metagame ranking (v9)

Observed problem:

- final V12.5 rankings still averaged every deck uniformly across the fixed 72 supplied 5v5 scenarios
- this could value a narrow counter as though its target were always equally common, or undervalue a broadly strong construction because the evaluator never let that construction become popular enough to cause counter adoption
- the user explicitly wants the final result to reflect PvP's counter cycle: a strong defensive shell such as H・F can make firepower more common, but firepower that exists mainly to answer H・F can become dead weight when H・F is absent; similarly a パプアさん → 水変 → 水シールド → パプアさん cycle should settle as a mixed field rather than being resolved by a fixed matchup bonus

Correction:

- added `src/core/metagame-v12-adaptive.js`
- the completed shared deck pool is now the measured strategy population
- strategy adoption and counter-scenario pressure coevolve with multiplicative-weights updates using the **existing exact per-scenario battle values**
- final scenario and strategy shares are time-averaged after burn-in so rock-paper-scissors/counter loops are represented as a mixture rather than whichever strategy wins the final iterate
- strategy selection keeps a strong frontier plus structurally different decks so a counter family is not lost behind many near-duplicate high scorers
- character opportunity value, matched-slot diagnostics, best deck, and baseline deck are recomputed under the adaptive scenario distribution before the existing mean-primary ranking function runs
- ranking marker is now `full-budget-opportunity-v9-adaptive-metagame`; adaptive report schema is `2`
- lightweight report-only reranking refuses reports without `adaptiveMetagame.version == 2`
- shared-pool recompute, watchdog, Pages publication, finalization refresh, and cost-100 rerank guards were aligned so old fixed-uniform reports cannot be mislabeled or published as v9

Compatibility:

- battle semantics did **not** change
- model/context version remains `team-battle-v12.5-effective-damage-individual-rank`
- battle semantics remain `opportunity-baseline-v6-target-priority`
- finalization schema remains `2`
- existing compatible V12.5 battle caches remain reusable because they already store every evaluated deck's `scenarioValues`
- completed old reports should be upgraded via `rate-metagame-v12.mjs --finalize-only=true`; no full heavy battle replay is required solely for this v9 aggregation change

Validation / next checks:

- synthetic tests cover structurally diverse strategy retention, broad strength versus a narrow counter, cyclic three-way counters, and adaptive best-deck/opportunity recomputation
- after CI passes and v9 is published, inspect `fire:100` in detail: H・F-style defense, the firepower shells that answer it, revive/stall cards, and whether a narrow answer's adoption falls when its target is uncommon
- do not hard-code the desired rank of any of those sanity-check characters; if results are surprising, inspect equilibrium strategy weights, scenario weights, best-deck changes, and opportunity deltas first

### 2026-09-23 — ghost guard-break and revive-target priority

Battle targeting was refined to match tactical play rather than treating every attacker identically.

- ghosts already ignored guard/attribute-guard redirection and defense multipliers, but target selection did not exploit that property; a ghost could continue stock-balancing into another enemy while the guard carrier stayed alive
- `guardBreakTargetForAttacker` now treats a ghost as a direct bypass attacker against any active guard/attribute-guard carrier, so tactical attack ordering can send the ghost into the wall first and subsequent ordinary attacks are no longer forced through that guard if the ghost removes it
- within the normal maximum-remaining-stock target pool, a character whose active skill is `revive` and still has skill uses remaining is now an absolute tie priority before killability, damage efficiency, or skill-charge timing
- revive users with all allowed uses exhausted are intentionally not prioritized as revive threats
- regression tests cover a non-ready revive user beating a killable equal-stock target, an exhausted revive user losing that special priority, and a ghost choosing a guard carrier even when another enemy has a deeper stock
- battle semantics bumped from `opportunity-baseline-v5-effective-damage` to `opportunity-baseline-v6-target-priority`; old V12.5 battle checkpoints are **not semantically compatible** and must not be mixed with the new targeting results

### 2026-09-23 — publish completed V12 conditions to the site immediately

Source branch: `fix-progressive-site-results`.

Observed problem:

- Pages deployment already triggered on shared-results pushes, but publication used an all-or-nothing gate: all seven cost-100 conditions had to be complete before the site consumed the shared-pool report tree
- the gate still expected the obsolete `full-budget-opportunity-v4-resumable` ranking marker, so current v8 results could never satisfy it
- when a deploy was triggered by a results-branch push, the default checkout could also use the results branch as application source instead of latest `master`

Correction:

- Pages source checkout is pinned to `master`
- deployment starts from the fallback snapshot and overlays each of the 28 representative conditions independently
- an overlay is accepted only when `progress.status == "complete"`, model/battle semantics/finalization version match V12.5, the marker is `full-budget-opportunity-v9-adaptive-metagame`, `report.json` contains `adaptiveMetagame.version == 2`, and the completed checkpoint also stores adaptive schema version 2
- completed conditions therefore appear on the site on the next results-branch Pages deployment; incomplete conditions keep their previous published version
- browser-knowledge publication remains optional and independent

Compatibility note:

No battle evidence or ranking values are recomputed by this change. It only changes which already-published report snapshot the Pages build consumes.

### 2026-09-22 — mean-primary contribution correction (v8)

Source branch while this entry was written: `fix-v12-mean-primary-ranking`. Intended ranking marker:

`full-budget-opportunity-v8-mean-primary-slot`

Observed problem:

- v7 correctly removed direct budget-fill bias, but ordering still placed the robust/lower-bound contribution before the measured mean
- that let variance penalties reverse cards whose average direct contribution was larger
- concrete fire-100 regression: 腹話フック had the larger same-four-teammate mean contribution (+1.39pt versus ズンビーフック +0.69pt), while ズンビーフック ranked higher because its robust value was less negative
- this was especially misleading because 腹話フック's 4-turn fire-team 4-hit mode has broader coverage in a fire restriction than ズンビーフック's 4-turn wind-team 3-hit mode

Correction:

- full five-slot **mean** opportunity contribution is now the first ranking signal and remains the source of cost opportunity
- when full-budget means tie, same-four-teammate **mean** contribution is the next direct slot-attribution signal
- robust contribution and complete-deck lower bounds are confidence tie-breaks after mean evidence, not primary ranking keys
- positive-contribution tiering is mean-led; robust negativity alone no longer demotes an otherwise positive mean
- ranking display score is derived from the mean opportunity value, while robust values remain available as diagnostics
- cost remains budget-neutral: no reward for spending the cap, no direct cheap-card bonus, and the lower-cost proxy/synergy tie-break from v7 is preserved
- regression tests pin the real ズンビーフック / 腹話フック evidence shape so lower variance cannot reverse the larger matched-slot mean again

Compatibility/recompute note:

This is a ranking-only semantic change. Existing V12.5 battle simulations and counterfactual evidence are reusable, so completed reports can be reranked without restarting heavy 19-runner battle computation. The lightweight cost-100 reranker should publish v8 rankings to the durable results branch after merge.

### 2026-09-22 — budget-neutral cost-cap correction (v7)

Source branch while this entry was written: `fix-v12-budget-neutral-ranking`. Current ranking marker after merge is intended to be:

`full-budget-opportunity-v7-budget-neutral-slot`

Observed problem:

- the ranking formula explicitly scaled matched-slot evidence by character cost, so cost itself changed how much evidence was trusted
- `selectDiverseDecks` broke exact proxy/synergy ties by preferring the **higher-total-cost** deck, which could prune an equally strong deck simply because it left budget unused
- this made it possible for budget usage itself, rather than measured 5v5 performance/opportunity value, to influence the result

Correction:

- total cost remains a legality ceiling, not a target to fill
- full five-slot reoptimization remains the source of cost opportunity: removing a card frees its actual cost and lets all five positions rebuild
- same-four-teammate evidence is no longer weighted by cost share
- matched-slot evidence may only adjust the robust full-budget result within the existing full-budget uncertainty band `mean - robust`; it cannot override the full-budget mean
- exact proxy/synergy search ties now retain the lower-cost complete deck rather than the fuller-cost deck
- browser priors, report CSV labels, cost-100 rerank workflows, and durable ranking markers are aligned to v7
- regression tests cover both equal battle evidence at different cost shares and preservation of an 80-cost deck over a 100-cost deck on an exact proxy/synergy tie

Compatibility/recompute note:

Existing V12.5 battle simulations remain numerically reusable for the ranking-only v7 refresh. The search tie-break change affects which candidate deck is retained in future candidate generation, so future/reopened battle searches automatically benefit from the fix. Completed cost-100 reports can be re-ranked immediately from existing evidence; if a suspicious result remains after v7, inspect whether a missing spare-budget deck requires targeted battle expansion rather than changing the ranking formula again.


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
