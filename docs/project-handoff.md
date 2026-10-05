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

Current V12.7 context:

- context/model version: `team-battle-v12.7-character-catalog-20261004-individual-rank`
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

### 2026-09-27 — publish each completed V12 result to the public site

Issue found after fire:100 completed:

- `deploy-pages.yml` declared pushes to `metagame-v12-shared-pool-results` as a trigger
- those result pushes are made inside Actions with `GITHUB_TOKEN`
- GitHub suppresses workflow chaining from those token-generated pushes, so the durable result branch could advance without a Pages deployment
- observed deployment history confirmed recent Pages runs came from master pushes, not the fire:100 completion push

Correction:

- Pages now also listens to `workflow_run` completion for:
  - `Metagame V12 distributed finalization accelerator`
  - `Metagame V12 shared-pool full recompute`
  - `V12 cost100 lightweight rerank`
  - `Metagame V12 browser knowledge precompute`
- deployment still validates ranking policy, adaptive schema, model version, battle semantics, and `status == complete` before overlaying a condition
- partial/intermediate checkpoints therefore trigger at most a harmless rebuild; they are never published as current results
- merging this fix to master itself triggers Pages, so the already-complete fire:100 result is published immediately

### 2026-09-26 — recover exact-battle artifacts across multiple failed fanout generations

Observed live after repeated merge/push failures:

- each new fanout selected only the immediately previous run as `recovery_run_id`
- the original 38-shard wave lived several generations back; later failed runs often contained only one or a few shard artifacts
- latest planner logged `recoveredEntryCount: 0` and scheduled the full 5,726 missing evaluations again even though those exact battles had already been computed earlier

Correction:

- fanout selection now gathers all recent non-expired runs that contain matching `v12-finalize-cache-<condition>-*` artifacts
- planner downloads each selected run into its own recovery directory and recursively merges the union before replanning
- duplicate exact battle keys are harmless and deduplicated by the evaluation cache
- this changes recovery/orchestration only; battle semantics, ranking policy, and finalization schema are unchanged

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


### 2026-09-28 — V12 deep search を数時間級に制限

Observed problem:

- water:100 finalization spent many hours in repeated deep-neighbourhood waves even though the 19-runner fanout itself was healthy
- the old deep search used 12 active seeds from a 48-deck frontier and tried every legal one-slot replacement, commonly producing 12k+ replacement references per round
- after every deep-search wave the measured frontier could change, causing the full frozen counterfactual shell to reopen and making one condition take far too long

Correction:

- added `src/core/metagame-v12-deep-search.js`
- future conditions use 6 active seeds from a 24-deck elite/diverse frontier
- each seed/slot keeps at most 20 replacement candidates, selected from measured deck strength + final individual rating + existing proxy evidence while explicitly preserving tactical-role and cost-band diversity
- deep-search exact battles are capped at 2,500 new evaluations for the entire condition, not merely per workflow wave
- deep search stops early when at least 87.5% of the measured frontier is unchanged and best-deck improvement is at most 0.25 percentage points
- hard round cap is reduced from 16 to 4 for the new bounded policy
- the normal per-character counterfactual audit remains unchanged: anchor limit 3 and replacement-deck limit 24 are preserved
- existing exact battle evidence remains reusable; battle semantics and ranking policy are unchanged

Transition safety:

- an already-running legacy deep search (currently water:100) is detected from an existing deep-search round/visited frontier without the new policy marker and keeps the old 12/48/full-replacement/16-round behavior until it finishes
- a fresh condition starts with bounded deep-search policy version 3; reopened checkpoints retain the policy version and cumulative deep-search evaluation count
- this avoids changing the meaning of water:100 halfway through while ensuring the next condition gets the bounded runtime policy

Runtime target:

- at the observed 19-runner throughput, the 2,500-evaluation deep-search ceiling is intended to keep the deep-search portion well below the old day-scale behavior; together with the unchanged initial/counterfactual work the target is a few hours per condition, not a month-scale sweep
- this is a runtime target, not a guaranteed wall-clock SLA; GitHub runner queueing and unusually expensive battle families can still vary

