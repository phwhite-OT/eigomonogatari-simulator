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
  const isV12WithPublishedDecks = metagameV12Model(constraint?.modelVersion)
    && Array.isArray(constraint.precomputedDecks)
    && constraint.precomputedDecks.length > 0;
  const isExactPublishedV12 = isV12WithPublishedDecks && !constraint.interpolation;

  if (isV12WithPublishedDecks && hasMetagameLiveCharacters(characters, automaticIds)) {
    const knowledge = await loadMetagameBrowserKnowledge(constraint);
    const cacheKey = metagameIncrementalCacheKey(
      constraint,
      characters,
      automaticIds,
      options,
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
      {
        ...options,
        browserKnowledge: knowledge,
      },
    );
    saveIncrementalSessionCache(cacheKey, result);
    return result;
  }

  // With no live DB character, the exact published V12 snapshot remains the
  // fastest and most accurate path. Event boosts still use the existing
  // battle re-evaluation path because stats differ from the published state.
  if (isExactPublishedV12 && !automaticIds.size && !boostedIds.size) {
    const fixedSlots = metagameFixedSlots(options.fixedSlots);
    const reusable = metagameV8PrecomputedResults(constraint, characters, fixedSlots);
    if (reusable.length) {
      const result = await findBestMetagameDeckBeforeV12PrecomputedFirst(
        data,
        constraintId,
        characters,
        options,
      );
      return {
        ...result,
        usedPrecomputedDeckCache: true,
        cachePolicy: result.cachePolicy ?? "published-v12-snapshot",
      };
    }
  }

  return findBestMetagameDeckBeforeV12PrecomputedFirst(data, constraintId, characters, options);
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
      ` ${knowledgeLabel}し、候補を局所生成→${counts[0] ?? 6}戦→${counts[1] ?? 12}戦で絞り、` +
      `最終候補だけ${counts[2] ?? searchResult.scenarioCount ?? 72}戦の5対5で確認しています。` +
      " キャラ追加ごとのV12全再計算は行いません。";
    return;
  }

  if (searchResult?.cachePolicy === "published-v12-snapshot") {
    note.textContent = `${note.textContent} 管理DBに未評価の追加・編集キャラがないため、公開V12スナップショットをそのまま再利用しています。`;
  }
};
