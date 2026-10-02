import {
  findBestMetagameDeckIncrementalLive,
  hasMetagameLiveCharacters,
  metagameLiveQueryFingerprint,
} from "../core/metagame-live.js";

const metagameBrowserKnowledgePromises = new Map();
const metagameIncrementalResultCache = new Map();

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
      interpolation,
      sourceConditions: [lower.inputId, upper.inputId],
    },
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

  // V12 always reconstructs a deck in the browser from character-level
  // evidence. Even an exact representative cost does not short-circuit to a
  // saved finished deck. Published decks remain environment/evidence inputs,
  // never the required starting point for generation.
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