- PR validation: Validate Metagame V12 passed after the bounded deep-search implementation. A follow-up planner guard preserves the deep-search policy version and cumulative evaluation budget if the frozen counterfactual plan is normalized/rebuilt, preventing the new runtime cap from being accidentally reset.


### 2026-09-28 — bounded deep-search final verification hardening

- Final audit found that the generic V12 validation workflow did not yet syntax-check the new deep-search helper/planner/reopen scripts and did not execute the new deep-search or recompute-resilience tests. The earlier PR CI was therefore insufficient evidence for the newly added runtime-control path even though existing V12 tests passed.
- Validation now explicitly checks the deep-search helper plus planner/evaluator/advance/reopen scripts and executes `test/metagame-v12-deep-search.test.js` and `test/metagame-v12-recompute-resilience.test.js`.
- Bounded deep search now requires at least two completed rounds before frontier-stability early exit. This guarantees that at least 12 of the 24 frontier seeds can be explored before convergence is accepted, while preserving the four-round / 2,500-new-evaluation hard caps.

### 2026-09-28 — recovered finalization delta durability fix

- Final audit found a real cause of the long water:100 stall at cursor 525: the plan job downloaded and merged cache deltas from prior interrupted waves into its temporary checkpoint, so the planner correctly saw those exact battles as already evaluated. However, the later merge job restored the durable results-branch checkpoint and merged only the current run's deltas. The recovered historical deltas were therefore never persisted.
- This created a split-brain loop: planner logs could report zero missing normal counterfactual evaluations while advance-metagame-v12-finalization-cache.mjs immediately stopped at a key that existed only in the planner's temporary recovered cache. Repeated runs then rediscovered/recovered the same evidence without durably advancing the cursor.
- The plan artifact now carries the recovered delta files alongside the manifest. The merge job merges both recovered and current deltas into the durable checkpoint before advancing the frozen plan.
- This fix does not alter battle results, ranking formulas, or search semantics. It only makes already completed exact evaluations durable, so a previously stuck cursor can advance instead of repeatedly recovering the same work.


### 2026-09-29 — cost 200 priority + bounded normal counterfactual

Observed problem:

- water:100 completed, but the queue immediately started wind:100 because both heavy selectors still iterated costs as 100 -> 200 -> 300 -> 500
- the user had explicitly requested that work move to cost 200 after water:100 rather than finishing all cost-100 conditions first
- wind:100 exposed a second runtime bottleneck before deep search: the normal matched-slot counterfactual planner produced 114,852 replacement references and hit the 9,500-unique-evaluation wave cap before deep search could add any work
- the previous 3-anchor x 24-replacement audit was too broad for the target of a few hours per condition

Correction:

- both the shared-pool selector and distributed-finalization selector now prioritize costs 200 -> 300 -> 500 -> remaining 100
- normal counterfactual policy is reduced from 3 anchors x 24 replacements to 2 anchors x 12 replacements
- anchor selection still keeps structurally distinct measured shells; replacement selection still keeps strong proxy candidates plus tactical-role and cost-band diversity
- replacement beam width is reduced from 4000 to 2500 because only 12 diverse matched-slot replacements are retained
- one distributed counterfactual wave is capped at 4,800 unique exact deck evaluations instead of 9,500
- planner and cache-advance stages both normalize stale 3/24 checkpoints to the current 2/12 policy, rebuilding the frozen plan deterministically while reusing all compatible exact battle cache entries
- deep-search round, visited seeds, bounded-search policy version, cumulative deep-search evaluation count, frontier keys, and previous best-win marker are preserved during that policy migration
- battle semantics, adaptive ranking policy, and exact cached battle results are unchanged

Transition:

