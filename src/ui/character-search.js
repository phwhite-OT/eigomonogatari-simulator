import { attributeClassLabel, resolveAttributeClass } from "../data/rules.js";
import { resolveCharacterImageUrl } from "../data/character-images.js";
import { createCharacterSearchIndex, searchCharacters } from "../core/character-search.js";
import { groupCharactersForCatalogue } from "../core/character-catalogue.js";

const CHARACTER_SEARCH_PAGE_SIZE = 24;

function characterSearchElement(tagName, className = "", textContent = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent) element.textContent = textContent;
  return element;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("ja-JP");
}

function appendCharacterId(fieldName, characterId) {
  const field = document.querySelector(`[name="${fieldName}"]`);
  if (!field) return false;
  const values = field.value.split(/[,、\n]/u).map((value) => value.trim()).filter(Boolean);
  if (!values.includes(String(characterId))) values.push(String(characterId));
  field.value = values.join(", ");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function createActionButton(label, action) {
  const button = characterSearchElement("button", "character-search-action", label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function renderCharacterPortrait(character) {
  const portrait = characterSearchElement("div", "character-portrait");
  portrait.dataset.characterImageId = String(character.id);
  const imageUrl = resolveCharacterImageUrl(character);
  const showPlaceholder = () => {
    portrait.replaceChildren(characterSearchElement("span", "character-portrait-placeholder", "画像"));
    portrait.classList.add("is-placeholder");
  };
  if (!imageUrl) {
    showPlaceholder();
    return portrait;
  }
  const image = document.createElement("img");
  image.src = imageUrl;
  image.alt = `${character.name}の画像`;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", showPlaceholder, { once: true });
  portrait.append(image);
  return portrait;
}

function renderCharacterCard(result, rank, {
  lightestAvailable = false,
  characterDatabaseAccess = false,
  onEditCharacter,
  onAddCharacterAtPosition,
  compact = false,
} = {}) {
  const { character } = result;
  const card = characterSearchElement("article", "character-search-card");
  card.classList.toggle("is-compact", compact);
  const heading = characterSearchElement("div", "character-search-card-heading");
  const identity = characterSearchElement("div", "character-search-identity");
  const attributeClass = resolveAttributeClass(character.attributes);
  const attribute = characterSearchElement("span", `character-attribute attribute-${attributeClass}`, result.attributeLabel);
  const name = characterSearchElement("h3", "", character.name);
  const id = characterSearchElement("small", "", `ID ${character.id}`);
  identity.append(attribute, name, id);
  const rankLabel = characterSearchElement("span", "character-search-rank", `#${rank}`);
  if (compact) heading.append(renderCharacterPortrait(character));
  heading.append(identity, rankLabel);

  const meta = characterSearchElement("div", "character-search-meta");
  for (const label of [character.rarity, character.region, `コスト ${character.cost}`, character.owned ? "所持" : "未所持"]) {
    meta.append(characterSearchElement("span", "", label));
  }

  const stats = characterSearchElement("div", "character-search-stats");
  for (const [label, value] of [["HP", character.hp], ["Power", character.pow]]) {
    const stat = characterSearchElement("span");
    stat.append(characterSearchElement("small", "", label), characterSearchElement("strong", "", typeof value === "number" ? formatNumber(value) : value));
    stats.append(stat);
  }

  const skill = characterSearchElement("div", "character-search-skill");
  const skillCategory = character.skillCategory && character.skillCategory !== "-" ? character.skillCategory : "スキルなし";
  const skillHeading = skillCategory === "スキルなし" ? skillCategory : `${character.skillTurn}T ・ ${skillCategory}`;
  skill.append(
    characterSearchElement("strong", "", skillHeading),
    characterSearchElement("p", "", character.skillName || "スキル説明なし"),
  );

  const reasons = characterSearchElement("div", "character-search-reasons");
  reasons.append(characterSearchElement("strong", "", "この検索に合う理由"));
  const reasonList = characterSearchElement("ul");
  for (const reason of result.reasons.slice(0, 4)) reasonList.append(characterSearchElement("li", "", reason));
  reasons.append(reasonList);

  const actions = characterSearchElement("div", "character-search-actions");
  actions.classList.toggle("is-admin", lightestAvailable || characterDatabaseAccess);
  actions.classList.toggle("is-database-admin", characterDatabaseAccess);
  actions.append(
    createActionButton("IDをコピー", async (event) => {
      const copied = await copyText(String(character.id));
      event.currentTarget.textContent = copied ? "コピーしました" : "コピーできませんでした";
      setTimeout(() => { event.currentTarget.textContent = "IDをコピー"; }, 1400);
    }),
    createActionButton("対戦の必須へ", (event) => {
      if (appendCharacterId("requiredIds", character.id)) event.currentTarget.textContent = "追加しました";
    }),
  );
  if (lightestAvailable) {
    actions.append(createActionButton("最軽装候補へ", (event) => {
      if (appendCharacterId("lightestCandidates", character.id)) event.currentTarget.textContent = "追加しました";
    }));
  }
  if (characterDatabaseAccess) {
    actions.append(
      createActionButton("編集", () => onEditCharacter?.(character)),
      createActionButton("前に追加", () => onAddCharacterAtPosition?.(character, "before")),
      createActionButton("後に追加", () => onAddCharacterAtPosition?.(character, "after")),
    );
  }

  card.append(heading, meta, stats, skill);
  if (!compact) card.append(reasons);
  card.append(actions);
  return card;
}

function catalogueResult(item, category) {
  return {
    character: item.character,
    attributeLabel: attributeClassLabel(item.character.attributes),
    reasons: ["送付データ順", `${category.name}・${item.sourceIndex + 1}番目`],
  };
}

function renderCatalogueCategory(group, categoryIndex, options) {
  const details = characterSearchElement("details", "character-catalogue-category");
  const summary = characterSearchElement("summary");
  const heading = characterSearchElement("span", "character-catalogue-category-heading");
  heading.append(
    characterSearchElement("strong", "", group.name),
    characterSearchElement("small", "", `${formatNumber(group.items.length)}体・データ順`),
  );
  summary.append(heading, characterSearchElement("b", "", "表示"));
  const content = characterSearchElement("div", "character-catalogue-category-content");
  details.append(summary, content);

  let visibleCount = CHARACTER_SEARCH_PAGE_SIZE;
  let rendered = false;
  const renderItems = () => {
    const fragment = document.createDocumentFragment();
    const grid = characterSearchElement("div", "character-catalogue-grid");
    group.items.slice(0, visibleCount).forEach((item) => {
      grid.append(renderCharacterCard(catalogueResult(item, group), item.sourceIndex + 1, { ...options, compact: true }));
    });
    fragment.append(grid);
    if (visibleCount < group.items.length) {
      const more = characterSearchElement("button", "button character-search-more", `さらに表示（残り${formatNumber(group.items.length - visibleCount)}体）`);
      more.type = "button";
      more.addEventListener("click", () => {
        visibleCount += CHARACTER_SEARCH_PAGE_SIZE;
        renderItems();
      });
      fragment.append(more);
    }
    content.replaceChildren(fragment);
  };
  details.addEventListener("toggle", () => {
    if (!details.open || rendered) return;
    rendered = true;
    renderItems();
  });
  if (categoryIndex === 0) {
    details.open = true;
    rendered = true;
    renderItems();
  }
  return details;
}

function renderCharacterCatalogue(resultRoot, index, options) {
  const groups = groupCharactersForCatalogue(index.documents.map((document) => document.character));
  const fragment = document.createDocumentFragment();
  const overview = characterSearchElement("section", "character-search-overview character-catalogue-overview");
  const copy = characterSearchElement("div");
  copy.append(
    characterSearchElement("span", "eyebrow", "CHARACTER ENCYCLOPEDIA"),
    characterSearchElement("h2", "", `${formatNumber(index.documents.length)}体を収録`),
    characterSearchElement("p", "", "送付データのシート順・行順を保ったまま分類しています。分類を開くと、登録された順に確認できます。"),
  );
  overview.append(copy, characterSearchElement("span", "character-catalogue-count", `${formatNumber(groups.length)}分類`));
  fragment.append(overview);
  groups.forEach((group, categoryIndex) => fragment.append(renderCatalogueCategory(group, categoryIndex, options)));
  resultRoot.replaceChildren(fragment);
}

function renderNoResults(resultRoot, response) {
  const empty = characterSearchElement("div", "character-search-empty is-compact");
  empty.append(
    characterSearchElement("span", "character-search-empty-mark", "0"),
    characterSearchElement("h2", "", "一致するキャラが見つかりません"),
    characterSearchElement("p", "", "条件を一つ減らす、数値条件を広げる、または名前を短くして試してください。"),
  );
  if (response.query.interpreted.length) {
    const chips = characterSearchElement("div", "character-search-intents");
    for (const label of response.query.interpreted) chips.append(characterSearchElement("span", "", label));
    empty.append(chips);
  }
  resultRoot.replaceChildren(empty);
}

function renderSearchResults(resultRoot, response, visibleLimit, onLoadMore, options) {
  if (!response.total) {
    renderNoResults(resultRoot, response);
    return;
  }
  const fragment = document.createDocumentFragment();
  const overview = characterSearchElement("section", "character-search-overview");
  const copy = characterSearchElement("div");
  copy.append(
    characterSearchElement("span", "eyebrow", "SEARCH RESULT"),
    characterSearchElement("h2", "", `${formatNumber(response.total)}体が一致`),
    characterSearchElement("p", "", `「${response.query.raw}」を名前・属性・スキル・地域などから検索しました。`),
  );
  const intents = characterSearchElement("div", "character-search-intents");
  for (const label of response.query.interpreted) intents.append(characterSearchElement("span", "", label));
  overview.append(copy, intents);
  fragment.append(overview);

  const grid = characterSearchElement("div", "character-search-grid");
  response.results.slice(0, visibleLimit).forEach((result, index) => grid.append(renderCharacterCard(result, index + 1, options)));
  fragment.append(grid);
  if (visibleLimit < response.total) {
    const loadMore = characterSearchElement("button", "button character-search-more", `さらに表示（残り${formatNumber(response.total - visibleLimit)}体）`);
    loadMore.type = "button";
    loadMore.addEventListener("click", onLoadMore);
    fragment.append(loadMore);
  }
  resultRoot.replaceChildren(fragment);
}

export function initializeCharacterSearch(root, initialCharacters, options = {}) {
  if (!root) return { setCharacters() {}, setLightestAvailable() {}, setCharacterDatabaseAccess() {}, search() {} };
  const form = root.querySelector("[data-character-search-form]");
  const input = form.elements.characterQuery;
  const sort = form.elements.characterSort;
  const clear = root.querySelector("[data-character-search-clear]");
  const resultRoot = root.querySelector("[data-character-search-results]");
  const count = root.querySelector("[data-character-search-count]");
  let index = createCharacterSearchIndex(initialCharacters);
  let response = null;
  let visibleLimit = CHARACTER_SEARCH_PAGE_SIZE;
  let debounceTimer = null;
  let lightestAvailable = Boolean(options.lightestAvailable);
  let characterDatabaseAccess = Boolean(options.characterDatabaseAccess);
  const onEditCharacter = typeof options.onEditCharacter === "function" ? options.onEditCharacter : () => {};
  const onAddCharacterAtPosition = typeof options.onAddCharacterAtPosition === "function" ? options.onAddCharacterAtPosition : () => {};
  const renderOptions = () => ({ lightestAvailable, characterDatabaseAccess, onEditCharacter, onAddCharacterAtPosition });

  const renderCurrent = () => {
    if (!response) {
      renderCharacterCatalogue(resultRoot, index, renderOptions());
      return;
    }
    renderSearchResults(resultRoot, response, visibleLimit, () => {
      visibleLimit += CHARACTER_SEARCH_PAGE_SIZE;
      renderCurrent();
    }, renderOptions());
  };

  const runSearch = () => {
    const query = input.value.trim();
    visibleLimit = CHARACTER_SEARCH_PAGE_SIZE;
    if (!query) {
      response = null;
      renderCurrent();
      return;
    }
    response = searchCharacters(index, query, { sort: sort.value, limit: index.documents.length });
    renderCurrent();
  };

  const scheduleSearch = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 120);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(debounceTimer);
    runSearch();
  });
  input.addEventListener("input", scheduleSearch);
  sort.addEventListener("change", runSearch);
  clear.addEventListener("click", () => {
    input.value = "";
    input.focus();
    runSearch();
  });
  root.querySelectorAll("[data-character-search-example]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.characterSearchExample;
      runSearch();
      input.focus();
    });
  });

  const setCharacters = (characters) => {
    index = createCharacterSearchIndex(characters);
    count.textContent = `${formatNumber(index.documents.length)}体収録`;
    runSearch();
  };
  const setLightestAvailable = (allowed) => {
    lightestAvailable = Boolean(allowed);
    renderCurrent();
  };
  const setCharacterDatabaseAccess = (allowed) => {
    characterDatabaseAccess = Boolean(allowed);
    renderCurrent();
  };
  setCharacters(initialCharacters);
  return { setCharacters, setLightestAvailable, setCharacterDatabaseAccess, search: runSearch };
}
