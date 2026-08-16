import {
  advanceTurn,
  evaluateBoard,
  resolveDefeatedCombatants,
} from "./battleState.js";
import {
  calculateMinimumDamage,
  resolveAttackBuffMultiplier,
  resolveDefenseMultiplier,
} from "./damage.js";
import {
  applySupportSkill,
  canUseSkill,
  consumeSkill,
  isAttackSkill,
  resolveAttackAction,
} from "./skills.js";

const BASIC_ATTACK = Object.freeze({ type: "single_attack", multiplier: 1, hits: 1 });
export const TARGET_POLICIES = Object.freeze({
  BALANCE: "balance",
  KILL_CONFIRM: "kill-confirm",
  SKILL_THREAT: "skill-threat",
  EXPERT: "expert",
});
export const ATTACK_ORDER_POLICIES = Object.freeze({
  LEFT_TO_RIGHT: "left-to-right",
  STRONGEST_FIRST: "strongest-first",
  TACTICAL: "tactical",
});
export const PLAY_STYLES = Object.freeze({
  DEFAULT: "default",
  EXPERT: "expert",
});
const DEFENSE_SKILL_TYPES = new Set(["damage_reduction", "guard", "attribute_guard"]);
const ATTACK_MODE_TYPES = new Set(["aoe_attack", "multi_hit_attack"]);
const PHASE_LABELS = Object.freeze({
  skill_selection: "スキル選択・温存",
  attribute_change: "属性変更",
  healing: "回復",
  attack_support: "攻撃強化",
  defense: "防御・かばう・かわす",
  attack: "攻撃",
  revive: "蘇生",
  replacement: "交代・幽霊化",
});

function opponentSide(side) {
  return side === "allies" ? "enemies" : "allies";
}

function targetableIndexes(combatants) {
  return combatants.flatMap((combatant, index) => (
    combatant.alive && !combatant.isGhost ? [index] : []
  ));
}

function remainingCharacterCount(combatant) {
  if (combatant.isGhost) return 0;
  return Math.max(0, combatant.deck.length - combatant.deckIndex);
}

function effectApplies(effect, ownerAttributes, opponentAttributes) {
  return (effect.conditions ?? []).every((condition) => {
    const attributes = condition.type === "ally_attribute" ? ownerAttributes : opponentAttributes;
    return attributes.includes(condition.attribute);
  });
}

function estimateDamage(actor, defender, skill, rules) {
  const attackEffects = actor.isGhost ? [] : actor.buffs.filter((effect) => (
    effect.type === "attack_buff" && effectApplies(effect, actor.attributes, defender.attributes)
  ));
  const defenseEffects = actor.isGhost ? [] : defender.buffs.filter((effect) => (
    DEFENSE_SKILL_TYPES.has(effect.type) && effectApplies(effect, defender.attributes, actor.attributes)
  ));
  return calculateMinimumDamage({
    attacker: {
      ...actor.character,
      attributes: actor.attributes,
      survivalTurns: actor.isGhost ? 0 : actor.survivalTurns,
    },
    defender: { ...defender.character, attributes: defender.attributes },
    skillMultiplier: skill.multiplier ?? 1,
    attackMultiplier: actor.isGhost ? 1 : resolveAttackBuffMultiplier(attackEffects),
    defenseMultiplier: actor.isGhost ? 1 : resolveDefenseMultiplier(defenseEffects),
    rules,
  }).value;
}

function redirectGuardForAttacker(state, actorSide, actor) {
  if (!actor || actor.isGhost) return undefined;
  let selected;
  for (const [index, combatant] of state[opponentSide(actorSide)].entries()) {
    if (!combatant.alive || combatant.isGhost) continue;
    for (const effect of combatant.buffs) {
      if (!['guard', 'attribute_guard'].includes(effect.type)) continue;
      if (!effectApplies(effect, combatant.attributes, actor.attributes)) continue;
      const activationOrder = Number(effect.activationOrder) || 0;
      if (!selected || activationOrder >= selected.activationOrder) {
        selected = { index, combatant, effect, activationOrder };
      }
    }
  }
  return selected;
}

function guardBreakTargetForAttacker(state, actorSide, actor) {
  const redirected = redirectGuardForAttacker(state, actorSide, actor);
  if (redirected) return { ...redirected, mode: 'redirected' };

  let selected;
  for (const [index, combatant] of state[opponentSide(actorSide)].entries()) {
    if (!combatant.alive || combatant.isGhost) continue;
    for (const effect of combatant.buffs) {
      if (effect.type !== 'attribute_guard') continue;
      if (effectApplies(effect, combatant.attributes, actor.attributes)) continue;
      const activationOrder = Number(effect.activationOrder) || 0;
      if (!selected || activationOrder >= selected.activationOrder) {
        selected = { index, combatant, effect, activationOrder, mode: 'bypass' };
      }
    }
  }
  return selected;
}

