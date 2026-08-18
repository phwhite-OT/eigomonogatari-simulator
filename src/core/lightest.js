import { applyRounding, resolveAttributeMultiplier } from "./damage.js";
import { DEFAULT_RULES } from "../data/rules.js";
import { calculateCharacterStatStages } from "../data/characters.js";
import { buildLightestGuidedCandidatePool } from "./lightest-guidance.js";
import {
  exactCandidateTrialPriority,
  exactStageInfeasibility,
  findExactLightestDeck,
  prepareExactLightestCandidateProfile,
  solveExactLightestStage,
} from "./lightest-exact.js";

export const LIGHTEST_DEFAULTS = Object.freeze({
  deckSize: 5,
  maxTurns: 12,
  answerMultiplier: 2.592,
  enemyAttackMultiplier: 1,
  eventBonusMultiplier: 1.5,
  difficulty: "pine",
  allowDuplicates: true,
  ownedOnly: false,
  resultLimit: 5,
  scoutDeckLimit: 36,
  scoutCandidateLimit: 10,
  scoutBeamWidth: 12,
  fastApproximation: false,
  targetSearch: "all",
  skillSearch: "all",
  orderSearch: "all",
  candidateGuidance: "all",
});

const ATTACK_TYPES = new Set(["single_attack", "aoe_attack", "multi_hit_attack"]);
const DEFENSE_TYPES = new Set(["damage_reduction", "guard", "attribute_guard"]);
const SUPPORT_TYPES = new Set([
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

function lightestAbortError() {
  const error = new Error("最軽装探索を中止しました");
  error.name = "AbortError";
  return error;
}

function lightestYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clampPositive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function characterAttributes(character) {
  return Array.isArray(character?.attributes) ? character.attributes : [];
}

function attributeSelectionMatches(character, allowedAttributes) {
  if (!allowedAttributes?.length) return true;
  return characterAttributes(character).some((attribute) => allowedAttributes.includes(attribute));
}

function raritySelectionMatches(character, rarities) {
  return !rarities?.length || rarities.includes(character.rarity);
}

function eventBonusCharacter(character, eventBonusIds, multiplier) {
  if (!eventBonusIds.has(String(character.id))) return structuredClone(character);
  return {
    ...structuredClone(character),
    hp: character.hp * multiplier,
    eventMultiplier: multiplier,
    eventBonus: true,
  };
}

export function resolveLightestEnemy(character, options = {}) {
  const difficulty = options.difficulty ?? LIGHTEST_DEFAULTS.difficulty;
  const level1Hp = Number(character.level1Hp);
  const level1Pow = Number(character.level1Pow);
  const hasLevel1Stats = Number.isFinite(level1Hp) && level1Hp > 0 &&
    Number.isFinite(level1Pow) && level1Pow >= 0;
  const manualStages = hasLevel1Stats
    ? calculateCharacterStatStages(level1Hp, level1Pow, {
      rarity: character.rarity,
      nonLimitMaxHp: character.baseHp,
      nonLimitMaxPow: character.basePow,
      fullLimitBreakHp: character.fullLimitBreakHp,
      fullLimitBreakPow: character.fullLimitBreakPow,
      normalMaxLevel: character.normalMaxLevel,
      fullLimitBreakMaxLevel: character.fullLimitBreakMaxLevel,
      maxLimitBreak: character.limitBreak,
    })
    : null;
  const nonLimitMaxStats = manualStages?.max ?? { hp: character.baseHp ?? character.hp, pow: character.basePow ?? character.pow };
  const fullLimitMaxStats = manualStages?.max_limit_break ?? { hp: character.hp, pow: character.pow };
  const sourceHp = difficulty === "pine"
    ? fullLimitMaxStats.hp
    : difficulty === "plum"
      ? Math.floor(nonLimitMaxStats.hp / 2)
      : nonLimitMaxStats.hp;
  const sourcePower = difficulty === "pine"
    ? fullLimitMaxStats.pow
    : difficulty === "plum"
      ? Math.floor(nonLimitMaxStats.pow / 2)
      : nonLimitMaxStats.pow;
  const hp = Math.max(1, clampPositive(options.hp, sourceHp));
  const pow = Math.max(0, clampPositive(options.pow, sourcePower));
  return {
    ...structuredClone(character),
    id: options.instanceId ?? `${character.id}:enemy:${options.order ?? 0}`,
    sourceCharacterId: String(character.id),
    sourceStats: {
      difficulty,
      automaticHp: sourceHp,
      automaticPow: sourcePower,
      bambooHp: nonLimitMaxStats.hp,
      bambooPow: nonLimitMaxStats.pow,
      pineHp: fullLimitMaxStats.hp,
      pinePow: fullLimitMaxStats.pow,
    },
    hp,
    pow,
    eventBonus: false,
    eventMultiplier: 1,
  };
}

function lightestAttributesAfterBuffs(character, buffs) {
  const attributeChange = [...buffs]
    .reverse()
    .find((effect) => effect.type === "attribute_change" && effect.attributes.length);
  return attributeChange ? [...attributeChange.attributes] : [...characterAttributes(character)];
}

function createLightestUnit(character, options = {}) {
  const buffs = structuredClone(options.buffs ?? []);
  return {
    character: structuredClone(character),
    currentHp: Math.max(1, Number(character.hp) || 1),
    maxHp: Math.max(1, Number(character.hp) || 1),
    attributes: lightestAttributesAfterBuffs(character, buffs),
    alive: true,
    ghost: false,
    reviveUsed: false,
    skillCounter: Math.max(0, Number(options.skillCounter) || 0),
    skillUses: 0,
    buffs,
    activationOrder: 0,
    lane: Number.isInteger(options.lane) ? options.lane : null,
  };
}

function createLightestState(deck, enemies) {
  return {
    turn: 1,
    allies: deck.map((character) => createLightestUnit(character)),
    enemies: [],
    enemyQueue: enemies.map((character) => structuredClone(character)),
    enemyLaneBuffs: [[], [], []],
    nextEffectOrder: 1,
    defeatedEnemies: 0,
  };
}

function activeUnits(units) {
  return units.filter((unit) => unit.alive && !unit.ghost);
}

function spawnLightestEnemies(state) {
  const desiredCount = Math.min(3, state.turn);
  const spawned = [];
  while (activeUnits(state.enemies).length < desiredCount && state.enemyQueue.length) {
    const occupiedLanes = new Set(state.enemies
      .filter((enemy) => enemy.alive && !enemy.ghost)
      .map((enemy) => enemy.lane));
    const lane = Array.from({ length: desiredCount }, (_, index) => index)
      .find((index) => !occupiedLanes.has(index));
    if (lane === undefined) break;
    const character = state.enemyQueue.shift();
    const inheritedBuffs = state.enemyLaneBuffs[lane] ?? [];
    state.enemyLaneBuffs[lane] = [];
    state.enemies.push(createLightestUnit(character, {
      skillCounter: state.turn - 1,
      lane,
      buffs: inheritedBuffs,
    }));
    spawned.push(character.name);
  }
  state.enemies.sort((left, right) => (left.lane ?? Infinity) - (right.lane ?? Infinity));
  return spawned;
}

function effectConditionMatches(effect, owner, opponent) {
  return (effect.conditions ?? []).every((condition) => {
    if (condition.type === "ally_attribute") return owner.attributes.includes(condition.attribute);
    if (condition.type === "enemy_attribute") return opponent.attributes.includes(condition.attribute);
    return true;
  });
}

function targetConditionMatches(skill, target, opponent) {
  return (skill.conditions ?? []).every((condition) => {
    if (condition.type === "ally_attribute") return target.attributes.includes(condition.attribute);
    if (condition.type === "enemy_attribute") return opponent?.attributes.includes(condition.attribute) ?? true;
    return true;
  });
}

function skillTargetsTeam(character) {
  return character.skill?.target === "ally_all" || /味方|全員/.test(character.skillName ?? "");
}

function alliedTargetIndexes(units, actorIndex, character, options = {}) {
  const skill = character.skill;
  const indexes = skill.target === "self" && !skillTargetsTeam(character)
    ? [actorIndex]
    : skill.target === "leader"
      ? [0]
      : units.map((_, index) => index);
  return indexes.filter((index) => {
    const target = units[index];
    if (!target || target.ghost !== Boolean(options.ghost)) return false;
    if (!options.ghost && !target.alive) return false;
    if (options.ghost && target.reviveUsed) return false;
    return options.ignoreConditions || targetConditionMatches(skill, target);
  });
}

function canUseLightestSkill(unit) {
  const skill = unit.character.skill;
  const maxUses = Math.min(2, Math.max(0, Number(unit.character.maxUses) || 2));
  return Boolean(
    unit.alive &&
    !unit.ghost &&
    skill &&
    SUPPORT_TYPES.has(skill.type) &&
    unit.skillUses < maxUses &&
    unit.skillCounter >= Math.max(0, Number(unit.character.skillTurn) || 0)
  );
}

function shouldUseAllySkill(state, actorIndex, skill) {
  if (skill.type === "heal") {
    return state.allies.some((unit) => unit.alive && !unit.ghost && unit.currentHp < unit.maxHp * 2);
  }
  if (skill.type === "revive") {
    return state.allies.some((unit) => unit.ghost && !unit.reviveUsed) ||
      state.allies.some((unit) => unit.alive && unit.currentHp <= unit.maxHp * 0.4);
  }
  if (skill.type === "delay") return activeUnits(state.enemies).length > 0;
  if (skill.type === "skill_reduction") {
    return state.allies.some((unit, index) => (
      index !== actorIndex &&
      unit.alive &&
      !unit.ghost &&
      unit.character.skill?.type !== "none" &&
      unit.skillCounter < Math.max(0, Number(unit.character.skillTurn) || 0)
    ));
  }
  return true;
}

function collectReadyIntents(state, skillTypes) {
  const intents = [];
  for (const side of ["allies", "enemies"]) {
    for (let actorIndex = 0; actorIndex < state[side].length; actorIndex += 1) {
      const unit = state[side][actorIndex];
      if (!canUseLightestSkill(unit) || !skillTypes.has(unit.character.skill.type)) continue;
      if (side === "allies" && !shouldUseAllySkill(state, actorIndex, unit.character.skill)) continue;
      intents.push({ side, actorIndex, character: unit.character, skill: unit.character.skill });
    }
  }
  return intents;
}

function consumeIntent(state, intent) {
  const unit = state[intent.side][intent.actorIndex];
  unit.skillUses += 1;
  unit.skillCounter = 0;
}

function opponentSide(side) {
  return side === "allies" ? "enemies" : "allies";
}

function applySkillReduction(state, intent) {
  const units = state[intent.side];
  const amount = Math.max(0, Number(intent.skill.amount) || 0);
  for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character)) {
    units[index].skillCounter += amount;
  }
}