- the already-running wind:100 fanout wave is allowed to finish so its exact delta artifacts are not thrown away
- once the new master revision owns the heavy-work mutex, the selectors choose the first incomplete cost-200 condition (fire:200) instead of continuing wind:100
- wind:100 remains resumable and will migrate to the new bounded counterfactual policy when cost-100 work is eventually resumed

Runtime expectation:

- on wind:100, the old policy generated 114,852 bounded counterfactual references. Scaling 3x24 to 2x12 cuts the nominal matched-slot reference budget to roughly one third before deduplication
- this should usually make normal counterfactual finalization fit in one or a small number of <=4,800-evaluation waves, while keeping the deep-search 2,500-evaluation condition ceiling introduced previously
- the target remains a few hours per condition rather than day-scale finalization; actual wall-clock still depends on fresh candidate coverage and GitHub runner scheduling


### 2026-09-29 — watchdog cost-priority alignment

Observed problem:

- shared-pool and finalization selectors were correctly changed to cost priority 200 -> 300 -> 500 -> remaining 100
- the watchdog still scanned 100 -> 200 -> 300 -> 500, so after wind:100 became finalizing it kept dispatching the finalization workflow
- the finalization selector then correctly saw fire:200 as the first priority condition but found it not ready for distributed finalization, exited successfully, and no shared-pool run was dispatched
- result: no expensive V12 calculation was active even though 26/28 conditions remained incomplete

Correction:

- watchdog representative cost order is now 200 -> 300 -> 500 -> 100, matching both heavy selectors
- resilience tests pin the same priority order in watchdog, shared-pool recompute, and finalization fanout
- shared-pool workflow received a matching invariant comment; because that workflow file is in its own push path filter, merging this fix immediately triggers the normal recompute path
- the next normal selector target is fire:200 because all cost-200 conditions are currently unstarted

Compatibility:

- no battle semantics, ranking policy, checkpoint schema, or cached battle evidence changes
- wind:100 remains resumable and is intentionally deprioritized until the higher-priority representative costs are processed


### 2026-10-01 — publish completed single-attribute V12 conditions

The public site should expose completed durable V12 conditions as soon as they are current and complete, without waiting for the full 28-condition sweep.

Verified complete on `metagame-v12-shared-pool-results` under the current model, battle semantics, finalization schema, adaptive-metagame schema, and ranking policy:

- `fire:100`
- `water:100`
- `fire:200`
- `water:200`
- `wind:200`

`wind:100` is still in counterfactual finalization and must not be published as current yet. In-progress `fire-water:200` must likewise stay unpublished until complete.

A master-branch documentation commit is used to trigger the existing `Deploy public site` workflow. That workflow overlays every individually complete current shared-pool condition from the durable results branch before building GitHub Pages, so this publishes the five completed conditions above without exposing incomplete checkpoints.


### 2026-10-01 — browser deck-generation UX clarified

User-facing intent:

- the primary metagame action is **deck generation**, not an opaque "candidate evaluation" action
- generation happens in the browser at request time
- precomputed V12/V12.5 environment and per-slot evidence are the search prior / candidate pool; the browser composes legal five-card decks from that evidence and then replays only the bounded finalist set in 5v5 simulation
- while generation is active, progress must be visible immediately below the generation button rather than elsewhere on the page

UI changes:

- renamed the metagame action button from `候補デッキを評価` to `デッキを生成`
- moved `data-metagame-sim-progress` into the action control directly below that button
- progress text now explicitly distinguishes browser-side candidate generation from finalist 5v5 verification
- added progressbar ARIA state and keeps `aria-valuenow` synchronized with the visible bar
- surrounding messages now say that precomputed environment information is used to generate the deck in the browser

Implementation remains grounded in `findBestMetagameDeck(...)` / `buildMetagameDeckCandidatesWithProgress(...)`: no server-side per-click deck generation was introduced, and no heavy V12 cloud recompute is triggered by the button.


### 2026-10-02 — refresh public site with every currently completed V12 condition

Manual publication refresh requested after additional V12 conditions completed.

