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
- final ranking policy: `matched-slot-counterfactual-v3-resumable`
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

The final ranking is not meant to reward a character merely because it was paired with a strong deck.

The current policy therefore uses matched-slot counterfactual evidence: compare battle outcomes while changing the relevant character/slot under controlled surrounding conditions. Deep-neighbourhood work expands exact evidence around important/high-performing configurations.

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

The workflows share concurrency intentionally. Normal recompute should hand off expensive finalization rather than spending hours doing it serially.

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
