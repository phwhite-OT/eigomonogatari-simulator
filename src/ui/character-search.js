import { resolveAttributeClass } from "../data/rules.js";
import { createCharacterSearchIndex, searchCharacters } from "../core/character-search.js";

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

function renderCharacterCard(result, rank) {
  const { character } = result;
  const card = characterSearchElement("article", "character-search-card");
  const heading = characterSearchElement("div", "character-search-card-heading");
  const identity = characterSearchElement("div", "character-search-identity");
  const attributeClass = resolveAttributeClass(character.attributes);
  const attribute = characterSearchElement("span", `character-attribute attribute-${attributeClass}`, result.attributeLabel);
  const name = characterSearchElement("h3", "", character.name);
  const id = characterSearchElement("small", "", `ID ${character.id}`);
  identity.append(attribute, name, id);
  const rankLabel = characterSearchElement("span", "character-search-rank", `#${rank}`);
  heading.append(identity, rankLabel);

  const meta = characterSearchElement("div", "character-search-meta");
  for (const label of [character.rarity, character.region, `コスト ${character.cost}`, character.owned ? "所持" : "未所持"]) {
    meta.append(characterSearchElement("span", "", label));
  }

  const stats = characterSearchElement("div", "character-search-stats");
  for (const [label, value] of [["HP", character.hp], ["Power", character.pow], ["Skill", `${character.skillTurn}T`]]) {
    const stat = characterSearchElement("span");
    stat.append(characterSearchElement("small", "", label), characterSearchElement("strong", "", typeof value === "number" ? formatNumber(value) : value));
    stats.append(stat);
  }

  const skill = characterSearchElement("div", "character-search-skill");
  skill.append(
    characterSearchElement("strong", "", character.skillCategory && character.skillCategory !== "-" ? character.skillCategory : "スキルなし"),
    characterSearchElement("p", "", character.skillName || "スキル説明なし"),
  );

  const reasons = characterSearchElement("div", "character-search-reasons");
  reasons.append(characterSearchElement("strong", "", "この検索に合う理由"));
  const reasonList = characterSearchElement("ul");
  for (const reason of result.reasons.slice(0, 4)) reasonList.append(characterSearchElement("li", "", reason));
  reasons.append(reasonList);

  const actions = characterSearchElement("div", "character-search-actions");
  actions.append(
    createActionButton("IDをコピー", async (event) => {
      const copied = await copyText(String(character.id));
      event.currentTarget.textContent = copied ? "コピーしました" : "コピーできませんでした";
      setTimeout(() => { event.currentTarget.textContent = "IDをコピー"; }, 1400);
    }),
    createActionButton("対戦の必須へ", (event) => {
      if (appendCharacterId("requiredIds", character.id)) event.currentTarget.textContent = "追加しました";
    }),
    createActionButton("最軽装候補へ", (event) => {
      if (appendCharacterId("lightestCandidates", character.id)) event.currentTarget.textContent = "追加しました";
    }),
  );

  card.append(heading, meta, stats, skill, reasons, actions);
  return card;
}

function renderSearchIntro(resultRoot, characterCount) {
  const intro = characterSearchElement("div", "character-search-empty");
  intro.append(
    characterSearchElement("span", "character-search-empty-mark", "⌕"),
    characterSearchElement("h2", "", `${formatNumber(characterCount)}体から検索できます`),
    characterSearchElement("p", "", "名前、属性、スキル、地域、レアリティなどのキーワードを、空白で区切って入力してください。"),
  );
  resultRoot.replaceChildren(intro);
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

function renderSearchResults(resultRoot, response, visibleLimit, onLoadMore) {
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
  response.results.slice(0, visibleLimit).forEach((result, index) => grid.append(renderCharacterCard(result, index + 1)));
  fragment.append(grid);
  if (visibleLimit < response.total) {
    const loadMore = characterSearchElement("button", "button character-search-more", `さらに表示（残り${formatNumber(response.total - visibleLimit)}体）`);
    loadMore.type = "button";
    loadMore.addEventListener("click", onLoadMore);
    fragment.append(loadMore);
  }
  resultRoot.replaceChildren(fragment);
}

export function initializeCharacterSearch(root, initialCharacters) {
  if (!root) return { setCharacters() {}, search() {} };
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

  const renderCurrent = () => {
    renderSearchResults(resultRoot, response, visibleLimit, () => {
      visibleLimit += CHARACTER_SEARCH_PAGE_SIZE;
      renderCurrent();
    });
  };

  const runSearch = () => {
    const query = input.value.trim();
    visibleLimit = CHARACTER_SEARCH_PAGE_SIZE;
    if (!query) {
      response = null;
      renderSearchIntro(resultRoot, index.documents.length);
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
  setCharacters(initialCharacters);
  return { setCharacters, search: runSearch };
}
