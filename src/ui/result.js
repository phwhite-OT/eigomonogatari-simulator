import { attributeClassLabel } from "../data/rules.js";

﻿const METRIC_LABELS = {
  opener: "初手安定度",
  attack: "攻撃性能",
  defense: "防御性能",
  skillConnection: "スキル接続",
  lateGame: "終盤性能",
  stability: "安定性",
  simulation: "対戦再現",
};

const SKILL_LABELS = {
  single_attack: "単体攻撃",
  aoe_attack: "全体攻撃",
  multi_hit_attack: "連続攻撃",
  attack_buff: "攻撃強化",
  damage_reduction: "防御強化",
  guard: "かばう・かわす",
  attribute_guard: "属性かばう",
  heal: "回復",
  revive: "蘇生",
  attribute_change: "属性変更",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatScore(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

function sideLabel(side) {
  return side === "allies" ? "味方" : "敵";
}

function metricBar(key, value) {
  const row = element("div", "metric-row");
  const label = element("span", "metric-label", METRIC_LABELS[key]);
  const track = element("span", "metric-track");
  const fill = element("span", "metric-fill");
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  track.append(fill);
  const score = element("strong", "metric-score", formatScore(value));
  row.append(label, track, score);
  return row;
}

function renderSlot(slot) {
  const card = element("article", "slot-card");
  const position = element("div", "slot-position", String(slot.position));
  const content = element("div", "slot-content");
  const heading = element("div", "slot-heading");
  const name = element("h4", "slot-name", slot.character.name);
  const meta = element(
    "span",
    "slot-meta",
    `${attributeClassLabel(slot.character.attributes)} · ${slot.character.rarity} · cost ${slot.character.cost}`,
  );
  heading.append(name, meta);
  const reasons = element("ul", "reason-list");
  for (const reason of slot.reasons) reasons.append(element("li", "", reason));
  content.append(heading, reasons);
  card.append(position, content);
  return card;
}

function renderAlternative(alternative) {
  const item = element("li", "alternative-item");
  item.append(
    element("span", "alternative-position", `${alternative.position}枠目`),
    element("span", "", `${alternative.from.name} → ${alternative.to.name}`),
    element("strong", "", `評価 ${formatScore(alternative.score)}`),
  );
  return item;
}

function supportChangeText(change) {
  if (change.revived) return `${change.targetName}を蘇生`;
  if (change.hpBefore !== undefined) return `${change.targetName} HP ${Math.round(change.hpBefore)}→${Math.round(change.hpAfter)}`;
  if (change.attributesAfter) return `${change.targetName} ${attributeClassLabel(change.attributesBefore)}→${attributeClassLabel(change.attributesAfter)}`;
  if (change.buffAdded) return `${change.targetName}へ${SKILL_LABELS[change.buffAdded] ?? change.buffAdded}`;
  return change.targetName;
}

function traceEventText(event) {
  const actor = event.actorName ? `${sideLabel(event.side)}P${event.actorIndex + 1} ${event.actorName}` : "";
  if (event.type === "skill_use" || event.type === "skill_hold") {
    const action = event.type === "skill_use" ? "使用" : "温存";
    return `${actor}: ${SKILL_LABELS[event.skillType] ?? event.skillType}を${action} — ${event.reason}`;
  }
  if (event.type === "skill_effect") {
    const changes = event.changes.map(supportChangeText).join("、") || "対象なし";
    return `${actor}: ${SKILL_LABELS[event.skillType] ?? event.skillType} → ${changes}`;
  }
  if (event.type === "attack") {
    if (!event.hits.length) return `${actor}: 攻撃対象なし`;
    const hits = event.hits.map((hit) => (
      `${sideLabel(event.side === "allies" ? "enemies" : "allies")}P${hit.targetIndex + 1} ${hit.targetName}へ${Math.round(hit.damage)} ` +
      `(HP ${Math.round(hit.hpBefore)}→${Math.round(hit.hpAfter)})${hit.defeated ? " 撃破" : ""}${hit.redirected ? " かばう発動" : ""}`
    )).join(" / ");
    return `${actor}: ${event.action === "attack_skill" ? SKILL_LABELS[event.skillType] : event.action === "ghost_attack" ? "幽霊攻撃" : "通常攻撃"} — ${hits}`;
  }
  if (event.type === "replacement") {
    return `${sideLabel(event.side)}P${event.playerIndex + 1}: ${event.from}から${event.to}へ交代`;
  }
  if (event.type === "ghost") {
    return `${sideLabel(event.side)}P${event.playerIndex + 1}: ${event.from}が倒れ、幽霊化`;
  }
  return event.type;
}

const DAMAGE_FACTOR_LABELS = Object.freeze([
  ["pow", "POW"],
  ["skill", "スキル倍率"],
  ["attack", "攻撃バフ"],
  ["self", "自分補正"],
  ["excellent", "Excellent"],
  ["questionLevel", "問題レベル"],
  ["attribute", "属性相性"],
  ["event", "イベント"],
  ["special", "特殊補正"],
  ["random", "乱数設定"],
  ["pvp", "対戦補正"],
  ["survival", "生存補正"],
  ["defense", "防御補正"],
]);

const ATTRIBUTE_LABELS = Object.freeze({
  fire: "火",
  water: "水",
  wind: "風",
  neutral: "無",
});

function formatDamageFactor(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "?";
  return numeric.toLocaleString("ja-JP", { maximumFractionDigits: 6 });
}

function resolveDamageRaw(hit) {
  const explicitRaw = Number(hit.damageRaw);
  if (Number.isFinite(explicitRaw)) return explicitRaw;
  const values = Object.values(hit.factors ?? {}).map(Number);
  return values.length && values.every(Number.isFinite)
    ? values.reduce((product, value) => product * value, 1)
    : undefined;
}

function formatAttributeMultiplier(value) {
  const numeric = Number(value);
  const fractions = [
    [1 / 3, "1/3"],
    [1 / 2, "1/2"],
    [2 / 3, "2/3"],
    [3 / 4, "3/4"],
    [5 / 6, "5/6"],
    [1, "1"],
  ];
  const fraction = fractions.find(([expected]) => Math.abs(numeric - expected) < 1e-9);
  return fraction ? `${fraction[1]}（${formatDamageFactor(numeric)}）` : formatDamageFactor(numeric);
}

function attributeFormulaText(attribute) {
  if (!attribute?.pairs?.length) return "";
  const attributes = (values) => values.map((value) => ATTRIBUTE_LABELS[value] ?? value).join("・");
  const pairTerms = attribute.pairs.map((pair) => (
    `${ATTRIBUTE_LABELS[pair.attack] ?? pair.attack}→${ATTRIBUTE_LABELS[pair.defense] ?? pair.defense} ${formatAttributeMultiplier(pair.multiplier)}`
  ));
  const operator = attribute.resolution === "average"
    ? `）÷${attribute.pairs.length}`
    : "）";
  return `属性：攻撃 ${attributes(attribute.attacks)} ／ 防御 ${attributes(attribute.defenses)}。` +
    `（${pairTerms.join(" ＋ ")}${operator} = ${formatAttributeMultiplier(attribute.multiplier)}`;
}

function factorBreakdownText(key, label, value, hit) {
  if (key === "survival") {
    const turns = Math.max(0, Number(hit.survivalTurns) || 0);
    const base = Number(hit.survivalBaseMultiplier) || 1.3;
    return `${label} ${formatDamageFactor(value)}（${formatDamageFactor(base)}^${turns}、${turns}ターン生存）`;
  }
  if (key === "attribute") return `${label} ${formatAttributeMultiplier(value)}`;
  return `${label} ${formatDamageFactor(value)}`;
}

function renderDamageFormula(hit, hitIndex) {
  if (!hit.factors || !Object.keys(hit.factors).length) return null;
  const details = element("details", "damage-formula");
  details.append(element("summary", "", `ヒット${hitIndex + 1}のダメージ式を見る`));

  const factors = DAMAGE_FACTOR_LABELS
    .filter(([key]) => Object.hasOwn(hit.factors, key))
    .map(([key, label]) => factorBreakdownText(key, label, hit.factors[key], hit));
  const equation = DAMAGE_FACTOR_LABELS
    .filter(([key]) => Object.hasOwn(hit.factors, key))
    .map(([key]) => formatDamageFactor(hit.factors[key]))
    .join(" × ");
  const raw = resolveDamageRaw(hit);
  const rounding = hit.rounding === "ceil"
    ? "切り上げ"
    : hit.rounding === "round"
      ? "四捨五入"
      : "切り捨て";

  const formula = element("p", "damage-formula-equation");
  formula.textContent = raw === undefined
    ? `${equation} → ${rounding} = ${formatDamageFactor(hit.damage)}`
    : `${equation} = ${formatDamageFactor(raw)} → ${rounding} = ${formatDamageFactor(hit.damage)}`;
  const breakdown = element("p", "damage-formula-breakdown", factors.join(" ／ "));
  const attributeDetail = attributeFormulaText(hit.attribute);
  if (attributeDetail) details.append(formula, breakdown, element("p", "damage-formula-breakdown", attributeDetail));
  else details.append(formula, breakdown);
  return details;
}

function renderTraceEvent(event) {
  const item = element("li", "", traceEventText(event));
  if (event.type === "attack") {
    event.hits.forEach((hit, index) => {
      const formula = renderDamageFormula(hit, index);
      if (formula) item.append(formula);
    });
  }
  return item;
}

export function renderSimulationTrace(trace) {
  const section = element("section", "insight-panel simulation-trace");
  section.append(element("h4", "", `対戦処理ログ：${trace.profileName}`));
  section.append(element(
    "p",
    "trace-note",
    trace.note ?? "推薦デッキを味方P2として配置し、他の味方4人と敵5人は代表値で再現しています。実デッキ同士の勝率ではありません。",
  ));
  const assumptions = element("details", "trace-assumptions");
  assumptions.append(element("summary", "", "シミュレーションの仮定を見る"));
  const assumptionList = element("ul", "reason-list");
  trace.assumptions.forEach((assumption) => assumptionList.append(element("li", "", assumption)));
  assumptions.append(assumptionList);
  section.append(assumptions);

  const turns = element("div", "simulation-turns");
  trace.history.forEach((turn) => {
    const turnDetails = element("details", "simulation-turn");
    const counts = `味方 ${turn.allies.remainingByPlayer.join("/")} · 敵 ${turn.enemies.remainingByPlayer.join("/")}`;
    turnDetails.append(element("summary", "", `TURN ${turn.turn} — ${counts}`));
    const phaseList = element("div", "phase-list");
    turn.phases.forEach((phase) => {
      if (!phase.events.length) return;
      const phaseBlock = element("section", "phase-block");
      phaseBlock.append(element("strong", "phase-label", phase.label));
      const eventList = element("ul", "trace-event-list");
      phase.events.forEach((event) => eventList.append(renderTraceEvent(event)));
      phaseBlock.append(eventList);
      phaseList.append(phaseBlock);
    });
    turnDetails.append(phaseList);
    turns.append(turnDetails);
  });
  section.append(turns);
  return section;
}

function renderResultCard(result, rank, totalCostLimit) {
  const card = element("article", "result-card");
  if (rank === 1) card.classList.add("result-card-featured");
  const summary = element("div", "result-summary");
  const rankBlock = element("div", "rank-block");
  rankBlock.append(element("span", "rank-label", "RANK"), element("strong", "rank-number", String(rank).padStart(2, "0")));
  const deckNames = element("div", "deck-name-list");
  result.deck.forEach((character, index) => {
    const chip = element("span", "deck-name-chip", `${index + 1} ${character.name}`);
    chip.title = `ID: ${character.id}`;
    deckNames.append(chip);
  });
  const score = element("div", "overall-score");
  score.style.setProperty("--score", result.score);
  score.append(element("strong", "", formatScore(result.score)), element("span", "", "総合評価"));
  summary.append(rankBlock, deckNames, score);

  const costLine = element("div", "cost-line");
  costLine.append(
    element("span", "", `総コスト ${result.totalCost} / ${totalCostLimit}`),
    element("span", "", `余裕 ${Math.max(0, totalCostLimit - result.totalCost)}`),
  );
  const metrics = element("div", "metric-grid");
  for (const [key, value] of Object.entries(result.metrics)) metrics.append(metricBar(key, value));

  const details = element("details", "result-details");
  const detailsSummary = element("summary", "details-toggle", "採用理由・対戦処理・弱点を見る");
  const detailsBody = element("div", "details-body");
  const slots = element("div", "slot-list");
  result.slots.forEach((slot) => slots.append(renderSlot(slot)));
  const weaknessSection = element("section", "insight-panel insight-warning");
  weaknessSection.append(element("h4", "", "確認したい弱点"));
  const weaknesses = element("ul", "reason-list");
  result.weaknesses.forEach((weakness) => weaknesses.append(element("li", "", weakness)));
  weaknessSection.append(weaknesses);
  detailsBody.append(slots);
  if (result.simulationTrace) detailsBody.append(renderSimulationTrace(result.simulationTrace));
  detailsBody.append(weaknessSection);

  if (result.alternatives.length) {
    const alternativeSection = element("section", "insight-panel");
    alternativeSection.append(element("h4", "", "1体入れ替え候補"));
    const alternatives = element("ul", "alternative-list");
    result.alternatives.forEach((alternative) => alternatives.append(renderAlternative(alternative)));
    alternativeSection.append(alternatives);
    detailsBody.append(alternativeSection);
  }
  details.append(detailsSummary, detailsBody);
  card.append(summary, costLine, metrics, details);
  return card;
}

export function renderIdle(container) {
  container.replaceChildren();
  const empty = element("section", "empty-state");
  empty.append(
    element("span", "empty-orbit", "5"),
    element("h2", "", "条件を決めて、候補を探索"),
    element("p", "", "最低保証ダメージ、配置適性、残りキャラ数、スキル接続を使い、処理ログ付きで5体デッキを推薦します。"),
  );
  container.append(empty);
}

export function renderError(container, messages) {
  container.replaceChildren();
  const panel = element("section", "message-panel message-error");
  panel.append(element("h2", "", "探索を開始できませんでした"));
  const list = element("ul", "reason-list");
  for (const message of messages) list.append(element("li", "", message));
  panel.append(list);
  container.append(panel);
}

export function renderCancelled(container) {
  container.replaceChildren();
  const panel = element("section", "message-panel");
  panel.append(element("h2", "", "探索をキャンセルしました"), element("p", "", "条件を調整して、いつでも再開できます。"));
  container.append(panel);
}

export function renderResults(container, searchResult) {
  container.replaceChildren();
  if (!searchResult.results.length) {
    renderError(container, ["有効なデッキ候補を生成できませんでした。コスト上限や固定配置を緩めてください。"]);
    return;
  }

  const header = element("section", "result-header");
  const headingGroup = element("div", "");
  headingGroup.append(
    element("span", "eyebrow", "RECOMMENDATIONS"),
    element("h2", "", `${searchResult.results.length}件を詳細評価`),
    element(
      "p",
      "",
      `${searchResult.stats.generated.toLocaleString("ja-JP")}回生成 · ${searchResult.stats.unique.toLocaleString("ja-JP")}件の固有候補 · ${(searchResult.stats.elapsedMs / 1000).toFixed(1)}秒`,
    ),
  );
  const filterSummary = element("div", "filter-summary");
  filterSummary.append(
    element("span", "", `候補 ${searchResult.candidates.length.toLocaleString("ja-JP")}体`),
    element("span", "", `上限 ${searchResult.constraints.totalCost}`),
    element("span", "", searchResult.constraints.mode),
    element("span", "", "ST: 2枠1〜2・3枠2〜3・4枠3〜4・5枠4〜5"),
  );
  header.append(headingGroup, filterSummary);

  const exclusionDetails = element("details", "exclusion-details");
  exclusionDetails.append(element("summary", "", "探索前フィルタの内訳"));
  const exclusionList = element("div", "exclusion-list");
  for (const [reason, count] of Object.entries(searchResult.excludedCounts)) {
    exclusionList.append(element("span", "", `${reason} ${count.toLocaleString("ja-JP")}`));
  }
  exclusionDetails.append(exclusionList);

  const resultList = element("div", "result-list");
  let visibleCount = Math.min(20, searchResult.results.length);
  const draw = () => {
    resultList.replaceChildren();
    searchResult.results.slice(0, visibleCount).forEach((result, index) => {
      resultList.append(renderResultCard(result, index + 1, searchResult.constraints.totalCost));
    });
  };
  draw();
  container.append(header, exclusionDetails, resultList);

  if (visibleCount < searchResult.results.length) {
    const moreButton = element("button", "button button-secondary load-more", "さらに20件表示");
    moreButton.type = "button";
    moreButton.addEventListener("click", () => {
      visibleCount = Math.min(searchResult.results.length, visibleCount + 20);
      draw();
      if (visibleCount >= searchResult.results.length) moreButton.remove();
    });
    container.append(moreButton);
  }
}

export function updateProgress(progressRoot, progress) {
  progressRoot.hidden = false;
  const ratio = progress.total ? progress.current / progress.total : 0;
  progressRoot.querySelector("[data-progress-bar]").style.width = `${Math.min(100, ratio * 100)}%`;
  progressRoot.querySelector("[data-progress-label]").textContent = progress.phase === "detail" ? "上位候補を詳細評価中" : "デッキ候補を生成中";
  progressRoot.querySelector("[data-progress-value]").textContent = `${progress.current.toLocaleString("ja-JP")} / ${progress.total.toLocaleString("ja-JP")}`;
  progressRoot.querySelector("[data-progress-valid]").textContent = `有効候補 ${progress.valid.toLocaleString("ja-JP")}`;
}

