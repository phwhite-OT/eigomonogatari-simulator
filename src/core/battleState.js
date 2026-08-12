function cloneState(state) {
  return structuredClone(state);
}

function normalizeDecks(charactersOrDecks) {
  if (!Array.isArray(charactersOrDecks)) return [];
  if (charactersOrDecks.length === 0) return [];
  return Array.isArray(charactersOrDecks[0])
    ? charactersOrDecks.map((deck) => deck.filter(Boolean))
    : charactersOrDecks.filter(Boolean).map((character) => [character]);
}

export function createCombatant(character, overrides = {}) {
  const deck = overrides.deck ?? [character];
  const deckIndex = overrides.deckIndex ?? 0;
  const naturalSkillCharge = overrides.naturalSkillCharge ?? 0;
  return {
    playerId: overrides.playerId ?? 1,
    deck,
    character,
    activeCharacterId: character?.id,
    currentHp: overrides.currentHp ?? character?.hp ?? 0,
    maxHp: overrides.maxHp ?? character?.hp ?? 0,
    alive: overrides.alive ?? Boolean(character),
    isGhost: overrides.isGhost ?? false,
    reviveUsed: overrides.reviveUsed ?? false,
    deckIndex,
    environmentPosition: overrides.environmentPosition ?? deckIndex + 1,
    skillCounter: overrides.skillCounter ?? naturalSkillCharge,
    naturalSkillCharge,
    skillUses: overrides.skillUses ?? 0,
    survivalTurns: overrides.survivalTurns ?? 0,
    buffs: overrides.buffs ?? [],
    debuffs: overrides.debuffs ?? [],
    attributes: overrides.attributes ?? [...(character?.attributes ?? [])],
  };
}

function createPlayer(deck, playerId, elapsedTurns) {
  return createCombatant(deck[0], {
    playerId,
    deck,
    deckIndex: 0,
    skillCounter: elapsedTurns,
    naturalSkillCharge: elapsedTurns,
    survivalTurns: elapsedTurns,
  });
}

export function createBattleState(allies, enemies, turn = 1) {
  const elapsedTurns = Math.max(0, Number(turn) - 1);
  return {
    turn,
    allies: normalizeDecks(allies).map((deck, index) => createPlayer(deck, index + 1, elapsedTurns)),
    enemies: normalizeDecks(enemies).map((deck, index) => createPlayer(deck, index + 1, elapsedTurns)),
    continuousEffects: [],
    pendingActions: [],
    nextEffectOrder: 1,
  };
}

function continuingEffects(effects) {
  return (effects ?? [])
    .filter((effect) => Number(effect.remainingTurns) > 1)
    .map((effect) => structuredClone(effect));
}

function attributesAfterContinuation(character, buffs) {
  const attributeChange = [...buffs]
    .reverse()
    .find((effect) => effect.type === "attribute_change" && effect.attributes?.length);
  return attributeChange ? [...attributeChange.attributes] : [...(character?.attributes ?? [])];
}

export function activateNextCharacter(combatant) {
  const deckIndex = combatant.deckIndex + 1;
  const character = combatant.deck[deckIndex];
  if (!character) {
    return {
      ...combatant,
      currentHp: 0,
      alive: false,
      isGhost: false,
      buffs: [],
      debuffs: [],
      attributes: [],
      survivalTurns: 0,
    };
  }
  const buffs = continuingEffects(combatant.buffs);
  const debuffs = continuingEffects(combatant.debuffs);
  return createCombatant(character, {
    playerId: combatant.playerId,
    deck: combatant.deck,
    deckIndex,
    environmentPosition: (combatant.environmentPosition ?? combatant.deckIndex + 1) + 1,
    skillCounter: combatant.naturalSkillCharge,
    naturalSkillCharge: combatant.naturalSkillCharge,
    survivalTurns: 0,
    buffs,
    debuffs,
    attributes: attributesAfterContinuation(character, buffs),
  });
}