At refresh time, the current complete conditions on `metagame-v12-shared-pool-results` are:

- `fire:100`
- `fire:200`
- `water:100`
- `water:200`
- `wind:200`
- `fire-water:200`

`wind:100` and `fire-wind:200` are still finalizing and are intentionally excluded. Legacy/non-current result directories are also excluded. This documentation-only master commit triggers the existing Pages deploy, which republishes every current complete condition from the durable results branch.


### 2026-10-03 — intermediate-cost browser search no longer rewards unused budget

Observed problem:

- generating a fire deck at cost 150 produced a cost-96 deck as rank 1 even though substantially stronger 100/200-band combinations should be available under the 150 cap
- browser beam trimming had a direct `- totalCost / budget * 0.05` term in one fill lane, so leaving budget unused received a search advantage
- the role-diversity lane was built only from the already-selected primary 60% of the beam, so it could not rescue distinct candidates that the primary slice had dropped
- the final 5v5 finalist set had no explicit coverage across budget-usage bands, allowing cheap proxy candidates to crowd out stronger higher-cost constructions before real battle evaluation

Fix:

- removed the direct whole-deck spend penalty from beam filling; total cost remains a ceiling, not a target
- added budget-usage coverage lanes that preserve strong candidates from several spend bands during partial beam search and again before the bounded final 5v5 pass
- spend-band coverage is exploration only: higher spend gets no score bonus, and a low-cost deck can still rank first if it actually wins the final battles
- rebuilt strategy-diversity buckets from the full unique beam rather than only the already-selected primary slice
- added regressions ensuring both low- and high-usage bands survive, and that a high-cost construction which is actually stronger reaches the final battle pass
- Pages deployment now runs the focused browser deck-generation/dynamic-cost/cache tests before publishing; V12 validation also includes `metagame-deck.js` and the dynamic-cost/deck tests

Compatibility:

- no battle semantics, V12 durable ranking policy, checkpoint schema, or precomputed battle evidence changed
- no expensive V12 recompute is required; this changes only browser-side candidate coverage/finalist selection for generated decks, especially intermediate costs such as 150


### 2026-10-03 — browser generation architecture corrected to individual-first reconstruction

User clarified that preserving precomputed decks by cost-usage band is the wrong abstraction for the product. Future browser generation must support arbitrary cost limits, many restrictions, fixed characters, and event-boosted characters, so saved finished decks cannot be the primary source of flexibility.

This supersedes the earlier 2026-10-03 spend-band candidate-retention experiment. The direct unused-budget reward remains removed, but explicit low/mid/high spend-band retention has also been removed.

Current design:

- **individual evidence is primary**: per character × position opportunity/contribution evidence drives browser search
- representative-cost V12 candidates are marked as budget-specific evidence and are not charged a second generic whole-budget penalty
- for an intermediate cost such as 150, the same character's fire:100 and fire:200 numeric individual evidence is linearly interpolated at 150; the old winner-take-all merge that kept whichever endpoint score was larger is gone
- if only one endpoint has a browser-knowledge package, arbitrary-cost generation does not apply that one-sided package over the two-band interpolation; it waits until both endpoint knowledge packages exist
- exact V12 recommendation generation no longer short-circuits to a saved finished deck in either V12 UI compatibility layer
- lazy browser knowledge can add candidates beyond the compact embedded top-96 slot pool using full `candidatePriors`
- measured `pairPriors` are a bounded secondary correction, not the main value signal
- exact 1.5x event-boost deltas from `boostModel` are applied to individual candidate evidence before beam search; the Pages knowledge payload now retains `boostModel` and `neighborhoods`
- boost precompute was deepened from 2 to 6 anchor decks per character/position. This increases offline work without increasing browser search time
- browser-knowledge workflow now has an `auto` mode and hourly selector that progressively builds missing/stale packages for completed representative conditions
- browser search uses a broader knowledge-backed beam (20,000 default) and then bounded real battle verification
- final verification is progressive: 6 surveyed scenarios -> 12 -> requested final scenarios (24 by default). Early stages are selected from the full surveyed pool rather than from a pre-truncated subset
- survivor selection keeps candidates strong by blended mean/lower-bound evidence while retaining mean, conservative, and proxy lanes; it does not retain decks merely because of their total cost
- an internal 8.5-minute deadline applies to browser generation. A later stage that cannot be completed fairly is discarded and the last fully completed equal-scenario stage is used. This preserves the hard requirement that browser generation stay below 10 minutes with safety margin

