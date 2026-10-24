import {
  findBestMetagameDeckIncrementalLive,
  hasMetagameLiveCharacters,
  metagameLiveQueryFingerprint,
} from "../core/metagame-live.js";

const metagameBrowserKnowledgePromises = new Map();
const metagameIncrementalResultCache = new Map();
const metagameExactSearchResultCache = new Map();

function metagameV12Model(value) {
  return /^team-battle-v12(?:\.|$)/.test(String(value ?? ""));
}

function metagameBrowserKnowledgePath(constraint) {
  const directory = String(constraint?.id ?? "").replaceAll(":", "-");
  return directory ? `./metagame-knowledge/${directory}.json` : null;
}

async function loadMetagameBrowserKnowledge(constraint) {
  const path = metagameBrowserKnowledgePath(constraint);
  if (!path || typeof globalThis.fetch !== "function") return null;
  if (!metagameBrowserKnowledgePromises.has(path)) {
    metagameBrowserKnowledgePromises.set(path, (async () => {
      try {
        const response = await globalThis.fetch(path, { cache: "force-cache" });
        if (!response.ok) return null;
        const knowledge = await response.json();
        if (String(knowledge?.inputId ?? "") !== String(constraint?.id ?? "")) return null;
        if (
          knowledge?.modelVersion &&
          constraint?.modelVersion &&
          String(knowledge.modelVersion) !== String(constraint.modelVersion)
        ) return null;
        return knowledge;
      } catch {
        return null;
      }
    })());
  }
  return metagameBrowserKnowledgePromises.get(path);
}


function metagameKnowledgeNumber(left, right, weight, fallback = 0) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * weight;
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return fallback;
}

function metagameInterpolateKnowledgeEntry(lower, upper, weight, numericKeys) {
  if (!lower) return upper ? { ...upper } : null;
  if (!upper) return { ...lower };
  const base = weight < 0.5 ? lower : upper;
  const merged = { ...base };
  for (const key of numericKeys) {
    if (Number.isFinite(Number(lower?.[key])) || Number.isFinite(Number(upper?.[key]))) {
      merged[key] = metagameKnowledgeNumber(lower?.[key], upper?.[key], weight);
    }
  }
  return merged;
}

function metagameMergeKnowledgeLists(lowerEntries, upperEntries, weight, keyFor, numericKeys) {
  const lower = new Map((lowerEntries ?? []).map((entry) => [keyFor(entry), entry]));
  const upper = new Map((upperEntries ?? []).map((entry) => [keyFor(entry), entry]));
  return [...new Set([...lower.keys(), ...upper.keys()])]
    .map((key) => metagameInterpolateKnowledgeEntry(lower.get(key), upper.get(key), weight, numericKeys))
    .filter(Boolean);
}

function metagameMergeRepresentativeScenarios(lower, upper) {
  const lowerCount = Math.max(0, Number(lower?.context?.scenarioCount) || 0);
  const result = {};
  for (const size of [6, 12, 18]) {
    const lowerIndices = lower?.representativeScenarios?.[size]?.indices ?? [];
    const upperIndices = upper?.representativeScenarios?.[size]?.indices ?? [];
    const lowerTarget = Math.ceil(size / 2);
    const upperTarget = Math.floor(size / 2);
    const selected = [
      ...lowerIndices.slice(0, lowerTarget).map(Number),
      ...upperIndices.slice(0, upperTarget).map((index) => lowerCount + Number(index)),
    ].filter(Number.isFinite);
    if (selected.length) result[size] = { indices: [...new Set(selected)].slice(0, size) };
  }
  return result;
}

function metagameMergeBoostKnowledge(lower, upper, weight) {
  const priors = metagameMergeKnowledgeLists(
    lower?.boostModel?.priors,
    upper?.boostModel?.priors,
    weight,
    (entry) => `${Number(entry.p)}:${String(entry.i)}`,
    ["n", "w", "l", "m", "r"],
  );
  if (!priors.length) return null;
  return {
    multiplier: metagameKnowledgeNumber(
      lower?.boostModel?.multiplier,
      upper?.boostModel?.multiplier,
      weight,
      1.5,
    ),
    candidateCount: priors.length,
    priors,
  };
}