export function activateGhost(combatant, ghostPower = 1000) {
  const character = {
    id: `ghost-${combatant.playerId}`,
    name: `幽霊${combatant.playerId}`,
    attributes: ["fire", "water", "wind"],
    hp: 1,
    pow: ghostPower,
    skillTurn: 99,
    maxUses: 0,
    skill: { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
  };
  return createCombatant(character, {
    playerId: combatant.playerId,
    deck: combatant.deck,
    deckIndex: combatant.deck.length,
    naturalSkillCharge: combatant.naturalSkillCharge,
    isGhost: true,
  });
}

export function resolveDefeatedCombatants(state, options = {}) {
  const next = cloneState(state);
  const transitions = [];
  const ghostPower = Number(options.ghostPower) || 1000;
  for (const side of ["allies", "enemies"]) {
    for (let index = 0; index < next[side].length; index += 1) {
      const combatant = next[side][index];
      if (combatant.alive || combatant.isGhost) continue;
      const defeatedName = combatant.character?.name ?? "不明";
      const replacement = combatant.deck[combatant.deckIndex + 1]
        ? activateNextCharacter(combatant)
        : activateGhost(combatant, ghostPower);
      next[side][index] = replacement;
      transitions.push({
        side,
        playerIndex: index,
        from: defeatedName,
        to: replacement.character.name,
        type: replacement.isGhost ? "ghost" : "replacement",
      });
    }
  }
  return { state: next, transitions };
}

export function updateCombatant(state, side, index, updater) {
  const next = cloneState(state);
  const current = next[side][index];
  next[side][index] = updater(current);
  return next;
}

export function applyDamageToCombatant(state, side, index, amount, options = {}) {
  return updateCombatant(state, side, index, (combatant) => {
    const currentHp = Math.max(0, combatant.currentHp - Math.max(0, amount));
    if (currentHp > 0) return { ...combatant, currentHp };
    const defeated = { ...combatant, currentHp: 0, alive: false };
    return options.deferReplacement ? defeated : activateNextCharacter(defeated);
  });
}

/**
 * Recovery can over-heal to twice the maximum HP.  The portion restored above
 * the normal maximum is only half as effective, matching the battle rule.
 */
export function recoveredHp(currentHp, maxHp, amount) {
  const maximum = Math.max(0, Number(maxHp) || 0);
  const current = Math.min(maximum * 2, Math.max(0, Number(currentHp) || 0));
  const recovery = Math.max(0, Number(amount) || 0);
  if (!maximum || !recovery) return current;

  const normalRecovery = Math.min(recovery, Math.max(0, maximum - current));
  const overflowRecovery = Math.max(0, recovery - normalRecovery) / 2;
  return Math.min(maximum * 2, current + normalRecovery + overflowRecovery);
}

export function applyHealingToCombatant(state, side, index, amount) {
  return updateCombatant(state, side, index, (combatant) => {
    if (!combatant.alive || combatant.isGhost) return combatant;
    return {
      ...combatant,
      currentHp: recoveredHp(combatant.currentHp, combatant.maxHp, amount),
    };
  });
}

function effectValue(combatant) {
  const buffValue = combatant.buffs.reduce((sum, effect) => {
    if (effect.type === "attack_buff") return sum + 7 * Math.max(0, effect.multiplier - 1);
    if (["damage_reduction", "guard", "attribute_guard"].includes(effect.type)) {
      return sum + 8 * Math.max(0, 1 - effect.multiplier);
    }
    return sum + 1;
  }, 0);
  const debuffValue = combatant.debuffs.reduce((sum, effect) => sum + (effect.amount ?? 1), 0);
  return buffValue - debuffValue;
}

function combatantValue(combatant) {
  if (!combatant.alive || combatant.isGhost) return 0;
  const hpRatio = combatant.maxHp > 0 ? combatant.currentHp / combatant.maxHp : 0;
  const roleImportance = combatant.character.roleTags.some((role) =>
    ["revive", "aoe_attacker", "guard", "finisher"].includes(role),
  )
    ? 6
    : 0;
  const skillReady = combatant.skillCounter >= combatant.character.skillTurn ? 5 : 0;
  const reserveValue = Math.max(0, combatant.deck.length - combatant.deckIndex - 1) * 4;
  return 35 + hpRatio * 45 + roleImportance + skillReady + reserveValue + effectValue(combatant);
}

export function evaluateBoard(state, perspective = "allies") {
  const opponent = perspective === "allies" ? "enemies" : "allies";
  const ownValue = state[perspective].reduce((sum, combatant) => sum + combatantValue(combatant), 0);
  const opponentValue = state[opponent].reduce((sum, combatant) => sum + combatantValue(combatant), 0);
  return ownValue - opponentValue;
}

export function advanceTurn(state) {
  const next = cloneState(state);
  next.turn += 1;
  for (const side of ["allies", "enemies"]) {
    for (const combatant of next[side]) {
      if (combatant.alive && !combatant.isGhost) {
        combatant.naturalSkillCharge += 1;
        combatant.skillCounter += 1;
        combatant.survivalTurns += 1;
      }
      combatant.buffs = combatant.buffs
        .map((effect) => ({ ...effect, remainingTurns: effect.remainingTurns - 1 }))
        .filter((effect) => effect.remainingTurns > 0);
      if (combatant.alive && !combatant.isGhost) {
        const attributeChange = [...combatant.buffs]
          .reverse()
          .find((effect) => effect.type === "attribute_change" && effect.attributes?.length);
        combatant.attributes = attributeChange
          ? [...attributeChange.attributes]
          : [...(combatant.character?.attributes ?? [])];
      }
      combatant.debuffs = combatant.debuffs
        .map((effect) => ({ ...effect, remainingTurns: effect.remainingTurns - 1 }))
        .filter((effect) => effect.remainingTurns > 0);
    }
  }
  next.continuousEffects = next.continuousEffects
    .map((effect) => ({ ...effect, remainingTurns: effect.remainingTurns - 1 }))
    .filter((effect) => effect.remainingTurns > 0);
  return next;
}
