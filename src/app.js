import { DEFAULT_RULES, mergeRules, validateRules } from "./data/rules.js";
import { parseCharacterPayload } from "./data/characters.js";
import { loadCharacterDatabase, saveCharacterDatabaseCharacter } from "./data/character-database.js";
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
import { isAdministratorSession } from "./auth/admin.js";

function combineCharacters(...characterLists) {
  const charactersById = new Map();
  for (const characters of characterLists) {
    for (const character of characters) charactersById.set(String(character.id), character);
  }
  return [...charactersById.values()];
}
function bootstrap() {
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
  const characterDatabaseNotice = document.querySelector("[data-character-database-notice]");
  const characterDatabaseAdminControls = document.querySelectorAll("[data-character-database-admin]");
  const bundledSourceLabel = `Book1.xlsx＋手動補完データ（${CHARACTER_CATALOG_SUMMARY.totalCharacters.toLocaleString("ja-JP")}体）`;
  let baseCharacters = [...CHARACTER_CATALOG];
  let databaseCharacters = [];
  let characters = combineCharacters(baseCharacters, databaseCharacters);
  let sourceLabel = bundledSourceLabel;
  let abortController = null;
  let characterSearchController = null;
  let characterEditorController = null;
  let lightestController = null;
  let deckCharacterPickerController = null;
  let databaseClient = null;
  let characterDatabaseRevision = 0;
  let administratorAccess = false;

  const refreshData = () => {
    hydrateCharacterOptions(form, characters);
    const databaseLabel = databaseCharacters.length ? ` + 管理DB${databaseCharacters.length.toLocaleString("ja-JP")}体` : "";
    updateDataSummary(dataSummary, characters, sourceLabel + databaseLabel);
    characterSearchController?.setCharacters(characters);
    lightestController?.setCharacters(characters);
    deckCharacterPickerController?.setCharacters(characters);
  };

  const tabsController = initializeAppTabs(document, { initialAccess: { lightest: false } });
  const applyAdministratorAccess = (session) => {
    const isAdministrator = isAdministratorSession(session);
    administratorAccess = isAdministrator;
    tabsController.setAccess("lightest", isAdministrator);
    characterSearchController?.setLightestAvailable(isAdministrator);
    characterSearchController?.setCharacterDatabaseAccess(isAdministrator);
    characterDatabaseAdminControls.forEach((control) => { control.hidden = !isAdministrator; });
    fileInput.disabled = !isAdministrator;
    resetDataButton.disabled = !isAdministrator;
    if (characterDatabaseNotice) {
      characterDatabaseNotice.textContent = isAdministrator
        ? "管理者としてログイン中です。キャラの追加・編集はキャラデータベースへ保存されます。"
        : "キャラデータベースの追加・編集は管理者アカウント専用です。";
    }
    if (isAdministrator && !lightestController) {
      lightestController = initializeLightest(lightestRoot, characters);
    }
    if (databaseClient) void refreshCharacterDatabase();
  };

  const setBusy = (busy) => {
    searchButton.disabled = busy;
    cancelButton.hidden = !busy;
    fileInput.disabled = busy || !administratorAccess;
    resetDataButton.disabled = busy || !administratorAccess;
    form.setAttribute("aria-busy", String(busy));
    if (!busy) progressRoot.hidden = true;
  };

  const persistCharacterDatabaseEntry = async (character) => {
    if (!administratorAccess) throw new Error("キャラデータベースの追加・編集は管理者アカウント専用です。");
    if (!databaseClient) throw new Error("キャラデータベースへの接続を準備中です。少し待ってからもう一度保存してください。");
    const savedCharacter = await saveCharacterDatabaseCharacter(databaseClient, character);
    characterDatabaseRevision += 1;
    databaseCharacters = combineCharacters(
      databaseCharacters.filter((item) => String(item.id) !== String(savedCharacter.id)),
      [savedCharacter],
    );
    characters = combineCharacters(baseCharacters, databaseCharacters);
    refreshData();
    renderIdle(resultRoot);
    if (characterDatabaseNotice) {
      characterDatabaseNotice.textContent = `キャラデータベースへ保存しました（管理DB ${databaseCharacters.length.toLocaleString("ja-JP")}体）。`;
    }
  };

  async function refreshCharacterDatabase() {
    if (!databaseClient) return;
    const revision = ++characterDatabaseRevision;
    try {
      const loadedCharacters = await loadCharacterDatabase(databaseClient);
      if (revision !== characterDatabaseRevision) return;
      databaseCharacters = loadedCharacters;
      characters = combineCharacters(baseCharacters, databaseCharacters);
      refreshData();
      if (administratorAccess && characterDatabaseNotice) {
        characterDatabaseNotice.textContent = `キャラデータベースを同期しました（管理DB ${databaseCharacters.length.toLocaleString("ja-JP")}体）。`;
      }
    } catch (error) {
      console.warn("Character database is unavailable.", error);
      if (administratorAccess && characterDatabaseNotice) {
        characterDatabaseNotice.textContent = "キャラデータベースを読み込めません。Supabaseのマイグレーション適用後に再読み込みしてください。";
      }
    }
  }

  initializeStaticOptions(form);
  deckCharacterPickerController = initializeDeckCharacterPicker(form, characters);
  characterSearchController = initializeCharacterSearch(characterSearchRoot, characters, {
    lightestAvailable: false,
    characterDatabaseAccess: false,
    onEditCharacter: (character) => characterEditorController?.openForEdit(character),
  });
  initializeMetagameSimulator(metagameRoot, METAGAME_SIMULATOR_DATA, CHARACTER_CATALOG);
  characterEditorController = initializeCharacterEditor(characterEditor, {
    getExistingIds: () => characters.map((character) => character.id),
    isAllowed: () => administratorAccess,
    onAdd: persistCharacterDatabaseEntry,
    onEdit: persistCharacterDatabaseEntry,
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

  const initializeAuthWhenAvailable = () => void (async () => {
    const auth = await initializeSupabaseAuth(document, {
      onSessionChange: applyAdministratorAccess,
    });
    if (!auth?.client) return;
    databaseClient = auth.client;
    await refreshCharacterDatabase();
  })();
  if (globalThis.supabase?.createClient) initializeAuthWhenAvailable();
  else window.addEventListener("eigo-supabase-ready", initializeAuthWhenAvailable, { once: true });

  fileInput.addEventListener("change", async () => {
    if (!administratorAccess) return;
    const [file] = fileInput.files;
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      baseCharacters = parseCharacterPayload(payload);
      characters = combineCharacters(baseCharacters, databaseCharacters);
      sourceLabel = file.name;
      refreshData();
      renderIdle(resultRoot);
    } catch (error) {
      renderError(resultRoot, String(error.message).split("\n"));
      fileInput.value = "";
    }
  });

  resetDataButton.addEventListener("click", () => {
    if (!administratorAccess) return;
    baseCharacters = [...CHARACTER_CATALOG];
    characters = combineCharacters(baseCharacters, databaseCharacters);
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
    findLightestDeck: (...args) => {
      if (!administratorAccess) throw new Error("最軽装機能は管理者アカウント専用です。");
      return findLightestDeck(...args);
    },
    simulateLightestStage: (...args) => {
      if (!administratorAccess) throw new Error("最軽装機能は管理者アカウント専用です。");
      return simulateLightestStage(...args);
    },
    solveExactLightestStage: (...args) => {
      if (!administratorAccess) throw new Error("最軽装機能は管理者アカウント専用です。");
      return solveExactLightestStage(...args);
    },
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