function skillTurnsRemaining(combatant) {
  const skillTurn = Number(combatant.character?.skillTurn);
  if (!Number.isFinite(skillTurn) || skillTurn >= 99) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, skillTurn - (Number(combatant.skillCounter) || 0));
}

function compareDamageEfficiency(left, right, killablePool) {
  return killablePool
    ? left.overkill - right.overkill
    : right.damageRatio - left.damageRatio;
}

function compareTargetCandidates(left, right, policy, killablePool) {
  if (policy === TARGET_POLICIES.BALANCE || policy === TARGET_POLICIES.EXPERT) {
    return (
      right.remaining - left.remaining ||
      Number(right.killable) - Number(left.killable) ||
      compareDamageEfficiency(left, right, left.killable && right.killable) ||
      left.skillTurnsRemaining - right.skillTurnsRemaining ||
      right.survivalTurns - left.survivalTurns ||
      right.threat - left.threat ||
      left.index - right.index
    );
  }
  if (policy === TARGET_POLICIES.SKILL_THREAT) {
    return (
      right.remaining - left.remaining ||
      left.skillTurnsRemaining - right.skillTurnsRemaining ||
      Number(right.killable) - Number(left.killable) ||
      compareDamageEfficiency(left, right, left.killable && right.killable) ||
      right.survivalTurns - left.survivalTurns ||
      right.threat - left.threat ||
      left.index - right.index
    );
  }
  return (
    Number(right.killable) - Number(left.killable) ||
    right.remaining - left.remaining ||
    compareDamageEfficiency(left, right, killablePool) ||
    left.skillTurnsRemaining - right.skillTurnsRemaining ||
    right.survivalTurns - left.survivalTurns ||
    right.threat - left.threat ||
    left.index - right.index
  );
}

export function targetPolicyReason(policy = TARGET_POLICIES.KILL_CONFIRM) {
  if (policy === TARGET_POLICIES.EXPERT) return "残数平準化を最優先に、撃破効率・発動間近のスキル・長期生存を統合して判断";
  if (policy === TARGET_POLICIES.BALANCE) return "敵の残りキャラ数の平準化を最優先";
  if (policy === TARGET_POLICIES.SKILL_THREAT) return "残数平準化後、発動が近い敵を優先";
  return "撃破可能な敵を確実に倒すことを優先し、その中で敵の残数を平準化";
}

export function selectPriorityTarget(state, actorSide, options = {}) {
  const actor = options.actor ?? state[actorSide]?.[options.actorIndex ?? 0];
  const skill = options.skill ?? BASIC_ATTACK;
  const rules = options.rules;
  const targets = state[opponentSide(actorSide)];
  const candidates = targetableIndexes(targets).map((index) => {
    const target = targets[index];
    const damage = actor && rules ? estimateDamage(actor, target, skill, rules) : 0;
    return {
      index,
      damage,
      killable: damage >= target.currentHp,
      remaining: remainingCharacterCount(target),
      overkill: Math.max(0, damage - target.currentHp),
      damageRatio: target.currentHp > 0 ? damage / target.currentHp : 0,
      threat: Number(target.character.pow) || 0,
      skillTurnsRemaining: skillTurnsRemaining(target),
      survivalTurns: Number(target.survivalTurns) || 0,
    };
  });
  if (!candidates.length) return undefined;
  if (typeof options.targetPolicy === "function") {
    const selected = options.targetPolicy({ state, actorSide, actor, skill, rules, candidates });
    const selectedIndex = typeof selected === "object" ? selected?.index : selected;
    if (candidates.some((candidate) => candidate.index === selectedIndex)) return selectedIndex;
  }
  // 色かばうを受けない攻撃者は、かばう役を直接倒して味方の攻撃を通す。
  // 通常のかばう、または対象色の攻撃は実際の攻撃処理で自動的にかばう役へ向かう。
  const guardBreakTarget = guardBreakTargetForAttacker(state, actorSide, actor);
  if (guardBreakTarget?.mode === 'bypass' && candidates.some(({ index }) => index === guardBreakTarget.index)) {
    return guardBreakTarget.index;
  }
  const policy = Object.values(TARGET_POLICIES).includes(options.targetPolicy)
    ? options.targetPolicy
    : TARGET_POLICIES.KILL_CONFIRM;
  const killable = candidates.filter((candidate) => candidate.killable);
  candidates.sort((left, right) => compareTargetCandidates(
    left,
    right,
    policy,
    killable.length > 0,
  ));
  return candidates[0].index;
}

function activeTokens(state, side) {
  return state[side].flatMap((combatant, index) => (
    combatant.alive
      ? [{
          side,
          actorIndex: index,
          actorId: combatant.activeCharacterId,
          actorName: combatant.character.name,
          actor: structuredClone(combatant),
        }]
      : []
  ));
}

