import { applyRounding, resolveAttributeMultiplier } from "./damage.js";
import { DEFAULT_RULES } from "../data/rules.js";

export const EXACT_LIGHTEST_DEFAULTS = Object.freeze({
  deckSize: 5,
  maxTurns: 12,
  answerMultiplier: 2.592,
  halfAnswerMultiplier: 0.5,
  allowHalfAnswer: false,
  enemyAttackMultiplier: 1,
  eventBonusMultiplier: 1.5,
  allowDuplicates: true,
  ownedOnly: false,
  resultLimit: 5,
  stopOnFirstWin: true,
  targetSearch: "all",
  skillSearch: "all",
});

const EXACT_ATTACK_TYPES = new Set(["single_attack", "aoe_attack", "multi_hit_attack"]);
const EXACT_DEFENSE_TYPES = new Set(["damage_reduction", "guard", "attribute_guard"]);
const EXACT_SUPPORTED_SKILLS = new Set([
  "attack_buff",
  "damage_reduction",
  "guard",
  "attribute_guard",
  "heal",
  "revive",
  "attribute_change",
  "skill_reduction",
  "delay",
  "aoe_attack",
  "multi_hit_attack",
]);
const EXACT_SKILL_PHASES = Object.freeze([
  Object.freeze(["skill_reduction"]),
  Object.freeze(["attribute_change"]),
  Object.freeze(["delay"]),
  Object.freeze([
    "attack_buff",
    "damage_reduction",
    "guard",
    "attribute_guard",
    "heal",
    "revive",
    "aoe_attack",
    "multi_hit_attack",
  ]),
]);

function exactAbortError() {
  const error = new Error("最軽装の完全探索を中止しました");
  error.name = "AbortError";
  return error;
}

function exactYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function exactAttributes(character) {
  return Array.isArray(character?.attributes) ? character.attributes : [];
}

function exactClone(value) {
  return structuredClone(value);
}

function exactPrepareAlly(character, eventBonusIds, multiplier) {
  const prepared = exactClone(character);
  const eventBonus = eventBonusIds.has(String(character.id));
  return {
    ...prepared,
    hp: eventBonus ? prepared.hp * multiplier : prepared.hp,
    eventBonus,
    eventMultiplier: eventBonus ? multiplier : 1,
  };
}

function exactAttributesAfterBuffs(character, buffs) {
  const attributeChange = [...buffs]
    .reverse()
    .find((effect) => effect.type === "attribute_change" && effect.attributes.length);
  return attributeChange ? [...attributeChange.attributes] : [...exactAttributes(character)];
}

function exactCreateUnit(character, options = {}) {
  const hp = Math.max(1, Number(character.hp) || 1);
  const buffs = exactClone(options.buffs ?? []);
  return {
    character: exactClone(character),
    currentHp: hp,
    maxHp: hp,
    attributes: exactAttributesAfterBuffs(character, buffs),
    alive: true,
    ghost: false,
    reviveUsed: false,
    skillCounter: Math.max(0, Number(options.skillCounter) || 0),
    skillUses: 0,
    buffs,
    lane: Number.isInteger(options.lane) ? options.lane : null,
  };
}

function exactCreateState(deck, enemies, options) {
  const eventBonusIds = new Set((options.eventBonusIds ?? []).map(String));
  const preparedDeck = deck.map((character) => exactPrepareAlly(
    character,
    eventBonusIds,
    options.eventBonusMultiplier,
  ));
  return {
    turn: 1,
    allies: preparedDeck.map((character) => exactCreateUnit(character)),
    enemies: [],
    enemyQueue: enemies.map((character) => exactClone(character)),
    enemyLaneBuffs: [[], [], []],
    nextEffectOrder: 1,
    defeatedEnemies: 0,
  };
}

function exactActive(units) {
  return units.filter((unit) => unit.alive && !unit.ghost);
}

function exactSpawn(state) {
  const desiredCount = Math.min(3, state.turn);
  const spawned = [];
  while (exactActive(state.enemies).length < desiredCount && state.enemyQueue.length) {
    const occupiedLanes = new Set(state.enemies
      .filter((enemy) => enemy.alive && !enemy.ghost)
      .map((enemy) => enemy.lane));
    const lane = Array.from({ length: desiredCount }, (_, index) => index)
      .find((index) => !occupiedLanes.has(index));
    if (lane === undefined) break;
    const character = state.enemyQueue.shift();
    const inheritedBuffs = state.enemyLaneBuffs[lane] ?? [];
    state.enemyLaneBuffs[lane] = [];
    state.enemies.push(exactCreateUnit(character, {
      skillCounter: state.turn - 1,
      lane,
      buffs: inheritedBuffs,
    }));
    spawned.push(character.name);
  }
  state.enemies.sort((left, right) => (left.lane ?? Infinity) - (right.lane ?? Infinity));
  return spawned;
}

function exactEffectMatches(effect, owner, opponent) {
  return (effect.conditions ?? []).every((condition) => {
    if (condition.type === "ally_attribute") return owner.attributes.includes(condition.attribute);
    if (condition.type === "enemy_attribute") return opponent?.attributes.includes(condition.attribute) ?? true;
    return true;
  });
}

function exactTargetMatches(skill, target, opponent) {
  return (skill.conditions ?? []).every((condition) => {
    if (condition.type === "ally_attribute") return target.attributes.includes(condition.attribute);
    if (condition.type === "enemy_attribute") return opponent?.attributes.includes(condition.attribute) ?? true;
    return true;
  });
}

function exactTargetsTeam(character) {
  return character.skill?.target === "ally_all" || /味方|全員/.test(character.skillName ?? "");
}

function exactFriendlyTargets(units, actorIndex, character, mode = "alive", ignoreConditions = false) {
  const skill = character.skill;
  const indexes = skill.target === "self" && !exactTargetsTeam(character)
    ? [actorIndex]
    : skill.target === "leader"
      ? [0]
      : units.map((_, index) => index);
  return indexes.filter((index) => {
    const target = units[index];
    if (!target) return false;
    if (mode === "alive" && (!target.alive || target.ghost)) return false;
    if (mode === "defeated" && ((target.alive && !target.ghost) || target.reviveUsed)) return false;
    return ignoreConditions || exactTargetMatches(skill, target);
  });
}

function exactCanUseSkill(unit, phaseTypes) {
  const skill = unit.character.skill;
  const maxUses = Math.min(2, Math.max(0, Number(unit.character.maxUses) || 2));
  return Boolean(
    unit.alive &&
    !unit.ghost &&
    skill &&
    EXACT_SUPPORTED_SKILLS.has(skill.type) &&
    phaseTypes.has(skill.type) &&
    unit.skillUses < maxUses &&
    unit.skillCounter >= Math.max(0, Number(unit.character.skillTurn) || 0)
  );
}

function exactAddBuff(state, unit, type, skill, overrides = {}) {
  unit.buffs.push({
    type,
    multiplier: Number(skill.multiplier) || 1,
    hits: Math.max(1, Number(skill.hits) || 1),
    attributes: (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []),
    conditions: exactClone(skill.conditions ?? []),
    remainingTurns: Math.max(1, Number(skill.duration) || 1),
    activationOrder: state.nextEffectOrder++,
    ...overrides,
  });
}

