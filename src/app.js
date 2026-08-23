import { DEFAULT_RULES, mergeRules, validateRules } from "./data/rules.js";
import { parseCharacterPayload } from "./data/characters.js";
import {
  loadCharacterDatabase,
  mergeCharacterDatabaseIntoCatalogue,
  saveCharacterDatabaseCharacter,
} from "./data/character-database.js";
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

const METAGAME_ACTIONS_REPOSITORY = "phwhite-OT/eigomonogatari-simulator";
const METAGAME_ACTIONS_WORKFLOW = "metagame-v7-cloud.yml";
const METAGAME_ACTIONS_POLL_INTERVAL_MS = 5 * 60 * 1000;

function metagameActionsElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metagameActionsEnvironmentLabel(input) {
  const [attributeKey = "", cost = ""] = String(input ?? "").split(":");
  const attributeLabel = {
    fire: "火",
    water: "水",
    wind: "風",
    "fire-water": "火水",
    "fire-wind": "火風",
    "water-wind": "水風",
    all: "全属性",
  }[attributeKey] ?? attributeKey;
  return cost ? `${attributeLabel}・コスト${cost}` : attributeLabel || "環境選択中";
}

function metagameActionsRunStateLabel(status) {
  return {
    completed: "完了",
    in_progress: "実行中",
    queued: "待機中",
    waiting: "待機中",
    pending: "待機中",
    requested: "開始待ち",
  }[status] ?? String(status || "状態不明");
}

function metagameActionsJobState(job) {
  if (job.status === "completed") {
    return job.conclusion === "success" ? "completed" : "failed";
  }
  if (job.status === "in_progress") return "running";
  return "waiting";
}

function metagameActionsEvaluationIdentity(job) {
  const stepName = (job.steps ?? [])
    .map((step) => String(step.name ?? ""))
    .find((name) => name.startsWith("Evaluate "));
  let match = stepName?.match(/^Evaluate (.+), position (\d+), shard ([^\s]+)$/);
  if (match) {
    return { input: match[1], position: Number(match[2]), shard: match[3] };
  }
  match = String(job.name ?? "").match(
    /^evaluate\s+\(([^,]+),\s*[^,]+,\s*(\d+),\s*([^,\s)]+)/i,
  );
  if (!match) return null;
  return { input: match[1], position: Number(match[2]), shard: match[3] };
}

function metagameActionsLiveRoot(root) {
  const container = root?.querySelector("[data-metagame-calculation-status]");
  if (!container) return null;
  let liveRoot = container.querySelector("[data-metagame-actions-live]");
  if (!liveRoot) {
    liveRoot = document.createElement("section");
    liveRoot.dataset.metagameActionsLive = "";
    container.append(liveRoot);
  }
  return liveRoot;
}

function renderMetagameActionsMessage(root, title, message, error = false) {
  const liveRoot = metagameActionsLiveRoot(root);
  if (!liveRoot) return;
  liveRoot.replaceChildren();
  const heading = metagameActionsElement("div", "metagame-calculation-heading");
  heading.append(
    metagameActionsElement("strong", "", "GitHub Actions ライブ進捗"),
    metagameActionsElement("span", "", title),
  );
  const note = metagameActionsElement(
    "p",
    "metagame-calculation-note",
    message,
  );
  if (error) note.setAttribute("role", "status");
  liveRoot.append(heading, note);
}

function renderMetagameActionsProgress(root, run, jobs, queuedRunExists) {
  const liveRoot = metagameActionsLiveRoot(root);
  if (!liveRoot) return;

  const evaluations = jobs
    .map((job) => ({ job, identity: metagameActionsEvaluationIdentity(job) }))
    .filter(({ identity }) => identity);
  const states = evaluations.map(({ job }) => metagameActionsJobState(job));
  const completed = states.filter((state) => state === "completed").length;
  const running = states.filter((state) => state === "running").length;
  const waiting = states.filter((state) => state === "waiting").length;
  const failed = states.filter((state) => state === "failed").length;
  const input = evaluations.find(({ identity }) => identity.input)?.identity.input ?? "";
  const byPosition = new Map();

  for (const { job, identity } of evaluations) {
    const current = byPosition.get(identity.position) ?? {
      total: 0,
      completed: 0,
      running: 0,
      waiting: 0,
      failed: 0,
    };
    current.total += 1;
    current[metagameActionsJobState(job)] += 1;
    byPosition.set(identity.position, current);
  }

  let phase = "環境選択中";
  if (evaluations.length) phase = metagameActionsEnvironmentLabel(input);
  const publishJob = jobs.find((job) => job.name === "publish");
  if (publishJob?.status === "in_progress") phase = "集計・保存中";

  const heading = metagameActionsElement("div", "metagame-calculation-heading");
  heading.append(
    metagameActionsElement("strong", "", "GitHub Actions ライブ進捗"),
    metagameActionsElement(
      "span",
      "",
      `Run #${run.run_number}・${metagameActionsRunStateLabel(run.status)}${queuedRunExists ? "・次Run待機あり" : ""}`,
    ),
  );

  const metrics = metagameActionsElement("div", "metagame-calculation-metrics");
  [
    ["現在", phase],
    ["シャード", evaluations.length ? `${completed}/${evaluations.length} 完了` : "準備中"],
    ["実行中", `${running}`],
    ["待機", `${waiting}`],
    ["失敗", `${failed}`],
    ["確認", new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date())],
  ].forEach(([label, value]) => {
    const metric = metagameActionsElement("div", "metagame-calculation-metric");
    metric.append(
      metagameActionsElement("span", "", label),
      metagameActionsElement("strong", "", value),
    );
    metrics.append(metric);
  });

  const positionText = [...byPosition.entries()]
    .sort(([left], [right]) => left - right)
    .map(([position, state]) => {
      const details = [
        state.running ? `実行${state.running}` : "",
        state.waiting ? `待機${state.waiting}` : "",
        state.failed ? `失敗${state.failed}` : "",
      ].filter(Boolean).join("・");
      return `${position}枠 ${state.completed}/${state.total}${details ? `（${details}）` : ""}`;
    })
    .join(" / ");

  const note = metagameActionsElement(
    "p",
    "metagame-calculation-note",
    positionText || (
      run.status === "queued"
        ? "前のV9 Runの終了待ちです。開始すると枠別シャード進捗を表示します。"
        : "select処理中です。評価ジョブが作成されると枠別シャード進捗を表示します。"
    ),
  );
  const link = document.createElement("a");
  link.href = String(run.html_url ?? "").startsWith("https://github.com/")
    ? run.html_url
    : `https://github.com/${METAGAME_ACTIONS_REPOSITORY}/actions`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "GitHub Actionsで開く";
  const methodology = metagameActionsElement(
    "p",
    "metagame-calculation-methodology",
    "公開GitHub APIを読み取るだけの表示です。計算の再実行・停止・書き込みは行いません。5分ごとに更新します。",
  );
  methodology.append(" ", link);

  liveRoot.replaceChildren(heading, metrics, note, methodology);
}