function delayTargetIndexes(units, skill, character) {
  const matching = units.flatMap((unit, index) => (
    unit.alive && !unit.ghost && targetConditionMatches(skill, unit) ? [index] : []
  ));
  return skill.target === "enemy_one" && !/全員/.test(character.skillName ?? "")
    ? matching.slice(0, 1)
    : matching;
}

function applyDelay(state, intent) {
  const units = state[opponentSide(intent.side)];
  const amount = Math.max(0, Number(intent.skill.amount) || 0);
  for (const index of delayTargetIndexes(units, intent.skill, intent.character)) {
    units[index].skillCounter -= amount;
  }
}

function addBuff(state, unit, type, skill) {
  unit.buffs.push({
    type,
    multiplier: Number(skill.multiplier) || 1,
    hits: Math.max(1, Number(skill.hits) || 1),
    attributes: (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []),
    conditions: structuredClone(skill.conditions ?? []),
    remainingTurns: Math.max(1, Number(skill.duration) || 1),
    activationOrder: state.nextEffectOrder++,
  });
}

function applyAttributeChange(state, intent) {
  const units = state[intent.side];
  const attributes = (intent.skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
  if (!attributes.length) return;
  for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character)) {
    addBuff(state, units[index], "attribute_change", intent.skill);
    units[index].attributes = [...attributes];
  }
}