Important interpretation:

- A cost-96 deck may still beat cost-145 decks and rank first if actual individual priors + combination evidence + 5v5 validation support it.
- What must not happen is a cost-96 deck winning because cost100 priors leaked unchanged into cost150, because unused budget was rewarded, because high-value characters were missing from the compact candidate pool, or because a precomputed finished deck was treated as the only search neighborhood.
- Offline/cloud computation can be much heavier than before. Prefer richer per-character, boost, and interaction knowledge over adding more browser runtime.

Validation added/updated:

- arbitrary-cost tests pin same-character lower/upper interpolation
- knowledge-only character priors must enter browser candidate generation
- boost priors must change the boosted character's pre-search individual value
- V12 exact-cost cache tests now require live reconstruction instead of finished-deck shortcut reuse
- staged browser verification test pins 6 -> 12 -> requested-final progression
- Pages runs the focused browser deck/dynamic-cost/cache regressions before deployment


Follow-up details after the individual-first correction:

- the Pages knowledge payload now preserves `boostModel` and `neighborhoods`; previously these expensive offline results were dropped by the deploy-time JSON projection
- boost priors now use up to 6 measured anchor decks per character/position instead of 2
- the 24-environment default is implemented as staged verification from the **full** surveyed scenario pool, not a 24-scenario pre-truncation
- when exact browser knowledge exists, the 6/12 early screens use offline-selected representative scenario indices
- when interpolating two knowledge bands, representative scenarios are combined from both endpoints (half from each, with the upper-band indices offset into the concatenated scenario pool)
- browser candidate construction and each battle scenario check the same 8.5-minute deadline; later incomplete stages are never mixed with fully evaluated candidates


Browser-knowledge scheduling/freshness policy:

- generated packages carry `policyVersion: 2`; Pages exposes that marker
- the automatic selector first fills **missing** packages, attribute-by-attribute and cost-by-cost (100 -> 200 -> 300 -> 500), so neighbouring cost bands needed for arbitrary-cost interpolation become available quickly
- only after all currently completed conditions have a package does it refresh stale source reports or old policy versions
- this means an existing fire:100 package does not get needlessly rebuilt before the missing fire:200 package needed for fire:150 two-sided knowledge


### 2026-10-04 — 2026年限定20体をWiki差分から補完

