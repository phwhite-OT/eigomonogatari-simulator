const findBestMetagameDeckBeforeV12FastLive = findBestMetagameDeck;

function metagameV12FastLivePriorityIds(constraint, automaticIds, boostedIds, fixedSlots) {
  const publishedTopIds = new Set((constraint?.slots ?? []).flatMap((slot) => (
    [...(slot.candidates ?? [])]
      .sort((left, right) => (
        metagamePublishedCandidateScore(right) - metagamePublishedCandidateScore(left) ||
        Number(left.cost) - Number(right.cost)
      ))
      .slice(0, 24)
      .map((entry) => String(entry.id))
  )));
  const fixedIds = new Set([...fixedSlots.values()].map(String));
  const priorityIds = new Set([...boostedIds, ...fixedIds]);
  for (const id of automaticIds) {
    if (publishedTopIds.has(String(id)) || fixedIds.has(String(id))) priorityIds.add(String(id));
  }
  return priorityIds;
}

function metagameV12FastLiveCandidateFromBase(base, deck, constraint, priorityIds) {
  const slotRatings = (constraint?.slots ?? []).map((slot) => new Map(
    (slot.candidates ?? []).map((rating) => [String(rating.id), rating]),
  ));
  const ratings = deck.map((character, index) => (
    slotRatings[index]?.get(String(character.id))
      ?? (String(base.deck?.[index]?.id) === String(character.id) ? base.ratings?.[index] : null)
      ?? metagameBoostedFallbackRating(character)
  ));
  const roleCounts = ratings.reduce((counts, rating) => metagameDeckRoleCountsAdd(counts, rating), {});
  const attackCommitment = ratings.reduce((sum, rating) => sum + metagameDeckAttackCommitment(rating), 0);
  return {
    deck,
    ratings,
    totalCost: deck.reduce((sum, character) => sum + Math.max(0, Number(character.cost) || 0), 0),
    proxyScore: Number(base.expectedWinLowerBound) || Number(base.expectedWinRate) || Number(base.proxyScore) || 0,
    synergyScore: calculateMetagameDeckSynergy(deck, ratings),
    handoffRisk: 0,
    budgetStrain: 0,
    advantageCount: ratings.filter((rating) => Number(rating.advantageCreation) > 0).length,
    counterCount: ratings.filter((rating) => Number(rating.counteraction) > 0).length,
    roleCounts,
    attackCommitment,
    firepowerSurplus: metagameDeckFirepowerSurplus(attackCommitment, roleCounts),
    priorityCharacterIds: [...priorityIds],
    injectedPositions: deck.flatMap((character, index) => (
      priorityIds.has(String(character.id)) ? [{ id: String(character.id), position: index + 1 }] : []
    )),
  };
}

