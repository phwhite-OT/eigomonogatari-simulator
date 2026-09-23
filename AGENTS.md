# AGENTS.md — project handoff / operating guide

This file is the first-stop context for Codex, ChatGPT, IDE agents, and humans who open this repository without prior conversation history.

## What this project is

This repository is an **英語物語 PvP deck simulator and recommendation app**. The goal is not merely to sort characters by static stats. The important goal is to reproduce practical 5-vs-5 battle behavior closely enough to recommend ordered five-character decks and to estimate which characters/decks actually perform well under attribute and total-cost restrictions.

The browser application is generated into `index.html`. Core simulation and metagame logic lives under `src/core/`; data under `src/data/`; long-running evaluators under `scripts/`; GitHub Actions under `.github/workflows/`; durable metagame outputs are maintained separately from source on the `metagame-v12-shared-pool-results` branch.

Read `docs/project-handoff.md` for the detailed architecture, current V12.5 computation design, recovery rules, and the current work state.

## Current highest-priority work

As of 2026-09-23, the main background task is the **V12.5 shared-pool metagame recompute/finalization**.

Important identifiers:

- model/context version: `team-battle-v12.5-effective-damage-individual-rank`
- battle semantics: `opportunity-baseline-v6-target-priority`
- ranking policy: `full-budget-opportunity-v9-adaptive-metagame`
- adaptive metagame schema: `2`
- finalization state version: `2`

Target selection semantics:
- normal attackers keep stock balancing as the first target rule
- among enemies with the same remaining stock, an active character with unused revive capacity is an absolute target priority before killability/damage efficiency
- ghosts bypass guard/attribute-guard redirection and mitigation, and therefore directly prioritize the currently active guard carrier even when another enemy has more remaining stock; this lets the ghost remove the wall before ordinary attackers act
- exhausted revive users (no skill uses remaining) lose the revive-priority flag
- durable results branch: `metagame-v12-shared-pool-results`
- report root: `reports/metagame-ratings-v12-team-opportunity/`

The expensive precompute covers exactly **28 representative environments**:

- attribute groups: `fire`, `water`, `wind`, `fire-water`, `fire-wind`, `water-wind`, `fire-water-wind`
- representative total costs: `100`, `200`, `300`, `500`

Do **not** expand this into every integer cost from 100–500. Intermediate browser costs are intentionally derived from the neighbouring representative bands.

## V12.5 execution flow

Normal recompute workflow:

`.github/workflows/metagame-v12-shared-pool-recompute.yml`

1. `select` finds the first incomplete environment and restores its durable checkpoint.
2. `evaluate` computes missing candidate ratings using a matrix with up to 19 runners in parallel.
3. `publish` merges checkpoints, creates/advances finalization state, writes progress to the results branch, and dispatches either the next candidate segment or distributed finalization.

The 19-runner cap is intentional: it leaves one runner slot available for lightweight/control work such as ranking refreshes instead of letting battle fanout consume all 20 slots.

Distributed finalization workflow:

`.github/workflows/metagame-v12-finalization-fanout.yml`

1. select a checkpoint in counterfactual finalization
2. build a globally deduplicated work plan
3. run up to 19 finalization shards in parallel
4. merge exact cache deltas and advance the frozen finalization plan

The expensive counterfactual/deep-neighbourhood battle work belongs in this fanout workflow, not in a long serial `publish` step.

Critical artifact invariant: every `prefill` shard must upload its cache delta and `merge` must refuse to continue when zero delta files are downloaded. In GitHub Action `with.path` fields, use GitHub expression syntax such as `${{ needs.select.outputs.output_directory }}`; shell-style `$METAGAME_OUTPUT_DIRECTORY` is not expanded there.

## Public-site publication

`.github/workflows/deploy-pages.yml` is triggered by pushes to `master`, `metagame-v12-shared-pool-results`, and the browser-knowledge results branch. It must always check out **master** for application source code, then overlay report data from result branches.

V12 result publication is **progressive per condition**. Start from the last broadly complete fallback snapshot, then replace each of the 28 representative condition directories independently when the shared-pool result is truly complete and its model version, battle semantics, finalization-state version, and ranking-policy marker match the current policy. Never gate the whole public site on all seven cost-100 conditions (or all 28 conditions) being complete at once.