function initializeMetagameActionsProgress(root) {
  if (!root || typeof fetch !== "function") return;
  let refreshing = false;

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const cacheBust = Date.now();
      const base = `https://api.github.com/repos/${METAGAME_ACTIONS_REPOSITORY}`;
      const runsResponse = await fetch(
        `${base}/actions/workflows/${METAGAME_ACTIONS_WORKFLOW}/runs?branch=master&event=workflow_dispatch&per_page=20&_=${cacheBust}`,
        { cache: "no-store" },
      );
      if (!runsResponse.ok) throw new Error(`Runs API ${runsResponse.status}`);
      const runsPayload = await runsResponse.json();
      const v9Runs = (runsPayload.workflow_runs ?? []).filter((run) => (
        String(run.name ?? "").includes("Metagame V9 marginal-contribution")
      ));
      const run = v9Runs.find((candidate) => candidate.status === "in_progress")
        ?? v9Runs.find((candidate) => ["queued", "waiting", "pending", "requested"].includes(candidate.status))
        ?? v9Runs[0];

      if (!run) {
        renderMetagameActionsMessage(
          root,
          "V9実行なし",
          "V9のWorkflow Runが見つかりません。Actionsから計算を開始するとここに進捗を表示します。",
        );
        return;
      }

      const jobsResponse = await fetch(
        `${base}/actions/runs/${run.id}/jobs?per_page=100&_=${cacheBust}`,
        { cache: "no-store" },
      );
      if (!jobsResponse.ok) throw new Error(`Jobs API ${jobsResponse.status}`);
      const jobsPayload = await jobsResponse.json();
      const queuedRunExists = v9Runs.some((candidate) => (
        candidate.id !== run.id
        && ["queued", "waiting", "pending", "requested"].includes(candidate.status)
      ));
      renderMetagameActionsProgress(root, run, jobsPayload.jobs ?? [], queuedRunExists);
    } catch (error) {
      console.warn("Metagame Actions live progress is unavailable.", error);
      renderMetagameActionsMessage(
        root,
        "取得できません",
        "GitHub APIの一時的な制限または通信エラーでライブ進捗を取得できません。保存済みの環境データ表示には影響しません。",
        true,
      );
    } finally {
      refreshing = false;
    }
  };

  renderMetagameActionsMessage(root, "確認中", "現在のV9 Workflow Runを確認しています。");
  void refresh();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, METAGAME_ACTIONS_POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
}

function combineCharacters(...characterLists) {
  return mergeCharacterDatabaseIntoCatalogue(characterLists[0], characterLists.slice(1).flat());
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
  let metagameController = null;
  let databaseClient = null;
  let characterDatabaseRevision = 0;
  let administratorAccess = false;

  // Database records are either additions or overrides made from this app.
  // The metagame evaluator must treat them as live data instead of silently
  // falling back to a bundle that was rated before the edit existed.
  const metagameAutomaticCharacterIds = () => databaseCharacters.map((character) => String(character.id));

  const refreshData = () => {
    hydrateCharacterOptions(form, characters);
    const databaseLabel = databaseCharacters.length ? ` + 管理DB${databaseCharacters.length.toLocaleString("ja-JP")}体` : "";
    updateDataSummary(dataSummary, characters, sourceLabel + databaseLabel);
    characterSearchController?.setCharacters(characters);
    lightestController?.setCharacters(characters);
    deckCharacterPickerController?.setCharacters(characters);
    metagameController?.setCharacters(characters, {
      automaticCharacterIds: metagameAutomaticCharacterIds(),
    });
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
    databaseCharacters = [
      ...databaseCharacters.filter((item) => String(item.id) !== String(savedCharacter.id)),
      savedCharacter,
    ];
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
    onAddCharacterAtPosition: (anchor, position) => characterEditorController?.openAtPosition(anchor, position),
  });
  metagameController = initializeMetagameSimulator(metagameRoot, METAGAME_SIMULATOR_DATA, characters, {
    automaticCharacterIds: metagameAutomaticCharacterIds(),
  });
  initializeMetagameActionsProgress(metagameRoot);
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
