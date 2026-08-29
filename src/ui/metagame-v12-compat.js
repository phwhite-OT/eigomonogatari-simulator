const METAGAME_V12_UI_MODEL_VERSION = "team-battle-v12.2-threshold-proxy";

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
      ? `V12.2で全5枠の計算が完了した${data.constraints.length}条件だけを利用しています。未完了の条件は候補生成・対戦に混ぜません。`
      : "V12.2で全5枠が完了した条件はまだありません。";
  }
  if (methodology) {
    methodology.textContent = "V12.2: 候補キャラ入りの最善デッキと、そのキャラを禁止して全5枠を同じ総コスト上限で再最適化した最善デッキを比較。安定補正後の勝率差を枠別順位に使い、その候補から完成デッキを組んで5対5環境へ再投入します。";
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
    metagameUiElement("strong", "", "V12.2 枠別機会価値ランキング"),
    metagameUiElement(
      "small",
      "",
      "候補入り最善デッキと、そのキャラを禁止して全5枠を再最適化した最善代替デッキを比較。安定補正後差を主順位に使います。",
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
          `機会差 ${metagameUiSigned(opportunity * 100)}pt / 安定補正 ${metagameUiSigned(robust * 100)}pt / 候補 ${metagameUiPercent(candidateWin)} / 代替 ${metagameUiPercent(benchmarkWin)} / ${status}`,
        ),
      );
      list.append(row);
    });
    card.append(list);
    grid.append(card);
  });
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
    `V12.2機会勝率差 ${metagameUiSigned((Number.isFinite(opportunity) ? opportunity : 0) * 100)}pt / 安定補正後 ${metagameUiSigned((Number.isFinite(robust) ? robust : opportunity || 0) * 100)}pt`,
    `このキャラを使える最善デッキ ${metagameUiPercent(Number.isFinite(candidateWin) ? candidateWin : rating.expectedWinRate)} / このキャラを禁止して全5枠再最適化 ${metagameUiPercent(Number.isFinite(benchmarkWin) ? benchmarkWin : 0)}`,
  ];
  if (rating?.evaluationStatus) {
    reasons.push(`V12.2評価状態: ${rating.evaluationStatus}${rating.evaluationWarning ? `（${rating.evaluationWarning}）` : ""}`);
  }
  const bestNames = rating?.bestDeck?.names ?? [];
  const baselineNames = rating?.baselineDeck?.names ?? [];
  if (bestNames.length === 5) reasons.push(`V12.2での候補入り最善例: ${bestNames.join(" / ")}`);
  if (baselineNames.length === 5) reasons.push(`候補禁止時の最善代替例: ${baselineNames.join(" / ")}`);
  reasons.push("完成デッキの最終順位は、この枠別機会価値だけで決めず、画面で選んだ環境数へ5対5で再投入した結果で決定します。");
  return reasons;
};

const renderMetagameSimulatorResultBeforeV12 = renderMetagameSimulatorResult;
renderMetagameSimulatorResult = function renderMetagameSimulatorResultV12(container, searchResult, characters) {
  renderMetagameSimulatorResultBeforeV12(container, searchResult, characters);
  if (String(searchResult?.constraint?.modelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION) return;
  const note = container.querySelector(".metagame-result-note");
  if (note) {
    note.textContent = "V12.2の枠別順位は『そのキャラを使える最善デッキ』と『そのキャラを禁止し、空いたコストを含め全5枠を再最適化した最善代替デッキ』の勝率差で作成しています。この画面の完成デッキ順位は、そのV12.2候補を組み合わせた後、選択した4/8/24/全環境へ再投入した5対5結果で決定します。";
  }
};