function metagameMergeBrowserKnowledge(lower, upper, interpolation) {
  if (!lower) return upper;
  if (!upper) return lower;
  const weight = Math.min(1, Math.max(0,
    (Number(interpolation.requestedCost) - Number(interpolation.lowerCost)) /
      Math.max(1, Number(interpolation.upperCost) - Number(interpolation.lowerCost)),
  ));
  return {
    schemaVersion: Math.max(Number(lower.schemaVersion) || 1, Number(upper.schemaVersion) || 1, 2),
    generatedAt: [lower.generatedAt, upper.generatedAt].filter(Boolean).join(" / "),
    inputId: `${String(lower.inputId)}+${String(upper.inputId)}@${interpolation.requestedCost}`,
    modelVersion: lower.modelVersion ?? upper.modelVersion,
    context: {
      totalCost: Number(interpolation.requestedCost),
      scenarioCount: (Number(lower?.context?.scenarioCount) || 0) + (Number(upper?.context?.scenarioCount) || 0),
      interpolation,
      sourceConditions: [lower.inputId, upper.inputId],
    },
    representativeScenarios: metagameMergeRepresentativeScenarios(lower, upper),
    candidatePriors: metagameMergeKnowledgeLists(
      lower.candidatePriors,
      upper.candidatePriors,
      weight,
      (entry) => `${Number(entry.p)}:${String(entry.i)}`,
      ["c", "w", "l", "m", "r", "s", "x", "q", "f", "t"],
    ),
    pairPriors: metagameMergeKnowledgeLists(
      lower.pairPriors,
      upper.pairPriors,
      weight,
      (entry) => `${Number(entry.a)}:${String(entry.i)}|${Number(entry.b)}:${String(entry.j)}`,
      ["n", "d"],
    ),
    boostModel: metagameMergeBoostKnowledge(lower, upper, weight),
    // Complete decks are deliberately not merged into arbitrary-cost search.
    // The browser must reconstruct from character/pair evidence at the
    // requested budget instead of inheriting a neighbouring finished deck.
    deckLibrary: [],
    neighborhoods: [],
  };
}

async function loadResolvedMetagameBrowserKnowledge(data, constraint) {
  if (!metagameV12Model(constraint?.modelVersion)) return null;
  const interpolation = constraint?.interpolation;
  if (interpolation?.kind === "between") {
    const [lower, upper] = await Promise.all([
      loadMetagameBrowserKnowledge({
        id: interpolation.lowerId,
        modelVersion: constraint.modelVersion,
      }),
      loadMetagameBrowserKnowledge({
        id: interpolation.upperId,
        modelVersion: constraint.modelVersion,
      }),
    ]);
    // Never let one neighbouring band overwrite a genuine arbitrary-cost
    // interpolation. Until both knowledge packages exist, the resolved
    // constraint's per-character 100/200 (etc.) interpolation is safer.
    if (!lower || !upper) return null;
    return metagameMergeBrowserKnowledge(lower, upper, interpolation);
  }
  if (interpolation?.kind === "nearest" && interpolation.sourceId) {
    return loadMetagameBrowserKnowledge({
      id: interpolation.sourceId,
      modelVersion: constraint.modelVersion,
    });
  }
  return loadMetagameBrowserKnowledge(constraint);
}

