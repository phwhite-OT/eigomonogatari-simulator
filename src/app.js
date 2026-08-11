import { DEFAULT_RULES, mergeRules, validateRules } from "./data/rules.js";
import { parseCharacterPayload } from "./data/characters.js";
import { CHARACTER_CATALOG, CHARACTER_CATALOG_SUMMARY } from "./data/character-catalog.js";
import { METAGAME_SIMULATOR_DATA } from "./data/metagame-simulator-data.js";
import { searchDecks } from "./core/search-fast.js";
import { findBestMetagameDeck } from "./core/metagame-deck.js";
import { findLightestDeck, simulateLightestStage } from "./core/lightest.js";
import { solveExactLightestStage } from "./core/lightest-exact.js";
import { createCharacterSearchIndex, parseCharacterSearchQuery, searchCharacters } from "./core/character-search.js";
import {
  hydrateCharacterOptions,
  initializeDeckCharacterPicker,
  initializeStaticOptions,
  readConstraints,
  updateDataSummary,
} from "./ui/form.js";
import {
  renderCancelled,
  renderError,
  renderIdle,
  renderResults,
  updateProgress,
} from "./ui/result.js";
import { initializeMetagameSimulator } from "./ui/metagame-simulator.js";
import { initializeLightest } from "./ui/lightest.js";
import { initializeCharacterSearch } from "./ui/character-search.js";
import { initializeCharacterEditor } from "./ui/character-editor.js";
import { initializeAppTabs } from "./ui/tabs.js";
import { initializeSupabaseAuth } from "./auth/supabase-auth.js";

const MANUAL_CHARACTERS_STORAGE_KEY = "eigo-deck-compass.manual-characters.v1";