function applyOtherSkill(state, intent) {
  const units = state[intent.side];
  const skill = intent.skill;
  if (skill.type === "heal") {
    for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character)) {
      const target = units[index];
      target.currentHp = Math.min(target.maxHp * 2, target.currentHp + target.maxHp * skill.multiplier);
    }
    return;
  }
  if (["attack_buff", ...DEFENSE_TYPES].includes(skill.type)) {
    for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character, { ignoreConditions: true })) {
      addBuff(state, units[index], skill.type, skill);
    }
    return;
  }
  if (skill.type === "aoe_attack" || skill.type === "multi_hit_attack") {
    for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character, { ignoreConditions: true })) {
      addBuff(state, units[index], skill.type, skill);
    }
  }
}

function processSkillPhase(state, skillTypes, apply, events) {
  const intents = collectReadyIntents(state, skillTypes);
  for (const intent of intents) {
    consumeIntent(state, intent);
    apply(state, intent);
    events.push({
      side: intent.side,
      actorName: intent.character.name,
      skillType: intent.skill.type,
      skillName: intent.character.skillName,
    });
  }
  return intents;
}

function advanceNaturalSkillCounters(state) {
  for (const side of ["allies", "enemies"]) {
    for (const unit of state[side]) {
      if (unit.alive && !unit.ghost) unit.skillCounter += 1;
    }
  }
}

function attackBuffMultiplier(attacker, defender) {
  return attacker.buffs
    .filter((effect) => effect.type === "attack_buff" && effectConditionMatches(effect, attacker, defender))
    .reduce((product, effect) => product * Math.max(0, Number(effect.multiplier) || 0), 1);
}

function defenseMultiplier(defender, attacker) {
  return defender.buffs
    .filter((effect) => DEFENSE_TYPES.has(effect.type) && effectConditionMatches(effect, defender, attacker))
    .reduce((product, effect) => product * Math.max(0, Number(effect.multiplier) || 0), 1);
}

function attackMode(attacker, defender) {
  const effects = attacker.buffs.filter((effect) => (
    ATTACK_TYPES.has(effect.type) && effectConditionMatches(effect, attacker, defender)
  ));
  if (effects.some((effect) => effect.type === "aoe_attack")) return { type: "aoe_attack", hits: 1 };
  const hits = Math.max(1, ...effects
    .filter((effect) => effect.type === "multi_hit_attack")
    .map((effect) => effect.hits));
  return hits > 1 ? { type: "multi_hit_attack", hits } : { type: "single_attack", hits: 1 };
}

function lightestDamage(attacker, defender, side, options) {
  const power = attacker.ghost
    ? Math.max(0, Number(attacker.character.pow) || 0) * 0.5
    : Math.max(0, Number(attacker.character.pow) || 0);
  const answerMultiplier = side === "allies"
    ? options.answerMultiplier
    : options.enemyAttackMultiplier;
  const attributeMultiplier = resolveAttributeMultiplier(
    attacker.attributes,
    defender.attributes,
    DEFAULT_RULES,
  );
  const eventMultiplier = Number(attacker.character.eventMultiplier) || 1;
  const raw = power * answerMultiplier * attributeMultiplier * eventMultiplier *
    (attacker.ghost ? 1 : attackBuffMultiplier(attacker, defender)) *
    (attacker.ghost ? 1 : defenseMultiplier(defender, attacker));
  return applyRounding(raw, "floor");
}

function redirectIndex(defenders, attacker) {
  let selected;
  defenders.forEach((defender, index) => {
    if (!defender.alive || defender.ghost) return;
    defender.buffs.forEach((effect) => {
      if (!["guard", "attribute_guard"].includes(effect.type)) return;
      if (!effectConditionMatches(effect, defender, attacker)) return;
      if (!selected || effect.activationOrder >= selected.activationOrder) {
        selected = { index, activationOrder: effect.activationOrder };
      }
    });
  });
  return selected?.index;
}

function selectAttackTarget(attacker, defenders, side, options) {
  const candidates = defenders.flatMap((defender, index) => {
    if (!defender.alive || defender.ghost) return [];
    const damage = lightestDamage(attacker, defender, side, options);
    return [{ index, damage, killable: damage >= defender.currentHp, overkill: Math.max(0, damage - defender.currentHp) }];
  });
  if (!candidates.length) return undefined;
  if (side === "enemies") {
    candidates.sort((left, right) => right.damage - left.damage || left.index - right.index);
  } else {
    candidates.sort((left, right) => (
      Number(right.killable) - Number(left.killable) ||
      (left.killable && right.killable ? left.overkill - right.overkill : right.damage - left.damage) ||
      left.index - right.index
    ));
  }
  return candidates[0].index;
}

