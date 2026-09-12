import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(path, "utf8");
}

async function write(path, content) {
  await fs.writeFile(path, content, "utf8");
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Patch target is ambiguous: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceAllChecked(source, before, after, minimum, label) {
  const count = source.split(before).length - 1;
  if (count < minimum) throw new Error(`Patch target count ${count} < ${minimum}: ${label}`);
  return source.split(before).join(after);
}

// 1) Make finalization resumable and broaden counterfactual exploration.
{
  const path = "scripts/rate-metagame-v12.mjs";
  let text = await read(path);

  text = replaceOnce(
    text,
    'const replacementDeckLimit = positiveInteger(readArgument("replacement-deck-limit", "12"), 12, 1);\nconst replacementBeamWidth = positiveInteger(readArgument("replacement-beam-width", "4000"), 4000, 500);',
    'const replacementDeckLimit = positiveInteger(readArgument("replacement-deck-limit", "24"), 24, 1);\nconst replacementBeamWidth = positiveInteger(readArgument("replacement-beam-width", "4000"), 4000, 500);\nconst counterfactualAnchorLimit = positiveInteger(readArgument("counterfactual-anchor-limit", "3"), 3, 1);',
    "replacement search defaults",
  );

  text = replaceOnce(
    text,
    'const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;\nlet stoppedEarly = false;',
    'const deadline = timeBudgetSeconds ? Date.now() + timeBudgetSeconds * 1000 : Infinity;\nconst finalizationDeadlineReached = (guardMs = 15000) => Number.isFinite(deadline) && Date.now() + guardMs >= deadline;\nlet stoppedEarly = false;',
    "finalization deadline helper",
  );

  text = replaceOnce(
    text,
    '// Seed a shared baseline from all legal candidates before reconciliation.\n// This search is paid once per condition, rather than once per character, so\n// cheap strong replacements cannot disappear merely because they missed the\n// bounded partner sample used by the direct per-character probes.\nconst globalBaselineCandidates = buildMetagameV12GlobalBaselineDecks(',
    '// Candidate battles are complete. From here on the checkpoint deliberately\n// remains resumable: a workflow chunk may stop before GitHub kills the runner,\n// persist the evaluated-deck cache, and continue in the next run.\nawait saveProgress("finalizing");\n\n// Seed a shared baseline from all legal candidates before reconciliation.\n// This search is paid once per condition, rather than once per character, so\n// cheap strong replacements cannot disappear merely because they missed the\n// bounded partner sample used by the direct per-character probes.\nconst globalBaselineCandidates = buildMetagameV12GlobalBaselineDecks(',
    "mark finalization resumable",
  );

  text = replaceOnce(
    text,
    'for (const entry of globalBaselineCandidates) {\n  const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;\n  if (evaluationCache.has(key)) continue;\n  evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));\n  globalBaselineNewEvaluations += 1;\n}\nif (globalBaselineNewEvaluations) await saveProgress();',
    'for (const entry of globalBaselineCandidates) {\n  const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;\n  if (evaluationCache.has(key)) continue;\n  if (finalizationDeadlineReached()) {\n    stoppedEarly = true;\n    break;\n  }\n  evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));\n  globalBaselineNewEvaluations += 1;\n  if (globalBaselineNewEvaluations % 5 === 0) await saveProgress("finalizing");\n}\nif (globalBaselineNewEvaluations) await saveProgress("finalizing");\nif (stoppedEarly) {\n  await saveProgress("finalizing");\n  console.log(`V12 finalization chunk stopped safely during global baseline after ${globalBaselineNewEvaluations} new deck evaluations.`);\n  process.exit(0);\n}',
    "global baseline checkpointing",
  );

  text = replaceOnce(
    text,
    'applyReconciledRatings();\n\n// Audit every rated card around its strongest known complete deck. Four slots\n// are frozen exactly and only the rated slot may change. These are additional\n// targeted battles, not a replay of the expensive candidate probes already in\n// the checkpoint. The cache makes the audit resumable and deduplicates shells\n// shared by multiple ratings.\nlet counterfactualNewEvaluations = 0;\nlet counterfactualCandidateDeckCount = 0;\nfor (const [index, ratings] of resultsByPosition.entries()) {\n  const position = index + 1;\n  for (const rating of ratings.values()) {\n    const replacements = buildMetagameV12CounterfactualReplacementDecks(\n      rating,\n      position,\n      resolvedInput,\n      candidatePools,\n      { replacementDeckLimit, replacementBeamWidth },\n    );\n    counterfactualCandidateDeckCount += replacements.length;\n    for (const entry of replacements) {\n      const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;\n      if (evaluationCache.has(key)) continue;\n      evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));\n      counterfactualNewEvaluations += 1;\n      if (counterfactualNewEvaluations % 50 === 0) await saveProgress();\n    }\n  }\n}\nif (counterfactualNewEvaluations) {',
    'applyReconciledRatings();\n\nfunction selectCounterfactualAnchors(rating, position, pool, limit) {\n  const positionIndex = position - 1;\n  const candidateId = String(rating.id);\n  const available = (pool ?? []).filter((entry) => String(entry.ids?.[positionIndex]) === candidateId);\n  const selected = [];\n  for (const entry of available) {\n    if (!selected.length) {\n      selected.push(entry);\n    } else {\n      const minOtherSlotDifference = Math.min(...selected.map((chosen) => (\n        entry.ids.reduce((count, id, index) => (\n          index === positionIndex || String(id) === String(chosen.ids[index]) ? count : count + 1\n        ), 0)\n      )));\n      if (minOtherSlotDifference >= 2) selected.push(entry);\n    }\n    if (selected.length >= limit) break;\n  }\n  for (const entry of available) {\n    if (selected.length >= limit) break;\n    if (!selected.includes(entry)) selected.push(entry);\n  }\n  return selected;\n}\n\n// Audit several structurally different strong shells for every rated card, not\n// only one best deck. Within each shell, only the rated slot may change. This\n// catches cards that are passengers in one shell and genuinely useful in another.\nlet counterfactualNewEvaluations = 0;\nlet counterfactualCandidateDeckCount = 0;\ncounterfactualAudit:\nfor (const [index, ratings] of resultsByPosition.entries()) {\n  const position = index + 1;\n  for (const rating of ratings.values()) {\n    const anchors = selectCounterfactualAnchors(rating, position, sharedDeckPool, counterfactualAnchorLimit);\n    const fallbackAnchor = rating.bestDeck?.ids?.length === 5 ? [{ ids: rating.bestDeck.ids }] : [];\n    for (const anchor of (anchors.length ? anchors : fallbackAnchor)) {\n      const anchorRating = {\n        ...rating,\n        bestDeck: { ...(rating.bestDeck ?? {}), ids: [...anchor.ids] },\n      };\n      const replacements = buildMetagameV12CounterfactualReplacementDecks(\n        anchorRating,\n        position,\n        resolvedInput,\n        candidatePools,\n        { replacementDeckLimit, replacementBeamWidth },\n      );\n      counterfactualCandidateDeckCount += replacements.length;\n      for (const entry of replacements) {\n        const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;\n        if (evaluationCache.has(key)) continue;\n        if (finalizationDeadlineReached()) {\n          stoppedEarly = true;\n          break counterfactualAudit;\n        }\n        evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));\n        counterfactualNewEvaluations += 1;\n        if (counterfactualNewEvaluations % 5 === 0) await saveProgress("finalizing");\n      }\n    }\n  }\n}\nif (counterfactualNewEvaluations) await saveProgress("finalizing");\nif (stoppedEarly) {\n  await saveProgress("finalizing");\n  console.log(`V12 finalization chunk stopped safely after ${counterfactualNewEvaluations} new matched-slot deck evaluations.`);\n  process.exit(0);\n}\nif (counterfactualNewEvaluations) {',
    "multi-anchor resumable counterfactual audit",
  );

  text = replaceOnce(
    text,
    '}\nawait saveProgress("complete");\n\nconst rankingsByPosition = resultsByPosition.map((ratings, index) => ({',
    '}\n\nconst rankingsByPosition = resultsByPosition.map((ratings, index) => ({',
    "delay complete checkpoint until reports exist",
  );

  text = replaceOnce(
    text,
    '    replacementDeckLimit,\n    replacementBeamWidth,',
    '    replacementDeckLimit,\n    replacementBeamWidth,\n    counterfactualAnchorLimit,',
    "report anchor limit",
  );

  text = replaceOnce(
    text,
    '    performancePolicy: "各候補の直接探索と共有基準デッキは既存キャッシュを再利用する。全shard統合後、各キャラの最善完成デッキに対して他4枠固定の差し替え候補を最大12本探索し、未評価の差し替えだけ追加実戦評価する。",',
    '    performancePolicy: "各候補の直接探索と共有基準デッキは既存キャッシュを再利用する。全shard統合後、各キャラについて構成の異なる強い完成デッキを最大3本監査し、各デッキで他4枠固定の差し替え候補を最大24本、proxy上位だけに偏らないよう層化して探索する。finalizeは時間予算内で必ずcheckpointを永続化して再開する。",',
    "report performance policy",
  );

  text = replaceOnce(
    text,
    'await fs.writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\\n`, "utf8");\nawait fs.writeFile(path.join(outputDirectory, "ranking.csv"), csvReport(report), "utf8");\nconsole.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated).`);',
    'await fs.writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\\n`, "utf8");\nawait fs.writeFile(path.join(outputDirectory, "ranking.csv"), csvReport(report), "utf8");\n// Only a fully materialized report may be called complete. The previous order\n// allowed a runner death after progress.json said complete but before reports existed.\nawait saveProgress("complete");\nconsole.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated).`);',
    "complete only after report write",
  );

  await write(path, text);
}

// 2) Diversify matched-slot replacement selection instead of taking only proxy top-N.
{
  const path = "src/core/metagame-v12.js";
  let text = await read(path);
  text = replaceOnce(
    text,
    '  const replacementDeckLimit = Math.max(1, Math.floor(Number(options.replacementDeckLimit) || 12));',
    '  const replacementDeckLimit = Math.max(1, Math.floor(Number(options.replacementDeckLimit) || 24));',
    "counterfactual default limit",
  );

  text = replaceOnce(
    text,
    '    return buildMetagameDeckCandidates(\n      constraint,\n      [...candidatePools.charactersById.values()],\n      { beamWidth: replacementBeamWidth },\n    ).filter((entry) => (\n      entry.deck.length === 5 &&\n      entry.deck.every((character, index) => (\n        index === positionIndex || String(character.id) === String(bestIds[index])\n      )) &&\n      String(entry.deck[positionIndex].id) !== String(rating.id)\n    )).slice(0, replacementDeckLimit);',
    '    const legal = buildMetagameDeckCandidates(\n      constraint,\n      [...candidatePools.charactersById.values()],\n      { beamWidth: replacementBeamWidth },\n    ).filter((entry) => (\n      entry.deck.length === 5 &&\n      entry.deck.every((character, index) => (\n        index === positionIndex || String(character.id) === String(bestIds[index])\n      )) &&\n      String(entry.deck[positionIndex].id) !== String(rating.id)\n    ));\n    if (legal.length <= replacementDeckLimit) return legal;\n\n    const selected = new Map();\n    const add = (entry) => selected.set(deckKey(entry.deck), entry);\n    // Keep the strongest proxy half, then deliberately spend the other half on\n    // role and cost coverage so a wrongly low proxy cannot disappear forever.\n    legal.slice(0, Math.max(1, Math.ceil(replacementDeckLimit * 0.5))).forEach(add);\n\n    const slotRatings = candidatePools.ratingsByPosition[positionIndex];\n    const roles = ["precision_attack", "sweep_attack", "defense", "revive", "recovery", "support", "neutral"];\n    for (const role of roles) {\n      if (selected.size >= replacementDeckLimit) break;\n      const entry = legal.find((candidate) => {\n        const replacement = candidate.deck[positionIndex];\n        return !selected.has(deckKey(candidate.deck)) && (slotRatings.get(String(replacement.id))?.role ?? "neutral") === role;\n      });\n      if (entry) add(entry);\n    }\n\n    const byCost = [...legal].sort((left, right) => (\n      (Number(left.deck[positionIndex]?.cost) || 0) - (Number(right.deck[positionIndex]?.cost) || 0) ||\n      (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0)\n    ));\n    while (selected.size < replacementDeckLimit) {\n      const remaining = byCost.filter((entry) => !selected.has(deckKey(entry.deck)));\n      if (!remaining.length) break;\n      const slotsLeft = replacementDeckLimit - selected.size;\n      for (let pick = 0; pick < Math.min(slotsLeft, remaining.length); pick += 1) {\n        const index = Math.min(remaining.length - 1, Math.floor((pick + 0.5) * remaining.length / Math.min(slotsLeft, remaining.length)));\n        add(remaining[index]);\n      }\n    }\n    return [...selected.values()].slice(0, replacementDeckLimit);',
    "stratified counterfactual replacements",
  );
  await write(path, text);
}

// 3) Make the workflow persist partial finalize chunks before runner timeout.
{
  const path = ".github/workflows/metagame-v12-shared-pool-recompute.yml";
  let text = await read(path);
  text = replaceAllChecked(
    text,
    "matched-slot-counterfactual-v2",
    "matched-slot-counterfactual-v3-resumable",
    4,
    "ranking policy version",
  );

  text = replaceOnce(
    text,
    '            jq -e \'.status == "complete" and .context.version == "team-battle-v12.4-full-opportunity-baseline" and .context.battleSemantics == "opportunity-baseline-v4"\' <<< "$progress" >/dev/null',
    '            jq -e \'(.status == "complete" or .status == "finalizing") and .context.version == "team-battle-v12.4-full-opportunity-baseline" and .context.battleSemantics == "opportunity-baseline-v4"\' <<< "$progress" >/dev/null',
    "select accepts finalizing checkpoint",
  );

  text = replaceOnce(
    text,
    '               jq -e \'.status == "complete" and .context.version == "team-battle-v12.4-full-opportunity-baseline" and .context.battleSemantics == "opportunity-baseline-v4"\' "$checkpoint_path" >/dev/null && \\',
    '               jq -e \'(.status == "complete" or .status == "finalizing") and .context.version == "team-battle-v12.4-full-opportunity-baseline" and .context.battleSemantics == "opportunity-baseline-v4"\' "$checkpoint_path" >/dev/null && \\',
    "rerank resumes finalizing checkpoint",
  );

  text = replaceOnce(
    text,
    '    runs-on: ubuntu-latest\n    # Final reconciliation evaluates the global baseline after shard work.\n    # 30 minutes was too short and killed a fully evaluated condition.\n    timeout-minutes: 180',
    '    runs-on: ubuntu-latest\n    env:\n      # Leave a large safety margin for report writing, git commit, and push.\n      # The script exits cleanly at this budget and the next workflow resumes it.\n      FINALIZE_TIME_BUDGET_SECONDS: "7200"\n    timeout-minutes: 165',
    "publish safe time budget",
  );

  text = replaceAllChecked(
    text,
    '                --checkpoint-path="$checkpoint_path" \\\n                --finalize-only=true',
    '                --checkpoint-path="$checkpoint_path" \\\n                --time-budget-seconds="$FINALIZE_TIME_BUDGET_SECONDS" \\\n                --finalize-only=true',
    2,
    "finalize time budget args",
  );

  text = replaceOnce(
    text,
    '            printf \'%s\\n\' "$ranking_policy" > "${output_path}/ranking-policy.txt"\n          done < <(jq -c \'.[]\' <<< "$TARGETS")',
    '            if jq -e \'.status == "complete"\' "$checkpoint_path" >/dev/null; then\n              printf \'%s\\n\' "$ranking_policy" > "${output_path}/ranking-policy.txt"\n              echo "Finalization complete for $input."\n            else\n              rm -f "${output_path}/ranking-policy.txt"\n              echo "Finalization checkpoint persisted for $input; the next run will resume it."\n            fi\n          done < <(jq -c \'.[]\' <<< "$TARGETS")',
    "only mark genuinely complete ranking",
  );

  await write(path, text);
}

console.log("Applied V12 resumable/self-healing patch successfully.");