findBestMetagameDeck = async function findBestMetagameDeckV12FastLive(data, constraintId, characters, options = {}) {
  const requestedTotalCost = Number(options.totalCost);
  const costMode = options.costMode === "exact" ? "exact" : "at_most";
  const constraint = { ...resolveMetagameConstraint(data, constraintId, requestedTotalCost), costMode };
  if (String(constraint?.modelVersion ?? "") !== METAGAME_V12_UI_MODEL_VERSION ||
      !Array.isArray(constraint.precomputedDecks) || !constraint.precomputedDecks.length) {
    return findBestMetagameDeckBeforeV12FastLive(data, constraintId, characters, options);
  }

  const boostedIds = normalizeMetagameBoostedCharacterIds(options.boostedCharacterIds);
  const automaticIds = normalizeMetagameBoostedCharacterIds(options.automaticCharacterIds);
  const fixedSlots = metagameFixedSlots(options.fixedSlots);
  const needsFastLive = Boolean(constraint.interpolation) || boostedIds.size > 0 || fixedSlots.size > 0;
  if (!needsFastLive) {
    return findBestMetagameDeckBeforeV12FastLive(data, constraintId, characters, options);
  }

  const charactersById = metagameCharactersById(characters, boostedIds);
  const interactiveCharacters = [...charactersById.values()];
  const relaxedConstraint = costMode === "exact" ? { ...constraint, costMode: "at_most" } : constraint;
  const bases = metagameV8PrecomputedResults(relaxedConstraint, interactiveCharacters, new Map()).slice(0, 32);
  if (!bases.length) {
    return findBestMetagameDeckBeforeV12FastLive(data, constraintId, characters, options);
  }

  const priorityIds = metagameV12FastLivePriorityIds(constraint, automaticIds, boostedIds, fixedSlots);
  const candidates = new Map();
  const addCandidate = (base, rawDeck) => {
    const deck = [...rawDeck];
    for (const [position, id] of fixedSlots) {
      const character = charactersById.get(String(id));
      if (!character || !matchesMetagamePositionConstraint(character, constraint, position)) return false;
      deck[position - 1] = character;
    }
    if (!metagameDeckIsLegal(deck, constraint, fixedSlots)) return false;
    const candidate = metagameV12FastLiveCandidateFromBase(base, deck, constraint, priorityIds);
    const key = metagameDeckKey(deck);
    const current = candidates.get(key);
    if (!current || candidate.proxyScore > current.proxyScore) candidates.set(key, candidate);
    return true;
  };

  for (const base of bases) addCandidate(base, base.deck);

  for (const id of priorityIds) {
    const character = charactersById.get(String(id));
    if (!character) continue;
    for (let index = 0; index < 5; index += 1) {
      const position = index + 1;
      if (!matchesMetagamePositionConstraint(character, constraint, position)) continue;
      if (fixedSlots.has(position) && String(fixedSlots.get(position)) !== String(id)) continue;
      let added = 0;
      for (const base of bases) {
        if (added >= 3) break;
        const deck = [...base.deck];
        deck[index] = character;
        if (addCandidate(base, deck)) added += 1;
      }
    }
  }

  if (!candidates.size) {
    return findBestMetagameDeckBeforeV12FastLive(data, constraintId, characters, options);
  }

  const candidateList = [...candidates.values()].sort((left, right) => (
    right.proxyScore - left.proxyScore || right.synergyScore - left.synergyScore || left.totalCost - right.totalCost
  ));
  const finalists = metagameSelectFinalistsWithBoosts(
    candidateList,
    options.finalistCount ?? 12,
    priorityIds,
  );
  const requestedScenarioCount = Number(options.interactiveScenarioCount ?? options.boostedScenarioCount);
  const interactiveScenarioCount = requestedScenarioCount === 0
    ? undefined
    : Math.max(1, requestedScenarioCount || 8);

  const liveEnvironmentDecks = [...boostedIds].flatMap((id) => {
    const representative = candidateList.find((candidate) => (
      candidate.deck.some((character) => String(character.id) === String(id))
    ));
    return representative ? [{ id: String(id), ids: representative.deck.map((character) => String(character.id)) }] : [];
  });
  const scenarioSet = metagameBattleScenarios(constraint, charactersById, boostedIds, {
    maxBaseScenarios: interactiveScenarioCount,
    environmentCharacterIds: automaticIds,
    maxAdditionalEnvironmentDecks: options.maxAdditionalEnvironmentDecks ?? 8,
    maxPrecomputedEnvironmentDecks: options.maxPrecomputedEnvironmentDecks ?? 4,
    liveEnvironmentDecks,
    includeLiveFallback: false,
  });
  const scenarios = scenarioSet.scenarios;
  if (!scenarios.length) {
    return findBestMetagameDeckBeforeV12FastLive(data, constraintId, characters, options);
  }

  options.onProgress?.({
    phase: "candidate",
    completed: 5,
    total: 5,
    slot: 5,
    slots: 5,
    checked: candidateList.length,
    stageTotal: candidateList.length,
    retained: candidateList.length,
    valid: candidateList.length,
  });

  const evaluated = [];
  let completedSimulations = 0;
  const totalSimulations = finalists.length * scenarios.length;
  options.onProgress?.({
    phase: "simulation",
    completed: 0,
    total: totalSimulations,
    valid: candidateList.length,
    deck: 1,
    decks: finalists.length,
    scenarios: scenarios.length,
  });
  for (let index = 0; index < finalists.length; index += 1) {
    evaluated.push(await metagameEvaluateDeck(
      finalists[index],
      scenarios,
      constraint,
      options.rules ?? DEFAULT_RULES,
      {
        ...options,
        onScenarioCompleted: () => {
          completedSimulations += 1;
          options.onProgress?.({
            phase: "simulation",
            completed: completedSimulations,
            total: totalSimulations,
            valid: candidateList.length,
            deck: index + 1,
            decks: finalists.length,
            scenarios: scenarios.length,
          });
        },
      },
    ));
  }
  evaluated.sort((left, right) => (
    right.expectedWinLowerBound - left.expectedWinLowerBound ||
    right.expectedWinRate - left.expectedWinRate ||
    left.totalCost - right.totalCost
  ));

  const usedAutomaticIds = [...priorityIds].filter((id) => automaticIds.has(String(id)));
  const ignoredAutomaticIds = [...automaticIds].filter((id) => !priorityIds.has(String(id)));
  return {
    constraint,
    generatedAt: data.generatedAt,
    candidateDeckCount: candidateList.length,
    simulatedDeckCount: finalists.length,
    scenarioCount: scenarios.length,
    excludedScenarioCount: scenarioSet.excludedScenarioCount,
    boostedCharacterIds: [...boostedIds],
    automaticCharacterIds: usedAutomaticIds,
    ignoredAutomaticCharacterIds: ignoredAutomaticIds,
    environmentCharacterIds: scenarioSet.environmentCharacterIds,
    environmentCombatants: scenarioSet.environmentCombatants,
    usedPrecomputedDeckSeeds: true,
    cachePolicy: "v12-precomputed-seed-fast-live",
    results: evaluated.slice(0, 3).map((candidate) => ({
      ...candidate,
      usedPrecomputedDeckSeeds: true,
      cachePolicy: "v12-precomputed-seed-fast-live",
    })),
  };
};

const renderMetagameSimulatorResultBeforeV12FastLive = renderMetagameSimulatorResult;
renderMetagameSimulatorResult = function renderMetagameSimulatorResultV12FastLive(container, searchResult, characters) {
  renderMetagameSimulatorResultBeforeV12FastLive(container, searchResult, characters);
  if (searchResult?.cachePolicy !== "v12-precomputed-seed-fast-live") return;
  const note = container.querySelector(".metagame-result-note");
  if (!note) return;
  note.textContent = `事前計算済みの強い完成デッキを探索の種として再利用し、変更された条件だけを差し替えて ${searchResult.simulatedDeckCount} デッキ × ${searchResult.scenarioCount} 環境を5対5で再評価しました。全候補からの重いビーム探索は行っていません。`;
};