function skillScopeMatches(skill, combatant, actorIndex, targetIndex, attributes = combatant.attributes) {
  if (combatant.isGhost || combatant.reviveUsed) return false;
  if (skill.target === "self" && actorIndex !== targetIndex) return false;
  if (skill.target === "leader" && targetIndex !== 0) return false;
  return (skill.conditions ?? []).every((condition) => (
    condition.type !== "ally_attribute" ||
    (attributes ?? combatant.character?.attributes ?? []).includes(condition.attribute)
  ));
}

function attributesAfterPlannedChanges(state, side, targetIndex, attributeIntents = []) {
  const target = state[side][targetIndex];
  let attributes = [...(target?.attributes ?? target?.character?.attributes ?? [])];
  for (const intent of attributeIntents) {
    if (intent.side !== side || intent.skill.type !== "attribute_change") continue;
    if (!skillScopeMatches(intent.skill, target, intent.actorIndex, targetIndex, attributes)) continue;
    const changed = (intent.skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
    if (changed.length) attributes = changed;
  }
  return attributes;
}

function reviveMayApply(state, side, actorIndex, skill, rules, attributeIntents = []) {
  const allies = state[side];
  const enemies = state[opponentSide(side)].filter((combatant) => combatant.alive);
  return allies.some((target, targetIndex) => {
    const attributes = attributesAfterPlannedChanges(state, side, targetIndex, attributeIntents);
    if (!target.alive || !skillScopeMatches(skill, target, actorIndex, targetIndex, attributes)) return false;
    return enemies.some((enemy) => {
      const enemySkill = canUseSkill(state, opponentSide(side), state[opponentSide(side)].indexOf(enemy)) &&
        isAttackSkill(enemy.character.skill)
        ? enemy.character.skill
        : BASIC_ATTACK;
      return estimateDamage(enemy, target, enemySkill, rules) >= target.currentHp;
    });
  });
}

function actorWillBeRevivedThisTurn(state, side, actorIndex, rules, attributeIntents = []) {
  const target = state[side][actorIndex];
  if (!target?.alive || target.isGhost || target.reviveUsed) return false;
  const enemies = state[opponentSide(side)];
  const willBeDefeated = enemies.some((enemy, enemyIndex) => {
    if (!enemy.alive || enemy.isGhost) return false;
    const enemySkill = canUseSkill(state, opponentSide(side), enemyIndex) && isAttackSkill(enemy.character.skill)
      ? enemy.character.skill
      : BASIC_ATTACK;
    return estimateDamage(enemy, target, enemySkill, rules) >= target.currentHp;
  });
  if (!willBeDefeated) return false;
  const attributes = attributesAfterPlannedChanges(state, side, actorIndex, attributeIntents);
  return state[side].some((reviver, reviverIndex) => (
    canUseSkill(state, side, reviverIndex) &&
    reviver.character.skill?.type === "revive" &&
    skillScopeMatches(reviver.character.skill, target, reviverIndex, actorIndex, attributes)
  ));
}

function skillDecision(state, side, actorIndex, rules, options) {
  const actor = state[side][actorIndex];
  const skill = actor.character.skill;
  if (typeof options.skillPolicy === "function") {
    return options.skillPolicy({ state, side, actorIndex, actor, skill, rules });
  }
  if (skill.type === "delay" || skill.type === "skill_reduction") {
    return { use: false, reason: "今回の評価では短縮・遅延効果を使用しない" };
  }
  if (options.playStyle === PLAY_STYLES.EXPERT) {
    return expertSkillDecision(state, side, actorIndex, rules, options);
  }
  const environmentPosition = actor.environmentPosition ?? actor.deckIndex + 1;
  if (environmentPosition >= 2 && skill.type !== "revive") {
    return { use: true, reason: "2枠目以降は使用可能なスキルを原則すぐ使用" };
  }
  if (skill.type === "revive") {
    return reviveMayApply(state, side, actorIndex, skill, rules)
      ? { use: true, reason: "このターンに蘇生対象が倒れる可能性があるため使用" }
      : { use: false, reason: "蘇生対象の撃破予測がないため温存" };
  }
  if (skill.type === "multi_hit_attack") {
    const totalMultiplier = Math.max(1, Number(skill.hits) || 1) * (Number(skill.multiplier) || 0);
    return totalMultiplier > 1
      ? { use: true, reason: `合計攻撃倍率${totalMultiplier.toFixed(2)}が通常攻撃を上回るため使用` }
      : { use: false, reason: "通常攻撃より最低保証が下がるため温存" };
  }
  if (skill.type === "aoe_attack") {
    const targetCount = targetableIndexes(state[opponentSide(side)]).length;
    const totalMultiplier = targetCount * (Number(skill.multiplier) || 0);
    return totalMultiplier > 1
      ? { use: true, reason: `${targetCount}体への全体攻撃が通常攻撃を上回るため使用` }
      : { use: false, reason: "対象数を含めても通常攻撃を上回らないため温存" };
  }
  if (skill.type === "single_attack") {
    return Number(skill.multiplier) > 1
      ? { use: true, reason: "攻撃倍率が通常攻撃を上回るため使用" }
      : { use: false, reason: "通常攻撃より最低保証が下がるため温存" };
  }
  return { use: true, reason: "有効な支援効果を先に適用するため使用" };
}

function attackSkillWithEffects(actor, baseSkill = BASIC_ATTACK) {
  const modeEffects = actor.isGhost ? [] : actor.buffs.filter((effect) => ATTACK_MODE_TYPES.has(effect.type));
  const aoe = baseSkill.type === "aoe_attack" || modeEffects.some((effect) => effect.type === "aoe_attack");
  const baseHits = baseSkill.type === "multi_hit_attack" ? Math.max(1, Number(baseSkill.hits) || 1) : 1;
  const extraHits = modeEffects.filter((effect) => effect.type === "multi_hit_attack").reduce((sum, effect) => (
    sum + Math.max(0, Number(effect.hits) - 1)
  ), 0);
  const hits = baseHits + extraHits;
  return {
    type: aoe ? "aoe_attack" : hits > 1 ? "multi_hit_attack" : "single_attack",
    multiplier: Number(baseSkill.multiplier) || 1,
    hits,
  };
}

function projectedSkillDamage(state, side, actor, skill, rules) {
  const effectiveSkill = attackSkillWithEffects(actor, skill);
  const targets = state[opponentSide(side)].filter((combatant) => combatant.alive && !combatant.isGhost);
  const damages = targets.map((target) => estimateDamage(actor, target, effectiveSkill, rules));
  if (effectiveSkill.type === "aoe_attack") {
    return damages.reduce((sum, damage) => sum + damage * Math.max(1, effectiveSkill.hits), 0);
  }
  const strongestHit = Math.max(0, ...damages);
  return effectiveSkill.type === "multi_hit_attack"
    ? strongestHit * Math.max(1, Number(effectiveSkill.hits) || 1)
    : strongestHit;
}

function crossTeamDamage(state, attackingSide, rules) {
  const defendingSide = opponentSide(attackingSide);
  return state[attackingSide].filter((combatant) => combatant.alive && !combatant.isGhost).reduce((sum, actor) => (
    sum + state[defendingSide].filter((target) => target.alive && !target.isGhost).reduce((damageSum, target) => (
      damageSum + estimateDamage(actor, target, BASIC_ATTACK, rules)
    ), 0)
  ), 0);
}

function totalCurrentHp(state, side) {
  return state[side].reduce((sum, combatant) => sum + (combatant.alive && !combatant.isGhost ? combatant.currentHp : 0), 0);
}

function expertSupportBenefit(state, side, actorIndex, skill, rules) {
  const after = applySupportSkill(state, side, actorIndex, skill, { consumeSkill: false });
  const outgoingGain = crossTeamDamage(after, side, rules) - crossTeamDamage(state, side, rules);
  const preventedDamage = crossTeamDamage(state, opponentSide(side), rules) - crossTeamDamage(after, opponentSide(side), rules);
  const healingGain = totalCurrentHp(after, side) - totalCurrentHp(state, side);
  return { outgoingGain, preventedDamage, healingGain };
}

function expertSkillDecision(state, side, actorIndex, rules, options = {}) {
  const actor = state[side][actorIndex];
  const skill = actor.character.skill;
  if (skill.type === "revive") {
    return reviveMayApply(state, side, actorIndex, skill, rules)
      ? { use: true, reason: "このターンの撃破を蘇生で覆せるため使用" }
      : { use: false, reason: "このターンに蘇生対象が発生しないため温存" };
  }
  if (skill.type === "heal") {
    const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules);
    if (benefit.healingGain <= 0) {
      return { use: false, reason: "現在ターンに回復できるHPがないため温存" };
    }
    return actorWillBeRevivedThisTurn(state, side, actorIndex, rules, options.plannedAttributeIntents)
      ? { use: false, reason: "このターンに自身が蘇生対象になるため温存" }
      : { use: true, reason: "現在ターンの実回復量があるため使用" };
  }
  if (isAttackSkill(skill)) {
    const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules);
    return benefit.outgoingGain > 0
      ? { use: true, reason: "通常攻撃より撃破・総ダメージ効率が上がるため使用" }
      : { use: false, reason: "既存の攻撃形態と重複するか盤面への寄与が増えないため温存" };
  }
  const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules);
  const useful = skill.type === "heal"
    ? benefit.healingGain > 0
    : benefit.outgoingGain > 0 || benefit.preventedDamage > 0;
  return useful
    ? { use: true, reason: "このターン以降の与ダメージ増加または被ダメージ軽減に寄与するため使用" }
    : { use: false, reason: "適用対象・属性条件・盤面効果が不足するため温存" };
}

