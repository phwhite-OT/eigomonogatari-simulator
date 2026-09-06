from pathlib import Path


def replace_exact(path, old, new, expected=1):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {actual}: {old[:100]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


def insert_after(path, anchor, addition):
    replace_exact(path, anchor, anchor + addition)


# --- src/core/metagame-v12.js ---
insert_after(
    "src/core/metagame-v12.js",
    '''  return [...selected.values()].sort((left, right) => (\n    (Number(right.proxyScore) || 0) - (Number(left.proxyScore) || 0) ||\n    (Number(left.totalCost) || 0) - (Number(right.totalCost) || 0)\n  ));\n}\n''',
    '''\n/**\n * Build local counterfactuals for a rated character's current best deck.\n * The other four slots are frozen exactly; only the rated slot may change.\n * This prevents a weak card from inheriting credit from four strong teammates.\n */\nexport function buildMetagameV12CounterfactualReplacementDecks(\n  rating,\n  position,\n  resolvedInput,\n  candidatePools,\n  options = {},\n) {\n  const positionIndex = Number(position) - 1;\n  const bestIds = rating?.bestDeck?.ids;\n  if (!Array.isArray(bestIds) || bestIds.length !== 5 || positionIndex < 0 || positionIndex > 4) return [];\n  if (String(bestIds[positionIndex]) !== String(rating.id)) return [];\n\n  const replacementDeckLimit = Math.max(1, Math.floor(Number(options.replacementDeckLimit) || 12));\n  const replacementBeamWidth = Math.max(500, Math.floor(Number(options.replacementBeamWidth) || 4000));\n  const ratingsByPosition = candidatePools?.ratingsByPosition ?? [];\n  const fixedIds = new Set(bestIds.filter((_, index) => index !== positionIndex).map(String));\n  const slots = bestIds.map((id, index) => {\n    const ratings = ratingsByPosition[index];\n    if (!ratings?.get || !ratings?.values) return { position: index + 1, candidates: [] };\n    if (index !== positionIndex) {\n      const fixed = ratings.get(String(id));\n      return { position: index + 1, candidates: fixed ? [fixed] : [] };\n    }\n    return {\n      position: index + 1,\n      candidates: [...ratings.values()].filter((candidate) => (\n        String(candidate.id) !== String(rating.id) && !fixedIds.has(String(candidate.id))\n      )),\n    };\n  });\n  if (slots.some((slot) => !slot.candidates.length)) return [];\n\n  const constraint = {\n    totalCost: resolvedInput.totalCost,\n    allowedAttributes: resolvedInput.allowedAttributes,\n    slots,\n  };\n  try {\n    return buildMetagameDeckCandidates(\n      constraint,\n      [...candidatePools.charactersById.values()],\n      { beamWidth: replacementBeamWidth },\n    ).filter((entry) => (\n      entry.deck.length === 5 &&\n      entry.deck.every((character, index) => (\n        index === positionIndex || String(character.id) === String(bestIds[index])\n      )) &&\n      String(entry.deck[positionIndex].id) !== String(rating.id)\n    )).slice(0, replacementDeckLimit);\n  } catch (error) {\n    if (error instanceof Error && /cost|総コスト|valid complete|legal deck/i.test(error.message)) return [];\n    throw error;\n  }\n}\n''',
)

replace_exact(
    "src/core/metagame-v12.js",
    '''/**\n * V12 slot rankings are recommendations for building a legal five-card team,\n * not standalone-card power rankings. Prefer the strongest already-evaluated\n * complete deck that contains the character in this exact slot. Opportunity\n * gain remains a tie-breaker/legacy fallback, so expensive cards are not\n * blindly penalized: they stay high only when the full legal team is actually\n * strong under the current cost cap.\n */\nexport function rankMetagameV12Characters(ratings) {\n  return [...ratings]\n    .sort((left, right) => (\n      compareCompleteDeckMetric(left, right, "expectedWinLowerBound") ||\n      compareCompleteDeckMetric(left, right, "expectedWinRate") ||\n      compareCompleteDeckMetric(left, right, "decisiveWinRate") ||\n      finiteOrNegativeInfinity(right.robustOpportunityWinGain) - finiteOrNegativeInfinity(left.robustOpportunityWinGain) ||\n      finiteOrNegativeInfinity(right.opportunityWinGain) - finiteOrNegativeInfinity(left.opportunityWinGain) ||\n      finiteOrNegativeInfinity(right.decisiveWinGain) - finiteOrNegativeInfinity(left.decisiveWinGain) ||\n      Number(left.cost) - Number(right.cost) ||\n      String(left.id).localeCompare(String(right.id))\n    ))\n    .map((rating, index) => ({\n      ...rating,\n      rank: index + 1,\n      rankingBasis: hasCompleteBestDeck(rating) ? "complete-deck-performance" : "opportunity-fallback",\n    }));\n}\n''',
    '''function rankingContributionEvidence(rating) {\n  const matched = rating?.counterfactualApplied === true;\n  const robust = finiteOrNegativeInfinity(\n    matched ? rating.counterfactualRobustWinGain : rating.robustOpportunityWinGain,\n  );\n  const mean = finiteOrNegativeInfinity(\n    matched ? rating.counterfactualWinGain : rating.opportunityWinGain,\n  );\n  return {\n    matched,\n    robust,\n    mean,\n    positive: Number.isFinite(robust) && robust > 0 ? 1 : 0,\n  };\n}\n\n/**\n * A complete deck can win despite one bad passenger. First require positive\n * marginal evidence: preferably the exact same four teammates with only this\n * slot replaced, otherwise the older global opportunity-cost evidence. Once\n * two cards both have positive evidence, complete-team strength decides which\n * one is the more useful building block. This keeps genuinely strong expensive\n * cards while preventing a weak card from riding a strong shell to the top.\n */\nexport function rankMetagameV12Characters(ratings) {\n  return [...ratings]\n    .sort((left, right) => {\n      const leftContribution = rankingContributionEvidence(left);\n      const rightContribution = rankingContributionEvidence(right);\n      const contributionTier = rightContribution.positive - leftContribution.positive;\n      if (contributionTier) return contributionTier;\n\n      if (leftContribution.positive && rightContribution.positive) {\n        return (\n          compareCompleteDeckMetric(left, right, "expectedWinLowerBound") ||\n          compareCompleteDeckMetric(left, right, "expectedWinRate") ||\n          compareCompleteDeckMetric(left, right, "decisiveWinRate") ||\n          rightContribution.robust - leftContribution.robust ||\n          rightContribution.mean - leftContribution.mean ||\n          finiteOrNegativeInfinity(right.decisiveWinGain) - finiteOrNegativeInfinity(left.decisiveWinGain) ||\n          Number(left.cost) - Number(right.cost) ||\n          String(left.id).localeCompare(String(right.id))\n        );\n      }\n\n      return (\n        rightContribution.robust - leftContribution.robust ||\n        rightContribution.mean - leftContribution.mean ||\n        compareCompleteDeckMetric(left, right, "expectedWinLowerBound") ||\n        compareCompleteDeckMetric(left, right, "expectedWinRate") ||\n        compareCompleteDeckMetric(left, right, "decisiveWinRate") ||\n        finiteOrNegativeInfinity(right.decisiveWinGain) - finiteOrNegativeInfinity(left.decisiveWinGain) ||\n        Number(left.cost) - Number(right.cost) ||\n        String(left.id).localeCompare(String(right.id))\n      );\n    })\n    .map((rating, index) => {\n      const contribution = rankingContributionEvidence(rating);\n      return {\n        ...rating,\n        rank: index + 1,\n        positiveContributionEvidence: contribution.positive === 1,\n        rankingBasis: contribution.matched\n          ? "matched-replacement-contribution"\n          : hasCompleteBestDeck(rating)\n            ? "complete-deck-performance"\n            : "opportunity-fallback",\n      };\n    });\n}\n''',
)

# --- src/core/metagame-v12-shared-pool.js ---
replace_exact(
    "src/core/metagame-v12-shared-pool.js",
    "export const METAGAME_V12_SHARED_POOL_VERSION = 1;",
    "export const METAGAME_V12_SHARED_POOL_VERSION = 2;",
)
insert_after(
    "src/core/metagame-v12-shared-pool.js",
    '''function sameIds(left = [], right = []) {\n  return left.length === right.length && left.every((id, index) => String(id) === String(right[index]));\n}\n''',
    '''\nfunction sameOtherSlots(left = [], right = [], positionIndex) {\n  return left.length === 5 && right.length === 5 && left.every((id, index) => (\n    index === positionIndex || String(id) === String(right[index])\n  ));\n}\n''',
)
replace_exact(
    "src/core/metagame-v12-shared-pool.js",
    '''  const decisiveWinGain = (Number(best.result.decisiveWinRate) || 0) - (Number(baseline.result.decisiveWinRate) || 0);\n  const score = signedOpportunityScore(robustOpportunityWinGain);\n  const includeValues = includeEvaluated.map((entry) => Number(entry.result.expectedWinRate) || 0);\n''',
    '''  const decisiveWinGain = (Number(best.result.decisiveWinRate) || 0) - (Number(baseline.result.decisiveWinRate) || 0);\n  const opportunityScore = signedOpportunityScore(robustOpportunityWinGain);\n\n  // The global exclusion baseline answers "can the whole deck be rebuilt\n  // better without this card?". For individual contribution we need the\n  // stricter causal question: keep the same four teammates and replace only\n  // this exact slot. The strongest evaluated exact replacement is deliberately\n  // used so a passenger cannot keep credit merely because one weak substitute\n  // was sampled.\n  const positionIndex = position - 1;\n  const matchedAlternatives = alternativeEvaluated\n    .filter((entry) => sameOtherSlots(best.ids, entry.ids, positionIndex))\n    .sort(compareEvaluatedDecks);\n  const counterfactualBaseline = matchedAlternatives[0] ?? null;\n  const counterfactualDeltas = counterfactualBaseline\n    ? (best.result.scenarioValues ?? []).map((value, index) => (\n      Number(value) - Number(counterfactualBaseline.result.scenarioValues?.[index])\n    )).filter(Number.isFinite)\n    : [];\n  const counterfactualWinGain = counterfactualBaseline\n    ? (counterfactualDeltas.length\n      ? average(counterfactualDeltas)\n      : (Number(best.result.expectedWinRate) || 0) - (Number(counterfactualBaseline.result.expectedWinRate) || 0))\n    : null;\n  const counterfactualStdDev = counterfactualBaseline ? standardDeviation(counterfactualDeltas) : null;\n  const counterfactualStandardError = counterfactualBaseline && counterfactualDeltas.length > 1\n    ? counterfactualStdDev / Math.sqrt(counterfactualDeltas.length)\n    : 0;\n  const counterfactualRobustWinGain = counterfactualBaseline\n    ? counterfactualWinGain - 1.28 * counterfactualStandardError\n    : null;\n  const counterfactualDecisiveWinGain = counterfactualBaseline\n    ? (Number(best.result.decisiveWinRate) || 0) - (Number(counterfactualBaseline.result.decisiveWinRate) || 0)\n    : null;\n  const primaryWinGain = counterfactualBaseline ? counterfactualWinGain : opportunityWinGain;\n  const primaryRobustWinGain = counterfactualBaseline ? counterfactualRobustWinGain : robustOpportunityWinGain;\n  const score = signedOpportunityScore(primaryRobustWinGain);\n  const includeValues = includeEvaluated.map((entry) => Number(entry.result.expectedWinRate) || 0);\n''',
)
replace_exact(
    "src/core/metagame-v12-shared-pool.js",
    '''    opportunityWinGain: rounded(opportunityWinGain),\n    robustOpportunityWinGain: rounded(robustOpportunityWinGain),\n    decisiveWinGain: rounded(decisiveWinGain),\n    marginalWinGain: rounded(opportunityWinGain),\n    marginalWinGainLowerBound: rounded(robustOpportunityWinGain),\n    candidateExpectedWinRate: rounded(best.result.expectedWinRate),\n''',
    '''    opportunityWinGain: rounded(opportunityWinGain),\n    robustOpportunityWinGain: rounded(robustOpportunityWinGain),\n    decisiveWinGain: rounded(decisiveWinGain),\n    counterfactualApplied: Boolean(counterfactualBaseline),\n    counterfactualWinGain: counterfactualBaseline ? rounded(counterfactualWinGain) : null,\n    counterfactualRobustWinGain: counterfactualBaseline ? rounded(counterfactualRobustWinGain) : null,\n    counterfactualDecisiveWinGain: counterfactualBaseline ? rounded(counterfactualDecisiveWinGain) : null,\n    counterfactualBenchmarkExpectedWinRate: counterfactualBaseline\n      ? rounded(counterfactualBaseline.result.expectedWinRate)\n      : null,\n    counterfactualReplacementDeckCount: matchedAlternatives.length,\n    counterfactualReplacementDeck: counterfactualBaseline\n      ? summarizePoolDeck(counterfactualBaseline, totalCost, null)\n      : null,\n    marginalWinGain: rounded(primaryWinGain),\n    marginalWinGainLowerBound: rounded(primaryRobustWinGain),\n    candidateExpectedWinRate: rounded(best.result.expectedWinRate),\n''',
)
replace_exact(
    "src/core/metagame-v12-shared-pool.js",
    '''    roleBreakdown: {\n      ...(rating.roleBreakdown ?? {}),\n      opportunityCostScore: rounded(score),\n      includeDeckStdDev: rounded(standardDeviation(includeValues)),\n      pairedScenarioStdDev: rounded(pairedStdDev),\n      pairedScenarioStandardError: rounded(pairedStandardError),\n      pairedScenarioCount: pairedDeltas.length,\n    },\n''',
    '''    roleBreakdown: {\n      ...(rating.roleBreakdown ?? {}),\n      opportunityCostScore: rounded(opportunityScore),\n      counterfactualContributionScore: counterfactualBaseline ? rounded(score) : null,\n      includeDeckStdDev: rounded(standardDeviation(includeValues)),\n      pairedScenarioStdDev: rounded(pairedStdDev),\n      pairedScenarioStandardError: rounded(pairedStandardError),\n      pairedScenarioCount: pairedDeltas.length,\n      counterfactualScenarioStdDev: counterfactualBaseline ? rounded(counterfactualStdDev) : null,\n      counterfactualScenarioStandardError: counterfactualBaseline ? rounded(counterfactualStandardError) : null,\n      counterfactualScenarioCount: counterfactualDeltas.length,\n    },\n''',
)

# --- scripts/rate-metagame-v12.mjs ---
insert_after(
    "scripts/rate-metagame-v12.mjs",
    '''  METAGAME_V12_MODEL_VERSION,\n''',
    '''  buildMetagameV12CounterfactualReplacementDecks,\n''',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '''    "機会勝率差", "安定補正後差", "候補勝率", "代替勝率", "候補デッキ", "代替デッキ", "評価状態",\n''',
    '''    "機会勝率差", "安定補正後差", "同一4枠差し替え勝率差", "差し替え安定補正後差",\n    "候補勝率", "代替勝率", "候補デッキ", "代替デッキ", "同一4枠差し替えデッキ", "評価状態",\n''',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '''    character.opportunityWinGain,\n    character.robustOpportunityWinGain,\n    character.candidateExpectedWinRate,\n''',
    '''    character.opportunityWinGain,\n    character.robustOpportunityWinGain,\n    character.counterfactualWinGain ?? "",\n    character.counterfactualRobustWinGain ?? "",\n    character.candidateExpectedWinRate,\n''',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '''    character.bestDeck.names.join(" / "),\n    character.baselineDeck.names.join(" / "),\n    character.evaluationStatus,\n''',
    '''    character.bestDeck.names.join(" / "),\n    character.baselineDeck.names.join(" / "),\n    character.counterfactualReplacementDeck?.names?.join(" / ") ?? "",\n    character.evaluationStatus,\n''',
)
insert_after(
    "scripts/rate-metagame-v12.mjs",
    '''const baselineBeamWidth = positiveInteger(readArgument("baseline-beam-width", "2000"), 2000, 500);\n''',
    '''const replacementDeckLimit = positiveInteger(readArgument("replacement-deck-limit", "12"), 12, 1);\nconst replacementBeamWidth = positiveInteger(readArgument("replacement-beam-width", "4000"), 4000, 500);\n''',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '''const sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);\nconst reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {\n  totalCost: resolvedInput.totalCost,\n});\nfor (const [index, ratings] of reconciledByPosition.entries()) {\n  resultsByPosition[index].clear();\n  for (const rating of ratings) resultsByPosition[index].set(String(rating.id), rating);\n}\nawait saveProgress("complete");\n''',
    '''let sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);\nlet reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {\n  totalCost: resolvedInput.totalCost,\n});\nfunction applyReconciledRatings() {\n  for (const [index, ratings] of reconciledByPosition.entries()) {\n    resultsByPosition[index].clear();\n    for (const rating of ratings) resultsByPosition[index].set(String(rating.id), rating);\n  }\n}\napplyReconciledRatings();\n\n// Audit every rated card around its strongest known complete deck. Four slots\n// are frozen exactly and only the rated slot may change. These are additional\n// targeted battles, not a replay of the expensive candidate probes already in\n// the checkpoint. The cache makes the audit resumable and deduplicates shells\n// shared by multiple ratings.\nlet counterfactualNewEvaluations = 0;\nlet counterfactualCandidateDeckCount = 0;\nfor (const [index, ratings] of resultsByPosition.entries()) {\n  const position = index + 1;\n  for (const rating of ratings.values()) {\n    const replacements = buildMetagameV12CounterfactualReplacementDecks(\n      rating,\n      position,\n      resolvedInput,\n      candidatePools,\n      { replacementDeckLimit, replacementBeamWidth },\n    );\n    counterfactualCandidateDeckCount += replacements.length;\n    for (const entry of replacements) {\n      const key = `${turns}:${entry.deck.map((character) => String(character.id)).join("|")}`;\n      if (evaluationCache.has(key)) continue;\n      evaluationCache.set(key, evaluateMetagameV7Deck(entry.deck, teamScenarios, { turns }));\n      counterfactualNewEvaluations += 1;\n      if (counterfactualNewEvaluations % 50 === 0) await saveProgress();\n    }\n  }\n}\nif (counterfactualNewEvaluations) {\n  await saveProgress();\n  sharedDeckPool = buildMetagameV12SharedDeckPool(evaluationCache, CHARACTER_CATALOG, turns);\n  reconciledByPosition = reconcileMetagameV12RatingsByPosition(resultsByPosition, sharedDeckPool, {\n    totalCost: resolvedInput.totalCost,\n  });\n  applyReconciledRatings();\n}\nawait saveProgress("complete");\n''',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '    objective: "候補キャラ入りの最善デッキと、そのキャラを禁止して同じ総コスト上限で再最適化した最善デッキを比較し、チーム勝率差をキャラ価値とする。",',
    '    objective: "完成デッキの強さを確認した上で、他4枠を固定して対象キャラだけ差し替える反実仮想比較から、そのキャラ自身の実貢献を検証する。",',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '    scoringPolicy: "最終順位に個人攻撃・個人耐久・役割・スキル発動の固定加点を使わない。負のチーム貢献も保持する。",',
    '    scoringPolicy: "同一4枠の差し替え比較を個人貢献の第一根拠にする。強い4人に運ばれたキャラは差し替え安定補正後差が正でなければ上位群へ入れない。差し替え証拠が無い場合だけ従来の全体再最適化機会費用へフォールバックする。",',
)
replace_exact(
    "scripts/rate-metagame-v12.mjs",
    '    performancePolicy: "各候補の直接探索は候補デッキ3本+除外代替3本のまま維持する。全shard統合後に各条件1回だけ全合法候補から共有基準デッキを探索・実戦評価し、そのキャッシュを全キャラの機会費用比較へ再利用する。",',
    '    performancePolicy: "各候補の直接探索と共有基準デッキは既存キャッシュを再利用する。全shard統合後、各キャラの最善完成デッキに対して他4枠固定の差し替え候補を最大12本探索し、未評価の差し替えだけ追加実戦評価する。",',
)
insert_after(
    "scripts/rate-metagame-v12.mjs",
    '''    baselineBeamWidth,\n''',
    '''    replacementDeckLimit,\n    replacementBeamWidth,\n''',
)
insert_after(
    "scripts/rate-metagame-v12.mjs",
    '''    globalBaselineNewEvaluationCount: globalBaselineNewEvaluations,\n''',
    '''    counterfactualCandidateDeckCount,\n    counterfactualNewEvaluationCount: counterfactualNewEvaluations,\n''',
)
insert_after(
    "scripts/rate-metagame-v12.mjs",
    '''console.log(`V12 full opportunity baseline: ${globalBaselineCandidates.length} decks (${globalBaselineNewEvaluations} newly evaluated).`);\n''',
    '''console.log(`V12 matched-slot counterfactuals: ${counterfactualCandidateDeckCount} decks (${counterfactualNewEvaluations} newly evaluated).`);\n''',
)

# --- workflows ---
insert_after(
    ".github/workflows/metagame-v12-shared-pool-recompute.yml",
    '''      - "src/core/metagame-v12.js"\n''',
    '''      - "src/core/metagame-v12-shared-pool.js"\n      - "scripts/rate-metagame-v12.mjs"\n''',
)
replace_exact(
    ".github/workflows/metagame-v12-shared-pool-recompute.yml",
    'ranking_policy="deck-first-complete-deck-v1"',
    'ranking_policy="matched-slot-counterfactual-v2"',
    expected=3,
)
replace_exact(
    ".github/workflows/metagame-v12-shared-pool-recompute.yml",
    'echo "Re-ranking $input_id from its completed evaluated-deck checkpoint; no candidate battles will be replayed."',
    'echo "Re-finalizing $input_id from its completed checkpoint; candidate probes are reused and only missing matched-slot counterfactuals may be evaluated."',
)
replace_exact(
    ".github/workflows/metagame-v12-shared-pool-recompute.yml",
    'echo "Reusing completed battle checkpoint for $input and regenerating only shared-pool reconciliation/ranking."',
    'echo "Reusing completed candidate checkpoint for $input and running matched-slot counterfactual reconciliation."',
)
replace_exact(
    ".github/workflows/metagame-v12-shared-pool-recompute.yml",
    'rankingPolicy:"deck-first-complete-deck-v1"',
    'rankingPolicy:"matched-slot-counterfactual-v2"',
)

replace_exact(
    ".github/workflows/deploy-pages.yml",
    'ranking_policy="deck-first-complete-deck-v1"',
    'ranking_policy="matched-slot-counterfactual-v2"',
)
replace_exact(
    ".github/workflows/deploy-pages.yml",
    'echo "Deploying deck-first V12 shared-pool results."',
    'echo "Deploying matched-slot counterfactual V12 shared-pool results."',
)
replace_exact(
    ".github/workflows/deploy-pages.yml",
    'echo "Deck-first shared-pool Cost100 results are not all published yet; deploying the last complete V12 results."',
    'echo "Counterfactual shared-pool Cost100 results are not all published yet; deploying the last complete V12 results."',
)

print("Applied V12 matched-slot counterfactual contribution fix.")