function hitTarget(attacker, defenders, targetIndex, side, options, action) {
  const defender = defenders[targetIndex];
  if (!defender?.alive || defender.ghost) return;
  const damage = lightestDamage(attacker, defender, side, options);
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

function resolveUnitAttack(attacker, defenders, side, options) {
  const referenceDefender = activeUnits(defenders)[0];
  if (!referenceDefender) return null;
  const mode = attacker.ghost ? { type: "single_attack", hits: 1 } : attackMode(attacker, referenceDefender);
  const action = { side, actorName: attacker.character.name, attackType: mode.type, hits: [] };
  if (mode.type === "aoe_attack") {
    const redirected = attacker.ghost ? undefined : redirectIndex(defenders, attacker);
    if (redirected !== undefined) hitTarget(attacker, defenders, redirected, side, options, action);
    else defenders.forEach((_, index) => hitTarget(attacker, defenders, index, side, options, action));
    return action;
  }
  for (let hit = 0; hit < mode.hits; hit += 1) {
    const redirected = attacker.ghost ? undefined : redirectIndex(defenders, attacker);
    const targetIndex = redirected ?? selectAttackTarget(attacker, defenders, side, options);
    if (targetIndex === undefined) break;
    hitTarget(attacker, defenders, targetIndex, side, options, action);
  }
  return action;
}

function projectedUnitDamage(unit, defenders, side, options) {
  return Math.max(0, ...activeUnits(defenders).map((defender) => lightestDamage(unit, defender, side, options)));
}

function resolveLightestAttacks(state, options) {
  const actions = [];
  const enemyAttackers = state.enemies.flatMap((unit, actorIndex) => (
    unit.alive && !unit.ghost ? [{ actorIndex, unit: structuredClone(unit) }] : []
  ));
  const allies = state.allies
    .filter((unit) => unit.alive || unit.ghost)
    .sort((left, right) => projectedUnitDamage(right, state.enemies, "allies", options) -
      projectedUnitDamage(left, state.enemies, "allies", options));
  for (const attacker of allies) {
    const action = resolveUnitAttack(attacker, state.enemies, "allies", options);
    if (action) actions.push(action);
  }
  const enemies = enemyAttackers
    .sort((left, right) => projectedUnitDamage(right.unit, state.allies, "enemies", options) -
      projectedUnitDamage(left.unit, state.allies, "enemies", options));
  for (const { unit: attacker } of enemies) {
    const action = resolveUnitAttack(attacker, state.allies, "enemies", options);
    if (action) actions.push(action);
  }
  const remainingEnemies = [];
  for (const enemy of state.enemies) {
    if (enemy.alive) {
      remainingEnemies.push(enemy);
      continue;
    }
    const carriedBuffs = enemy.buffs.filter((effect) => effect.remainingTurns > 1);
    if (Number.isInteger(enemy.lane) && carriedBuffs.length) {
      state.enemyLaneBuffs[enemy.lane] = structuredClone(carriedBuffs);
    }
    state.defeatedEnemies += 1;
  }
  state.enemies = remainingEnemies.sort((left, right) => (left.lane ?? Infinity) - (right.lane ?? Infinity));
  return actions;
}

function ghostDefeatedAllies(state) {
  const ghosts = [];
  for (const ally of state.allies) {
    if (ally.alive || ally.ghost) continue;
    ally.ghost = true;
    ghosts.push(ally.character.name);
  }
  return ghosts;
}

function applyRevives(state, intents, events) {
  for (const intent of intents) {
    const units = state[intent.side];
    for (const index of alliedTargetIndexes(units, intent.actorIndex, intent.character, { ghost: true })) {
      const target = units[index];
      target.ghost = false;
      target.alive = true;
      target.reviveUsed = true;
      target.currentHp = Math.max(1, Math.min(target.maxHp * 2, target.maxHp * intent.skill.multiplier));
      events.push({ side: intent.side, actorName: intent.character.name, targetName: target.character.name });
    }
  }
}

function lightestExpireBuffs(buffs) {
  return buffs
    .map((effect) => ({ ...effect, remainingTurns: effect.remainingTurns - 1 }))
    .filter((effect) => effect.remainingTurns > 0);
}

function expireEffects(state) {
  for (const side of ["allies", "enemies"]) {
    for (const unit of state[side]) {
      unit.buffs = lightestExpireBuffs(unit.buffs);
      unit.attributes = lightestAttributesAfterBuffs(unit.character, unit.buffs);
    }
  }
  state.enemyLaneBuffs = state.enemyLaneBuffs.map(lightestExpireBuffs);
}

function lightestSnapshot(state) {
  return {
    aliveAllies: state.allies.filter((unit) => unit.alive && !unit.ghost).length,
    ghosts: state.allies.filter((unit) => unit.ghost).length,
    activeEnemies: activeUnits(state.enemies).length,
    queuedEnemies: state.enemyQueue.length,
    defeatedEnemies: state.defeatedEnemies,
    allyHpRatio: state.allies.reduce((sum, unit) => sum + (unit.ghost ? 0 : unit.currentHp / unit.maxHp), 0) /
      Math.max(1, state.allies.length),
  };
}

export function simulateLightestStage(deck, enemies, simulationOptions = {}) {
  const options = { ...LIGHTEST_DEFAULTS, ...simulationOptions };
  const eventBonusIds = new Set((options.eventBonusIds ?? []).map(String));
  const preparedDeck = deck.map((character) => eventBonusCharacter(
    character,
    eventBonusIds,
    options.eventBonusMultiplier,
  ));
  const state = createLightestState(preparedDeck, enemies);
  const history = [];
  let cleared = false;
  let failed = false;

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    state.turn = turn;
    const spawned = spawnLightestEnemies(state);
    if (!state.enemies.length && !state.enemyQueue.length) {
      cleared = true;
      break;
    }
    const skills = [];
    processSkillPhase(state, new Set(["skill_reduction"]), applySkillReduction, skills);
    processSkillPhase(state, new Set(["attribute_change"]), applyAttributeChange, skills);
    processSkillPhase(state, new Set(["delay"]), applyDelay, skills);
    const otherIntents = collectReadyIntents(state, new Set([
      "attack_buff",
      "damage_reduction",
      "guard",
      "attribute_guard",
      "heal",
      "revive",
      "aoe_attack",
      "multi_hit_attack",
    ]));
    const reviveIntents = [];
    for (const intent of otherIntents) {
      consumeIntent(state, intent);
      skills.push({
        side: intent.side,
        actorName: intent.character.name,
        skillType: intent.skill.type,
        skillName: intent.character.skillName,
      });
      if (intent.skill.type === "revive") reviveIntents.push(intent);
      else applyOtherSkill(state, intent);
    }
    advanceNaturalSkillCounters(state);
    const attacks = resolveLightestAttacks(state, options);
    const becameGhosts = ghostDefeatedAllies(state);
    const revives = [];
    applyRevives(state, reviveIntents, revives);
    const snapshot = lightestSnapshot(state);
    history.push({ turn, spawned, skills, attacks, becameGhosts, revives, ...snapshot });
    cleared = state.enemyQueue.length === 0 && activeUnits(state.enemies).length === 0;
    failed = activeUnits(state.allies).length === 0 && !cleared;
    expireEffects(state);
    if (cleared || failed) break;
  }

  const final = lightestSnapshot(state);
  const allSurvived = final.aliveAllies === deck.length && final.ghosts === 0;
  return {
    cleared,
    failed,
    allSurvived,
    threeStar: cleared && allSurvived && history.length <= options.maxTurns,
    turnsCompleted: history.length,
    totalCost: deck.reduce((sum, character) => sum + Math.max(0, Number(character.cost) || 0), 0),
    deck,
    enemies,
    history,
    final,
    assumptions: [
      "限定イベント同様、敵は固定順で1問目1体・2問目2体・3問目以降3体になるよう補充",
      "攻撃フェーズ開始時に生存していた敵味方は、その後に撃破されても同じターンの攻撃を行う",
      "短縮→属性変更→遅延→その他→攻撃→蘇生の順で処理",
      "敵は使用可能なスキルを必ず使用し、味方は有効なスキルを自動使用",
      "味方は撃破可能な敵を優先し、敵は通常攻撃で最大ダメージとなる相手を優先",
      "乱数・対戦固定係数・生存1.3倍補正・リーダー/助っ人スキルは不使用",
      "防御効果の重複には対戦用の減衰を適用しない",
    ],
  };
}