- `src/data/character-supplements-2026.js` に、Book1.xlsx/既存カタログとの差分として先に特定していた2026/06〜2026/11の限定20体を追加。
- 調査元は英語物語Wikiの `限定（図鑑）` のみ。属性はソースの色セル（赤=fire / 青=water / 緑=wind、2色=複属性）を直接採用し、Cost、通常HP/Power、限界突破HP/Power、rare、ターン、ゆるスキルも同じ行から転記。
- 対象: マンジェリこん / イワシ祭りのジェリ子 / 鰯売り恋のマンンジェリ子 / ほおずきおこしん / 鬼灯ズキ子 / ほおずき市の浅子さん / 悩める織女 / 恋する牛郎 / 超おり姫！ / 夏の筒彦さん / せとっくん / 瀬戸際先生 / あんたが瀬戸大将 / わらしちゃん（絵コンテ） / わらしちゃん（原画） / ぱいにゃ(演出)CV:わらし / カラベラ・ユカたん / 死者の日☆パレンケ / パレンケリーナ（姉） / 秋ｱﾆﾒ「伝説のぱいにゃ」。
- Wikiソース上の名称は `鰯売り恋のマンンジェリ子`（「ン」が重複）なので、外部サイトで推測修正せず、そのまま補完データへ保持した。
- この限定表はCRを含め全対象が通常Lv99・限界突破7・Lv237表記。既存の補完ヘルパーがCRをLv132/限界突破6へ固定していたため、ヘルパーに `maxLevel`/`limitBreak` の個別指定を追加し、この20体は237/7を明示した。既存補完キャラの既定値は変更していない。
- これは「20体が未登録かを再照合した」作業ではない。20体は事前の Wiki 2294体 − リポジトリ収録名の差分で既に未収録と特定済みであり、今回の作業はその追加用データ確定と実装。
- Source commit: `f64ed373a420e548c26a95087f53d096c39e8ddd`.
- 検証: 更新後の `character-supplements-2026.js` をJavaScriptとして評価し、補完54体中 `y26-limited-*` が20体、ID重複0、代表3体（せとっくん/夏の筒彦さん/パレンケリーナ（姉））の属性・数値・スキル構造が期待通りであることを確認。ローカル `npm test` / `npm run build` は実行環境からGitHubへDNS接続できずリポジトリを取得できなかったため未実施。長時間のV12再計算は自動で開始していない。


### 2026-10-04 — catalogue差分調査の訂正

- 大容量の `src/data/workbook-characters.js` を通常の file fetch で読むと本文が空になりうる。これを「既存Book1に存在しない」と誤認し、進化17体・協力53体を一時的に補完へ重複追加してしまった。
- 正しい差分判定では、`workbook-characters.js` のGit blob本体（2216 entries）を取得し、その `name` と `character-supplements-2026.js` / 手動補完を合わせて照合すること。
- 再照合の結果、進化17体・協力54体・その他93体は既存Book1に収録済みだった。誤追加した `wiki-evo-*` / `wiki-coop-*` 70件は削除済み。
- `二条嬢☆浴衣モード` を独断で `二条城☆浴衣モード` に変更した修正も撤回し、元の `二条嬢☆浴衣モード` に復元済み。
- 今後は、Wiki表記と既存データの差異を見つけても、ユーザー確認なしに既存名を改名しない。外部データの誤記推定も、既存データを上書きする根拠にはしない。
- 現在確認済み: `character-supplements-2026.js` は74件、`wiki-evo-*`/`wiki-coop-*` は0件、補完側の重複名0件。


### 2026-10-04 — 暫定キャラデータ7体の恒久メモ

- Wiki内部の矛盾・表記差が残る7体（飛べ翔べ真純ちゃん / ホホベニモン / クタマク姐さん / ビオチン / 酒血肉☆凛 / トリック☆アナンシ君 / ビタミンB2）は、**現在値のままデッキ生成・評価に使用してよいが、確定値とは扱わない**。
- 詳細なWiki矛盾・現在採用値・今後の更新ルールは `docs/character-data-caveats.md` に集約した。
- `src/data/character-supplements-2026.js` の7件の `notes` にも `⚠暫定` と上記ドキュメントへの参照を付与済み。
- 7体はすでに補完データに存在していたため、重複追加はしていない。


### 2026-10-04 — latest character catalogue forces a clean V12 evidence generation

- New character supplements discovered during the 2026-10-04 Wiki audit are now part of the live catalogue. The supplement set is 74 characters total, including the newly added limited/yuru-hunting/battle/Fukubiki entries and the seven records explicitly marked provisional in `docs/character-data-caveats.md`.
- V12 model/context generation was advanced from `team-battle-v12.6-character-catalog-20261003-individual-rank` to `team-battle-v12.7-character-catalog-20261004-individual-rank`.
- This is a **catalogue compatibility reset**, not a battle-semantics or ranking-policy change. Battle semantics remain `opportunity-baseline-v6-target-priority`; ranking remains `full-budget-opportunity-v9-adaptive-metagame`.
- Old V12 checkpoints/reports generated from the 2026-10-03 catalogue must not be treated as current for the new catalogue. The normal 28 representative environments are recomputed under the new model/context version.
- Browser arbitrary-cost handling is unchanged: heavy precompute stays at costs 100/200/300/500 and intermediate integer costs are reconstructed from neighbouring per-character evidence.
- Source push of this commit intentionally triggers the shared-pool recompute workflow. Any run still executing from the obsolete 2026-10-03 source is stale work and must not publish as current.