function loadManualCharacters() {
  try {
    const raw = localStorage.getItem(MANUAL_CHARACTERS_STORAGE_KEY);
    return raw ? parseCharacterPayload(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveManualCharacters(characters) {
  try {
    localStorage.setItem(MANUAL_CHARACTERS_STORAGE_KEY, JSON.stringify(characters));
  } catch {
  }
}

function combineCharacters(baseCharacters, manualCharacters) {
  const ids = new Set();
  return [...baseCharacters, ...manualCharacters].filter((character) => {
    const id = String(character.id);
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}
function bootstrap() {
  const initializeAuthWhenAvailable = () => void initializeSupabaseAuth();
  if (globalThis.supabase?.createClient) initializeAuthWhenAvailable();
  else window.addEventListener("eigo-supabase-ready", initializeAuthWhenAvailable, { once: true });
  const form = document.querySelector("[data-search-form]");
  const dataSummary = document.querySelector("[data-data-summary]");
  const resultRoot = document.querySelector("[data-results]");
  const progressRoot = document.querySelector("[data-progress]");
  const metagameRoot = document.querySelector("[data-metagame-simulator]");
  const lightestRoot = document.querySelector("[data-lightest-root]");
  const characterSearchRoot = document.querySelector("[data-character-search-root]");
  const characterEditor = document.querySelector("[data-character-editor]");
  const rulesEditor = form.elements.rulesJson;
  const searchButton = form.querySelector("[data-search-button]");
  const cancelButton = form.querySelector("[data-cancel-button]");
  const fileInput = document.querySelector("[data-character-file]");
  const resetDataButton = document.querySelector("[data-reset-demo]");
  const bundledSourceLabel = `Book1.xlsx＋手動補完データ（${CHARACTER_CATALOG_SUMMARY.totalCharacters.toLocaleString("ja-JP")}体）`;
  let baseCharacters = [...CHARACTER_CATALOG];
  let manualCharacters = loadManualCharacters();
  let characters = combineCharacters(baseCharacters, manualCharacters);
  let sourceLabel = bundledSourceLabel;
  let abortController = null;
  let characterSearchController = null;
  let lightestController = null;
  let deckCharacterPickerController = null;

  const refreshData = () => {
    hydrateCharacterOptions(form, characters);
    const manualLabel = manualCharacters.length ? ` + 手入力${manualCharacters.length.toLocaleString("ja-JP")}体` : "";
    updateDataSummary(dataSummary, characters, sourceLabel + manualLabel);
    characterSearchController?.setCharacters(characters);
    lightestController?.setCharacters(characters);
    deckCharacterPickerController?.setCharacters(characters);
  };

  const setBusy = (busy) => {
    searchButton.disabled = busy;
    cancelButton.hidden = !busy;
    fileInput.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    if (!busy) progressRoot.hidden = true;
  };

  initializeStaticOptions(form);
  initializeAppTabs(document);
  deckCharacterPickerController = initializeDeckCharacterPicker(form, characters);
  characterSearchController = initializeCharacterSearch(characterSearchRoot, characters);
  initializeMetagameSimulator(metagameRoot, METAGAME_SIMULATOR_DATA, CHARACTER_CATALOG);
  lightestController = initializeLightest(lightestRoot, characters);
  initializeCharacterEditor(characterEditor, {
    getExistingIds: () => characters.map((character) => character.id),
    onAdd: (character) => {
      manualCharacters = [...manualCharacters, character];
      saveManualCharacters(manualCharacters);
      characters = combineCharacters(baseCharacters, manualCharacters);
      refreshData();
      renderIdle(resultRoot);
    },
  });
  resetDataButton.textContent = "収録データへ戻す";
  rulesEditor.value = JSON.stringify({
    damage: DEFAULT_RULES.damage,
    position: DEFAULT_RULES.position,
    continuousEffectDiscounts: DEFAULT_RULES.continuousEffectDiscounts,
    simulation: DEFAULT_RULES.simulation,
  }, null, 2);
  refreshData();
  renderIdle(resultRoot);

  fileInput.addEventListener("change", async () => {
    const [file] = fileInput.files;
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      baseCharacters = parseCharacterPayload(payload);
      characters = combineCharacters(baseCharacters, manualCharacters);
      sourceLabel = file.name;
      refreshData();
      renderIdle(resultRoot);
    } catch (error) {
      renderError(resultRoot, String(error.message).split("\n"));
      fileInput.value = "";
    }
  });

  resetDataButton.addEventListener("click", () => {
    baseCharacters = [...CHARACTER_CATALOG];
    characters = combineCharacters(baseCharacters, manualCharacters);
    sourceLabel = bundledSourceLabel;
    fileInput.value = "";
    refreshData();
    renderIdle(resultRoot);
  });

  cancelButton.addEventListener("click", () => abortController?.abort());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let rules;
    try {
      const overrides = JSON.parse(rulesEditor.value || "{}");
      rules = mergeRules(DEFAULT_RULES, overrides);
    } catch (error) {
      renderError(resultRoot, [`ルール設定JSONを解析できません: ${error.message}`]);
      return;
    }
    const ruleErrors = validateRules(rules);
    if (ruleErrors.length) {
      renderError(resultRoot, ruleErrors);
      return;
    }

    abortController = new AbortController();
    setBusy(true);
    resultRoot.replaceChildren();
    const loading = document.createElement("section");
    loading.className = "message-panel";
    const heading = document.createElement("h2");
    heading.textContent = "探索を開始しました";
    const copy = document.createElement("p");
    copy.textContent = "画面を固めないよう、処理を小分けにして進めます。";
    loading.append(heading, copy);
    resultRoot.append(loading);

    try {
      const searchResult = await searchDecks(characters, readConstraints(form), rules, {
        signal: abortController.signal,
        onProgress: (progress) => updateProgress(progressRoot, progress),
      });
      if (searchResult.errors.length) renderError(resultRoot, searchResult.errors);
      else renderResults(resultRoot, searchResult);
    } catch (error) {
      if (error.name === "AbortError") renderCancelled(resultRoot);
      else renderError(resultRoot, [error.message ?? String(error)]);
    } finally {
      abortController = null;
      setBusy(false);
    }
  });

  window.EigoDeckApp = Object.freeze({
    version: "0.1.0",
    searchDecks,
    findBestMetagameDeck,
    findLightestDeck,
    simulateLightestStage,
    solveExactLightestStage,
    createCharacterSearchIndex,
    parseCharacterSearchQuery,
    searchCharacters,
    metagameSimulatorData: METAGAME_SIMULATOR_DATA,
    parseCharacterPayload,
    defaultRules: DEFAULT_RULES,
    bundledCharacters: CHARACTER_CATALOG,
    dataSummary: CHARACTER_CATALOG_SUMMARY,
    currentCharacters: () => [...characters],
  });
}

try {
  bootstrap();
} catch (error) {
  const resultRoot = document.querySelector("[data-metagame-result]");
  if (resultRoot) {
    resultRoot.textContent = `対戦デッキ機能の初期化に失敗しました: ${error.message ?? String(error)}`;
  }
  console.error(error);
}