function chooseSkills(state, rules, options) {
  const candidates = [];
  for (const side of ["allies", "enemies"]) {
    for (let actorIndex = 0; actorIndex < state[side].length; actorIndex += 1) {
      if (!canUseSkill(state, side, actorIndex)) continue;
      const actor = state[side][actorIndex];
      const decision = skillDecision(state, side, actorIndex, rules, options);
      candidates.push({
        side,
        actorIndex,
        actorId: actor.activeCharacterId,
        actorName: actor.character.name,
        skill: structuredClone(actor.character.skill),
        use: Boolean(decision.use),
        reason: decision.reason,
      });
    }
  }
  const attributeIntents = candidates.filter(({ use, skill }) => use && skill.type === "attribute_change");
  for (const intent of candidates) {
    if (intent.skill.type === "revive") {
      const use = reviveMayApply(state, intent.side, intent.actorIndex, intent.skill, rules, attributeIntents);
      intent.use = use;
      intent.reason = use
        ? "このターンの属性変更後に蘇生対象となる撃破予測があるため使用"
        : "このターンの属性変更後に蘇生対象となる撃破予測がないため温存";
    } else if (intent.skill.type === "heal" && options.playStyle === PLAY_STYLES.EXPERT) {
      const decision = expertSkillDecision(state, intent.side, intent.actorIndex, rules, {
        ...options,
        plannedAttributeIntents: attributeIntents,
      });
      intent.use = Boolean(decision.use);
      intent.reason = decision.reason;
    }
  }
  const events = candidates.map((intent) => (
    {
      type: intent.use ? "skill_use" : "skill_hold",
      side: intent.side,
      actorIndex: intent.actorIndex,
      actorId: intent.actorId,
      actorName: intent.actorName,
      skillType: intent.skill.type,
      reason: intent.reason,
    }
  ));
  const intents = candidates.filter((intent) => intent.use);
  return { intents, events };
}

