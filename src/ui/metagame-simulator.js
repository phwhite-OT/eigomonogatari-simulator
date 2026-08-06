import { attributeClassLabel } from "../data/rules.js";
import { findBestMetagameDeck } from "../core/metagame-deck.js";

function metagameUiElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metagameUiPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function metagameUiSigned(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function metagameUiImpactReasons(character, rating, environment, deck) {
  const reasons = [
    `このキャラを${rating.scenarioCount}盤面で固定評価: 予測勝率 ${metagameUiPercent(rating.expectedWinRate)} / 信頼下限 ${metagameUiPercent(rating.expectedWinLowerBound)}`,
    `スキル有効時と無効時の勝率差 ${metagameUiSigned((Number(rating.skillWinGain) || 0) * 100)}pt / 実発動率 ${metagameUiPercent(rating.skillActivationRate)}`,
    `1盤面あたりの差分: 味方交代抑制 ${metagameUiSigned(rating.allyPreservationNet)} / 敵交代増加 ${metagameUiSigned(rating.enemyRemovalNet)}`,
    `味方維持率 ${metagameUiPercent(rating.allyRetentionRate)} / 敵への進行率 ${metagameUiPercent(rating.enemyPressureRate)}`,
  ];
  if (["delay", "skill_reduction"].includes(character.skill?.type)) {
    reasons.push("短縮・遅延効果は今回の評価対象外です。採用された場合は、通常攻撃・耐久・他枠との組み合わせが主因です。");
  }
  const enemyConditions = (character.skill?.conditions ?? [])
    .filter((condition) => condition.type === "enemy_attribute");
  for (const condition of enemyConditions) {
    const matched = environment.filter((entry) => entry.attributes.includes(condition.attribute));
    const names = matched.slice(0, 4).map((entry) => entry.name).join("、");
    const share = matched.reduce((sum, entry) => sum + Number(entry.projectedUsageShare || 0), 0);
    reasons.push(matched.length
      ? `敵${attributeClassLabel([condition.attribute])}条件が、上位10体では${names}などに一致（表示範囲の合計使用率 ${metagameUiPercent(share)}）`
      : `敵${attributeClassLabel([condition.attribute])}条件は、表示中の使用率上位10体には直接一致していません。`);
  }
  const allyConditions = (character.skill?.conditions ?? [])
    .filter((condition) => condition.type === "ally_attribute");
  for (const condition of allyConditions) {
    const matched = deck.filter((ally) => ally.attributes.includes(condition.attribute));
    reasons.push(`味方${attributeClassLabel([condition.attribute])}条件は、このデッキの${matched.length}/5体に一致: ${matched.map((ally) => ally.name).join("、")}`);
  }
  if (!enemyConditions.length && !allyConditions.length) {
    reasons.push("特定色への条件一致ではなく、全対象または自身への効果として評価されています。");
  }
  return reasons;
}

function metagameUiSlot(character, rating, position, environment, deck) {
  const card = metagameUiElement("article", "metagame-slot-card");
  const number = metagameUiElement("span", "metagame-slot-number", String(position));
  const copy = metagameUiElement("div", "metagame-slot-copy");
  const heading = metagameUiElement("div", "metagame-slot-heading");
  heading.append(
    metagameUiElement("h4", "", character.name),
    metagameUiElement("span", "", `${attributeClassLabel(character.attributes)}・${character.rarity}`),
  );
  const details = metagameUiElement("p", "", `コスト ${character.cost} / スキル ${character.skillTurn}ターン`);
  const skill = metagameUiElement("small", "", character.skillName || "スキルなし");
  const ratingLine = metagameUiElement(
    "small",
    "metagame-slot-rating",
    `枠単体の詳細評価 ${metagameUiPercent(rating.expectedWinRate)}・総合${rating.overallRank}位`,
  );
  const impact = metagameUiElement("details", "metagame-impact");
  impact.append(metagameUiElement("summary", "", "この枠での採用根拠を見る"));
  const reasonList = metagameUiElement("ul", "");
  metagameUiImpactReasons(character, rating, environment, deck).forEach((reason) => (
    reasonList.append(metagameUiElement("li", "", reason))
  ));
  impact.append(reasonList);
  copy.append(heading, details, skill, ratingLine, impact);
  card.append(number, copy);
  return card;
}

function metagameUiEnvironmentAudit(constraint) {
  const section = metagameUiElement("section", "metagame-environment-audit");
  const heading = metagameUiElement("div", "metagame-environment-heading");
  heading.append(
    metagameUiElement("h3", "", "枠ごとの予測環境"),
    metagameUiElement("p", "", "各枠で出現頻度が高いと推定された上位10体です。所持率と枠評価順位から使用率を算出しています。"),
  );
  const grid = metagameUiElement("div", "metagame-environment-grid");
  constraint.slots.forEach((slot) => {
    const card = metagameUiElement("article", "metagame-environment-slot");
    card.append(metagameUiElement("h4", "", `${slot.position}枠目`));
    const list = metagameUiElement("ol", "");
    slot.environment.forEach((entry) => {
      const item = metagameUiElement("li", "");
      const copy = metagameUiElement("span", "");
      copy.append(
        metagameUiElement("strong", "", entry.name),
        metagameUiElement("small", "", `${attributeClassLabel(entry.attributes)}・${entry.rarity}・cost ${entry.cost}`),
      );
      item.append(copy, metagameUiElement("b", "", metagameUiPercent(entry.projectedUsageShare)));
      list.append(item);
    });
    card.append(list);
    grid.append(card);
  });
  section.append(heading, grid);
  return section;
}

function metagameUiResultCard(result, rank, constraint) {
  const card = metagameUiElement("article", `metagame-deck-result${rank === 1 ? " is-best" : ""}`);
  const header = metagameUiElement("header", "metagame-result-header");
  const title = metagameUiElement("div", "");
  title.append(
    metagameUiElement("span", "metagame-result-rank", rank === 1 ? "BEST DECK" : `NEXT ${rank}`),
    metagameUiElement("h3", "", rank === 1 ? "最高予測勝率デッキ" : "次点デッキ"),
  );
  const winRate = metagameUiElement("div", "metagame-win-rate");
  winRate.append(
    metagameUiElement("strong", "", metagameUiPercent(result.expectedWinRate)),
    metagameUiElement("span", "", `信頼下限 ${metagameUiPercent(result.expectedWinLowerBound)}`),
  );
  header.append(title, winRate);
  const summary = metagameUiElement("div", "metagame-result-summary");
  summary.append(
    metagameUiElement("span", "", `総コスト ${result.totalCost} / ${constraint.totalCost}`),
    metagameUiElement("span", "", `勝 ${metagameUiPercent(result.decisiveWinRate)}`),
    metagameUiElement("span", "", `分 ${metagameUiPercent(result.decisiveDrawRate)}`),
    metagameUiElement("span", "", `敗 ${metagameUiPercent(result.decisiveLossRate)}`),
    metagameUiElement("span", "", `継続判定 ${metagameUiPercent(result.ongoingRate)}`),
  );
  const slots = metagameUiElement("div", "metagame-slot-list");
  result.deck.forEach((character, index) => slots.append(
    metagameUiSlot(
      character,
      result.ratings[index],
      index + 1,
      constraint.slots[index].environment,
      result.deck,
    ),
  ));
  card.append(header, summary, slots);
  return card;
}

function renderMetagameSimulatorResult(container, searchResult) {
  container.replaceChildren();
  const overview = metagameUiElement("section", "metagame-result-overview");
  overview.append(
    metagameUiElement("strong", "", searchResult.constraint.label),
    metagameUiElement(
      "span",
      "",
      `${searchResult.candidateDeckCount.toLocaleString("ja-JP")}候補から${searchResult.simulatedDeckCount}デッキを再対戦・各${searchResult.scenarioCount}環境`,
    ),
    metagameUiElement("span", "", `評価モデル ${searchResult.constraint.modelVersion ?? "unknown"}`),
  );
  container.append(overview, metagameUiEnvironmentAudit(searchResult.constraint));
  searchResult.results.forEach((result, index) => container.append(
    metagameUiResultCard(result, index + 1, searchResult.constraint),
  ));
  const note = metagameUiElement("p", "metagame-result-note");
  note.textContent = "採用根拠は、そのキャラを対象枠へ固定した30盤面での差分です。完成デッキの予測勝率は、別途30環境へ再投入して比較しています。引き分けは0.5、12ターンで未決着の場合は残数と残HPから勝利見込みを算出します。";
  container.append(note);
}

function renderSurveyedMetagameConstraints(container, constraints, selectedId) {
  container.replaceChildren();
  const heading = metagameUiElement("div", "metagame-surveyed-heading");
  heading.append(
    metagameUiElement("strong", "", "実装済みの環境"),
    metagameUiElement("span", "", constraints.length + "縛り・各5枠を選択して確認できます"),
  );
  const list = metagameUiElement("div", "metagame-surveyed-list");
  constraints.forEach((constraint) => {
    const button = metagameUiElement(
      "button",
      "metagame-surveyed-constraint" + (constraint.id === selectedId ? " is-active" : ""),
    );
    button.type = "button";
    button.dataset.metagameSurveyedConstraint = constraint.id;
    button.setAttribute("aria-pressed", String(constraint.id === selectedId));
    const environmentCount = constraint.slots[0]?.environment.length ?? 0;
    button.append(
      metagameUiElement("strong", "", constraint.label),
      metagameUiElement(
        "small",
        "",
        "5枠・各上位" + environmentCount + "体・" + constraint.scenarioCount + "環境",
      ),
    );
    list.append(button);
  });
  container.append(heading, list);
}
function renderMetagameEnvironmentPreview(container, constraint) {
  container.replaceChildren();
  if (!constraint) {
    container.append(metagameUiElement("p", "metagame-environment-preview-empty", "調査済みの環境データはありません。"));
    return;
  }
  container.append(metagameUiEnvironmentAudit(constraint));
}
function renderMetagameSimulatorMessage(container, message, error = false) {
  container.replaceChildren(metagameUiElement(
    "section",
    `metagame-simulator-message${error ? " is-error" : ""}`,
    message,
  ));
}

export function initializeMetagameSimulator(root, data, characters) {
  const form = root.querySelector("[data-metagame-form]");
  const select = form.elements.metagameConstraint;
  const submitButton = form.querySelector("[data-metagame-submit]");
  const cancelButton = form.querySelector("[data-metagame-cancel]");
  const status = root.querySelector("[data-metagame-data-status]");
  const progress = root.querySelector("[data-metagame-sim-progress]");
  const progressLabel = progress.querySelector("[data-metagame-progress-label]");
  const progressValue = progress.querySelector("[data-metagame-progress-value]");
  const progressBar = progress.querySelector("[data-metagame-progress-bar]");
  const resultRoot = root.querySelector("[data-metagame-result]");
  const previewStatus = root.querySelector("[data-metagame-environment-preview-status]");
  const previewContent = root.querySelector("[data-metagame-environment-preview-content]");
  const surveyedConstraints = root.querySelector("[data-metagame-surveyed-constraints]");
  let abortController = null;

  select.replaceChildren();
  for (const constraint of data.constraints) {
    const option = document.createElement("option");
    option.value = constraint.id;
    option.textContent = constraint.label;
    select.append(option);
  }
  status.textContent = data.constraints.length
    ? `利用可能 ${data.constraints.length}縛り / 評価完了 ${data.sourceCompletedRuns}/${data.sourceTotalRuns} / ${data.sourceIsLegacy ? "旧評価v2（v3再計算中）" : "攻守均衡v3"}`
    : "利用可能な調査完了済み縛りがありません";
  submitButton.disabled = data.constraints.length === 0;
  const updateEnvironmentPreview = () => {
    const constraint = data.constraints.find((entry) => entry.id === select.value);
    previewStatus.textContent = constraint
      ? `${constraint.scenarioCount}盤面・各枠の予測使用率 上位10体`
      : "調査済み環境なし";
    renderMetagameEnvironmentPreview(previewContent, constraint);
    renderSurveyedMetagameConstraints(surveyedConstraints, data.constraints, constraint?.id);
  };
  updateEnvironmentPreview();
  select.addEventListener("change", updateEnvironmentPreview);
  surveyedConstraints.addEventListener("click", (event) => {
    const button = event.target.closest("[data-metagame-surveyed-constraint]");
    if (!button || button.disabled) return;
    select.value = button.dataset.metagameSurveyedConstraint;
    updateEnvironmentPreview();
  });
  renderMetagameSimulatorMessage(
    resultRoot,
    data.constraints.length
      ? "縛りを選び、「最高勝率デッキを計算」を押してください。"
      : "枠別メタ環境評価が1縛り分完了すると利用できます。",
  );

  const setBusy = (busy) => {
    submitButton.disabled = busy || data.constraints.length === 0;
    select.disabled = busy;
    surveyedConstraints.querySelectorAll("[data-metagame-surveyed-constraint]").forEach((button) => {
      button.disabled = busy;
    });
    cancelButton.hidden = !busy;
    progress.hidden = !busy;
  };

  cancelButton.addEventListener("click", () => abortController?.abort());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    abortController = new AbortController();
    setBusy(true);
    renderMetagameSimulatorMessage(resultRoot, "合法デッキを組み合わせ、調査済み環境で再対戦しています。");
    try {
      const searchResult = await findBestMetagameDeck(data, select.value, characters, {
        signal: abortController.signal,
        onProgress: ({ phase, completed, total, valid }) => {
          const ratio = total > 0 ? completed / total : 0;
          progressLabel.textContent = phase === "candidate" ? "候補デッキを生成" : "完成デッキを再対戦";
          progressValue.textContent = phase === "candidate"
            ? valid ? `${valid.toLocaleString("ja-JP")}候補` : "組み合わせ中"
            : `${completed} / ${total}`;
          progressBar.style.width = `${Math.round(ratio * 100)}%`;
        },
      });
      renderMetagameSimulatorResult(resultRoot, searchResult);
    } catch (error) {
      renderMetagameSimulatorMessage(
        resultRoot,
        error.name === "AbortError" ? "シミュレーションを中止しました。" : error.message,
        error.name !== "AbortError",
      );
    } finally {
      abortController = null;
      setBusy(false);
    }
  });
}
