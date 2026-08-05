import { ATTRIBUTES, ATTRIBUTE_CLASS_LABELS } from "../data/rules.js";
import { ROLE_TAGS } from "../data/characters.js";
import { normalizeConstraints } from "../core/filter.js";


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
  const options = characters.map((character) => ({
    value: String(character.id),
    label: `${character.name}（ID: ${character.id} / ${character.cost}）`,
  }));
  for (const select of form.querySelectorAll("[data-fixed-position]")) {
    const currentValue = select.value;
    replaceOptions(select, options, `${select.dataset.fixedPosition}枠目：指定なし`);
    if (options.some((option) => option.value === currentValue)) select.value = currentValue;
  }

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