function consumeSelectedSkills(state, intents) {
  return intents.reduce(
    (current, intent) => consumeSkill(current, intent.side, intent.actorIndex),
    state,
  );
}

function phase(id, events = []) {
  return { id, label: PHASE_LABELS[id], events };
}

function supportChanges(before, after, side) {
  const changes = [];
  for (let index = 0; index < after[side].length; index += 1) {
    const previous = before[side][index];
    const current = after[side][index];
    if (previous.currentHp !== current.currentHp) {
      changes.push({
        playerIndex: index,
        targetName: current.character.name,
        hpBefore: previous.currentHp,
        hpAfter: current.currentHp,
      });
    }
    if (previous.alive !== current.alive) {
      changes.push({
        playerIndex: index,
        targetName: current.character.name,
        revived: current.alive,
      });
    }
    if (previous.buffs.length !== current.buffs.length) {
      changes.push({
        playerIndex: index,
        targetName: current.character.name,
        buffAdded: current.buffs.at(-1)?.type,
      });
    }
    if (previous.attributes.join("+") !== current.attributes.join("+")) {
      changes.push({
        playerIndex: index,
        targetName: current.character.name,
        attributesBefore: previous.attributes,
        attributesAfter: current.attributes,
      });
    }
  }
  return changes;
}

function applySupportPhase(state, intents, skillTypes) {
  let next = state;
  const events = [];
  for (const intent of intents.filter(({ skill }) => skillTypes.includes(skill.type))) {
    const before = next;
    next = applySupportSkill(next, intent.side, intent.actorIndex, intent.skill, { consumeSkill: false });
    events.push({
      type: "skill_effect",
      side: intent.side,
      actorIndex: intent.actorIndex,
      actorName: intent.actorName,
      skillType: intent.skill.type,
      changes: supportChanges(before, next, intent.side),
    });
  }
  return { state: next, events };
}

function projectedAttackDamage(intent, state, rules) {
  return projectedSkillDamage(state, intent.side, intent.actor, intent.skill, rules);
}

function tacticalAttackIntentScore(intent, state, rules, options) {
  const targetIndex = selectPriorityTarget(state, intent.side, {
    actor: intent.actor,
    actorIndex: intent.actorIndex,
    skill: intent.skill,
    rules,
    targetPolicy: options.targetPolicy ?? TARGET_POLICIES.EXPERT,
  });
  const target = state[opponentSide(intent.side)][targetIndex];
  if (!target) return 0;
  const damage = estimateDamage(intent.actor, target, intent.skill, rules);
  const defeated = intent.skill.type === "aoe_attack"
    ? state[opponentSide(intent.side)].filter((entry) => entry.alive && !entry.isGhost).filter((entry) => (
      estimateDamage(intent.actor, entry, intent.skill, rules) >= entry.currentHp
    )).length
    : Number(damage >= target.currentHp);
  return (
    defeated * 1_000_000 +
    remainingCharacterCount(target) * 10_000 +
    Number(damage >= target.currentHp) * 1_000 +
    Math.min(999, damage / Math.max(1, target.currentHp)) * 10 +
    projectedAttackDamage(intent, state, rules) / 1_000
  );
}