### 2026-10-04 — user-provided environment set is an anchor, not ground truth

- The user-provided environment/deck set is **not intended to be an exhaustive representation of the real PvP metagame**.
- It may lag newly added characters and cannot cover the full space of real player strategies.
- Use it as a **stability anchor / variance-reduction support** so ratings do not swing wildly between recomputes.
- Do not optimize final rankings only for this supplied environment set, and do not treat absence from the supplied set as evidence that a new character or strategy is weak/unimportant.
- Final evaluation should continue to rely on generated/adaptive metagame diversity, counter-strategy discovery, and broader simulated battle evidence; the supplied environment is one stabilizing component among those signals.
- When new characters are added, they must still be allowed to enter candidate generation and reshape the simulated metagame even if they are absent from the supplied environment set.


### 2026-10-04 — explicit stale-run preemption signal

- Added `ops/v12-preempt-stale-now.txt` as an explicit restart signal.
- Only a change to that signal file (or a manual workflow dispatch) triggers the destructive stale-run preemptor; ordinary source pushes still do not cancel an active V12 wave.
- The same signal also triggers the shared-pool recompute workflow, so obsolete-source runs are cancelled and a recompute from the same current source revision is queued immediately.
- This was used to replace the obsolete `d5cce4d...` water:200 run with a current-catalogue run after the 2026-10-04 character refresh.


### 2026-10-04 — keep the 19-runner candidate pool fed with three shard waves

- Observed during current fire:200: 20 total candidate shards meant 11 could finish while only 9 long-running shards remained, leaving roughly 10 runner slots idle.
- The candidate matrix now plans up to **57 shards per condition** instead of 20, while workflow `max-parallel` remains **19**.
- This creates roughly three waves of smaller work items. As one shard finishes, a queued shard immediately occupies that runner, so utilization stays near the intended 19-runner ceiling for much more of the condition.
- This does **not** increase simultaneous runner usage above 19 and still leaves one of the usual 20 hosted-runner slots free for control/rerank work.
- Conditions are still finalized independently and in priority order; this is a scheduling/granularity optimization only. Battle semantics, candidate coverage, ranking policy, and model version are unchanged.
- The already-running fire:200 wave is not cancelled/restarted merely to apply this optimization; the finer 57-shard scheduling applies from the next normal candidate wave onward.


### 2026-10-05 — ignore obsolete finalization recovery deltas instead of failing

- fire:200 candidate evaluation reached counterfactual finalization under V12.7, but the recovery selector also found old fire:200 artifacts from the previous catalogue generation.
- `merge-metagame-v12-finalization-deltas.mjs` correctly rejected those artifacts as incompatible, but that rejection aborted the whole fanout plan and caused repeated finalization failures.
- Recovery now calls the merger with `--skip-incompatible=true`. Context compatibility checks remain strict; incompatible deltas are skipped, never merged.
- If every recovered artifact is obsolete, finalization continues from the durable current-generation checkpoint instead of failing.
- Default merger behavior remains strict/fail-fast unless the explicit recovery flag is used.


### 2026-10-05 — Wiki追加74体を正規図鑑カテゴリへ移動