function lightestDeckSizes(stage) {
  if (!Array.isArray(stage.deckSizes)) return [];
  return [...new Set(stage.deckSizes.map(Number).filter((size) => Number.isInteger(size) && size >= 1 && size <= 5))]
    .sort((left, right) => left - right);
}

function lightestSearchScope(stage, options, guidance = null) {
  const omitted = [];
  if (options.targetSearch === "automatic") omitted.push({ key: "targets", label: "手動ターゲット" });
  if (options.skillSearch === "automatic") omitted.push({ key: "skills", label: "スキル温存・使用順" });
  if (stage.orderByHpDescending) omitted.push({ key: "order", label: "並び順" });
  if (guidance?.applied) omitted.push({ key: "candidates", label: "攻略候補" });
  return {
    targetSearch: options.targetSearch,
    skillSearch: options.skillSearch,
    orderSearch: stage.orderByHpDescending ? "hp_descending" : "all",
    omitted,
  };
}
function lightestCombinedSearchResult(stage, deckSizes, attempts, best, scout = null, searchScope, guidance = null, precheck = null) {
  const reference = attempts.at(-1) ?? {};
  const generatedCombinationCount = attempts.reduce((sum, attempt) => sum + attempt.generatedCombinationCount, 0);
  const prePrunedCombinationCount = attempts.reduce((sum, attempt) => sum + attempt.prePrunedCombinationCount, 0);
  const simulatedDeckCount = attempts.reduce((sum, attempt) => sum + attempt.simulatedDeckCount, 0);
  const prePrunedReasons = attempts.reduce((reasons, attempt) => {
    for (const [reason, count] of Object.entries(attempt.prePrunedReasons ?? {})) {
      reasons[reason] = (reasons[reason] ?? 0) + count;
    }
    return reasons;
  }, {});
  const availableCharacterCount = Math.max(
    0,
    Number(precheck?.availableCharacterCount) || 0,
    ...attempts.map((attempt) => attempt.availableCharacterCount),
  );
  const mergedPrecheck = {
    ...(precheck ?? {}),
    ...(reference.precheck ?? {}),
    skippedDeckSizes: precheck?.skippedDeckSizes ?? [],
  };
  return {
    ...reference,
    stage: { ...stage, deckSizes, deckSize: best?.deck.length ?? null },
    results: best ? [best] : [],
    candidatePoolSize: availableCharacterCount,
    availableCharacterCount,
    generatedDeckCount: simulatedDeckCount,
    generatedCombinationCount,
    prePrunedCombinationCount,
    prePrunedReasons,
    simulatedDeckCount,
    searchedThroughCost: best?.totalCost ?? reference?.searchedThroughCost ?? null,
    targetCost: stage.targetCost ?? null,
    stoppedOnFirstWin: Boolean(best),
    foundThreeStar: Boolean(best),
    searchedDeckSizes: deckSizes,
    scout,
    guidance,
    searchScope,
    precheck: mergedPrecheck,
    exact: !searchScope?.omitted?.length,
    assumptions: reference.assumptions ?? [],
  };
}

function lightestRequestedTargetCost(stage) {
  const hasTargetCost = stage.targetCost !== undefined && stage.targetCost !== null && String(stage.targetCost).trim() !== "";
  if (!hasTargetCost) return null;
  const targetCost = Number(stage.targetCost);
  if (!Number.isInteger(targetCost) || targetCost < 0) throw new Error("指定コストは0以上の整数で設定してください");
  if (targetCost > Number(stage.maxCost)) throw new Error("指定コストは最大指定コスト以下で設定してください");
  return targetCost;
}