function guardBreakAssessment(intent, state, rules) {
  const guard = guardBreakTargetForAttacker(state, intent.side, intent.actor);
  if (!guard) return undefined;
  return {
    ...guard,
    damage: estimateDamage(intent.actor, guard.combatant, intent.skill, rules),
  };
}

function compareGuardBreakOrder(left, right, state, rules) {
  const leftGuard = guardBreakAssessment(left, state, rules);
  const rightGuard = guardBreakAssessment(right, state, rules);
  if (!leftGuard && !rightGuard) return 0;
  if (!leftGuard) return 1;
  if (!rightGuard) return -1;

  const leftPriority = leftGuard.mode === 'bypass' ? 2 : 1;
  const rightPriority = rightGuard.mode === 'bypass' ? 2 : 1;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;

  if (leftGuard.index !== rightGuard.index) {
    return rightGuard.damage - leftGuard.damage || leftGuard.index - rightGuard.index;
  }

  const guardHp = Math.max(1, Number(leftGuard.combatant.currentHp) || 0);
  const guardMaxHp = Math.max(1, Number(leftGuard.combatant.maxHp) || guardHp);
  const leftFinishes = leftGuard.damage >= guardHp;
  const rightFinishes = rightGuard.damage >= guardHp;
  const nearDefeat = guardHp <= guardMaxHp * 0.35;
  if (nearDefeat && leftFinishes !== rightFinishes) return Number(rightFinishes) - Number(leftFinishes);
  if (nearDefeat && leftFinishes && rightFinishes) {
    return leftGuard.damage - rightGuard.damage;
  }
  return rightGuard.damage - leftGuard.damage;
}

function orderAttackIntents(intents, side, state, rules, options) {
  const requestedOrder = options.attackOrder?.[side];
  if (Array.isArray(requestedOrder)) {
    const order = new Map(requestedOrder.map((playerIndex, index) => [playerIndex, index]));
    return intents.sort((left, right) => (
      (order.get(left.actorIndex) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.actorIndex) ?? Number.MAX_SAFE_INTEGER)
    ));
  }
  if (options.attackOrderPolicy === ATTACK_ORDER_POLICIES.TACTICAL) {
    return intents.sort((left, right) => (
      compareGuardBreakOrder(left, right, state, rules) ||
      tacticalAttackIntentScore(right, state, rules, options) - tacticalAttackIntentScore(left, state, rules, options) ||
      left.actorIndex - right.actorIndex
    ));
  }
  if (options.attackOrderPolicy === ATTACK_ORDER_POLICIES.STRONGEST_FIRST) {
    return intents.sort((left, right) => (
      compareGuardBreakOrder(left, right, state, rules) ||
      projectedAttackDamage(right, state, rules) - projectedAttackDamage(left, state, rules) ||
      left.actorIndex - right.actorIndex
    ));
  }
  return intents;
}

function attackIntents(state, selectedSkills, rules, options) {
  const selected = new Map(selectedSkills.map((intent) => [`${intent.side}:${intent.actorIndex}`, intent]));
  const tokens = {
    allies: activeTokens(state, "allies"),
    enemies: activeTokens(state, "enemies"),
  };
  return ["allies", "enemies"].flatMap((side) => orderAttackIntents(tokens[side].map((token) => {
    const skill = attackSkillWithEffects(token.actor);
    return {
      ...token,
      skill,
      action: token.actor.isGhost
        ? "ghost_attack"
        : skill.type === "single_attack" ? "basic_attack" : "attack_skill",
    };
  }), side, state, rules, options));
}

function resolveAttacks(state, intents, rules, options) {
  let next = state;
  const actions = [];
  for (const intent of intents) {
    const targetIndex = selectPriorityTarget(next, intent.side, {
      actor: intent.actor,
      actorIndex: intent.actorIndex,
      skill: intent.skill,
      rules,
      targetPolicy: options.targetPolicy,
    });
    const result = resolveAttackAction(
      next,
      intent.side,
      intent.actorIndex,
      rules,
      intent.skill,
      {
        actorSnapshot: intent.actor,
        targetIndex,
        deferReplacement: true,
        consumeSkill: false,
      },
    );
    next = result.state;
    actions.push({
      type: "attack",
      action: intent.action,
      side: intent.side,
      actorIndex: intent.actorIndex,
      actorId: intent.actorId,
      actorName: intent.actorName,
      skillType: intent.skill.type,
      targetIndex,
      targetPolicy: options.targetPolicy ?? TARGET_POLICIES.KILL_CONFIRM,
      targetReason: targetPolicyReason(options.targetPolicy),
      hits: result.hits,
    });
  }
  return { state: next, actions };
}