This means a newly completed condition such as `fire-100` should become visible on the next Pages deployment while unfinished conditions continue using their previous published snapshots. Result-branch source files themselves are not authoritative application code.

## Reliability / recovery design

This system is intentionally resumable. Preserve that property when changing it.

- long calculations must save checkpoints/artifacts instead of depending on one uninterrupted run
- control-plane jobs such as `select` and the watchdog should read `progress-summary.json` first; the full `progress.json` checkpoint can be tens of megabytes and is reserved for workers that actually need the battle cache
- durable writers must refresh `progress-summary.json` whenever they change `progress.json`; legacy results without the summary are supported through a full-checkpoint fallback
- GitHub transport/service failures may be retried
- `.github/workflows/metagame-v12-watchdog.yml` checks periodically and resumes safe stalled work
- `publish` must hand work to `metagame-v12-finalization-fanout.yml` only after the checkpoint is in `finalizationState.phase == "counterfactual"` with remaining frozen-plan work; earlier finalization phases such as global baseline must continue through normal shared-pool segments
  - workflow-level `pending` with zero jobs is a legitimate concurrency wait while another heavy V12 run owns `metagame-v12-shared-pool-recompute`; a healthy owner must not be cancelled just because a newer pending continuation exists
  - watchdog workflow-run JSON must be read from files/stdin rather than passed wholesale through shell argv; large Actions payloads can exceed `ARG_MAX`
  - if there is no heavy owner and the desired continuation remains pending for more than 15 minutes, recycle that orphaned pending run and dispatch a fresh continuation
- `.github/workflows/metagame-v12-preempt-stale.yml` prevents obsolete source revisions from continuing to consume runner time
- deterministic code/data failures must **not** be hidden behind an infinite retry loop
- never discard a valid durable checkpoint merely because a later dispatch failed

A watchdog/restart mechanism can restart known-safe work, but it does **not** magically repair unknown program bugs. When a deterministic failure repeats, inspect logs and fix the underlying logic.

## Important recent handoff fix

A durable checkpoint can contain all candidate ratings while still needing a finalize-only transition. In that state the ordinary missing-candidate planner returns zero shards, which previously produced:

`No candidate shards selected for incomplete input fire:100`

`scripts/build-metagame-v12-work-matrix.mjs` now emits one deterministic `*-finalize-handoff` shard when a compatible saved checkpoint exists but no candidate is missing. This deliberately re-evaluates one already-covered candidate so that a normal checkpoint artifact exists for `publish`; `publish` can then advance into finalization and hand the expensive work to the 19-runner fanout.

Do not remove this as “redundant” unless the workflow is redesigned so that `publish` can directly consume an already-complete candidate checkpoint without an evaluate artifact.

## Invariants: do not casually change these

1. A match is modeled as **five player decks vs five player decks**, not one deck vs one deck.
2. Static HP/Power/skill proxies may help bounded partner search, but must not silently replace measured battle evidence as the final ranking signal.
3. Candidate coverage and final ranking are separate concerns. Finishing candidate ratings does not necessarily mean the environment is fully `complete`; counterfactual finalization can remain.
4. A checkpoint is considered current only when its model version, battle semantics, finalization version, and ranking-policy marker match the current policy.
5. The results branch is durable computation state. Do not delete/reset `metagame-v12-shared-pool-results` unless a deliberate semantics/model invalidation requires a clean recompute.
6. Source pushes can invalidate in-flight calculations. Concurrency/preemption behavior exists to prevent mixed-source results.
7. Preserve exact resumability: continuing from a checkpoint should not change the meaning of already completed work.

## Before changing simulation/metagame code

Read at least:

- `README.md`
- `docs/project-handoff.md`
- `src/core/simulate.js`
- `src/core/metagame-v7.js`
- `src/core/metagame-v12.js`
- `src/core/metagame-v12-adaptive.js`
- `src/core/metagame-v12-finalization.js`
- `scripts/rate-metagame-v12.mjs`
- `scripts/build-metagame-v12-work-matrix.mjs`
- the two V12 workflows listed above

If the task touches battle semantics, also inspect tests before changing behavior.

## Validation

At minimum, for ordinary source changes:

```bash
npm test
npm run build
```

For workflow/script changes, also run relevant Node syntax checks and inspect the generated matrix/checkpoint behavior. Do not trigger a fresh expensive 28-environment recompute merely to test a small syntax change if a local/synthetic validation is sufficient.

