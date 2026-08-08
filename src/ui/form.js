import { ATTRIBUTES, ATTRIBUTE_CLASS_LABELS } from "../data/rules.js";
import { ROLE_TAGS } from "../data/characters.js";
import { normalizeConstraints } from "../core/filter.js";
import { createCharacterSearchIndex, searchCharacters } from "../core/character-search.js";


function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((left, right) => left.localeCompare(right, "ja"));
}

function readChecked(form, name) {
  return [...form.querySelectorAll(`[name="${name}"]:checked`)].map((input) => input.value);
}

function parseList(value) {
  return [...new Set(String(value ?? "").split(/[\s,、]+/).map((item) => item.trim()).filter(Boolean))];
}

function replaceOptions(select, options, placeholder) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.append(empty);
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
}

export function initializeStaticOptions(form) {
  const roleSelect = form.elements.requiredRole;
  replaceOptions(
    roleSelect,
    ROLE_TAGS.map((role) => ({ value: role, label: role })),
    "指定なし",
  );

  for (const groupName of ["allowedAttributes", "forbiddenAttributes"]) {
    const container = form.querySelector(`[data-attribute-group="${groupName}"]`);
    container.replaceChildren();
    for (const attribute of ATTRIBUTES) {
      const label = document.createElement("label");
      label.className = `attribute-chip attribute-${attribute}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = groupName;
      input.value = attribute;
      if (groupName === "allowedAttributes") input.checked = true;
      const text = document.createElement("span");
      text.textContent = ATTRIBUTE_CLASS_LABELS[attribute] ?? attribute;
      label.append(input, text);
      container.append(label);
    }
  }
}

export function hydrateCharacterOptions(form, characters) {
  const rarityList = form.querySelector("[data-rarity-list]");
  rarityList.replaceChildren();
  for (const rarity of uniqueSorted(characters.map((character) => character.rarity))) {
    const option = document.createElement("option");
    option.value = rarity;
    rarityList.append(option);
  }

  const regionList = form.querySelector("[data-region-list]");
  regionList.replaceChildren();
  for (const region of uniqueSorted(characters.map((character) => character.region))) {
    const option = document.createElement("option");
    option.value = region;
    regionList.append(option);
  }
}

function formElement(tagName, className = "", textContent = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent) element.textContent = textContent;
  return element;
}

function fieldIds(field) {
  return parseList(field?.value);
}

function setFieldIds(field, values) {
  field.value = [...new Set(values.map(String).filter(Boolean))].join(", ");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function removeFieldId(field, characterId) {
  setFieldIds(field, fieldIds(field).filter((id) => id !== String(characterId)));
}

function fixedTargetPosition(target) {
  const match = /^fixed:(\d+)$/.exec(target ?? "");
  return match ? Number(match[1]) : null;
}

export function initializeDeckCharacterPicker(form, initialCharacters) {
  const selectionRoot = form.querySelector("[data-deck-character-selection]");
  const fixedPositionList = form.querySelector("[data-fixed-position-list]");
  const picker = form.querySelector("[data-deck-character-picker]");
  if (!selectionRoot || !fixedPositionList || !picker) return { setCharacters() {} };

  const requiredInput = form.elements.requiredIds;
  const forbiddenInput = form.elements.forbiddenIds;
  const pickerHeading = picker.querySelector("[data-deck-character-picker-heading]");
  const pickerClose = picker.querySelector("[data-deck-character-picker-close]");
  const pickerQuery = picker.querySelector("[data-deck-character-picker-query]");
  const pickerSearch = picker.querySelector("[data-deck-character-picker-search]");
  const pickerResults = picker.querySelector("[data-deck-character-picker-results]");
  const fixedPositionFields = [...form.querySelectorAll("[data-fixed-position]")]
    .sort((left, right) => Number(left.dataset.fixedPosition) - Number(right.dataset.fixedPosition));
  let charactersById = new Map();
  let characterSearchIndex = createCharacterSearchIndex([]);
  let pickerTarget = null;
  let pickerSearchTimer = null;

  const selectedCharacter = (characterId) => charactersById.get(String(characterId)) ?? {
    id: String(characterId),
    name: `ID ${characterId}`,
  };
  const renderChips = (target, field, emptyLabel) => {
    const container = selectionRoot.querySelector(`[data-deck-character-selection-chips="${target}"]`);
    container.replaceChildren();
    const ids = fieldIds(field);
    if (!ids.length) {
      container.append(formElement("span", "deck-character-selection-empty", emptyLabel));
      return;
    }
    for (const characterId of ids) {
      const character = selectedCharacter(characterId);
      const chip = formElement("span", "deck-character-selection-chip");
      const name = formElement("strong", "", character.name);
      const remove = formElement("button", "", "×");
      remove.type = "button";
      remove.ariaLabel = `${character.name}を解除`;
      remove.addEventListener("click", () => removeFieldId(field, characterId));
      chip.append(name, remove);
      container.append(chip);
    }
  };
  const renderFixedPositions = () => {
    fixedPositionList.replaceChildren();
    for (const field of fixedPositionFields) {
      const position = Number(field.dataset.fixedPosition);
      const character = field.value ? selectedCharacter(field.value) : null;
      const card = formElement("section", "deck-fixed-position");
      const heading = formElement("div", "deck-fixed-position-heading");
      heading.append(
        formElement("strong", "", `${position}枠目`),
        formElement("small", "", character ? character.name : "固定なし"),
      );
      const select = formElement("button", "button button-ghost", character ? "キャラを変更" : "キャラを検索");
      select.type = "button";
      select.addEventListener("click", () => openPicker(`fixed:${position}`));
      card.append(heading, select);
      if (character) {
        const clear = formElement("button", "button button-ghost", "固定解除");
        clear.type = "button";
        clear.addEventListener("click", () => {
          field.value = "";
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
        card.append(clear);
      }
      fixedPositionList.append(card);
    }
  };
  const renderSelections = () => {
    renderChips("required", requiredInput, "まだ指定されていません");
    renderChips("forbidden", forbiddenInput, "まだ指定されていません");
    renderFixedPositions();
  };
  const pickerTargetLabel = () => {
    if (pickerTarget === "required") return "必須キャラを検索";
    if (pickerTarget === "forbidden") return "禁止キャラを検索";
    const position = fixedTargetPosition(pickerTarget);
    return position ? `${position}枠目の固定キャラを検索` : "キャラを検索";
  };
  const renderPickerMessage = (message) => {
    pickerResults.replaceChildren(formElement("p", "deck-character-picker-message", message));
  };
  const fixedField = (position) => fixedPositionFields.find((field) => Number(field.dataset.fixedPosition) === position);
  const isFixedElsewhere = (characterId, position) => !form.elements.allowDuplicates.checked && fixedPositionFields.some((field) => (
    Number(field.dataset.fixedPosition) !== position && field.value === String(characterId)
  ));
  const addCharacter = (character) => {
    const characterId = String(character.id);
    if (pickerTarget === "required") {
      removeFieldId(forbiddenInput, characterId);
      setFieldIds(requiredInput, [...fieldIds(requiredInput), characterId]);
      renderPickerResults();
      return;
    }
    if (pickerTarget === "forbidden") {
      removeFieldId(requiredInput, characterId);
      for (const field of fixedPositionFields) {
        if (field.value === characterId) field.value = "";
      }
      setFieldIds(forbiddenInput, [...fieldIds(forbiddenInput), characterId]);
      renderSelections();
      renderPickerResults();
      return;
    }
    const position = fixedTargetPosition(pickerTarget);
    const field = fixedField(position);
    if (!field || isFixedElsewhere(characterId, position)) return;
    removeFieldId(forbiddenInput, characterId);
    field.value = characterId;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    picker.hidden = true;
    pickerTarget = null;
  };
  const renderPickerResults = () => {
    const query = pickerQuery.value.trim();
    if (!query) {
      renderPickerMessage("名前・属性・スキルなどで検索してください。例: 火 回復 / 低コスト 蘇生");
      return;
    }
    const response = searchCharacters(characterSearchIndex, query, { limit: 18 });
    if (!response.total) {
      renderPickerMessage("一致するキャラがありません。キーワードを短くして試してください。");
      return;
    }
    const list = formElement("div", "deck-character-picker-results");
    for (const result of response.results) {
      const character = result.character;
      const card = formElement("article", "deck-character-picker-result");
      card.append(
        formElement("strong", "", character.name),
        formElement("small", "", `${result.attributeLabel}・${character.rarity}・cost ${character.cost}・${character.skillTurn}T`),
        formElement("p", "", character.skillName || "スキルなし"),
      );
      const select = formElement("button", "", "追加");
      select.type = "button";
      const position = fixedTargetPosition(pickerTarget);
      const alreadySelected = pickerTarget === "required"
        ? fieldIds(requiredInput).includes(String(character.id))
        : pickerTarget === "forbidden"
          ? fieldIds(forbiddenInput).includes(String(character.id))
          : position && fixedField(position)?.value === String(character.id);
      if (alreadySelected) {
        select.disabled = true;
        select.textContent = "選択済み";
      } else if (position && isFixedElsewhere(character.id, position)) {
        select.disabled = true;
        select.textContent = "別枠で固定済み";
      } else if (pickerTarget === "required") select.textContent = "必須へ追加";
      else if (pickerTarget === "forbidden") select.textContent = "禁止へ追加";
      else select.textContent = `${position}枠目に固定`;
      select.addEventListener("click", () => addCharacter(character));
      card.append(select);
      list.append(card);
    }
    pickerResults.replaceChildren(list);
  };
  const openPicker = (target) => {
    pickerTarget = target;
    picker.hidden = false;
    pickerHeading.textContent = pickerTargetLabel();
    pickerQuery.value = "";
    renderPickerResults();
    pickerQuery.focus();
  };

  selectionRoot.querySelectorAll("[data-deck-character-picker-open]").forEach((button) => {
    button.addEventListener("click", () => openPicker(button.dataset.deckCharacterPickerOpen));
  });
  pickerClose.addEventListener("click", () => {
    picker.hidden = true;
    pickerTarget = null;
  });
  pickerSearch.addEventListener("click", renderPickerResults);
  pickerQuery.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    renderPickerResults();
  });
  pickerQuery.addEventListener("input", () => {
    clearTimeout(pickerSearchTimer);
    pickerSearchTimer = setTimeout(renderPickerResults, 120);
  });
  [requiredInput, forbiddenInput, ...fixedPositionFields].forEach((field) => {
    field.addEventListener("input", renderSelections);
  });
  form.elements.allowDuplicates.addEventListener("change", () => {
    if (!picker.hidden) renderPickerResults();
  });

  const setCharacters = (characters) => {
    const nextCharacters = Array.isArray(characters) ? characters : [];
    charactersById = new Map(nextCharacters.map((character) => [String(character.id), character]));
    characterSearchIndex = createCharacterSearchIndex(nextCharacters);
    renderSelections();
    if (!picker.hidden) renderPickerResults();
  };
  setCharacters(initialCharacters);
  return { setCharacters };
}

export function readConstraints(form) {
  const fixedPositions = {};
  for (const select of form.querySelectorAll("[data-fixed-position]")) {
    if (select.value) fixedPositions[select.dataset.fixedPosition] = select.value;
  }
  return normalizeConstraints({
    totalCost: form.elements.totalCost.value,
    deckSize: form.elements.deckSize.value,
    allowedAttributes: readChecked(form, "allowedAttributes"),
    forbiddenAttributes: readChecked(form, "forbiddenAttributes"),
    allowDuplicates: form.elements.allowDuplicates.checked,
    ownedOnly: form.elements.ownedOnly.checked,
    requiredIds: parseList(form.elements.requiredIds.value),
    forbiddenIds: parseList(form.elements.forbiddenIds.value),
    fixedPositions,
    requiredRole: form.elements.requiredRole.value,
    rarities: parseList(form.elements.rarities.value),
    regions: parseList(form.elements.regions.value),
    mode: form.elements.mode.value,
    includeLow: form.elements.includeLow.checked,
    debugIncludeExcluded: form.elements.debugIncludeExcluded.checked,
  });
}

export function updateDataSummary(container, characters, sourceLabel) {
  const tiers = Object.groupBy(characters, (character) => character.pvpTier);
  const owned = characters.filter((character) => character.owned).length;
  container.querySelector("[data-data-source]").textContent = sourceLabel;
  container.querySelector("[data-character-count]").textContent = characters.length.toLocaleString("ja-JP");
  container.querySelector("[data-owned-count]").textContent = owned.toLocaleString("ja-JP");
  container.querySelector("[data-priority-count]").textContent = (tiers.priority?.length ?? 0).toLocaleString("ja-JP");
}