function lightestCharacterCost(character) {
  return Math.max(0, Number(character?.cost) || 0);
}
function lightestScoutPriority(character) {
  return exactCandidateTrialPriority(character) / (lightestCharacterCost(character) + 1);
}
function lightestScoutDeckKey(deck) {
  return deck.map((character) => String(character.id)).join("\u001f");
}
function lightestDeckCost(deck) {
  return deck.reduce((sum, character) => sum + lightestCharacterCost(character), 0);
}
function lightestTaskKey(deckSize, cost) {
  return `${deckSize}\u001f${cost}`;
}
function lightestScoutCandidatePool(available, limit) {
  const efficiency = [...available].sort((left, right) => (
    lightestScoutPriority(right) - lightestScoutPriority(left) ||
    exactCandidateTrialPriority(right) - exactCandidateTrialPriority(left) ||
    lightestCharacterCost(left) - lightestCharacterCost(right) ||
    String(left.id).localeCompare(String(right.id))
  ));
  const strength = [...available].sort((left, right) => (
    exactCandidateTrialPriority(right) - exactCandidateTrialPriority(left) ||
    lightestCharacterCost(left) - lightestCharacterCost(right) ||
    String(left.id).localeCompare(String(right.id))
  ));
  const seen = new Set();
  return [
    ...efficiency.slice(0, Math.ceil(limit / 2)),
    ...strength,
  ].filter((character) => {
    const id = String(character.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, limit);
}
function lightestScoutDecksForProfile(entry, stage, options) {
  const deckLimit = Math.max(0, Math.floor(Number(options.scoutDeckLimit) || 0));
  const candidateLimit = Math.max(1, Math.floor(Number(options.scoutCandidateLimit) || 1));
  const beamWidth = Math.max(1, Math.floor(Number(options.scoutBeamWidth) || 1));
  if (!deckLimit) return [];
  const requiredLastSkillType = String(stage.requiredLastSkillType ?? "").trim();
  const candidatePool = lightestScoutCandidatePool(entry.profile.available, candidateLimit);
  const lastCandidates = requiredLastSkillType
    ? entry.profile.available.filter((character) => String(character?.skill?.type ?? "none") === requiredLastSkillType)
    : candidatePool;
  const orderedLastCandidates = [...lastCandidates].sort((left, right) => (
    lightestScoutPriority(right) - lightestScoutPriority(left) ||
    lightestCharacterCost(left) - lightestCharacterCost(right) ||
    String(left.id).localeCompare(String(right.id))
  )).slice(0, Math.max(1, Math.ceil(deckLimit / beamWidth)));
  const decks = [];
  const seen = new Set();
  for (const lastCharacter of orderedLastCandidates) {
    let prefixes = [{ deck: [], score: 0, cost: lightestCharacterCost(lastCharacter) }];
    for (let slot = 0; slot < entry.deckSize - 1; slot += 1) {
      const nextPrefixes = [];
      for (const prefix of prefixes) {
        for (const character of candidatePool) {
          if (!options.allowDuplicates && (
            String(character.id) === String(lastCharacter.id) ||
            prefix.deck.some((entryCharacter) => String(entryCharacter.id) === String(character.id))
          )) continue;
          if (stage.orderByHpDescending && prefix.deck.length &&
            Number(prefix.deck.at(-1).hp) < Number(character.hp)) continue;
          const nextCost = prefix.cost + lightestCharacterCost(character);
          if (nextCost > Number(stage.maxCost)) continue;
          nextPrefixes.push({
            deck: [...prefix.deck, character],
            score: prefix.score + exactCandidateTrialPriority(character),
            cost: nextCost,
          });
        }
      }
      prefixes = nextPrefixes.sort((left, right) => (
        right.score - left.score || left.cost - right.cost || lightestScoutDeckKey(left.deck).localeCompare(lightestScoutDeckKey(right.deck))
      )).slice(0, beamWidth);
      if (!prefixes.length) break;
    }
    for (const prefix of prefixes) {
      const deck = [...prefix.deck, lastCharacter];
      const key = lightestScoutDeckKey(deck);
      if (seen.has(key)) continue;
      seen.add(key);
      decks.push({ deck, score: prefix.score + exactCandidateTrialPriority(lastCharacter) });
      if (decks.length >= deckLimit) return decks;
    }
  }
  return decks;
}
async function lightestScoutWinningDeck(profiles, stage, options, eligibleTasks = null) {
  const deckLimit = Math.max(0, Math.floor(Number(options.scoutDeckLimit) || 0));
  if (!deckLimit) return { attempted: false, sampledDeckCount: 0, candidateDeckCount: 0, found: false };
  const targetCost = lightestRequestedTargetCost(stage);
  const eligibleTaskKeys = eligibleTasks
    ? new Set(eligibleTasks.map((task) => lightestTaskKey(task.deckSize, task.cost)))
    : null;
  const candidates = profiles
    .flatMap((entry) => lightestScoutDecksForProfile(entry, stage, options))
    .filter(({ deck }) => targetCost === null || lightestDeckCost(deck) === targetCost)
    .filter(({ deck }) => !eligibleTaskKeys || eligibleTaskKeys.has(lightestTaskKey(deck.length, lightestDeckCost(deck))))
    .sort((left, right) => right.score - left.score ||
      lightestDeckCost(left.deck) - lightestDeckCost(right.deck))
    .slice(0, deckLimit);
  for (let index = 0; index < candidates.length; index += 1) {
    if (options.signal?.aborted) throw lightestAbortError();
    const candidate = candidates[index];
    const simulationOptions = {
      ...options,
      maxTurns: Number(stage.maxTurns) || options.maxTurns,
      eventBonusIds: stage.eventBonusIds ?? [],
    };
    const simulation = simulateLightestStage(candidate.deck, stage.enemies, simulationOptions);
    options.onProgress?.({
      phase: "scout",
      completed: index + 1,
      total: candidates.length,
      valid: simulation.threeStar ? 1 : 0,
      candidateCount: Math.max(0, ...profiles.map((entry) => entry.profile.available.length)),
    });
    if (simulation.threeStar) {
      const verification = solveExactLightestStage(candidate.deck, stage.enemies, simulationOptions);
      if (verification.threeStar) {
        return {
          attempted: true,
          sampledDeckCount: index + 1,
          candidateDeckCount: candidates.length,
          found: true,
          deck: candidate.deck,
          upperCost: simulation.totalCost,
        };
      }
    }
    if ((index + 1) % 8 === 0) await lightestYield();
  }
  return {
    attempted: true,
    sampledDeckCount: candidates.length,
    candidateDeckCount: candidates.length,
    found: false,
  };
}
function lightestCostTasks(profiles, targetCost, preferredDeck = null) {
  const combinationCountAtCost = (entry, cost) => entry.profile.combinationCountsByCost.get(cost) ?? 0;
  const costs = [...new Set(profiles.flatMap((entry) => entry.profile.attainableCosts))]
    .filter((cost) => targetCost === null || cost === targetCost)
    .filter((cost) => profiles.some((entry) => combinationCountAtCost(entry, cost) > 0))
    .sort((left, right) => left - right);
  return costs.flatMap((cost, costIndex) => {
    const matchingProfiles = profiles
      .filter((entry) => combinationCountAtCost(entry, cost) > 0)
      .sort((left, right) => {
        const preferredCost = preferredDeck?.reduce((sum, character) => sum + lightestCharacterCost(character), 0);
        if (cost === preferredCost && left.deckSize === preferredDeck?.length) return -1;
        if (cost === preferredCost && right.deckSize === preferredDeck?.length) return 1;
        return left.deckSize - right.deckSize;
      });
    return matchingProfiles.map((entry, costDeckIndex) => ({
      ...entry,
      cost,
      totalCombinations: combinationCountAtCost(entry, cost),
      costIndex: costIndex + 1,
      costCount: costs.length,
      costDeckIndex: costDeckIndex + 1,
      costDeckSizeCount: matchingProfiles.length,
    }));
  });
}

function lightestDamageViableTasks(tasks, enemies) {
  const totalEnemyHp = (enemies ?? []).reduce((sum, enemy) => sum + Math.max(0, Number(enemy?.hp) || 0), 0);
  return tasks.filter((task) => {
    const upperBound = task.profile.optimisticDamageUpperBoundsByCost.get(task.cost);
    return upperBound === undefined || upperBound >= totalEnemyHp;
  });
}

// Phase 1 for the local runner.  This deliberately returns only a proven
// winning *upper bound*: candidate guidance and automatic actions may miss a
// cheaper deck, but every returned deck is simulated before it is accepted.
// The caller must still exhaust every lower cost with the exact search.
export async function findLightestScoutUpperBound(characters, stage, searchOptions = {}) {
  const deckSizes = lightestDeckSizes(stage);
  const options = { ...LIGHTEST_DEFAULTS, ...searchOptions };
  const normalizedOptions = {
    ...options,
    targetSearch: "automatic",
    skillSearch: "automatic",
    orderSearch: "hp_descending",
  };
  const normalizedStage = {
    ...stage,
    orderByHpDescending: true,
  };
  const guidance = buildLightestGuidedCandidatePool(characters, normalizedStage, normalizedOptions);
  const scoutCharacters = guidance.characters;
  const searchScope = lightestSearchScope(normalizedStage, normalizedOptions, guidance);
  const requestedDeckSizes = deckSizes.length
    ? deckSizes
    : [Number(normalizedStage.deckSize ?? normalizedOptions.deckSize)];
  const profileEntries = requestedDeckSizes.map((deckSize, index) => ({
    deckSize,
    deckSizeIndex: index + 1,
    profile: prepareExactLightestCandidateProfile(
      scoutCharacters,
      { ...normalizedStage, deckSize },
      normalizedOptions,
    ),
  }));
  const profiles = profileEntries.filter((entry) => !entry.profile.infeasibility);
  const stageInfeasibility = exactStageInfeasibility(normalizedStage, normalizedOptions);
  if (!profiles.length || stageInfeasibility) {
    return {
      found: false,
      scout: { attempted: false, sampledDeckCount: 0, candidateDeckCount: 0, found: false },
      guidance,
      searchScope,
      stage: normalizedStage,
      precheck: stageInfeasibility ? { stage: stageInfeasibility } : null,
    };
  }
  const targetCost = lightestRequestedTargetCost(normalizedStage);
  const tasks = lightestDamageViableTasks(
    lightestCostTasks(profiles, targetCost),
    normalizedStage.enemies,
  );
  const scout = tasks.length
    ? await lightestScoutWinningDeck(profiles, normalizedStage, normalizedOptions, tasks)
    : { attempted: false, sampledDeckCount: 0, candidateDeckCount: 0, found: false };
  return {
    found: Boolean(scout?.found),
    upperCost: scout?.upperCost ?? null,
    deck: scout?.deck ?? null,
    scout,
    guidance,
    searchScope,
    stage: normalizedStage,
    precheck: tasks.length ? null : { damageUpperBound: true },
  };
}

export async function findLightestDeck(characters, stage, searchOptions = {}) {
  const deckSizes = lightestDeckSizes(stage);
  const options = { ...LIGHTEST_DEFAULTS, ...searchOptions };
  const normalizedOptions = {
    ...options,
    targetSearch: options.targetSearch === "automatic" || options.fastApproximation ? "automatic" : "all",
    skillSearch: options.skillSearch === "automatic" || options.fastApproximation ? "automatic" : "all",
    orderSearch: options.orderSearch === "hp_descending" || options.fastApproximation ? "hp_descending" : "all",
  };
  const normalizedStage = {
    ...stage,
    orderByHpDescending: Boolean(stage.orderByHpDescending || normalizedOptions.orderSearch === "hp_descending"),
  };
  const guidance = buildLightestGuidedCandidatePool(characters, normalizedStage, normalizedOptions);
  const guidedCharacters = guidance.characters;
  const searchScope = lightestSearchScope(normalizedStage, normalizedOptions, guidance);
  if (!deckSizes.length) {
    const result = await findExactLightestDeck(guidedCharacters, normalizedStage, normalizedOptions);
    return { ...result, guidance, searchScope, exact: !searchScope.omitted.length };
  }
  const targetCost = lightestRequestedTargetCost(normalizedStage);
  const profileEntries = deckSizes.map((deckSize, index) => ({
    deckSize,
    deckSizeIndex: index + 1,
    profile: prepareExactLightestCandidateProfile(guidedCharacters, { ...normalizedStage, deckSize }, normalizedOptions),
  }));
  const skippedDeckSizes = profileEntries.flatMap((entry) => {
    const hasCombination = [...entry.profile.combinationCountsByCost.values()].some((count) => count > 0);
    const infeasibility = entry.profile.infeasibility ?? (
      !entry.profile.attainableCosts.length
        ? { reason: "costCapacity", deckSize: entry.deckSize, maxCost: normalizedStage.maxCost }
        : !hasCombination
          ? { reason: "requiredLastSkillUnavailable", requiredLastSkillType: normalizedStage.requiredLastSkillType }
          : null
    );
    return infeasibility ? [{ deckSize: entry.deckSize, ...infeasibility }] : [];
  });
  const profiles = profileEntries.filter((entry) => !skippedDeckSizes.some((skipped) => skipped.deckSize === entry.deckSize));
  const precheck = {
    availableCharacterCount: Math.max(0, ...profileEntries.map((entry) => entry.profile.available.length)),
    skippedDeckSizes,
  };
  if (!profiles.length) {
    return lightestCombinedSearchResult(normalizedStage, deckSizes, [], null, null, searchScope, guidance, precheck);
  }
  const stageInfeasibility = exactStageInfeasibility(normalizedStage, normalizedOptions);
  if (stageInfeasibility) {
    const attempts = [];
    for (const entry of profiles) {
      attempts.push(await findExactLightestDeck(guidedCharacters, {
        ...normalizedStage,
        deckSizes: undefined,
        deckSize: entry.deckSize,
      }, {
        ...normalizedOptions,
        preparedCandidateProfile: entry.profile,
      }));
    }
    return lightestCombinedSearchResult(
      normalizedStage,
      deckSizes,
      attempts,
      null,
      null,
      searchScope,
      guidance,
      { ...precheck, stage: stageInfeasibility },
    );
  }
  const candidateTasks = lightestCostTasks(profiles, targetCost);
  if (!candidateTasks.length) {
    return lightestCombinedSearchResult(normalizedStage, deckSizes, [], null, null, searchScope, guidance, precheck);
  }
  const damageViableTasks = lightestDamageViableTasks(candidateTasks, normalizedStage.enemies);
  const searchPrecheck = !damageViableTasks.length
    ? {
      ...precheck,
      damageUpperBound: { taskCount: candidateTasks.length, viableTaskCount: 0 },
    }
    : precheck;
  const scout = damageViableTasks.length
    ? await lightestScoutWinningDeck(profiles, normalizedStage, normalizedOptions, damageViableTasks)
    : null;
  const tasks = lightestCostTasks(profiles, targetCost, scout?.deck)
    .filter((task) => scout?.upperCost === undefined || task.cost <= scout.upperCost);
  const attempts = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex];
    const progressMetadata = {
      cost: task.cost,
      costIndex: task.costIndex,
      costCount: task.costCount,
      deckSize: task.deckSize,
      deckSizeIndex: task.deckSizeIndex,
      deckSizeCount: deckSizes.length,
      costDeckIndex: task.costDeckIndex,
      costDeckSizeCount: task.costDeckSizeCount,
      taskIndex: taskIndex + 1,
      taskCount: tasks.length,
    };
    searchOptions.onProgress?.({
      phase: "exact",
      ...progressMetadata,
      completed: 0,
      combinations: 0,
      totalCombinations: task.totalCombinations,
      costDeckCount: 0,
      valid: 0,
      candidateCount: task.profile.available.length,
      taskCompleted: false,
    });
    const attempt = await findExactLightestDeck(guidedCharacters, {
      ...normalizedStage,
      deckSizes: undefined,
      deckSize: task.deckSize,
      targetCost: task.cost,
    }, {
      ...normalizedOptions,
      preparedCandidateProfile: task.profile,
      preferredDeck: task.cost === scout?.upperCost && task.deckSize === scout?.deck?.length ? scout?.deck : undefined,
      onProgress: (progress) => searchOptions.onProgress?.({
        ...progress,
        ...progressMetadata,
        taskCompleted: false,
      }),
    });
    attempts.push(attempt);
    searchOptions.onProgress?.({
      phase: "exact",
      ...progressMetadata,
      completed: attempt.simulatedDeckCount,
      combinations: attempt.generatedCombinationCount,
      totalCombinations: task.totalCombinations,
      costDeckCount: attempt.simulatedDeckCount,
      valid: attempt.results.length,
      candidateCount: attempt.availableCharacterCount,
      taskCompleted: true,
    });
    const winner = attempt.results[0];
    if (winner) return lightestCombinedSearchResult(
      normalizedStage,
      deckSizes,
      attempts,
      winner,
      scout,
      searchScope,
      guidance,
      searchPrecheck,
    );
    await lightestYield();
  }
  return lightestCombinedSearchResult(normalizedStage, deckSizes, attempts, null, scout, searchScope, guidance, searchPrecheck);
}