## How to determine live computation status

Do not infer “calculation has started” merely because a workflow run is `in_progress`.

Check the actual job/step:

- `select` = choosing/restoring work; not the expensive calculation
- `evaluate` + `Recompute V12 candidate shard` in progress = candidate battle calculation is running
- finalization fanout `prefill` + `Evaluate assigned unique counterfactual battles` = distributed expensive finalization is running
- `publish`/`merge` = checkpoint consolidation / handoff, normally not the main expensive fanout

The exact live run ID is intentionally not hard-coded here because it becomes stale. Inspect GitHub Actions for the newest run on `master`.

## Current V12 ranking policy

Current ranking marker: `full-budget-opportunity-v9-adaptive-metagame`.

Final ranking is no longer a simple uniform average over the fixed 72 supplied scenarios. The completed shared deck pool is treated as the measured strategy population. A time-averaged coevolution loop raises adoption for complete decks that perform well under the current scenario mix, while the environment side raises weight on scenarios where the currently popular decks underperform. This approximates the practical counter cycle (strong deck → counter adoption → counter-counter adoption) without hard-coded character exceptions. A uniform scenario floor and time averaging keep rock-paper-scissors style cycles represented instead of collapsing to the final iterate.

This adaptive pass is ranking/reporting only. It consumes the existing per-scenario battle vectors already stored in the V12 cache, so compatible V12.5 battle checkpoints remain reusable. `scripts/rerank-metagame-v12-report.mjs` must never upgrade an old fixed-environment report by relabeling it; only reports already containing `adaptiveMetagame.version == 2` may use that lightweight reranker. Completed legacy reports are upgraded through `scripts/rate-metagame-v12.mjs --finalize-only=true`, which rebuilds the adaptive aggregation from durable battle evidence without replaying the heavy battles.

Individual contribution is ordered from central battle evidence first. The primary signal is the **mean** full five-slot budget-reallocation opportunity result. That comparison already captures cost because removing a candidate frees its cost and allows all five slots to rebuild. When two candidates have the same full-budget mean, the controlled same-four-teammate **mean** contribution is the next direct-attribution signal.

Robust/lower-bound evidence is a confidence tie-break only after the mean signals. The matched-slot robust result may still adjust the conservative diagnostic inside the full-budget uncertainty band:

`correction cap = max(0, opportunity mean - robust opportunity)`

That correction is **not weighted by character cost or budget usage** and cannot push the conservative contribution beyond the full-budget mean. It no longer outranks a larger measured mean merely because the latter has more variance. If matched-slot evidence is unavailable, the full-budget mean is reused for the matched-mean tie-break so missing diagnostics are not treated as negative evidence.

Treat total cost as a **ceiling, not a target**. Unused budget has no direct bonus or penalty. Search tie-breaks must not prefer a fuller-cost deck merely because it spends more; when proxy and synergy are equal, preserve the lower-cost legal deck so a strong spare-budget construction is not pruned.

Long-running battle evidence remains reusable across ranking-only changes. Heavy battle workflows remain serialized by `metagame-v12-shared-pool-recompute`, while every job that writes `metagame-v12-shared-pool-results` also uses the short job-level lock `metagame-v12-result-writer`. The lightweight cost-100 reranker uses a separate workflow concurrency group so it can consume the intentionally reserved 20th runner while a 19-runner battle wave is active, but it still takes the result-writer lock before touching durable results. Stale-run cancellation is manual unless battle semantics themselves become incompatible.

## Documentation rule for future agents

When a change materially alters architecture, battle semantics, ranking policy, checkpoint format, workflow recovery, or the meaning of V12 outputs, update **both** this file and `docs/project-handoff.md` in the same change. The goal is that a new agent can begin useful work without needing any previous chat history.


## Every-fix handoff rule

Do not rely on chat history to preserve current work context.

After **every source/workflow/evaluation fix**, update the rolling handoff log in `docs/project-handoff.md` during the same work session. Record the change, reason, compatibility/recompute implications, validation/current state, and next checks as relevant. Minor fixes only need a short dated log entry there.

If the fix materially changes architecture, battle semantics, ranking policy, checkpoint format, workflow recovery/topology, or the meaning of V12 outputs, update the explanatory sections in both this file and `docs/project-handoff.md` as well.
