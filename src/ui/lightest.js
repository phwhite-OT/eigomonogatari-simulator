import { attributeClassLabel } from "../data/rules.js";
import { createCharacterSearchIndex, searchCharacters } from "../core/character-search.js";
import {
  findLightestDeck,
  resolveLightestEnemy,
} from "../core/lightest.js";

function lightestElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lightestPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function splitValues(value) {
  return [...new Set(String(value ?? "").split(/[、,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function splitDeckValues(value) {
  return String(value ?? "").split(/[、,\n]/).map((item) => item.trim()).filter(Boolean);
}

function parseReferenceDecks(value, resolveCharacter, errors) {
  return String(value ?? "").split(/[;\n]+/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const deck = [];
    for (const entry of splitDeckValues(line)) {
      const resolved = resolveCharacter(entry);
      if (resolved.error) errors.push("公開デッキ " + (index + 1) + ": " + resolved.error);
      else if (resolved.character) deck.push(resolved.character);
    }
    if (!deck.length) errors.push("公開デッキ " + (index + 1) + ": キャラを1体以上入力してください。");
    return deck;
  });
}

const LIGHTEST_SKILL_LABELS = Object.freeze({
  attack_buff: "攻撃強化",
  damage_reduction: "ダメージ軽減",
  guard: "かばう",
  attribute_guard: "色かばう",
  heal: "回復",
  revive: "蘇生",
  attribute_change: "属性変更",
  skill_reduction: "スキル短縮",
  delay: "遅延",
  aoe_attack: "全体攻撃",
  multi_hit_attack: "連続攻撃",
  continuous_heal: "継続回復",
});

const LIGHTEST_TARGET_LABELS = Object.freeze({
  self: "自身",
  ally_all: "味方全員",
  enemy_one: "敵1体",
  enemy_all: "敵全体",
});

const LIGHTEST_ATTRIBUTE_LABELS = Object.freeze({ fire: "火", water: "水", wind: "風", all: "全" });

const LIGHTEST_DIFFICULTY_LABELS = Object.freeze({
  plum: "梅（Lv1）",
  bamboo: "竹（無凸LvMAX）",
  pine: "松（完凸LvMAX）",
});

function lightestSkillDetail(event) {
  const skill = event.skill ?? {};
  const details = [];
  if (skill.target) details.push(`対象: ${LIGHTEST_TARGET_LABELS[skill.target] ?? skill.target}`);
  if (Number(skill.amount) > 0) details.push(`効果量: ${skill.amount}`);
  if (Number(skill.multiplier) !== 1 && Number.isFinite(Number(skill.multiplier))) details.push(`倍率: ${skill.multiplier}`);
  if (Number(skill.hits) > 1) details.push(`ヒット数: ${skill.hits}`);
  if (Number(skill.duration) > 1) details.push(`継続: ${skill.duration}ターン`);
  const changedAttributes = (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
  if (changedAttributes.length) details.push(`変更先: ${changedAttributes.map((attribute) => LIGHTEST_ATTRIBUTE_LABELS[attribute] ?? attribute).join("・")}`);
  const label = event.skillName || LIGHTEST_SKILL_LABELS[event.skillType] || "スキル";
  return `${event.actorName}［${label}］${details.length ? `（${details.join("・")}）` : ""}`;
}

function characterDisplay(character) {
  return `${character.name}｜${character.id}`;
}

function createCharacterResolver(characters) {
  const byId = new Map(characters.map((character) => [String(character.id), character]));
  const byDisplay = new Map(characters.map((character) => [characterDisplay(character), character]));
  const byName = new Map();
  characters.forEach((character) => {
    const entries = byName.get(character.name) ?? [];
    entries.push(character);
    byName.set(character.name, entries);
  });
  return (value) => {
    const normalized = String(value ?? "").trim();
    if (!normalized) return { character: null };
    if (byId.has(normalized)) return { character: byId.get(normalized) };
    if (byDisplay.has(normalized)) return { character: byDisplay.get(normalized) };
    const named = byName.get(normalized) ?? [];
    if (named.length === 1) return { character: named[0] };
    if (named.length > 1) return { error: `「${normalized}」は同名キャラが複数います。候補一覧からID付きの項目を選んでください。` };
    return { error: `「${normalized}」に一致するキャラがありません。` };
  };
}

function lightestEnemyRow(index) {
  const row = lightestElement("div", "lightest-enemy-row");
  row.dataset.lightestEnemyRow = "";
  row.append(
    lightestElement("span", "lightest-enemy-order", String(index + 1)),
  );
  const character = document.createElement("input");
  character.type = "text";
  character.setAttribute("list", "lightest-character-list");
  character.placeholder = "敵キャラ名を入力";
  character.dataset.lightestEnemyCharacter = "";
  const hp = document.createElement("input");
  hp.type = "number";
  hp.min = "1";
  hp.step = "1";
  hp.placeholder = "HP自動";
  hp.dataset.lightestEnemyHp = "";
  const power = document.createElement("input");
  power.type = "number";
  power.min = "0";
  power.step = "1";
  power.placeholder = "Power自動";
  power.dataset.lightestEnemyPower = "";
  const resolved = lightestElement("p", "lightest-enemy-resolved", "キャラを選ぶと探索に使う敵ステータスを表示します。");
  resolved.dataset.lightestEnemyResolved = "";
  const remove = lightestElement("button", "lightest-enemy-remove", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `${index + 1}番目の敵を削除`);
  remove.addEventListener("click", () => row.remove());
  row.append(character, hp, power, remove, resolved);
  return row;
}

function renderResolvedEnemyStats(row, resolveCharacter, difficulty) {
  const output = row.querySelector("[data-lightest-enemy-resolved]");
  const value = row.querySelector("[data-lightest-enemy-character]").value;
  if (!value.trim()) {
    output.textContent = "キャラを選ぶと探索に使う敵ステタスを表示します。";
    output.classList.remove("is-error");
    return;
  }
  const resolved = resolveCharacter(value);
  if (resolved.error) {
    output.textContent = resolved.error;
    output.classList.add("is-error");
    return;
  }
  const hpInput = row.querySelector("[data-lightest-enemy-hp]").value;
  const powerInput = row.querySelector("[data-lightest-enemy-power]").value;
  const automatic = resolveLightestEnemy(resolved.character, { difficulty });
  const enemy = resolveLightestEnemy(resolved.character, {
    difficulty,
    hp: hpInput || undefined,
    pow: powerInput || undefined,
  });
  const source = resolved.character.source;
  const sourceLabel = source?.sheet && source?.row ? `・元データ ${source.sheet} ${source.row}行` : "";
  const overrides = [];
  if (hpInput) overrides.push("HP上書き");
  if (powerInput) overrides.push("Power上書き");
  output.textContent = [
    `自動値 ${LIGHTEST_DIFFICULTY_LABELS[difficulty]}: HP ${automatic.hp} / Power ${automatic.pow}`,
    overrides.length ? `→ 使用値: HP ${enemy.hp} / Power ${enemy.pow}（${overrides.join("・")}）` : "",
    `竹: ${automatic.sourceStats.bambooHp} / ${automatic.sourceStats.bambooPow}`,
    `松: ${automatic.sourceStats.pineHp} / ${automatic.sourceStats.pinePow}${sourceLabel}`,
  ].filter(Boolean).join(" ｜ ");
  output.classList.remove("is-error");
}

function renderResolvedEnemyList(enemies) {
  const details = lightestElement("details", "lightest-enemy-audit");
  details.append(lightestElement("summary", "", "敵ステータスの採用値を見る"));
  const list = lightestElement("ol", "");
  enemies.forEach((enemy, index) => {
    const source = enemy.source;
    const sourceLabel = source?.sheet && source?.row ? `（元データ: ${source.sheet} ${source.row}行）` : "";
    const stages = enemy.sourceStats ?? {};
    list.append(lightestElement(
      "li",
      "",
      `${index + 1}. ${enemy.name}: 使用 HP ${enemy.hp} / Power ${enemy.pow} ｜ 竹 ${stages.bambooHp} / ${stages.bambooPow} ｜ 松 ${stages.pineHp} / ${stages.pinePow}${sourceLabel}`,
    ));
  });
  details.append(list);
  return details;
}

function renumberEnemyRows(container) {
  [...container.querySelectorAll("[data-lightest-enemy-row]")].forEach((row, index) => {
    row.querySelector(".lightest-enemy-order").textContent = String(index + 1);
    row.querySelector(".lightest-enemy-remove").setAttribute("aria-label", `${index + 1}番目の敵を削除`);
  });
}

function renderLightestMessage(root, message, error = false) {
  root.replaceChildren(lightestElement(
    "section",
    `lightest-message${error ? " is-error" : ""}`,
    message,
  ));
}

function renderLightestTurn(turn, deckSize) {
  const item = lightestElement("li", "lightest-turn-item");
  const header = lightestElement("div", "lightest-turn-heading");
  header.append(
    lightestElement("strong", "", `${turn.turn}問目`),
    lightestElement("span", "", `味方生存 ${turn.aliveAllies}/${deckSize}・敵撃破累計 ${turn.defeatedEnemies}`),
  );
  const details = [];
  if (turn.spawned.length) details.push(`出現: ${turn.spawned.join("、")}`);
  if (turn.answerLabel) details.push(`回答: ${turn.answerLabel}`);
  const targetAssignments = turn.targetAssignments ?? [];
  if (targetAssignments.length) {
    details.push(`ターゲット指定: ${targetAssignments.map((assignment) => (
      `P${assignment.allyIndex + 1} ${assignment.actorName} → ${assignment.targetName}`
    )).join(" / ")}`);
  }
  const actualAttacks = turn.attacks
    .filter((action) => action.side === "allies")
    .flatMap((action) => {
      const targets = [...new Set(action.hits.map((hit) => hit.targetName))];
      return targets.length
        ? [`P${(action.actorIndex ?? 0) + 1} ${action.actorName} → ${targets.join("、")}`]
        : [];
    });
  if (actualAttacks.length) details.push(`実際の攻撃対象: ${actualAttacks.join(" / ")}`);
  const allySkills = turn.skills.filter((event) => event.side === "allies");
  const enemySkills = turn.skills.filter((event) => event.side === "enemies");
  if (allySkills.length) details.push(`使用スキル: ${allySkills.map(lightestSkillDetail).join(" / ")}`);
  if (enemySkills.length) details.push(`敵スキル: ${enemySkills.map(lightestSkillDetail).join(" / ")}`);
  const defeated = turn.attacks.flatMap((action) => action.hits.filter((hit) => hit.defeated).map((hit) => hit.targetName));
  if (defeated.length) details.push(`撃破: ${[...new Set(defeated)].join("、")}`);
  if (turn.becameGhosts.length) details.push(`幽霊化: ${turn.becameGhosts.join("、")}`);
  if (turn.revives.length) details.push(`蘇生: ${turn.revives.map((event) => event.targetName).join("、")}`);
  const list = lightestElement("ul", "");
  details.forEach((detail) => list.append(lightestElement("li", "", detail)));
  item.append(header, list);
  return item;
}

function renderLightestResult(result, rank) {
  const card = lightestElement("article", `lightest-result-card${result.threeStar ? " is-cleared" : ""}`);
  const header = lightestElement("header", "lightest-result-header");
  const title = lightestElement("div", "");
  title.append(
    lightestElement("span", "lightest-result-rank", result.threeStar ? `三冠デッキ ${rank}` : `参考候補 ${rank}`),
    lightestElement("h3", "", result.threeStar ? `総コスト ${result.totalCost}` : "三冠条件未達"),
  );
  const badges = lightestElement("div", "lightest-result-badges");
  badges.append(
    lightestElement("span", result.cleared ? "is-ok" : "is-ng", result.cleared ? "クリア" : "未クリア"),
    lightestElement("span", result.allSurvived ? "is-ok" : "is-ng", result.allSurvived ? "全員生存" : "生存条件未達"),
    lightestElement("span", "", `${result.turnsCompleted}問`),
  );
  header.append(title, badges);
  const deck = lightestElement("div", "lightest-deck-grid");
  deck.style.gridTemplateColumns = `repeat(${Math.min(5, result.deck.length)}, minmax(0, 1fr))`;
  result.deck.forEach((character, index) => {
    const slot = lightestElement("article", "lightest-deck-slot");
    slot.append(
      lightestElement("span", "", String(index + 1)),
      lightestElement("strong", "", character.name),
      lightestElement("small", "", `${attributeClassLabel(character.attributes)}・${character.rarity}・cost ${character.cost}`),
      lightestElement("p", "", character.skillName || "スキルなし"),
    );
    deck.append(slot);
  });
  const metrics = lightestElement("div", "lightest-result-metrics");
  metrics.append(
    lightestElement("span", "", `撃破 ${result.final.defeatedEnemies}/${result.enemies.length}`),
    lightestElement("span", "", `残HP率 ${lightestPercent(result.final.allyHpRatio)}`),
    lightestElement("span", "", `幽霊 ${result.final.ghosts}体`),
    lightestElement("span", "", `探索状態 ${result.exactSearch?.visitedStates?.toLocaleString("ja-JP") ?? 0}`),
  );
  const audit = lightestElement("details", "lightest-turn-audit");
  audit.open = true;
  audit.append(lightestElement("summary", "", "推奨プレイ手順（回答・5人別ターゲット・スキル）"));
  const turns = lightestElement("ol", "");
  result.history.forEach((turn) => turns.append(renderLightestTurn(turn, result.deck.length)));
  audit.append(turns);
  card.append(header, metrics, deck, renderResolvedEnemyList(result.enemies), audit);
  return card;
}

function lightestSearchSummary(searchResult) {
  const targetCost = Number.isInteger(searchResult.targetCost) ? searchResult.targetCost : null;
  const omitted = searchResult.searchScope?.omitted ?? [];
  if (omitted.length) {
    const suffix = "省略: " + omitted.map((entry) => entry.label).join("・");
    return searchResult.foundThreeStar
      ? "選択した探索範囲で総コスト " + searchResult.searchedThroughCost + " の三冠デッキを発見（" + suffix + "）"
      : "選択した探索範囲では三冠デッキなし（" + suffix + "）";
  }
  if (!searchResult.foundThreeStar) {
    return targetCost === null
      ? `最大指定コスト ${searchResult.stage.maxCost} まで完全探索して三冠デッキなし`
      : `指定コスト ${targetCost} を完全探索して三冠デッキなし`;
  }
  return targetCost === null
    ? `総コスト ${searchResult.searchedThroughCost} が厳密な最小値。最初の三冠デッキで探索を終了`
    : `指定コスト ${targetCost} で三冠デッキを発見。最初の1件で探索を終了`;
}

function renderLightestResults(root, searchResult) {
  root.replaceChildren();
  const overview = lightestElement("section", "lightest-result-overview");
  overview.append(
    lightestElement("strong", "", lightestSearchSummary(searchResult)),
    lightestElement("span", "", `${searchResult.availableCharacterCount}体・組合せ${searchResult.generatedCombinationCount.toLocaleString("ja-JP")}・配置込み${searchResult.simulatedDeckCount.toLocaleString("ja-JP")}デッキを検証`),
  );
  const omitted = searchResult.searchScope?.omitted ?? [];
  if (["stage", "reference"].includes(searchResult.guidance?.mode)) {
    const guidance = searchResult.guidance;
    const usesReferenceCore = guidance.mode === "reference";
    overview.append(lightestElement(
      "span",
      "",
      guidance.applied
        ? usesReferenceCore
          ? "公開デッキ中心: 登録デッキ " + guidance.referenceDeckCount + "件の役割から、" + guidance.sourceCandidateCount + "体中" + guidance.candidateCount + "体を残して全探索。登録デッキのキャラは必ず残します。候補外の最適解は保証しません。"
          : "攻略候補: ステージ相性・コスト・火力・耐久・発動ターンで " + guidance.sourceCandidateCount + "体から" + guidance.candidateCount + "体へ圧縮。公開デッキ " + guidance.referenceDeckCount + "件のキャラは残しています。候補外の最適解は保証しません。"
        : "攻略候補: " + guidance.sourceCandidateCount + "体に支配関係のある候補はなく、全員を保持しています。",
    ));
  }
  const actionOmitted = omitted.filter((entry) => entry.key !== "candidates");
  if (actionOmitted.length) {
    overview.append(lightestElement(
      "span",
      "",
      "省略した行動分岐: " + actionOmitted.map((entry) => entry.label).join("・") + "。残った候補キャラ・総コスト・デッキ枚数は全探索です。",
    ));
  }
  if (searchResult.scout?.attempted) {
    overview.append(lightestElement(
      "span",
      "",
      searchResult.scout.found
        ? "高速候補確認: " + searchResult.scout.sampledDeckCount + "件目で総コスト " + searchResult.scout.upperCost + " の勝利候補を発見。以下は完全探索済み"
        : "高速候補確認: " + searchResult.scout.sampledDeckCount + "件を確認。勝利候補なしのため完全探索を継続",
    ));
  }
  root.append(overview);
  searchResult.results.forEach((result, index) => root.append(renderLightestResult(result, index + 1)));
  const assumptions = lightestElement("details", "lightest-assumptions");
  assumptions.append(lightestElement("summary", "", "現在の再現ルールと前提を見る"));
  const list = lightestElement("ul", "");
  searchResult.assumptions.forEach((assumption) => list.append(lightestElement("li", "", assumption)));
  assumptions.append(list);
  root.append(assumptions);
}

export function initializeLightest(root, characters) {
  const form = root.querySelector("[data-lightest-form]");
  const enemyRows = root.querySelector("[data-lightest-enemy-rows]");
  const addEnemy = root.querySelector("[data-lightest-add-enemy]");
  const submit = root.querySelector("[data-lightest-submit]");
  const cancel = root.querySelector("[data-lightest-cancel]");
  const progress = root.querySelector("[data-lightest-progress]");
  const progressLabel = progress.querySelector("[data-lightest-progress-label]");
  const progressValue = progress.querySelector("[data-lightest-progress-value]");
  const progressBar = progress.querySelector("[data-lightest-progress-bar]");
  const overallProgressLabel = progress.querySelector("[data-lightest-overall-label]");
  const overallProgressValue = progress.querySelector("[data-lightest-overall-value]");
  const overallProgressBar = progress.querySelector("[data-lightest-overall-bar]");
  const costProgressLabel = progress.querySelector("[data-lightest-cost-label]");
  const costProgressValue = progress.querySelector("[data-lightest-cost-value]");
  const costProgressBar = progress.querySelector("[data-lightest-cost-bar]");
  const results = root.querySelector("[data-lightest-results]");
  const datalist = root.querySelector("#lightest-character-list");
  const eventBonusInput = form.elements.lightestEventBonus;
  const referenceDecksInput = form.elements.lightestReferenceDecks;
  const eventBonusSelected = root.querySelector("[data-lightest-event-bonus-selected]");
  const referenceDraftRoot = root.querySelector("[data-lightest-reference-draft]");
  const referenceSelected = root.querySelector("[data-lightest-reference-selected]");
  const referenceCount = root.querySelector("[data-lightest-reference-count]");
  const referenceSave = root.querySelector("[data-lightest-reference-save]");
  const referenceClear = root.querySelector("[data-lightest-reference-clear]");
  const picker = root.querySelector("[data-lightest-character-picker]");
  const pickerHeading = root.querySelector("[data-lightest-picker-heading]");
  const pickerClose = root.querySelector("[data-lightest-picker-close]");
  const pickerForm = root.querySelector("[data-lightest-picker-form]");
  const pickerQuery = pickerForm.querySelector("[name=lightestPickerQuery]");
  const pickerSubmit = pickerForm.querySelector("[data-lightest-picker-submit]");
  const pickerResults = root.querySelector("[data-lightest-picker-results]");
  const sortByHp = root.querySelector("[data-lightest-sort-hp]");
  const sortByHpStatus = root.querySelector("[data-lightest-sort-hp-status]");
  const fastApproximation = form.elements.lightestFastApproximation;
  const automaticTargeting = form.elements.lightestAutomaticTargeting;
  const immediateSkills = form.elements.lightestImmediateSkills;
  const hpOrderOnly = form.elements.lightestHpOrderOnly;
  const candidateGuidance = form.elements.lightestCandidateGuidance;
  const referenceDeckCore = form.elements.lightestReferenceDeckCore;
  const fastApproximationToggle = root.querySelector("[data-lightest-fast-approximation-toggle]");
  let orderByHpDescending = false;
  let activeCharacters = characters;
  let resolveCharacter = createCharacterResolver(activeCharacters);
  let characterSearchIndex = createCharacterSearchIndex(activeCharacters);
  let referenceDraft = [];
  let pickerMode = "event";
  let pickerSearchTimer = null;
  let refreshPickerSelections = () => {};
  let abortController = null;

  const setCharacters = (nextCharacters) => {
    activeCharacters = Array.isArray(nextCharacters) ? nextCharacters : [];
    resolveCharacter = createCharacterResolver(activeCharacters);
    characterSearchIndex = createCharacterSearchIndex(activeCharacters);
    refreshPickerSelections();
    const optionsFragment = document.createDocumentFragment();
    activeCharacters.forEach((character) => {
      const option = document.createElement("option");
      option.value = characterDisplay(character);
      option.label = `${attributeClassLabel(character.attributes)}・${character.rarity}・cost ${character.cost}`;
      optionsFragment.append(option);
    });
    datalist.replaceChildren(optionsFragment);
  };
  setCharacters(characters);
  for (let index = 0; index < 5; index += 1) enemyRows.append(lightestEnemyRow(index));

  const selectedCharacters = (value) => splitValues(value).flatMap((entry) => {
    const resolved = resolveCharacter(entry);
    return resolved.character ? [resolved.character] : [];
  });
  const selectedDeckCharacters = (value) => splitDeckValues(value).flatMap((entry) => {
    const resolved = resolveCharacter(entry);
    return resolved.character ? [resolved.character] : [];
  });
  const renderChips = (container, selected, onRemove, emptyLabel, removable = true) => {
    container.replaceChildren();
    if (!selected.length) {
      container.append(lightestElement("span", "lightest-picker-empty", emptyLabel));
      return;
    }
    selected.forEach((character, index) => {
      const chip = lightestElement("span", "lightest-picker-chip");
      chip.append(lightestElement("strong", "", character.name), lightestElement("small", "", "cost " + character.cost));
      if (removable) {
        const remove = lightestElement("button", "", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", character.name + "を削除");
        remove.addEventListener("click", () => onRemove(index));
        chip.append(remove);
      }
      container.append(chip);
    });
  };
  const setEventBonusCharacters = (selected) => {
    const unique = [...new Map(selected.map((character) => [String(character.id), character])).values()];
    eventBonusInput.value = unique.map((character) => String(character.id)).join(", ");
    refreshPickerSelections();
  };
  const referenceLines = () => String(referenceDecksInput.value ?? "").split(/\n/).map((line) => line.trim()).filter(Boolean);
  const setReferenceLines = (lines) => {
    referenceDecksInput.value = lines.join("\n");
    refreshPickerSelections();
  };
  const renderPickerResults = () => {
    const query = pickerQuery.value.trim();
    pickerResults.replaceChildren();
    if (!query) {
      pickerResults.append(lightestElement("p", "lightest-picker-message", "名前・属性・スキルなどで検索してください。例: 火 回復 / 低コスト 蘇生"));
      return;
    }
    const response = searchCharacters(characterSearchIndex, query, { limit: 18 });
    if (!response.total) {
      pickerResults.append(lightestElement("p", "lightest-picker-message", "一致するキャラがありません。キーワードを短くして試してください。"));
      return;
    }
    const list = lightestElement("div", "lightest-picker-results-grid");
    response.results.forEach((result) => {
      const character = result.character;
      const card = lightestElement("article", "lightest-picker-result");
      const heading = lightestElement("div", "");
      heading.append(
        lightestElement("strong", "", character.name),
        lightestElement("small", "", attributeClassLabel(character.attributes) + "・" + character.rarity + "・cost " + character.cost),
      );
      card.append(heading, lightestElement("p", "", character.skillName || "スキルなし"));
      const add = lightestElement("button", "", pickerMode === "event" ? "補正対象へ追加" : "作成中デッキへ追加");
      add.type = "button";
      if (pickerMode === "reference" && referenceDraft.length >= 5) {
        add.disabled = true;
        add.textContent = "デッキは5体まで";
      }
      add.addEventListener("click", () => {
        if (pickerMode === "event") {
          setEventBonusCharacters([...selectedCharacters(eventBonusInput.value), character]);
        } else if (referenceDraft.length < 5) {
          referenceDraft = [...referenceDraft, character];
          refreshPickerSelections();
          renderPickerResults();
        }
      });
      card.append(add);
      list.append(card);
    });
    pickerResults.append(list);
  };
  const openPicker = (mode) => {
    pickerMode = mode;
    picker.hidden = false;
    pickerHeading.textContent = mode === "event" ? "イベント補正キャラを検索" : "公開デッキに入れるキャラを検索";
    pickerQuery.value = "";
    renderPickerResults();
    pickerQuery.focus();
  };
  refreshPickerSelections = () => {
    const bonuses = selectedCharacters(eventBonusInput.value);
    renderChips(eventBonusSelected, bonuses, (index) => {
      bonuses.splice(index, 1);
      setEventBonusCharacters(bonuses);
    }, "まだ追加されていません");
    renderChips(referenceDraftRoot, referenceDraft, (index) => {
      referenceDraft.splice(index, 1);
      refreshPickerSelections();
      renderPickerResults();
    }, "検索でカードを選び、公開デッキを1件作成します");
    referenceSave.disabled = !referenceDraft.length;
    referenceClear.disabled = !referenceDraft.length;
    referenceSelected.replaceChildren();
    const lines = referenceLines();
    referenceCount.textContent = "登録済み " + lines.length + "件";
    if (!lines.length) {
      referenceSelected.append(lightestElement("span", "lightest-picker-empty", "公開デッキはまだ登録されていません"));
    } else {
      lines.forEach((line, deckIndex) => {
        const deck = selectedDeckCharacters(line);
        const row = lightestElement("div", "lightest-reference-deck");
        row.append(lightestElement("strong", "", "公開デッキ " + (deckIndex + 1)));
        const cards = lightestElement("div", "lightest-picker-chips");
        renderChips(cards, deck, null, "不明なカード", false);
        row.append(cards);
        const remove = lightestElement("button", "", "このデッキを削除");
        remove.type = "button";
        remove.addEventListener("click", () => {
          const next = referenceLines();
          next.splice(deckIndex, 1);
          setReferenceLines(next);
        });
        row.append(remove);
        referenceSelected.append(row);
      });
    }
  };
  root.querySelectorAll("[data-lightest-picker-open]").forEach((button) => {
    button.addEventListener("click", () => openPicker(button.dataset.lightestPickerOpen));
  });
  pickerClose.addEventListener("click", () => { picker.hidden = true; });
  pickerSubmit.addEventListener("click", renderPickerResults);
  pickerQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      renderPickerResults();
    }
  });
  pickerQuery.addEventListener("input", () => {
    clearTimeout(pickerSearchTimer);
    pickerSearchTimer = setTimeout(renderPickerResults, 120);
  });
  referenceSave.addEventListener("click", () => {
    if (!referenceDraft.length) return;
    setReferenceLines([...referenceLines(), referenceDraft.map((character) => String(character.id)).join(", ")]);
    referenceDraft = [];
    refreshPickerSelections();
  });
  referenceClear.addEventListener("click", () => {
    referenceDraft = [];
    refreshPickerSelections();
    renderPickerResults();
  });
  refreshPickerSelections();
  const refreshResolvedEnemyStats = () => {
    const difficulty = form.elements.lightestDifficulty.value;
    [...enemyRows.querySelectorAll("[data-lightest-enemy-row]")].forEach((row) => {
      renderResolvedEnemyStats(row, resolveCharacter, difficulty);
    });
  };
  refreshResolvedEnemyStats();
  const setHpSort = (enabled) => {
    orderByHpDescending = enabled;
    sortByHp.setAttribute("aria-pressed", String(enabled));
    sortByHp.classList.toggle("is-active", enabled);
    sortByHp.querySelector("span").textContent = enabled ? "HP順を適用中" : "HPが高い順に並べる";
    sortByHpStatus.textContent = enabled
      ? "最初の枠から最後の直前までをHP降順に固定します。最後の枠は蘇生です。"
      : "必要なときだけ押してください。オンにすると、最後の蘇生枠を除いてHPの高い順に固定し、同HPの並びだけを完全探索します。";
  };
  sortByHp.addEventListener("click", () => {
    setHpSort(!orderByHpDescending);
    hpOrderOnly.checked = orderByHpDescending;
    renderFastApproximationToggle();
  });
  renderLightestMessage(results, "敵を出現順に設定すると、三冠できる最小コストデッキを探索します。");

  addEnemy.addEventListener("click", () => {
    enemyRows.append(lightestEnemyRow(enemyRows.children.length));
    renumberEnemyRows(enemyRows);
    refreshResolvedEnemyStats();
  });
  enemyRows.addEventListener("click", () => queueMicrotask(() => renumberEnemyRows(enemyRows)));
  enemyRows.addEventListener("input", refreshResolvedEnemyStats);
  form.elements.lightestDifficulty.addEventListener("change", refreshResolvedEnemyStats);
  cancel.addEventListener("click", () => abortController?.abort());
  const scopeControls = [automaticTargeting, immediateSkills, hpOrderOnly];
  const renderFastApproximationToggle = () => {
    const omittedCount = scopeControls.filter((control) => control.checked).length;
    const enabled = omittedCount === scopeControls.length;
    fastApproximation.checked = enabled;
    fastApproximation.indeterminate = omittedCount > 0 && !enabled;
    fastApproximationToggle.setAttribute("aria-pressed", String(enabled));
    fastApproximationToggle.classList.toggle("is-active", enabled);
    fastApproximationToggle.querySelector("span").textContent = enabled
      ? "省略プリセット: ON"
      : omittedCount
        ? "省略設定: " + omittedCount + "項目"
        : "省略プリセット: OFF";
  };
  const setScopePreset = (enabled) => {
    scopeControls.forEach((control) => { control.checked = enabled; });
    setHpSort(enabled);
    renderFastApproximationToggle();
  };
  fastApproximation.addEventListener("change", () => setScopePreset(fastApproximation.checked));
  fastApproximationToggle.addEventListener("click", () => setScopePreset(!fastApproximation.checked || fastApproximation.indeterminate));
  automaticTargeting.addEventListener("change", renderFastApproximationToggle);
  immediateSkills.addEventListener("change", renderFastApproximationToggle);
  hpOrderOnly.addEventListener("change", () => {
    setHpSort(hpOrderOnly.checked);
    renderFastApproximationToggle();
  });
  renderFastApproximationToggle();

  const setBusy = (busy) => {
    submit.disabled = busy;
    fastApproximationToggle.disabled = busy;
    sortByHp.disabled = busy;
    scopeControls.forEach((control) => { control.disabled = busy; });
    fastApproximation.disabled = busy;
    candidateGuidance.disabled = busy;
    referenceDeckCore.disabled = busy;
    root.querySelectorAll("[data-lightest-picker-open], [data-lightest-reference-save], [data-lightest-reference-clear], [data-lightest-picker-close]").forEach((control) => { control.disabled = busy; });
    cancel.hidden = !busy;
    form.setAttribute("aria-busy", String(busy));
    progress.hidden = !busy;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errors = [];
    const difficulty = form.elements.lightestDifficulty.value;
    const enemies = [];
    [...enemyRows.querySelectorAll("[data-lightest-enemy-row]")].forEach((row, order) => {
      const value = row.querySelector("[data-lightest-enemy-character]").value;
      if (!value.trim()) return;
      const resolved = resolveCharacter(value);
      if (resolved.error) {
        errors.push(`${order + 1}番目: ${resolved.error}`);
        return;
      }
      const hpValue = row.querySelector("[data-lightest-enemy-hp]").value;
      const powerValue = row.querySelector("[data-lightest-enemy-power]").value;
      enemies.push(resolveLightestEnemy(resolved.character, {
        difficulty,
        hp: hpValue || undefined,
        pow: powerValue || undefined,
        order,
      }));
    });
    if (!enemies.length) errors.push("敵を1体以上設定してください。");
    const eventBonusIds = [];
    const candidateIds = [];
    for (const value of splitValues(form.elements.lightestEventBonus.value)) {
      const resolved = resolveCharacter(value);
      if (resolved.error) errors.push(`強化対象: ${resolved.error}`);
      else eventBonusIds.push(String(resolved.character.id));
    }
    for (const value of splitValues(form.elements.lightestCandidates.value)) {
      const resolved = resolveCharacter(value);
      if (resolved.error) errors.push(`味方候補: ${resolved.error}`);
      else candidateIds.push(String(resolved.character.id));
    }
    const referenceDecks = parseReferenceDecks(form.elements.lightestReferenceDecks.value, resolveCharacter, errors);
    const maxCost = Number(form.elements.lightestMaxCost.value);
    const targetCostText = form.elements.lightestTargetCost.value.trim();
    const targetCost = targetCostText === "" ? null : Number(targetCostText);
    if (targetCost !== null && (!Number.isInteger(targetCost) || targetCost < 0)) {
      errors.push("指定コストは0以上の整数で設定してください");
    }
    if (targetCost !== null && Number.isFinite(maxCost) && targetCost > maxCost) {
      errors.push("指定コストは最大指定コスト以下で設定してください");
    }

    if (errors.length) {
      renderLightestMessage(results, errors.join("\n"), true);
      return;
    }

    const stage = {
      enemies,
      maxCost,
      targetCost,
      maxTurns: Number(form.elements.lightestMaxTurns.value),
      deckSizes: [1, 2, 3, 4, 5],
      requiredLastSkillType: "revive",
      orderByHpDescending,
      allowedAttributes: [...form.querySelectorAll("input[name='lightestAllowedAttributes']:checked")].map((input) => input.value),
      rarities: splitValues(form.elements.lightestRarities.value),
      eventBonusIds,
      candidateIds,
      referenceDecks,
    };
    abortController = new AbortController();
    setBusy(true);
    overallProgressLabel.textContent = "全体（総コスト）";
    overallProgressValue.textContent = "区画を準備中";
    overallProgressBar.style.width = "0%";
    costProgressLabel.textContent = "現在の総コスト";
    costProgressValue.textContent = "区画を準備中";
    costProgressBar.style.width = "0%";
    progressLabel.textContent = "現在の編成";
    progressValue.textContent = "総コストとデッキ枚数の区画を作成しています";
    progressBar.style.width = "0%";
    const searchRange = targetCost === null
      ? `低い総コストから最大指定コスト ${maxCost} まで`
      : `指定コスト ${targetCost} だけ`;
    renderLightestMessage(results, `${searchRange}、全デッキ配置と全行動を漏れなく調べています。三冠デッキを1件見つけた時点で終了します。`);
    try {
      const searchResult = await findLightestDeck(activeCharacters, stage, {
        allowDuplicates: form.elements.lightestAllowDuplicates.checked,
        ownedOnly: form.elements.lightestOwnedOnly.checked,
        targetSearch: automaticTargeting.checked ? "automatic" : "all",
        skillSearch: immediateSkills.checked ? "automatic" : "all",
        orderSearch: hpOrderOnly.checked ? "hp_descending" : "all",
        candidateGuidance: candidateGuidance.checked ? "stage" : "all",
        referenceDeckCore: referenceDeckCore.checked,
        answerMultiplier: Number(form.elements.lightestAnswerMultiplier.value),
        enemyAttackMultiplier: Number(form.elements.lightestEnemyMultiplier.value),
        signal: abortController.signal,
        onProgress: ({
          phase,
          cost,
          completed,
          combinations,
          costDeckCount,
          valid,
          total,
          candidateCount,
          deckSize,
          costIndex,
          costCount,
          costDeckIndex,
          costDeckSizeCount,
          taskIndex,
          taskCount,
          taskCompleted,
          totalCombinations,
        }) => {
          if (phase === "scout") {
            const scoutTotal = Math.max(1, Number(total) || 1);
            const scoutCompleted = Math.max(0, Number(completed) || 0);
            overallProgressLabel.textContent = "高速候補を確認中";
            overallProgressValue.textContent = scoutCompleted + " / " + scoutTotal + " デッキ";
            overallProgressBar.style.width = Math.round(Math.min(1, scoutCompleted / scoutTotal) * 100) + "%";
            costProgressLabel.textContent = "完全探索の上限を探しています";
            costProgressValue.textContent = "勝利候補があれば、その総コスト以下だけを完全探索します";
            costProgressBar.style.width = "0%";
            progressLabel.textContent = "高速候補確認";
            progressValue.textContent = scoutCompleted + " / " + scoutTotal + " デッキ・候補 " + candidateCount;
            progressBar.style.width = Math.round(Math.min(1, scoutCompleted / scoutTotal) * 100) + "%";
            return;
          }
          const costTotal = Math.max(1, Number(costCount) || 1);
          const costDeckTotal = Math.max(1, Number(costDeckSizeCount) || 1);
          const currentCombinationTotal = Math.max(0, Number(totalCombinations) || 0);
          const currentCombinationRatio = taskCompleted
            ? 1
            : currentCombinationTotal > 0
              ? Math.min(1, combinations / currentCombinationTotal)
              : 0;
          const currentCostRatio = ((Math.max(1, Number(costDeckIndex) || 1) - 1) + currentCombinationRatio) / costDeckTotal;
          const overallRatio = ((Math.max(1, Number(costIndex) || 1) - 1) + currentCostRatio) / costTotal;
          overallProgressLabel.textContent = "全体（総コスト）";
          overallProgressValue.textContent = `${costIndex} / ${costCount} コスト帯`;
          overallProgressBar.style.width = `${Math.round(Math.min(1, overallRatio) * 100)}%`;
          costProgressLabel.textContent = `総コスト ${cost} の編成サイズ`;
          costProgressValue.textContent = `${costDeckIndex} / ${costDeckSizeCount} 編成`;
          costProgressBar.style.width = `${Math.round(Math.min(1, currentCostRatio) * 100)}%`;
          progressLabel.textContent = `${deckSize}体編成・有効組合せ`;
          progressValue.textContent = `${combinations.toLocaleString("ja-JP")} / ${currentCombinationTotal.toLocaleString("ja-JP")}組合せ・配置込み${costDeckCount.toLocaleString("ja-JP")}デッキ・候補${candidateCount}・三冠${valid}`;
          progressBar.style.width = `${Math.round(currentCombinationRatio * 100)}%`;
        },
      });
      renderLightestResults(results, searchResult);
    } catch (error) {
      renderLightestMessage(results, error.name === "AbortError" ? "最軽装探索を中止しました。" : error.message, error.name !== "AbortError");
    } finally {
      abortController = null;
      setBusy(false);
    }
  });
  return { setCharacters };
}