function exactHealUnit(unit, multiplier) {
  if (!unit.alive || unit.ghost) return;
  unit.currentHp = Math.min(unit.maxHp * 2, unit.currentHp + unit.maxHp * Math.max(0, Number(multiplier) || 0));
}

function exactDelayTargets(units, skill, character) {
  const matching = units.flatMap((unit, index) => (
    unit.alive && !unit.ghost && exactTargetMatches(skill, unit) ? [index] : []
  ));
  return skill.target === "enemy_one" && !/全員/.test(character.skillName ?? "")
    ? matching.slice(0, 1)
    : matching;
}

function exactApplyIntent(state, intent, pendingRevives) {
  const actor = state[intent.side][intent.actorIndex];
  const skill = actor.character.skill;
  actor.skillUses += 1;
  actor.skillCounter = 0;
  const ownUnits = state[intent.side];
  const opponentUnits = state[intent.side === "allies" ? "enemies" : "allies"];

  if (skill.type === "skill_reduction") {
    const amount = Math.max(0, Number(skill.amount) || 0);
    for (const index of exactFriendlyTargets(ownUnits, intent.actorIndex, actor.character)) {
      ownUnits[index].skillCounter += amount;
    }
  } else if (skill.type === "attribute_change") {
    const attributes = (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
    if (attributes.length) {
      for (const index of exactFriendlyTargets(ownUnits, intent.actorIndex, actor.character)) {
        exactAddBuff(state, ownUnits[index], "attribute_change", skill);
        ownUnits[index].attributes = [...attributes];
      }
    }
  } else if (skill.type === "delay") {
    const amount = Math.max(0, Number(skill.amount) || 0);
    for (const index of exactDelayTargets(opponentUnits, skill, actor.character)) {
      opponentUnits[index].skillCounter -= amount;
    }
  } else if (skill.type === "heal") {
    for (const index of exactFriendlyTargets(ownUnits, intent.actorIndex, actor.character)) {
      const target = ownUnits[index];
      exactHealUnit(target, skill.multiplier);
      if (Number(skill.duration) > 1) {
        exactAddBuff(state, target, "continuous_heal", skill);
      }
    }
  } else if (skill.type === "revive") {
    pendingRevives.push({
      side: intent.side,
      actorIndex: intent.actorIndex,
      character: exactClone(actor.character),
      skill: exactClone(skill),
    });
  } else if (["attack_buff", ...EXACT_DEFENSE_TYPES].includes(skill.type)) {
    for (const index of exactFriendlyTargets(ownUnits, intent.actorIndex, actor.character, "alive", true)) {
      exactAddBuff(state, ownUnits[index], skill.type, skill);
    }
  } else if (["aoe_attack", "multi_hit_attack"].includes(skill.type)) {
    for (const index of exactFriendlyTargets(ownUnits, intent.actorIndex, actor.character, "alive", true)) {
      exactAddBuff(state, ownUnits[index], skill.type, skill);
    }
  }

  return {
    side: intent.side,
    actorName: actor.character.name,
    skillType: skill.type,
    skillName: actor.character.skillName,
    skill: {
      target: skill.target,
      multiplier: skill.multiplier,
      amount: skill.amount,
      hits: skill.hits,
      duration: skill.duration,
      effects: exactClone(skill.effects ?? []),
    },
  };
}

function exactReadyIntents(state, phaseTypes, used) {
  const intents = [];
  for (const side of ["allies", "enemies"]) {
    for (let actorIndex = 0; actorIndex < state[side].length; actorIndex += 1) {
      const key = `${side}:${actorIndex}`;
      if (used.has(key) || !exactCanUseSkill(state[side][actorIndex], phaseTypes)) continue;
      intents.push({ side, actorIndex, key });
    }
  }
  return intents;
}

function exactOrderSensitiveBuff(buff) {
  return ["guard", "attribute_guard", "attribute_change"].includes(buff.type);
}

function exactBuffKey(buff) {
  return [
    buff.type,
    buff.multiplier,
    buff.hits,
    buff.remainingTurns,
    exactOrderSensitiveBuff(buff) ? buff.activationOrder : 0,
    (buff.attributes ?? []).join(","),
    JSON.stringify(buff.conditions ?? []),
  ];
}

function exactCanonicalBuffKeys(buffs) {
  return buffs.map(exactBuffKey).map(JSON.stringify).sort();
}

function exactUnitKey(unit) {
  return [
    String(unit.character.id),
    unit.currentHp,
    unit.maxHp,
    unit.alive ? 1 : 0,
    unit.ghost ? 1 : 0,
    unit.reviveUsed ? 1 : 0,
    unit.skillCounter,
    unit.skillUses,
    unit.lane ?? -1,
    unit.attributes.join(","),
    exactCanonicalBuffKeys(unit.buffs),
  ];
}

function exactStateKey(state) {
  return JSON.stringify([
    state.turn,
    state.defeatedEnemies,
    state.allies.map(exactUnitKey),
    state.enemies.map(exactUnitKey),
    state.enemyLaneBuffs.map(exactCanonicalBuffKeys),
    state.enemyQueue.map((character) => String(character.id)),
  ]);
}

function exactPendingKey(pendingRevives) {
  return pendingRevives.map((intent) => [intent.side, intent.actorIndex, String(intent.character.id)]);
}

function exactSkillPhase(initial, phaseTypes, initialPending, initialEvents, stats, options) {
  if (options.skillSearch === "automatic") {
    const state = exactClone(initial);
    const pendingRevives = exactClone(initialPending);
    const events = [...initialEvents];
    const usedAllies = new Set();
    while (true) {
      const readyAlly = exactReadyIntents(state, phaseTypes, usedAllies)
        .filter((intent) => intent.side === "allies")
        .sort((left, right) => left.actorIndex - right.actorIndex)[0];
      if (!readyAlly) break;
      events.push(exactApplyIntent(state, readyAlly, pendingRevives));
      usedAllies.add(readyAlly.key);
      stats.skillBranches += 1;
    }
    const usedEnemies = new Set();
    while (true) {
      const readyEnemy = exactReadyIntents(state, phaseTypes, usedEnemies)
        .filter((intent) => intent.side === "enemies")
        .sort((left, right) => left.actorIndex - right.actorIndex)[0];
      if (!readyEnemy) break;
      events.push(exactApplyIntent(state, readyEnemy, pendingRevives));
      usedEnemies.add(readyEnemy.key);
      stats.skillBranches += 1;
    }
    return [{ state, pendingRevives, events }];
  }
  const allyOutcomes = new Map();
  const allyVisited = new Set();
  const exploreAllies = (state, used, pendingRevives, events) => {
    const visitKey = JSON.stringify([exactStateKey(state), [...used].sort(), exactPendingKey(pendingRevives)]);
    if (allyVisited.has(visitKey)) return;
    allyVisited.add(visitKey);
    const outcomeKey = JSON.stringify([exactStateKey(state), exactPendingKey(pendingRevives)]);
    if (!allyOutcomes.has(outcomeKey)) allyOutcomes.set(outcomeKey, { state, pendingRevives, events, used });
    const readyAllies = exactReadyIntents(state, phaseTypes, used)
      .filter((intent) => intent.side === "allies");
    for (const intent of readyAllies) {
      const nextState = exactClone(state);
      const nextPending = exactClone(pendingRevives);
      const event = exactApplyIntent(nextState, intent, nextPending);
      const nextUsed = new Set(used);
      nextUsed.add(intent.key);
      stats.skillBranches += 1;
      exploreAllies(nextState, nextUsed, nextPending, [...events, event]);
    }
  };
  exploreAllies(exactClone(initial), new Set(), exactClone(initialPending), [...initialEvents]);

  const outcomes = new Map();
  for (const allyOutcome of allyOutcomes.values()) {
    const state = exactClone(allyOutcome.state);
    const pendingRevives = exactClone(allyOutcome.pendingRevives);
    const events = [...allyOutcome.events];
    const usedEnemies = new Set();
    while (true) {
      const readyEnemy = exactReadyIntents(state, phaseTypes, usedEnemies)
        .filter((intent) => intent.side === "enemies")
        .sort((left, right) => left.actorIndex - right.actorIndex)[0];
      if (!readyEnemy) break;
      events.push(exactApplyIntent(state, readyEnemy, pendingRevives));
      usedEnemies.add(readyEnemy.key);
      stats.skillBranches += 1;
    }
    const key = JSON.stringify([exactStateKey(state), exactPendingKey(pendingRevives)]);
    if (!outcomes.has(key)) outcomes.set(key, { state, pendingRevives, events });
  }
  return [...outcomes.values()];
}

function exactApplyContinuousHealing(state, events) {
  for (const side of ["allies", "enemies"]) {
    for (const unit of state[side]) {
      for (const effect of unit.buffs.filter((buff) => buff.type === "continuous_heal")) {
        const hpBefore = unit.currentHp;
        exactHealUnit(unit, effect.multiplier);
        if (unit.currentHp !== hpBefore) {
          events.push({
            side,
            actorName: unit.character.name,
            skillType: "continuous_heal",
            skillName: `継続回復 ${Math.round(effect.multiplier * 100)}%`,
          });
        }
      }
    }
  }
}

function exactAdvanceCounters(state) {
  for (const side of ["allies", "enemies"]) {
    for (const unit of state[side]) {
      if (unit.alive && !unit.ghost) unit.skillCounter += 1;
    }
  }
}

function exactSkillOutcomes(state, stats, options) {
  let branches = [{ state: exactClone(state), pendingRevives: [], events: [] }];
  for (let phaseIndex = 0; phaseIndex < EXACT_SKILL_PHASES.length; phaseIndex += 1) {
    const phaseTypes = new Set(EXACT_SKILL_PHASES[phaseIndex]);
    const next = [];
    for (const branch of branches) {
      const prepared = exactClone(branch);
      if (phaseIndex === EXACT_SKILL_PHASES.length - 1) {
        exactApplyContinuousHealing(prepared.state, prepared.events);
      }
      next.push(...exactSkillPhase(
        prepared.state,
        phaseTypes,
        prepared.pendingRevives,
        prepared.events,
        stats,
        options,
      ));
    }
    const deduped = new Map();
    for (const branch of next) {
      const key = JSON.stringify([exactStateKey(branch.state), exactPendingKey(branch.pendingRevives)]);
      if (!deduped.has(key)) deduped.set(key, branch);
    }
    branches = [...deduped.values()];
  }
  branches.forEach((branch) => exactAdvanceCounters(branch.state));
  return branches;
}

function exactAttackBuff(attacker, defender) {
  return attacker.buffs
    .filter((effect) => effect.type === "attack_buff" && exactEffectMatches(effect, attacker, defender))
    .reduce((product, effect) => product * Math.max(0, Number(effect.multiplier) || 0), 1);
}

function exactDefenseMultiplier(defender, attacker) {
  return defender.buffs
    .filter((effect) => EXACT_DEFENSE_TYPES.has(effect.type) && exactEffectMatches(effect, defender, attacker))
    .reduce((product, effect) => product * Math.max(0, Number(effect.multiplier) || 0), 1);
}

function exactAttackMode(attacker, defender) {
  if (attacker.ghost) return { type: "single_attack", hits: 1 };
  const effects = attacker.buffs.filter((effect) => (
    EXACT_ATTACK_TYPES.has(effect.type) && exactEffectMatches(effect, attacker, defender)
  ));
  if (effects.some((effect) => effect.type === "aoe_attack")) return { type: "aoe_attack", hits: 1 };
  const hits = Math.max(1, ...effects
    .filter((effect) => effect.type === "multi_hit_attack")
    .map((effect) => effect.hits));
  return hits > 1 ? { type: "multi_hit_attack", hits } : { type: "single_attack", hits: 1 };
}

function exactDamage(attacker, defender, side, options, answerFactor = 1) {
  const power = Math.max(0, Number(attacker.character.pow) || 0);
  const eventMultiplier = Number(attacker.character.eventMultiplier) || 1;
  const answerMultiplier = side === "allies"
    ? options.answerMultiplier * answerFactor
    : options.enemyAttackMultiplier;
  const attributeMultiplier = resolveAttributeMultiplier(
    attacker.attributes,
    defender.attributes,
    DEFAULT_RULES,
  );
  if (attacker.ghost) {
    return applyRounding(power * eventMultiplier * 0.5 * answerMultiplier * attributeMultiplier, "floor");
  }
  return applyRounding(
    power * eventMultiplier * answerMultiplier * attributeMultiplier *
      exactAttackBuff(attacker, defender) * exactDefenseMultiplier(defender, attacker),
    "floor",
  );
}

function exactRedirectIndex(defenders, attacker) {
  let selected;
  defenders.forEach((defender, index) => {
    if (!defender.alive || defender.ghost) return;
    defender.buffs.forEach((effect) => {
      if (!["guard", "attribute_guard"].includes(effect.type)) return;
      if (!exactEffectMatches(effect, defender, attacker)) return;
      if (!selected || effect.activationOrder >= selected.activationOrder) {
        selected = { index, activationOrder: effect.activationOrder };
      }
    });
  });
  return selected?.index;
}

function exactAutoTarget(attacker, defenders, side, options, answerFactor) {
  const candidates = defenders.flatMap((defender, index) => (
    defender.alive && !defender.ghost
      ? [{ index, damage: exactDamage(attacker, defender, side, options, answerFactor) }]
      : []
  ));
  candidates.sort((left, right) => right.damage - left.damage || left.index - right.index);
  return candidates[0]?.index;
}

function exactHit(attacker, defenders, targetIndex, side, options, answerFactor, action) {
  const defender = defenders[targetIndex];
  if (!defender?.alive || defender.ghost) return;
  const damage = exactDamage(attacker, defender, side, options, answerFactor);
  const hpBefore = defender.currentHp;
  defender.currentHp = Math.max(0, defender.currentHp - damage);
  defender.alive = defender.currentHp > 0;
  action.hits.push({
    targetName: defender.character.name,
    damage,
    hpBefore,
    hpAfter: defender.currentHp,
    defeated: !defender.alive,
  });
}

function exactResolveUnitAttack(attacker, defenders, side, options, answerFactor, manualTarget) {
  const reference = exactActive(defenders)[0];
  if (!reference) return null;
  const mode = exactAttackMode(attacker, reference);
  const action = { side, actorName: attacker.character.name, attackType: mode.type, hits: [] };
  if (mode.type === "aoe_attack") {
    const redirected = attacker.ghost ? undefined : exactRedirectIndex(defenders, attacker);
    if (redirected !== undefined) exactHit(attacker, defenders, redirected, side, options, answerFactor, action);
    else defenders.forEach((_, index) => exactHit(attacker, defenders, index, side, options, answerFactor, action));
    return action;
  }
  for (let hit = 0; hit < mode.hits; hit += 1) {
    const redirected = attacker.ghost ? undefined : exactRedirectIndex(defenders, attacker);
    const manualIsAlive = manualTarget !== undefined && defenders[manualTarget]?.alive && !defenders[manualTarget]?.ghost;
    const targetIndex = redirected ?? (manualIsAlive
      ? manualTarget
      : exactAutoTarget(attacker, defenders, side, options, answerFactor));
    if (targetIndex === undefined) break;
    exactHit(attacker, defenders, targetIndex, side, options, answerFactor, action);
  }
  return action;
}

function exactGhostDefeatedAllies(state) {
  const ghosts = [];
  for (const ally of state.allies) {
    if (ally.alive || ally.ghost) continue;
    ally.ghost = true;
    ally.attributes = [...exactAttributes(ally.character)];
    ally.buffs = [];
    ghosts.push(ally.character.name);
  }
  return ghosts;
}

function exactApplyRevives(state, pendingRevives) {
  const events = [];
  for (const intent of pendingRevives) {
    const units = state[intent.side];
    for (const index of exactFriendlyTargets(units, intent.actorIndex, intent.character, "defeated")) {
      const target = units[index];
      target.ghost = false;
      target.alive = true;
      target.reviveUsed = true;
      target.currentHp = Math.max(1, Math.min(target.maxHp * 2, target.maxHp * intent.skill.multiplier));
      if (!target.attributes.length) target.attributes = [...exactAttributes(target.character)];
      events.push({ side: intent.side, actorName: intent.character.name, targetName: target.character.name });
    }
  }
  return events;
}

function exactResolveBattle(branch, options, answerFactor, manualTargets = []) {
  const state = exactClone(branch.state);
  const attacks = [];
  const allyAttackers = state.allies.flatMap((unit, actorIndex) => (
    unit.alive || unit.ghost ? [{ actorIndex, unit: exactClone(unit) }] : []
  ));
  const enemyAttackers = state.enemies.flatMap((unit, actorIndex) => (
    unit.alive && !unit.ghost ? [{ actorIndex, unit: exactClone(unit) }] : []
  ));
  for (const { actorIndex: allyIndex, unit: attacker } of allyAttackers) {
    const action = exactResolveUnitAttack(
      attacker,
      state.enemies,
      "allies",
      options,
      answerFactor,
      manualTargets[allyIndex],
    );
    if (action) attacks.push({ ...action, actorIndex: allyIndex });
  }
  for (const { actorIndex: enemyIndex, unit: enemy } of enemyAttackers) {
    const action = exactResolveUnitAttack(enemy, state.allies, "enemies", options, 1, undefined);
    if (action) attacks.push({ ...action, actorIndex: enemyIndex });
  }
  const becameGhosts = exactGhostDefeatedAllies(state);
  const revives = exactApplyRevives(state, branch.pendingRevives);
  const remainingEnemies = [];
  for (const enemy of state.enemies) {
    if (enemy.alive) {
      remainingEnemies.push(enemy);
      continue;
    }
    const carriedBuffs = enemy.buffs.filter((effect) => effect.remainingTurns > 1);
    if (Number.isInteger(enemy.lane) && carriedBuffs.length) {
      state.enemyLaneBuffs[enemy.lane] = exactClone(carriedBuffs);
    }
    state.defeatedEnemies += 1;
  }
  state.enemies = remainingEnemies.sort((left, right) => (left.lane ?? Infinity) - (right.lane ?? Infinity));
  return { state, attacks, becameGhosts, revives };
}

function exactExpireBuffs(buffs) {
  return buffs
    .map((effect) => ({ ...effect, remainingTurns: effect.remainingTurns - 1 }))
    .filter((effect) => effect.remainingTurns > 0);
}

function exactExpireEffects(state) {
  for (const side of ["allies", "enemies"]) {
    for (const unit of state[side]) {
      unit.buffs = exactExpireBuffs(unit.buffs);
      unit.attributes = exactAttributesAfterBuffs(unit.character, unit.buffs);
    }
  }
  state.enemyLaneBuffs = state.enemyLaneBuffs.map(exactExpireBuffs);
}

function exactSnapshot(state) {
  return {
    aliveAllies: state.allies.filter((unit) => unit.alive && !unit.ghost).length,
    ghosts: state.allies.filter((unit) => unit.ghost).length,
    activeEnemies: exactActive(state.enemies).length,
    queuedEnemies: state.enemyQueue.length,
    defeatedEnemies: state.defeatedEnemies,
    allyHpRatio: state.allies.reduce((sum, unit) => sum + (unit.ghost ? 0 : unit.currentHp / unit.maxHp), 0) /
      Math.max(1, state.allies.length),
  };
}

function exactManualTargetGroupKey(state, allyIndex, referenceTarget) {
  const ally = state.allies[allyIndex];
  if (exactAttackMode(ally, referenceTarget).type !== "single_attack") return null;
  if (!ally.ghost && exactRedirectIndex(state.enemies, ally) !== undefined) return null;
  return JSON.stringify([
    ally.ghost ? 1 : 0,
    Math.max(0, Number(ally.character.pow) || 0),
    Number(ally.character.eventMultiplier) || 1,
    ally.attributes,
    ally.buffs.map(exactBuffKey),
  ]);
}

function exactManualTargetGroups(state, controlledAllyIndexes, referenceTarget) {
  const groups = [];
  for (const allyIndex of controlledAllyIndexes) {
    const key = exactManualTargetGroupKey(state, allyIndex, referenceTarget);
    const previous = groups.at(-1);
    if (key && previous?.key === key && previous.allyIndexes.at(-1) === allyIndex - 1) {
      previous.allyIndexes.push(allyIndex);
    } else {
      groups.push({ key, allyIndexes: [allyIndex] });
    }
  }
  return groups;
}

function exactUnorderedTargetPlanCount(targetCount, attackerCount) {
  let count = 1;
  for (let index = 1; index <= attackerCount; index += 1) {
    count = (count * (targetCount + index - 1)) / index;
  }
  return count;
}

function exactManualTargetPlans(state, stats, options) {
  const targetIndexes = state.enemies.flatMap((enemy, index) => (
    enemy.alive && !enemy.ghost ? [index] : []
  ));
  const manualTargets = Array(state.allies.length).fill(undefined);
  if (!targetIndexes.length || options.targetSearch === "automatic") return [manualTargets];
  const referenceTarget = state.enemies[targetIndexes[0]];
  const targetableAllyIndexes = state.allies.flatMap((ally, index) => (
    (ally.alive || ally.ghost) && exactAttackMode(ally, referenceTarget).type !== "aoe_attack"
      ? [index]
      : []
  ));
  const controlledAllyIndexes = targetableAllyIndexes.filter((index) => (
    Math.max(0, Number(state.allies[index].character.pow) || 0) > 0
  ));
  stats.skippedTargetControls += targetableAllyIndexes.length - controlledAllyIndexes.length;
  const targetGroups = exactManualTargetGroups(state, controlledAllyIndexes, referenceTarget);
  for (const group of targetGroups) {
    if (!group.key || group.allyIndexes.length < 2) continue;
    stats.collapsedTargetPlans += targetIndexes.length ** group.allyIndexes.length -
      exactUnorderedTargetPlanCount(targetIndexes.length, group.allyIndexes.length);
  }
  const plans = [];
  const selectGroup = (groupCursor) => {
    if (groupCursor >= targetGroups.length) {
      plans.push([...manualTargets]);
      return;
    }
    const group = targetGroups[groupCursor];
    const selectTarget = (allyCursor, minimumTargetCursor) => {
      if (allyCursor >= group.allyIndexes.length) {
        selectGroup(groupCursor + 1);
        return;
      }
      const allyIndex = group.allyIndexes[allyCursor];
      const startTargetCursor = group.key ? minimumTargetCursor : 0;
      for (let targetCursor = startTargetCursor; targetCursor < targetIndexes.length; targetCursor += 1) {
        manualTargets[allyIndex] = targetIndexes[targetCursor];
        selectTarget(allyCursor + 1, targetCursor);
      }
      manualTargets[allyIndex] = undefined;
    };
    selectTarget(0, 0);
  };
  selectGroup(0);
  return plans;
}

function exactTargetAssignments(state, manualTargets) {
  return manualTargets.flatMap((targetIndex, allyIndex) => {
    if (targetIndex === undefined) return [];
    const ally = state.allies[allyIndex];
    const target = state.enemies[targetIndex];
    if (!ally || !target) return [];
    return [{
      allyIndex,
      actorName: ally.character.name,
      targetIndex,
      targetName: target.character.name,
    }];
  });
}

function exactAnswerModes(options) {
  const answerModes = [{ key: "full", label: "正答", factor: 1 }];
  if (options.allowHalfAnswer) {
    answerModes.push({ key: "half", label: "半誤答", factor: options.halfAnswerMultiplier });
  }
  return answerModes;
}

function exactAllSurvived(state, deckSize) {
  return state.allies.filter((unit) => unit.alive && !unit.ghost).length === deckSize &&
    state.allies.every((unit) => !unit.ghost);
}

function exactMaximumDefeatsByDeadline(currentTurn, maxTurns) {
  let capacity = 0;
  for (let turn = currentTurn; turn <= maxTurns; turn += 1) capacity += Math.min(3, turn);
  return capacity;
}

function exactBoundProduct(left, right) {
  if (left === 0 || right === 0) return 0;
  const result = left * right;
  return Number.isFinite(result) ? result : Infinity;
}

function exactPotentialAttackMultiplier(state) {
  let multiplier = 1;
  const includeMultiplier = (value) => {
    multiplier = exactBoundProduct(multiplier, Math.max(1, Number(value) || 1));
  };
  for (const unit of state.allies) {
    unit.buffs
      .filter((buff) => buff.type === "attack_buff")
      .forEach((buff) => includeMultiplier(buff.multiplier));
    const skill = unit.character.skill;
    if (skill?.type !== "attack_buff") continue;
    const maxUses = Math.min(2, Math.max(0, Number(unit.character.maxUses) || 2));
    const remainingUses = Math.max(0, maxUses - unit.skillUses);
    for (let use = 0; use < remainingUses; use += 1) includeMultiplier(skill.multiplier);
  }
  return multiplier;
}

function exactPotentialHitsPerAttacker(state) {
  let hits = 1;
  const includeAttackMode = (type, value) => {
    if (type === "aoe_attack") hits = Math.max(hits, 3);
    if (type === "multi_hit_attack") hits = Math.max(hits, Math.max(1, Number(value) || 1));
  };
  for (const unit of state.allies) {
    unit.buffs.forEach((buff) => includeAttackMode(buff.type, buff.hits));
    includeAttackMode(unit.character.skill?.type, unit.character.skill?.hits);
  }
  return hits;
}

function exactRemainingDamageUpperBound(state, options) {
  const remainingTurns = Math.max(0, options.maxTurns - state.turn + 1);
  const power = state.allies.reduce((sum, unit) => (
    sum + Math.max(0, Number(unit.character.pow) || 0) * Math.max(0, Number(unit.character.eventMultiplier) || 1)
  ), 0);
  return exactBoundProduct(
    exactBoundProduct(
      exactBoundProduct(power, Math.max(0, Number(options.answerMultiplier) || 0)),
      exactPotentialAttackMultiplier(state),
    ),
    exactBoundProduct(exactPotentialHitsPerAttacker(state), remainingTurns),
  );
}

function exactImpossibleReason(state, options) {
  if (!exactActive(state.allies).length) return "noActiveAllies";
  const remainingEnemyCount = exactActive(state.enemies).length + state.enemyQueue.length;
  if (remainingEnemyCount > exactMaximumDefeatsByDeadline(state.turn, options.maxTurns)) {
    return "enemyCapacity";
  }
  const activeEnemyHp = exactActive(state.enemies)
    .reduce((sum, enemy) => sum + Math.max(0, Number(enemy.currentHp) || 0), 0);
  const queuedEnemyHp = state.enemyQueue
    .reduce((sum, enemy) => sum + Math.max(0, Number(enemy.hp) || 0), 0);
  const remainingEnemyHp = activeEnemyHp + queuedEnemyHp;
  return exactRemainingDamageUpperBound(state, options) < remainingEnemyHp ? "damageUpperBound" : null;
}

function exactInitialDeckImpossibleReason(deck, enemies, options) {
  const state = exactCreateState(deck, enemies, options);
  exactSpawn(state);
  return exactImpossibleReason(state, options);
}

function exactAssumptions() {
  return [
    "総コストの低い到達可能値から順に、候補圧縮せず全デッキ・全配置を探索",
    "味方スキルは温存を含む全使用順、正答・半誤答、各ターンの5人別手動標的を完全探索",
    "同コストの公式順位は実時間のため、このシミュレーターでは順位付けしない",
    "敵は固定順で1問目1体・2問目2体・3問目以降3体になるよう補充",
    "攻撃フェーズ開始時に生存していた敵味方は、その後に撃破されても同じターンの攻撃を行う",
    "残ターンの撃破枠と最大理論ダメージでも不可能な状態だけを安全に枝刈り",
    "幽霊は元の非幽霊時Powerの半分で属性相性のみ適用し、攻撃・防御スキルを無視",
    "継続回復は発動ターンを含め、指定ターン数だけその他スキル段階で処理",
    "乱数・対戦固定係数・生存1.3倍補正・リーダー/助っ人スキルは不使用",
  ];
}

export function solveExactLightestStage(deck, enemies, solveOptions = {}) {
  const options = { ...EXACT_LIGHTEST_DEFAULTS, ...solveOptions };
  const initial = exactCreateState(deck, enemies, options);
  const failedMemo = new Set();
  const stats = {
    visitedStates: 0,
    memoHits: 0,
    skillBranches: 0,
    battleBranches: 0,
    skippedTargetControls: 0,
    collapsedTargetPlans: 0,
    prunedStates: { noActiveAllies: 0, enemyCapacity: 0, damageUpperBound: 0 },
  };

  const search = (inputState) => {
    if (options.signal?.aborted) throw exactAbortError();
    if (inputState.turn > options.maxTurns) return null;
    const memoKey = exactStateKey(inputState);
    if (failedMemo.has(memoKey)) {
      stats.memoHits += 1;
      return null;
    }
    stats.visitedStates += 1;
    const state = exactClone(inputState);
    const spawned = exactSpawn(state);
    if (!state.enemies.length && !state.enemyQueue.length) {
      return exactAllSurvived(state, deck.length) ? { state, history: [] } : null;
    }
    const impossibleReason = exactImpossibleReason(state, options);
    if (impossibleReason) {
      stats.prunedStates[impossibleReason] += 1;
      failedMemo.add(memoKey);
      return null;
    }
    const skillBranches = exactSkillOutcomes(state, stats, options);
    const turnOutcomes = new Map();
    for (const skillBranch of skillBranches) {
      for (const answerMode of exactAnswerModes(options)) {
        for (const manualTargets of exactManualTargetPlans(skillBranch.state, stats, options)) {
          stats.battleBranches += 1;
          const battle = exactResolveBattle(skillBranch, options, answerMode.factor, manualTargets);
          const turnLog = {
            turn: state.turn,
            spawned,
            skills: skillBranch.events,
            answerMode: answerMode.key,
            answerLabel: answerMode.label,
            targetAssignments: exactTargetAssignments(skillBranch.state, manualTargets),
            attacks: battle.attacks,
            becameGhosts: battle.becameGhosts,
            revives: battle.revives,
            ...exactSnapshot(battle.state),
          };
          const outcomeKey = exactStateKey(battle.state);
          if (!turnOutcomes.has(outcomeKey)) turnOutcomes.set(outcomeKey, { state: battle.state, turnLog });
        }
      }
    }
    for (const outcome of turnOutcomes.values()) {
      const cleared = outcome.state.enemyQueue.length === 0 && exactActive(outcome.state.enemies).length === 0;
      if (cleared && exactAllSurvived(outcome.state, deck.length)) {
        return { state: outcome.state, history: [outcome.turnLog] };
      }
      if (outcome.state.turn >= options.maxTurns) continue;
      if (!exactActive(outcome.state.allies).length) continue;
      const nextState = exactClone(outcome.state);
      exactExpireEffects(nextState);
      nextState.turn += 1;
      const suffix = search(nextState);
      if (suffix) return { state: suffix.state, history: [outcome.turnLog, ...suffix.history] };
    }
    failedMemo.add(memoKey);
    return null;
  };

  const solution = search(initial);
  const finalState = solution?.state ?? initial;
  const history = solution?.history ?? [];
  return {
    cleared: Boolean(solution),
    failed: !solution,
    allSurvived: Boolean(solution),
    threeStar: Boolean(solution),
    turnsCompleted: history.length,
    totalCost: deck.reduce((sum, character) => sum + Math.max(0, Number(character.cost) || 0), 0),
    deck,
    enemies,
    history,
    final: exactSnapshot(finalState),
    exactSearch: stats,
    searchPolicy: { targetSearch: options.targetSearch, skillSearch: options.skillSearch },
    assumptions: exactAssumptions(),
  };
}

function exactAttributeMatches(character, allowedAttributes) {
  return !allowedAttributes?.length || exactAttributes(character).some((attribute) => allowedAttributes.includes(attribute));
}

function exactRarityMatches(character, rarities) {
  return !rarities?.length || rarities.includes(character.rarity);
}


export function exactCandidateTrialPriority(character) {
  const power = Math.max(0, Number(character.pow) || 0);
  const hp = Math.max(0, Number(character.hp) || 0);
  const skill = character.skill ?? {};
  const skillTurn = Math.max(0, Number(character.skillTurn) || 99);
  const readiness = 1 / (skillTurn + 1);
  const targetCount = Math.max(1, Number(skill.targetCount) || 1);
  const multiplier = Number(skill.multiplier) || 1;
  const hits = Math.max(1, Number(skill.hits) || 1);
  let skillValue = 0;
  if (skill.type === "attack_buff") skillValue = power * Math.max(0, multiplier - 1) * targetCount;
  if (skill.type === "aoe_attack") skillValue = power * 2;
  if (skill.type === "multi_hit_attack") skillValue = power * Math.max(0, hits - 1);
  if (["damage_reduction", "guard", "attribute_guard", "heal", "revive"].includes(skill.type)) {
    skillValue = hp * Math.max(1, Number(skill.multiplier) || 1) * targetCount;
  }
  return power * 2 + hp * 0.35 + skillValue * readiness;
}

function exactCharacterSkillType(character) {
  return String(character?.skill?.type ?? "none");
}

function exactRequiredLastSkillType(stage) {
  const value = String(stage.requiredLastSkillType ?? "").trim();
  return value || null;
}

function exactHp(character) {
  return Math.max(0, Number(character?.hp) || 0);
}

function exactDeckHasRequiredLastSkill(combination, requiredLastSkillType) {
  return !requiredLastSkillType || combination.some((character) => (
    exactCharacterSkillType(character) === requiredLastSkillType
  ));
}
function exactAvailableCharacters(characters, stage, options) {
  const candidateIds = new Set((stage.candidateIds ?? []).map(String));
  return characters
    .filter((character) => (
      exactAttributeMatches(character, stage.allowedAttributes) &&
      exactRarityMatches(character, stage.rarities ?? []) &&
      (!options.ownedOnly || character.owned !== false) &&
      (!candidateIds.size || candidateIds.has(String(character.id))) &&
      Math.max(0, Number(character.cost) || 0) <= stage.maxCost
    ))
    .sort((left, right) => (
      Number(left.cost) - Number(right.cost) ||
      exactCandidateTrialPriority(right) - exactCandidateTrialPriority(left) ||
      String(left.id).localeCompare(String(right.id))
    ));
}

function exactAttainableCosts(characters, deckSize, maxCost, allowDuplicates) {
  const sumsByCount = Array.from({ length: deckSize + 1 }, () => new Set());
  sumsByCount[0].add(0);
  if (allowDuplicates) {
    for (let count = 1; count <= deckSize; count += 1) {
      for (const sum of sumsByCount[count - 1]) {
        for (const character of characters) {
          const next = sum + Math.max(0, Number(character.cost) || 0);
          if (next <= maxCost) sumsByCount[count].add(next);
        }
      }
    }
  } else {
    for (const character of characters) {
      const cost = Math.max(0, Number(character.cost) || 0);
      for (let count = deckSize; count >= 1; count -= 1) {
        for (const sum of sumsByCount[count - 1]) {
          const next = sum + cost;
          if (next <= maxCost) sumsByCount[count].add(next);
        }
      }
    }
  }
  return [...sumsByCount[deckSize]].sort((left, right) => left - right);
}

function exactCombinationCounts(characters, deckSize, maxCost, allowDuplicates, requiredLastSkillType) {
  const countsBySize = Array.from({ length: deckSize + 1 }, () => new Map());
  countsBySize[0].set(0, [1, 0]);
  for (const character of characters) {
    const cost = Math.max(0, Number(character.cost) || 0);
    const isRequiredSkill = exactCharacterSkillType(character) === requiredLastSkillType;
    const firstCount = allowDuplicates ? 1 : deckSize;
    const lastCount = allowDuplicates ? deckSize : 1;
    const increment = allowDuplicates ? 1 : -1;
    for (let count = firstCount; allowDuplicates ? count <= lastCount : count >= lastCount; count += increment) {
      for (const [sum, [withoutRequiredSkill, withRequiredSkill]] of countsBySize[count - 1]) {
        const nextSum = sum + cost;
        if (nextSum > maxCost) continue;
        const nextCounts = countsBySize[count].get(nextSum) ?? [0, 0];
        if (isRequiredSkill) {
          nextCounts[1] += withoutRequiredSkill + withRequiredSkill;
        } else {
          nextCounts[0] += withoutRequiredSkill;
          nextCounts[1] += withRequiredSkill;
        }
        countsBySize[count].set(nextSum, nextCounts);
      }
    }
  }
  return new Map([...countsBySize[deckSize]].map(([cost, [withoutRequiredSkill, withRequiredSkill]]) => [
    cost,
    requiredLastSkillType ? withRequiredSkill : withoutRequiredSkill + withRequiredSkill,
  ]));
}

export function prepareExactLightestCandidateProfile(characters, stage, searchOptions = {}) {
  const options = { ...EXACT_LIGHTEST_DEFAULTS, ...searchOptions };
  const deckSize = Number(stage.deckSize ?? options.deckSize);
  if (!Number.isInteger(deckSize) || deckSize < 1 || deckSize > 5) {
    throw new Error("デッキ枚数は1〜5で設定してください");
  }
  if (!Number.isFinite(Number(stage.maxCost)) || Number(stage.maxCost) < 0) {
    throw new Error("コスト上限を0以上で設定してください");
  }
  const normalizedStage = {
    ...stage,
    maxCost: Number(stage.maxCost),
    deckSize,
    requiredLastSkillType: exactRequiredLastSkillType(stage),
    orderByHpDescending: Boolean(stage.orderByHpDescending),
  };
  const available = exactAvailableCharacters(characters, normalizedStage, { ...options, deckSize });
  if (!available.length) throw new Error("縛りに合う味方候補がありません");
  if (!options.allowDuplicates && available.length < deckSize) {
    throw new Error("重複なしでは味方候補がデッキ枚数に足りません");
  }
  const attainableCosts = exactAttainableCosts(
    available,
    deckSize,
    normalizedStage.maxCost,
    options.allowDuplicates,
  );
  return {
    deckSize,
    maxCost: normalizedStage.maxCost,
    allowDuplicates: Boolean(options.allowDuplicates),
    available,
    attainableCosts,
    combinationCountsByCost: exactCombinationCounts(
      available,
      deckSize,
      normalizedStage.maxCost,
      options.allowDuplicates,
      normalizedStage.requiredLastSkillType,
    ),
  };
}

function* exactCombinationsAtCost(characters, targetCost, deckSize, allowDuplicates, startIndex = 0, deck = [], sum = 0) {
  if (deck.length === deckSize) {
    if (sum === targetCost) yield [...deck];
    return;
  }
  const remainingAfterPick = deckSize - deck.length - 1;
  for (let index = startIndex; index < characters.length; index += 1) {
    const character = characters[index];
    const cost = Math.max(0, Number(character.cost) || 0);
    const nextSum = sum + cost;
    if (nextSum > targetCost) break;
    const nextStart = allowDuplicates ? index : index + 1;
    const minimumTailCost = remainingAfterPick > 0
      ? Math.max(0, Number(characters[nextStart]?.cost) || Infinity) * remainingAfterPick
      : 0;
    if (nextSum + minimumTailCost > targetCost) continue;
    deck.push(character);
    yield* exactCombinationsAtCost(
      characters,
      targetCost,
      deckSize,
      allowDuplicates,
      nextStart,
      deck,
      nextSum,
    );
    deck.pop();
  }
}

function exactDeckOrderKey(deck) {
  return deck.map((character) => String(character.id)).join("\u001f");
}
function exactPreferredDeck(preferredDeck, available, stage, options, totalCost) {
  if (!Array.isArray(preferredDeck) || preferredDeck.length !== options.deckSize) return null;
  const charactersById = new Map(available.map((character) => [String(character.id), character]));
  const deck = preferredDeck.map((character) => charactersById.get(String(character?.id)));
  if (deck.some((character) => !character)) return null;
  if (!options.allowDuplicates && new Set(deck.map((character) => String(character.id))).size !== deck.length) return null;
  if (deck.reduce((sum, character) => sum + Math.max(0, Number(character.cost) || 0), 0) !== totalCost) return null;
  if (stage.requiredLastSkillType && exactCharacterSkillType(deck.at(-1)) !== stage.requiredLastSkillType) return null;
  if (stage.orderByHpDescending) {
    for (let index = 1; index < deck.length - 1; index += 1) {
      if (exactHp(deck[index - 1]) < exactHp(deck[index])) return null;
    }
  }
  return deck;
}
function* exactUniquePermutations(deck, constraints = {}) {
  const counts = new Map();
  const byId = new Map();
  const requiredLastSkillType = constraints.requiredLastSkillType ?? null;
  const orderByHpDescending = Boolean(constraints.orderByHpDescending);
  for (const character of deck) {
    const id = String(character.id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    byId.set(id, character);
  }
  const ids = [...counts.keys()].sort((left, right) => (
    exactCandidateTrialPriority(byId.get(right)) - exactCandidateTrialPriority(byId.get(left)) ||
    left.localeCompare(right)
  ));
  const current = [];
  function* recurse() {
    if (current.length === deck.length) {
      yield [...current];
      return;
    }
    const slotIndex = current.length;
    const isLastSlot = slotIndex === deck.length - 1;
    for (const id of ids) {
      const remaining = counts.get(id) ?? 0;
      if (!remaining) continue;
      const character = byId.get(id);
      if (isLastSlot && requiredLastSkillType && exactCharacterSkillType(character) !== requiredLastSkillType) continue;
      if (orderByHpDescending && slotIndex > 0 && !isLastSlot && exactHp(current.at(-1)) < exactHp(character)) continue;
      counts.set(id, remaining - 1);
      current.push(character);
      yield* recurse();
      current.pop();
      counts.set(id, remaining);
    }
  }
  yield* recurse();
}

export async function findExactLightestDeck(characters, stage, searchOptions = {}) {
  const options = { ...EXACT_LIGHTEST_DEFAULTS, ...searchOptions };
  const requestedDeckSize = Number(stage.deckSize ?? options.deckSize);
  if (!Number.isInteger(requestedDeckSize) || requestedDeckSize < 1 || requestedDeckSize > 5) {
    throw new Error("デッキ枚数は1〜5で設定してください");
  }
  options.deckSize = requestedDeckSize;
  if (!Array.isArray(stage.enemies) || !stage.enemies.length) throw new Error("敵を1体以上設定してください");
  if (!Number.isFinite(Number(stage.maxCost)) || Number(stage.maxCost) < 0) {
    throw new Error("コスト上限を0以上で設定してください");
  }
  const hasTargetCost = stage.targetCost !== undefined && stage.targetCost !== null && String(stage.targetCost).trim() !== "";
  const targetCost = hasTargetCost ? Number(stage.targetCost) : null;
  if (targetCost !== null && (!Number.isInteger(targetCost) || targetCost < 0)) {
    throw new Error("指定コストは0以上の整数で設定してください");
  }
  if (targetCost !== null && targetCost > Number(stage.maxCost)) {
    throw new Error("指定コストは最大指定コスト以下で設定してください");
  }
  const normalizedStage = {
    ...stage,
    maxCost: Number(stage.maxCost),
    maxTurns: Number(stage.maxTurns) || options.maxTurns,
    deckSize: options.deckSize,
    requiredLastSkillType: exactRequiredLastSkillType(stage),
    orderByHpDescending: Boolean(stage.orderByHpDescending),
    targetCost,
  };
  const preparedCandidateProfile = options.preparedCandidateProfile;
  const canReusePreparedProfile = preparedCandidateProfile &&
    preparedCandidateProfile.deckSize === options.deckSize &&
    preparedCandidateProfile.maxCost === normalizedStage.maxCost &&
    preparedCandidateProfile.allowDuplicates === Boolean(options.allowDuplicates);
  const available = canReusePreparedProfile
    ? preparedCandidateProfile.available
    : exactAvailableCharacters(characters, normalizedStage, options);
  if (!available.length) throw new Error("縛りに合う味方候補がありません");
  if (!options.allowDuplicates && available.length < options.deckSize) {
    throw new Error("重複なしでは味方候補がデッキ枚数に足りません");
  }
  const attainableCosts = canReusePreparedProfile
    ? preparedCandidateProfile.attainableCosts
    : exactAttainableCosts(
      available,
      options.deckSize,
      normalizedStage.maxCost,
      options.allowDuplicates,
    );
  const combinationCountsByCost = canReusePreparedProfile
    ? preparedCandidateProfile.combinationCountsByCost
    : exactCombinationCounts(
      available,
      options.deckSize,
      normalizedStage.maxCost,
      options.allowDuplicates,
      normalizedStage.requiredLastSkillType,
    );
  const costsToSearch = (normalizedStage.targetCost === null
    ? attainableCosts
    : attainableCosts.filter((cost) => cost === normalizedStage.targetCost))
    .filter((cost) => (combinationCountsByCost.get(cost) ?? 0) > 0);
  let generatedCombinations = 0;
  let prePrunedCombinationCount = 0;
  let simulatedDeckCount = 0;
  const winners = [];
  let searchedThroughCost = normalizedStage.targetCost;
  let stoppedOnFirstWin = false;
  let preferredDeckTested = false;
  let preferredDeckAccepted = false;

  for (const totalCost of costsToSearch) {
    searchedThroughCost = totalCost;
    const totalCombinations = combinationCountsByCost.get(totalCost) ?? 0;
    let costDeckCount = 0;
    let shouldStop = false;
    const preferredDeck = exactPreferredDeck(
      options.preferredDeck,
      available,
      normalizedStage,
      options,
      totalCost,
    );
    const preferredDeckKey = preferredDeck ? exactDeckOrderKey(preferredDeck) : null;
    if (preferredDeck) {
      if (options.signal?.aborted) throw exactAbortError();
      preferredDeckTested = true;
      const result = solveExactLightestStage(preferredDeck, normalizedStage.enemies, {
        ...options,
        maxTurns: normalizedStage.maxTurns,
        eventBonusIds: normalizedStage.eventBonusIds ?? [],
      });
      simulatedDeckCount += 1;
      costDeckCount += 1;
      if (result.threeStar) {
        preferredDeckAccepted = true;
        if (options.stopOnFirstWin || winners.length < options.resultLimit) winners.push(result);
        if (options.stopOnFirstWin) {
          stoppedOnFirstWin = true;
          shouldStop = true;
        }
      }
    }
    for (const combination of exactCombinationsAtCost(
      available,
      totalCost,
      options.deckSize,
      options.allowDuplicates,
    )) {
      if (!exactDeckHasRequiredLastSkill(combination, normalizedStage.requiredLastSkillType)) continue;
      generatedCombinations += 1;
      const initialImpossibleReason = exactInitialDeckImpossibleReason(
        combination,
        normalizedStage.enemies,
        {
          ...options,
          maxTurns: normalizedStage.maxTurns,
          eventBonusIds: normalizedStage.eventBonusIds ?? [],
        },
      );
      if (initialImpossibleReason) {
        prePrunedCombinationCount += 1;
        continue;
      }
      for (const deck of exactUniquePermutations(combination, {
        requiredLastSkillType: normalizedStage.requiredLastSkillType,
        orderByHpDescending: normalizedStage.orderByHpDescending,
      })) {
        if (preferredDeckKey && exactDeckOrderKey(deck) === preferredDeckKey) continue;
        if (options.signal?.aborted) throw exactAbortError();
        const result = solveExactLightestStage(deck, normalizedStage.enemies, {
          ...options,
          maxTurns: normalizedStage.maxTurns,
          eventBonusIds: normalizedStage.eventBonusIds ?? [],
        });
        simulatedDeckCount += 1;
        costDeckCount += 1;
        if (result.threeStar) {
          if (options.stopOnFirstWin || winners.length < options.resultLimit) winners.push(result);
          if (options.stopOnFirstWin) {
            stoppedOnFirstWin = true;
            shouldStop = true;
            break;
          }
        }
        if (simulatedDeckCount % 10 === 0) {
          options.onProgress?.({
            phase: "exact",
            cost: totalCost,
            completed: simulatedDeckCount,
            combinations: generatedCombinations,
            totalCombinations,
            costDeckCount,
            valid: winners.length,
            candidateCount: available.length,
          });
          await exactYield();
        }
      }
      if (shouldStop) break;
    }
    options.onProgress?.({
      phase: "exact",
      cost: totalCost,
      completed: simulatedDeckCount,
      combinations: generatedCombinations,
      totalCombinations,
      costDeckCount,
      valid: winners.length,
      candidateCount: available.length,
    });
    if (shouldStop || winners.length) break;
    await exactYield();
  }

  return {
    stage: normalizedStage,
    results: winners,
    candidatePoolSize: available.length,
    availableCharacterCount: available.length,
    generatedDeckCount: simulatedDeckCount,
    generatedCombinationCount: generatedCombinations,
    prePrunedCombinationCount,
    preferredDeckTested,
    preferredDeckAccepted,
    simulatedDeckCount,
    searchedThroughCost,
    targetCost: normalizedStage.targetCost,
    stoppedOnFirstWin,
    foundThreeStar: winners.length > 0,
    exact: true,
    assumptions: exactAssumptions(),
  };
}