function combatantStock(combatant) {
  const totalHp = combatant.deck.reduce((sum, character) => sum + Math.max(0, Number(character.hp) || 0), 0);
  if (combatant.isGhost) {
    return { totalHp, remainingHp: 0, remainingCharacters: 0, activeHpRatio: 0, active: false, ghost: true };
  }
  if (!combatant.alive) {
    const reserveHp = combatant.deck
      .slice(combatant.deckIndex + 1)
      .reduce((sum, character) => sum + Math.max(0, Number(character.hp) || 0), 0);
    return {
      totalHp,
      remainingHp: reserveHp,
      remainingCharacters: Math.max(0, combatant.deck.length - combatant.deckIndex - 1),
      activeHpRatio: 0,
      active: false,
      ghost: false,
    };
  }
  const reserveHp = combatant.deck
    .slice(combatant.deckIndex + 1)
    .reduce((sum, character) => sum + Math.max(0, Number(character.hp) || 0), 0);
  return {
    totalHp,
    remainingHp: combatant.currentHp + reserveHp,
    remainingCharacters: combatant.deck.length - combatant.deckIndex,
    activeHpRatio: combatant.maxHp > 0 ? combatant.currentHp / combatant.maxHp : 0,
    active: true,
    ghost: false,
  };
}

export function snapshotTeam(state, side) {
  const stocks = state[side].map(combatantStock);
  const activeStocks = stocks.filter((stock) => stock.active);
  const remainingByPlayer = stocks.map((stock) => stock.remainingCharacters);
  return {
    totalHp: stocks.reduce((sum, stock) => sum + stock.totalHp, 0),
    remainingHp: stocks.reduce((sum, stock) => sum + stock.remainingHp, 0),
    remainingCharacters: remainingByPlayer.reduce((sum, count) => sum + count, 0),
    remainingByPlayer,
    remainingSpread: remainingByPlayer.length
      ? Math.max(...remainingByPlayer) - Math.min(...remainingByPlayer)
      : 0,
    activePlayers: activeStocks.length,
    ghosts: stocks.filter((stock) => stock.ghost).length,
    activeHpRatio: activeStocks.length
      ? activeStocks.reduce((sum, stock) => sum + stock.activeHpRatio, 0) / activeStocks.length
      : 0,
  };
}

function teamIsAllGhosts(state, side) {
  return state[side].length > 0 && state[side].every((combatant) => combatant.isGhost);
}

function outcomeOf(state) {
  const alliesDefeated = teamIsAllGhosts(state, "allies");
  const enemiesDefeated = teamIsAllGhosts(state, "enemies");
  if (alliesDefeated && enemiesDefeated) return "draw";
  if (enemiesDefeated) return "allies";
  if (alliesDefeated) return "enemies";
  return "ongoing";
}

function continuationMetrics(history) {
  const bySource = {};
  const add = (source, field) => {
    if (!source?.sourceCharacterId) return;
    const id = String(source.sourceCharacterId);
    bySource[id] ??= { attackHits: 0, carriedAttackHits: 0, defenseHits: 0, carriedDefenseHits: 0 };
    bySource[id][field] += 1;
  };
  for (const action of history.flatMap((entry) => entry.actions)) {
    for (const hit of action.hits) {
      for (const source of hit.continuation?.attackSources ?? []) {
        add(source, "attackHits");
        if (source.carried) add(source, "carriedAttackHits");
      }
      for (const source of hit.continuation?.defenseSources ?? []) {
        add(source, "defenseHits");
        if (source.carried) add(source, "carriedDefenseHits");
      }
    }
  }
  const totals = Object.values(bySource).reduce((sum, entry) => ({
    attackHits: sum.attackHits + entry.attackHits,
    carriedAttackHits: sum.carriedAttackHits + entry.carriedAttackHits,
    defenseHits: sum.defenseHits + entry.defenseHits,
    carriedDefenseHits: sum.carriedDefenseHits + entry.carriedDefenseHits,
  }), { attackHits: 0, carriedAttackHits: 0, defenseHits: 0, carriedDefenseHits: 0 });
  return { ...totals, bySource };
}

