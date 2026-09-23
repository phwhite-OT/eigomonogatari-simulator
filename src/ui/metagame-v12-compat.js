const METAGAME_V12_UI_MODEL_VERSION = "team-battle-v12.5-effective-damage-individual-rank";

const metagameUiHasCurrentSkillEvidenceBeforeV12 = metagameUiHasCurrentSkillEvidence;
metagameUiHasCurrentSkillEvidence = function metagameUiHasCurrentV12Evidence(data) {
  return String(data?.sourceModelVersion ?? "") === METAGAME_V12_UI_MODEL_VERSION
    || metagameUiHasCurrentSkillEvidenceBeforeV12(data);
};

const metagameUiCalculationStateBeforeV12 = metagameUiCalculationState;
metagameUiCalculationState = function metagameUiCalculationStateV12(data) {
  if (String(data?.sourceModelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION) {
    return metagameUiCalculationStateBeforeV12(data);
  }
  return {
    complete: "完了",
    in_progress: "計算中",
    paused: "完了済み条件を公開中",
  }[data.sourceStatus] ?? "集計済み";
};

const renderMetagameCalculationStatusBeforeV12 = renderMetagameCalculationStatus;
renderMetagameCalculationStatus = function renderMetagameCalculationStatusV12(container, data) {
  renderMetagameCalculationStatusBeforeV12(container, data);
  if (String(data?.sourceModelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION) return;
  const note = container.querySelector(".metagame-calculation-note");
  const methodology = container.querySelector(".metagame-calculation-methodology");
  if (note) {
    note.textContent = data.constraints.length
      ? `V12で全5枠の計算が完了した${data.constraints.length}条件だけを利用しています。未完了の条件は候補生成・対戦に混ぜません。`
      : "V12で全5枠が完了した条件はまだありません。";
  }
  if (methodology) {
    methodology.textContent = "V12: 単体貢献は候補キャラ入り最善デッキと、そのキャラを禁止して全5枠を再最適化した最善代替デッキで比較します。さらに強い完成デッキ同士の対策→対策返しを反復し、均衡採用率・均衡環境勝率・対策依存度も別軸で表示します。";
  }
};

const renderMetagameDebugRankingsBeforeV12 = renderMetagameDebugRankings;
renderMetagameDebugRankings = function renderMetagameDebugRankingsV12(container, constraint) {
  if (String(constraint?.modelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION) {
    renderMetagameDebugRankingsBeforeV12(container, constraint);
    return;
  }
  container.replaceChildren();
  const rankings = (constraint?.slots ?? []).map((slot) => (
    slot.debugRankings ?? slot.candidates?.slice(0, 12) ?? []
  ));
  const heading = metagameUiElement("div", "metagame-debug-rankings-heading");
  heading.append(
    metagameUiElement("strong", "", "V12 枠別ランキング（単体貢献＋均衡メタ）"),
    metagameUiElement(
      "small",
      "",
      "単体貢献順位は全5枠再最適化の機会差、均衡メタ順位は対策循環が落ち着いた最終採用率です。どちらか一方だけで「最強」とは扱いません。",
    ),
  );
  const grid = metagameUiElement("div", "metagame-debug-ranking-grid");
  rankings.forEach((entries, index) => {
    const card = metagameUiElement("section", "metagame-debug-ranking-slot");
    card.append(metagameUiElement("h3", "", `${index + 1}枠目 上位`));
    const list = metagameUiElement("ol", "metagame-debug-ranking-list");
    entries.forEach((entry) => {
      const row = metagameUiElement("li", "");
      const opportunity = Number(entry.opportunityWinGain ?? entry.marginalWinGain);
      const robust = Number(entry.robustOpportunityWinGain ?? entry.marginalWinGainLowerBound);
      const candidateWin = Number(entry.candidateExpectedWinRate ?? entry.expectedWinRate);
      const benchmarkWin = Number(entry.benchmarkExpectedWinRate ?? entry.baselineExpectedWinRate);
      const status = entry.evaluationStatus === "partial-skill-support"
        ? "遅延/短縮は部分対応"
        : entry.evaluationStatus === "complete"
          ? "評価完了"
          : String(entry.evaluationStatus ?? "評価済み");
      row.append(
        metagameUiElement("strong", "", entry.name ?? entry.id),
        metagameUiElement("span", "", `${attributeClassLabel(entry.attributes)}・C${entry.cost}・${entry.skillTurn}T`),
        metagameUiElement(
          "small",
          "",
          `${entry.equilibriumRank ? `均衡 #${entry.equilibriumRank}・採用 ${metagameUiPercent(Number(entry.equilibriumUsageRate) || 0)}・環境勝率 ${metagameUiPercent(Number(entry.equilibriumExpectedWinRate) || 0)}・対策依存 ${metagameUiSigned((Number(entry.equilibriumMetaDependency) || 0) * 100)}pt / ` : ""}機会差 ${metagameUiSigned(opportunity * 100)}pt / 安定補正 ${metagameUiSigned(robust * 100)}pt / 候補 ${metagameUiPercent(candidateWin)} / 代替 ${metagameUiPercent(benchmarkWin)} / ${status}`,
        ),
      );
      list.append(row);
    });
    card.append(list);
    grid.append(card);
  });
  const equilibrium = constraint?.equilibrium;
  if (Array.isArray(equilibrium?.decks) && equilibrium.decks.length) {
    const equilibriumCard = metagameUiElement("section", "metagame-debug-ranking-slot");
    const convergence = equilibrium.converged ? "均衡収束" : "近似均衡";
    equilibriumCard.append(metagameUiElement(
      "h3",
      "",
      `最終メタ 上位デッキ（${convergence} / exploitability ${(Number(equilibrium.exploitability) * 100).toFixed(2)}pt）`,
    ));
    const equilibriumList = metagameUiElement("ol", "metagame-debug-ranking-list");
    equilibrium.decks.slice(0, 12).forEach((deck) => {
      const row = metagameUiElement("li", "");
      const dependencyTarget = deck.dependencyTargetNames?.length
        ? ` / 主な依存先 ${deck.dependencyTargetNames.join(" / ")}`
        : "";
      row.append(
        metagameUiElement("strong", "", `#${deck.rank ?? "-"} ${(deck.names ?? []).join(" / ")}`),
        metagameUiElement("span", "", `C${deck.totalCost}・均衡採用 ${metagameUiPercent(Number(deck.usageRate) || 0)}`),
        metagameUiElement(
          "small",
          "",
          `最終環境勝率 ${metagameUiPercent(Number(deck.expectedWinRate) || 0)} / 対策依存 ${metagameUiSigned((Number(deck.metaDependency) || 0) * 100)}pt${dependencyTarget}`,
        ),
      );
      equilibriumList.append(row);
    });
    equilibriumCard.append(equilibriumList);
    grid.prepend(equilibriumCard);
  }
  container.append(heading, grid);
};

const metagameUiImpactReasonsBeforeV12 = metagameUiImpactReasons;
metagameUiImpactReasons = function metagameUiImpactReasonsV12(character, rating, environment, deck) {
  const robust = Number(rating?.robustOpportunityWinGain ?? rating?.marginalWinGainLowerBound);
  const opportunity = Number(rating?.opportunityWinGain ?? rating?.marginalWinGain);
  const candidateWin = Number(rating?.candidateExpectedWinRate);
  const benchmarkWin = Number(rating?.benchmarkExpectedWinRate ?? rating?.baselineExpectedWinRate);
  if (![robust, opportunity, candidateWin, benchmarkWin].some(Number.isFinite)) {
    return metagameUiImpactReasonsBeforeV12(character, rating, environment, deck);
  }
  const reasons = [
    `V12機会勝率差 ${metagameUiSigned((Number.isFinite(opportunity) ? opportunity : 0) * 100)}pt / 安定補正後 ${metagameUiSigned((Number.isFinite(robust) ? robust : opportunity || 0) * 100)}pt`,
    `このキャラを使える最善デッキ ${metagameUiPercent(Number.isFinite(candidateWin) ? candidateWin : rating.expectedWinRate)} / このキャラを禁止して全5枠再最適化 ${metagameUiPercent(Number.isFinite(benchmarkWin) ? benchmarkWin : 0)}`,
  ];
  if (Number(rating?.equilibriumRank) > 0) {
    const dependencyTarget = rating?.equilibriumDependencyTarget?.length
      ? ` / 主な依存先: ${rating.equilibriumDependencyTarget.join(" / ")}`
      : "";
    reasons.push(
      `均衡メタ #${rating.equilibriumRank}: 採用率 ${metagameUiPercent(Number(rating.equilibriumUsageRate) || 0)} / 最終環境勝率 ${metagameUiPercent(Number(rating.equilibriumExpectedWinRate) || 0)} / 対策依存 ${metagameUiSigned((Number(rating.equilibriumMetaDependency) || 0) * 100)}pt${dependencyTarget}`,
    );
  }
  if (rating?.evaluationStatus) {
    reasons.push(`V12評価状態: ${rating.evaluationStatus}${rating.evaluationWarning ? `（${rating.evaluationWarning}）` : ""}`);
  }
  const bestNames = rating?.bestDeck?.names ?? [];
  const baselineNames = rating?.baselineDeck?.names ?? [];
  if (bestNames.length === 5) reasons.push(`V12での候補入り最善例: ${bestNames.join(" / ")}`);
  if (baselineNames.length === 5) reasons.push(`候補禁止時の最善代替例: ${baselineNames.join(" / ")}`);
  reasons.push("単体貢献と均衡メタは別物です。特定デッキへの対策だけで強い構成は、その標的の採用率が下がると均衡採用率も自然に下がります。");
  return reasons;
};

const findBestMetagameDeckBeforeV12Cache = findBestMetagameDeck;
findBestMetagameDeck = async function findBestMetagameDeckV12Cache(data, constraintId, characters, options = {}) {
  const requestedTotalCost = Number(options.totalCost);
  const costMode = options.costMode === "exact" ? "exact" : "at_most";
  const constraint = { ...resolveMetagameConstraint(data, constraintId, requestedTotalCost), costMode };
  if (String(constraint?.modelVersion ?? "") === METAGAME_V12_UI_MODEL_VERSION) {
    const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
    const automaticIds = normalizeMetagameBoostedCharacterIds(options.automaticCharacterIds);
    const canReusePublishedDecks = !constraint.interpolation
      && !boostedIds.size
      && !automaticIds.size
      && Array.isArray(constraint.precomputedDecks)
      && constraint.precomputedDecks.length > 0;
    if (canReusePublishedDecks) {
      const fixedSlots = metagameFixedSlots(options.fixedSlots);
      const precomputed = metagameV8PrecomputedResults(constraint, characters, fixedSlots);
      if (precomputed.length) {
        options.onProgress?.({
          phase: "candidate",
          completed: 5,
          total: 5,
          slot: 5,
          slots: 5,
          checked: precomputed.length,
          stageTotal: precomputed.length,
          retained: precomputed.length,
          valid: precomputed.length,
        });
        return {
          constraint,
          generatedAt: data.generatedAt,
          candidateDeckCount: precomputed.length,
          simulatedDeckCount: 0,
          scenarioCount: Number(precomputed[0]?.scenarioCount) || Number(constraint.scenarioCount) || 0,
          boostedCharacterIds: [],
          automaticCharacterIds: [],
          usedPrecomputedDeckCache: true,
          results: precomputed.slice(0, 3).map((candidate) => ({
            ...candidate,
            usedPrecomputedDeckCache: true,
          })),
        };
      }
    }
  }
  return findBestMetagameDeckBeforeV12Cache(data, constraintId, characters, options);
};

const renderMetagameSimulatorResultBeforeV12 = renderMetagameSimulatorResult;
renderMetagameSimulatorResult = function renderMetagameSimulatorResultV12(container, searchResult, characters) {
  renderMetagameSimulatorResultBeforeV12(container, searchResult, characters);
  if (String(searchResult?.constraint?.modelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION) return;
  const note = container.querySelector(".metagame-result-note");
  if (note) {
    note.textContent = searchResult.usedPrecomputedDeckCache
      ? `この結果はV12で既に実戦評価済みの完成デッキを再利用しています。ブラウザ側の候補ビーム探索と再対戦は行っていません（事前評価 ${searchResult.scenarioCount}環境）。補正キャラ・新規編集キャラ・未計算コスト・保存済み候補にない固定条件を指定した場合だけ再計算します。`
      : "V12の枠別順位は『そのキャラを使える最善デッキ』と『そのキャラを禁止し、空いたコストを含め全5枠を再最適化した最善代替デッキ』の勝率差で作成しています。この画面の完成デッキ順位は、そのV12候補を組み合わせた後、選択した環境へ再投入した5対5結果で決定します。";
  }
};