- ユーザー指示により、2026年に追加調査した74体を `手動補完2026` 扱いから外した。
- `src/data/character-supplements-2026.js` は廃止し、`src/data/wiki-character-additions.js` を正規のWiki追加データとして使用する。
- 74体の `source.sheet` は英語物語Wiki/既存Book1のカテゴリに揃え、`限定` / `ゆる狩` / `対戦` / `福引` / `EXTRA` のいずれかにした。図鑑UIは `source.sheet` でグループ化するため、既存Book1キャラと同じカテゴリへ表示される。
- 福引S5の7体はシーズン情報をnotesに残しつつ、正規カテゴリとして `region: "福引"` / `source.sheet: "福引"` に統一した。
- キャラID、属性、Cost、HP/Power、スキル、暫定7体の採用値は変更していない。分類・データ所有元の整理のみ。
- `docs/character-data-caveats.md` の更新先も `src/data/wiki-character-additions.js` に変更した。
- 回帰テストはWiki追加が74体、`手動補完2026` が0体、source.sheetが上記5カテゴリだけであることを固定する。
- 過去ログ中の `character-supplements-2026.js` 記述は当時の履歴として残るが、**現在の正本は `wiki-character-additions.js`**。


### 2026-10-05 — lets-eiigo-only icon refresh

- User explicitly restricted this icon task to `https://lets-eiigo.com/`; do not browse/fetch another content site for this task.
- `scripts/import-lets-eiigo-images.mjs` is now hard-restricted to the `lets-eiigo.com` origin for content/image fetches; the previous official-site fallback was removed from the importer.
- lets-eiigo's `二条壌☆浴衣モード` is mapped only for icon matching to the existing catalogue name `二条嬢☆浴衣モード`; the character name itself remains unchanged.
- Added `.github/workflows/import-lets-eiigo-images.yml`: it scans lets-eiigo catalogue/detail/posts/pages/media, downloads every safely exact-matched missing icon, rebuilds `src/data/character-image-manifest.js`, records coverage, and commits imported assets.
- Ambiguous unmatched images must remain unmatched rather than being guessed onto a character.
- Before this refresh, the manifest had 1,854 mapped images and `character-images/lets-eiigo-sources.json` had 1,726 source records.


### 2026-10-05 — lets-eiigo WordPress API 403 fallback

- First icon-refresh run reached the normal lets-eiigo catalogue pages but failed when `/wp-json/wp/v2/categories` returned HTTP 403.
- WordPress category/posts/pages/media APIs are now optional enrichment only. A blocked API logs a warning and the importer continues with the ordinary lets-eiigo catalogue pages instead of aborting the entire refresh.
- Source restriction remains unchanged: only `lets-eiigo.com` is allowed for content/image fetches.


### 2026-10-05 — confirmed lets-eiigo image-name aliases

- After the site-only crawl, 286 unmatched rows collapsed to 45 unique alt names; most were repeated store banners/article thumbnails rather than character icons.
- Cross-checking only against lets-eiigo pages and the current local catalogue identified ten missing-character icons with one-to-one spelling differences. Added image-only aliases for:
  - `ﾀｰｷｰﾃﾞｰなじとっこ君` → `ﾀｰｷｰﾃﾞ-なじとっこ君`
  - `草カロ四郎` → `草カロ四朗`
  - `ガジランガ守り隊員` → `カジランガ守り隊員`
  - `オロモ君は鬱気味` → `オロモ君は欝気味`
  - `ヌッと出る☆ウィス君` → `ﾇｯと出る☆ウイス君`
  - `伊予まっつぁん` → `伊予まぁつぁん`
  - `なるとびくんの海中浮遊` → `なるとびくんの海中遊泳`
  - `超蝶ペッパーくん` → `蝶々ペッパーくん`
  - `ツノザヤ君は能天気` → `ツノザヤ君は脳天気`
  - `スポッて言うとイナフ君` → `ｽﾎﾟｯって言うとｲﾅﾌ君`
- These mappings affect icon association only; catalogue names/data were not rewritten.
- Numeric HTML entities are now decoded (e.g. `&#x2642;`), and a literal trailing `アイコン` is stripped only for exact-name matching.
- Ambiguous items such as `keibi2`, `unknown`, and skin images without a dedicated catalogue row remain deliberately unmatched.