export function simulateBattle(initialState, rules, options = {}) {
  const configuredTurns = Number(options.turns ?? rules.simulation?.turns ?? 8);
  const totalTurns = Math.min(12, Math.max(1, Math.floor(configuredTurns || 8)));
  const initial = {
    allies: snapshotTeam(initialState, "allies"),
    enemies: snapshotTeam(initialState, "enemies"),
    board: evaluateBoard(initialState, "allies"),
  };
  let state = structuredClone(initialState);
  const history = [];

  for (let turnIndex = 0; turnIndex < totalTurns; turnIndex += 1) {
    options.onTurnStart?.({ turn: state.turn, state: structuredClone(state) });
    const phases = [];
    const selection = chooseSkills(state, rules, options);
    phases.push(phase("skill_selection", selection.events));
    state = consumeSelectedSkills(state, selection.intents);

    const attribute = applySupportPhase(state, selection.intents, ["attribute_change"]);
    state = attribute.state;
    phases.push(phase("attribute_change", attribute.events));

    const healing = applySupportPhase(state, selection.intents, ["heal"]);
    state = healing.state;
    phases.push(phase("healing", healing.events));

    const attackSupport = applySupportPhase(state, selection.intents, ["attack_buff", "aoe_attack", "multi_hit_attack"]);
    state = attackSupport.state;
    phases.push(phase("attack_support", attackSupport.events));

    const defense = applySupportPhase(state, selection.intents, ["damage_reduction", "guard", "attribute_guard"]);
    state = defense.state;
    phases.push(phase("defense", defense.events));

    const scheduledAttacks = attackIntents(state, selection.intents, rules, options);
    const attack = resolveAttacks(state, scheduledAttacks, rules, options);
    state = attack.state;
    phases.push(phase("attack", attack.actions));

    const reviveIntents = [...selection.intents]
      .filter(({ skill }) => skill.type === "revive")
      .sort((left, right) => (Number(right.skill.multiplier) || 0) - (Number(left.skill.multiplier) || 0));
    const revive = applySupportPhase(state, reviveIntents, ["revive"]);
    state = revive.state;
    phases.push(phase("revive", revive.events));

    const replacement = resolveDefeatedCombatants(state, {
      ghostPower: rules.simulation?.ghostPower ?? 1000,
    });
    state = replacement.state;
    phases.push(phase("replacement", replacement.transitions.map((transition) => ({
      type: transition.type,
      ...transition,
    }))));

    history.push({
      turn: state.turn,
      phases,
      actions: attack.actions,
      allies: snapshotTeam(state, "allies"),
      enemies: snapshotTeam(state, "enemies"),
      board: evaluateBoard(state, "allies"),
    });
    const outcome = outcomeOf(state);
    state = advanceTurn(state);
    if (outcome !== "ongoing") break;
  }

  const final = {
    allies: snapshotTeam(state, "allies"),
    enemies: snapshotTeam(state, "enemies"),
    board: evaluateBoard(state, "allies"),
  };
  return {
    state,
    history,
    turnsCompleted: history.length,
    attackModel: "simultaneous",
    assumptions: [
      "両チームの攻撃者は攻撃フェーズ開始時に確定し、途中で倒されても攻撃する",
      options.attackOrderPolicy === ATTACK_ORDER_POLICIES.STRONGEST_FIRST
        ? "チーム内は推定ダメージが高いキャラから攻撃する"
        : "チーム内の攻撃順は指定がなければ左から順に処理する",
      targetPolicyReason(options.targetPolicy),
      "短縮・遅延スキルの効果は使用しない",
      "乱数は最低値で計算する",
    ],
    outcome: outcomeOf(state),
    initial,
    final,
    metrics: {
      allyLosses: initial.allies.remainingCharacters - final.allies.remainingCharacters,
      enemyLosses: initial.enemies.remainingCharacters - final.enemies.remainingCharacters,
      allyRemainingSpread: final.allies.remainingSpread,
      enemyRemainingSpread: final.enemies.remainingSpread,
      boardDelta: final.board - initial.board,
      continuation: continuationMetrics(history),
    },
  };
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function scoreSimulationResult(result) {
  const initialEnemyCount = Math.max(1, result.initial.enemies.remainingCharacters);
  const initialAllyCount = Math.max(1, result.initial.allies.remainingCharacters);
  const enemyProgress = clamp(result.metrics.enemyLosses / initialEnemyCount * 100);
  const allyRetention = clamp((1 - result.metrics.allyLosses / initialAllyCount) * 100);
  const countAdvantage = clamp(50 + (result.metrics.enemyLosses - result.metrics.allyLosses) * 8);
  const enemyBalance = result.metrics.enemyLosses > 0
    ? clamp(100 - result.metrics.enemyRemainingSpread * 25)
    : 50;
  const boardProgress = clamp(50 + result.metrics.boardDelta * 0.2);
  return clamp(
    enemyProgress * 0.35 +
    allyRetention * 0.3 +
    countAdvantage * 0.2 +
    enemyBalance * 0.1 +
    boardProgress * 0.05,
  );
}
