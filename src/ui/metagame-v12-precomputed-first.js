const findBestMetagameDeckBeforeV12PrecomputedFirst = findBestMetagameDeck;
findBestMetagameDeck = async function findBestMetagameDeckV12PrecomputedFirst(data, constraintId, characters, options = {}) {
  const requestedTotalCost = Number(options.totalCost);
  const costMode = options.costMode === "exact" ? "exact" : "at_most";
  const constraint = { ...resolveMetagameConstraint(data, constraintId, requestedTotalCost), costMode };
  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const automaticIds = normalizeMetagameBoostedCharacterIds(options.automaticCharacterIds);
  const isExactPublishedV12 = String(constraint?.modelVersion ?? "") === METAGAME_V12_UI_MODEL_VERSION
    && !constraint.interpolation
    && Array.isArray(constraint.precomputedDecks)
    && constraint.precomputedDecks.length > 0
    && !boostedIds.size;

  if (isExactPublishedV12 && automaticIds.size) {
    const fixedSlots = metagameFixedSlots(options.fixedSlots);
    const publishedCharacters = [...CHARACTER_CATALOG];
    const reusable = metagameV8PrecomputedResults(constraint, publishedCharacters, fixedSlots);
    if (reusable.length) {
      const result = await findBestMetagameDeckBeforeV12PrecomputedFirst(
        data,
        constraintId,
        publishedCharacters,
        {
          ...options,
          automaticCharacterIds: [],
        },
      );
      return {
        ...result,
        usedPrecomputedDeckCache: true,
        cachePolicy: "published-v12-snapshot",
        ignoredAutomaticCharacterIds: [...automaticIds],
        results: (result.results ?? []).map((entry) => ({
          ...entry,
          usedPrecomputedDeckCache: true,
          cachePolicy: "published-v12-snapshot",
        })),
      };
    }
  }

  return findBestMetagameDeckBeforeV12PrecomputedFirst(data, constraintId, characters, options);
};

const renderMetagameSimulatorResultBeforeV12PrecomputedFirst = renderMetagameSimulatorResult;
renderMetagameSimulatorResult = function renderMetagameSimulatorResultV12PrecomputedFirst(container, searchResult, characters) {
  renderMetagameSimulatorResultBeforeV12PrecomputedFirst(container, searchResult, characters);
  if (searchResult?.cachePolicy !== "published-v12-snapshot") return;
  const note = container.querySelector(".metagame-result-note");
  if (!note) return;
  note.textContent = `${note.textContent} 管理DBに保存済みの追加・編集キャラが存在しても、通常の計算済みV12条件ではクラウド計算時の公開スナップショットを優先して即時表示します。補正キャラや保存済みにない固定構成を指定した場合は再計算します。`;
};