function metagameCacheHash(value) {
  let hash = 2_166_136_261;
  for (const symbol of String(value ?? "")) {
    hash = Math.imul(hash ^ symbol.charCodeAt(0), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function metagameExactSearchCacheKey(data, constraint, characters, automaticIds, options, knowledge) {
  const accuracyOptions = {
    interactiveScenarioCount: options.interactiveScenarioCount ?? null,
    boostedScenarioCount: options.boostedScenarioCount ?? null,
    finalistCount: options.finalistCount ?? null,
    beamWidth: options.beamWidth ?? null,
    browserTimeBudgetMs: options.browserTimeBudgetMs ?? null,
    maxAdditionalEnvironmentDecks: options.maxAdditionalEnvironmentDecks ?? null,
    maxPrecomputedEnvironmentDecks: options.maxPrecomputedEnvironmentDecks ?? null,
    liveEnvironmentMinimumWinRate: options.liveEnvironmentMinimumWinRate ?? null,
    rules: options.rules ?? null,
  };
  return [
    "v2",
    String(data?.generatedAt ?? ""),
    String(constraint?.modelVersion ?? ""),
    metagameLiveQueryFingerprint(constraint, characters, automaticIds, options),
    String(knowledge?.generatedAt ?? "no-knowledge"),
    metagameCacheHash(JSON.stringify(accuracyOptions)),
  ].join("::");
}

function metagameIncrementalCacheKey(constraint, characters, automaticIds, options, knowledge) {
  return [
    "v1",
    metagameLiveQueryFingerprint(constraint, characters, automaticIds, options),
    String(knowledge?.generatedAt ?? "no-knowledge"),
  ].join("::");
}

function cloneIncrementalResult(result, characters) {
  if (!result) return null;
  const byId = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const hydrate = (entry) => {
    const ids = entry?.deck?.map((character) => String(character?.id ?? character))
      ?? entry?.deckIds
      ?? [];
    const deck = ids.map((id) => byId.get(String(id))).filter(Boolean);
    if (deck.length !== 5) return null;
    return { ...entry, deck };
  };
  const results = (result.results ?? []).map(hydrate).filter(Boolean);
  if (!results.length) return null;
  return { ...result, results };
}

function compactIncrementalResult(result) {
  const {
    constraint: _constraint,
    results = [],
    ...summary
  } = result ?? {};
  return {
    ...summary,
    results: results.map((entry) => {
      const {
        scenarioValues: _scenarioValues,
        deck = [],
        ...rest
      } = entry;
      return {
        ...rest,
        deckIds: deck.map((character) => String(character.id)),
        deck: deck.map((character) => ({ id: String(character.id) })),
      };
    }),
  };
}

function readIncrementalSessionCache(key, characters, constraint) {
  const memory = cloneIncrementalResult(metagameIncrementalResultCache.get(key), characters);
  if (memory) return { ...memory, constraint };
  try {
    const raw = globalThis.sessionStorage?.getItem(`eigomonogatari:metagame-live:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const hydrated = cloneIncrementalResult(parsed, characters);
    if (hydrated) metagameIncrementalResultCache.set(key, parsed);
    return hydrated ? { ...hydrated, constraint } : null;
  } catch {
    return null;
  }
}

function saveIncrementalSessionCache(key, result) {
  const compact = compactIncrementalResult(result);
  metagameIncrementalResultCache.set(key, compact);
  try {
    globalThis.sessionStorage?.setItem(
      `eigomonogatari:metagame-live:${key}`,
      JSON.stringify(compact),
    );
  } catch {
    // A private window or a full storage quota must never block deck search.
  }
}

function readExactSearchSessionCache(key, characters, constraint) {
  const memory = cloneIncrementalResult(metagameExactSearchResultCache.get(key), characters);
  if (memory) return { ...memory, constraint };
  try {
    const raw = globalThis.sessionStorage?.getItem(`eigomonogatari:metagame-exact:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const hydrated = cloneIncrementalResult(parsed, characters);
    if (hydrated) metagameExactSearchResultCache.set(key, parsed);
    return hydrated ? { ...hydrated, constraint } : null;
  } catch {
    return null;
  }
}

function saveExactSearchSessionCache(key, result) {
  if (!result || result.timeBudgetReached) return;
  const compact = compactIncrementalResult(result);
  metagameExactSearchResultCache.set(key, compact);
  try {
    globalThis.sessionStorage?.setItem(
      `eigomonogatari:metagame-exact:${key}`,
      JSON.stringify(compact),
    );
  } catch {
    // Cache availability must never affect the calculation itself.
  }
}

let metagameWorkerJobSequence = 0;

function metagameWorkerError(name, message, stack = "") {
  const error = new Error(message);
  error.name = name || "Error";
  if (stack) error.stack = stack;
  return error;
}

function metagameWorkerAttributeKey(constraint) {
  if (constraint?.attributeKey) return String(constraint.attributeKey);
  return [...new Set(constraint?.allowedAttributes ?? [])].sort().join("-");
}

function metagameWorkerRelevantData(data, resolvedConstraint) {
  const attributeKey = metagameWorkerAttributeKey(resolvedConstraint);
  if (!attributeKey) return data;
  return {
    ...data,
    constraints: (data?.constraints ?? []).filter(
      (entry) => metagameWorkerAttributeKey(entry) === attributeKey,
    ),
  };
}

function runMetagameDeckSearchWorker(
  data,
  constraintId,
  characters,
  options = {},
  resolvedConstraint = null,
) {
  if (typeof globalThis.Worker !== "function") return Promise.resolve(null);

  let worker;
  try {
    worker = new Worker("./src/core/metagame-worker.js", { type: "module" });
  } catch {
    return Promise.resolve(null);
  }

  const jobId = `metagame-${++metagameWorkerJobSequence}`;
  const { signal, onProgress, ...workerOptions } = options;
  return new Promise((resolve, reject) => {
    let ready = false;
    let started = false;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener?.("abort", abort);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      const error = new Error("デッキシミュレーションを中止しました。");
      error.name = "AbortError";
      finish(reject, error);
    };
    const handleError = (event) => {
      if (!started) {
        // A browser that cannot load module workers should transparently use
        // the exact same main-thread implementation.
        finish(resolve, null);
        return;
      }
      finish(reject, metagameWorkerError(
        "MetagameWorkerError",
        event?.message || "Web Workerでのデッキ計算に失敗しました。",
      ));
    };
    const handleMessage = (event) => {
      const message = event.data ?? {};
      if (message.type === "ready" && !ready) {
        ready = true;
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          worker.postMessage({
            type: "search",
            jobId,
            data: metagameWorkerRelevantData(data, resolvedConstraint),
            constraintId,
            characters,
            options: workerOptions,
          });
          started = true;
        } catch {
          // Structured-clone support differs across older browsers. Falling
          // back before work starts preserves exact behavior.
          finish(resolve, null);
        }
        return;
      }
      if (String(message.jobId ?? "") !== jobId) return;
      if (message.type === "progress") {
        onProgress?.(message.progress ?? {});
        return;
      }
      if (message.type === "result") {
        finish(resolve, message.result);
        return;
      }
      if (message.type === "error") {
        const payload = message.error ?? {};
        finish(reject, metagameWorkerError(
          payload.name,
          payload.message || "Web Workerでのデッキ計算に失敗しました。",
          payload.stack,
        ));
      }
    };

    signal?.addEventListener?.("abort", abort, { once: true });
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    if (signal?.aborted) abort();
  });
}

const findBestMetagameDeckBeforeV12PrecomputedFirst = findBestMetagameDeck;
findBestMetagameDeck = async function findBestMetagameDeckV12PrecomputedFirst(data, constraintId, characters, options = {}) {
  const requestedTotalCost = Number(options.totalCost);
  const costMode = options.costMode === "exact" ? "exact" : "at_most";
  const constraint = { ...resolveMetagameConstraint(data, constraintId, requestedTotalCost), costMode };
  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const automaticIds = normalizeMetagameBoostedCharacterIds(options.automaticCharacterIds);
  const isV12 = metagameV12Model(constraint?.modelVersion);
  const knowledge = isV12
    ? await loadResolvedMetagameBrowserKnowledge(data, constraint)
    : null;
  const nextOptions = {
    ...options,
    browserKnowledge: knowledge,
  };

  if (isV12 && hasMetagameLiveCharacters(characters, automaticIds)) {
    const cacheKey = metagameIncrementalCacheKey(
      constraint,
      characters,
      automaticIds,
      nextOptions,
      knowledge,
    );
    const cached = readIncrementalSessionCache(cacheKey, characters, constraint);
    if (cached) {
      options.onProgress?.({
        phase: "candidate",
        completed: 5,
        total: 5,
        slot: 5,
        slots: 5,
        checked: cached.candidateDeckCount ?? 0,
        stageTotal: cached.candidateDeckCount ?? 0,
        retained: cached.candidateDeckCount ?? 0,
        valid: cached.candidateDeckCount ?? 0,
      });
      return {
        ...cached,
        cachePolicy: "v12-live-incremental-session-cache",
        usedIncrementalLiveEvaluation: true,
      };
    }

    const result = await findBestMetagameDeckIncrementalLive(
      data,
      constraintId,
      characters,
      nextOptions,
    );
    saveIncrementalSessionCache(cacheKey, result);
    return result;
  }

  // V12 always reconstructs the first result in the browser from
  // character-level evidence. A byte-for-byte equivalent repeat query in the
  // same session may reuse that completed result; this is not a published
  // finished-deck shortcut and never changes first-run candidate coverage.
  if (isV12) {
    const cacheKey = metagameExactSearchCacheKey(
      data,
      constraint,
      characters,
      automaticIds,
      nextOptions,
      knowledge,
    );
    const cached = readExactSearchSessionCache(cacheKey, characters, constraint);
    if (cached) {
      options.onProgress?.({
        phase: "candidate",
        completed: 5,
        total: 5,
        slot: 5,
        slots: 5,
        checked: cached.candidateDeckCount ?? 0,
        stageTotal: cached.candidateDeckCount ?? 0,
        retained: cached.candidateDeckCount ?? 0,
        valid: cached.candidateDeckCount ?? 0,
      });
      return {
        ...cached,
        cachePolicy: "v12-exact-session-cache",
      };
    }
    const workerResult = await runMetagameDeckSearchWorker(
      data,
      constraintId,
      characters,
      nextOptions,
      constraint,
    );
    const result = workerResult ?? await findBestMetagameDeckBeforeV12PrecomputedFirst(
      data,
      constraintId,
      characters,
      nextOptions,
    );
    saveExactSearchSessionCache(cacheKey, result);
    return result;
  }

  return findBestMetagameDeckBeforeV12PrecomputedFirst(
    data,
    constraintId,
    characters,
    nextOptions,
  );
};

const renderMetagameSimulatorResultBeforeV12PrecomputedFirst = renderMetagameSimulatorResult;
renderMetagameSimulatorResult = function renderMetagameSimulatorResultV12PrecomputedFirst(container, searchResult, characters) {
  renderMetagameSimulatorResultBeforeV12PrecomputedFirst(container, searchResult, characters);
  const note = container.querySelector(".metagame-result-note");
  if (!note) return;

  if (searchResult?.usedIncrementalLiveEvaluation) {
    const counts = searchResult.screenedScenarioCounts ?? [];
    const liveCount = searchResult.liveCharacterIds?.length ?? 0;
    const knowledgeLabel = searchResult.browserKnowledgeSchemaVersion
      ? "事前学習knowledgeを使用"
      : "公開V12完成デッキを土台に使用";
    note.textContent =
      `${note.textContent} 管理DBの追加・編集キャラ${liveCount}体は無視せず増分評価しました。` +
      ` ${knowledgeLabel}し、候補を局所生成→${counts[0] ?? 12}戦→${counts[1] ?? 24}戦で絞り、` +
      `最終候補だけ${counts[2] ?? searchResult.scenarioCount ?? 72}戦の5対5で確認しています。` +
      " キャラ追加ごとのV12全再計算は行いません。";
    return;
  }

  if (metagameV12Model(searchResult?.constraint?.modelVersion) && !searchResult?.usedIncrementalLiveEvaluation) {
    const knowledgeLabel = searchResult?.browserKnowledgeUsed
      ? "全候補の事前計算済み単体評価・連携評価"
      : "公開済みの枠別単体評価";
    note.textContent = `${note.textContent} ${knowledgeLabel}を使って、この条件専用の5体をブラウザ上で組み直しています。完成済みデッキの丸ごと流用ではありません。`;
  }
};
