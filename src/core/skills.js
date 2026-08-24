import {
  calculateMinimumDamage,
  resolveAttackBuffMultiplier,
  resolveDefenseMultiplier,
} from "./damage.js";
import { activateNextCharacter, evaluateBoard, recoveredHp } from "./battleState.js";

const attackTypes = new Set(["single_attack", "aoe_attack", "multi_hit_attack"]);
const defenseTypes = new Set(["damage_reduction", "guard", "attribute_guard"]);
const supportTypes = new Set(["attack_buff", "damage_reduction", "guard", "attribute_guard", "heal", "revive", "attribute_change"]);
const excludedSkillTypes = new Set(["delay", "skill_reduction"]);

export function isExcludedSkill(skill) {
  return excludedSkillTypes.has(skill?.type);
}

function targetableIndexes(combatants) {
  return combatants.flatMap((combatant, index) => (
    combatant.alive && !combatant.isGhost ? [index] : []
  ));
}

function effectApplies(effect, ownerAttributes, opponentAttributes) {
  return (effect.conditions ?? []).every((condition) => {
    const attributes = condition.type === "ally_attribute" ? ownerAttributes : opponentAttributes;
    return attributes.includes(condition.attribute);
  });
}

function supportConditionApplies(skill, target) {
  // 属性条件は、戦闘中の現在属性で判定する。死亡直後も色変更の効果は
  // 蘇生フェーズまで残るため、ここで元のキャラクター属性へ戻してはいけない。
  const targetAttributes = target.attributes ?? target.character?.attributes ?? [];
  return (skill.conditions ?? []).every((condition) => (
    condition.type !== "ally_attribute" || targetAttributes.includes(condition.attribute)
  ));
}

function supportTargetIndexes(allies, actorIndex, skill, options = {}) {
  const { alive = true, applyConditions = true } = options;
  const indexes = skill.target === "self"
    ? [actorIndex]
    : skill.target === "leader"
      ? [0]
      : allies.map((_, index) => index);
  return indexes.filter((index) => {
    const target = allies[index];
    return Boolean(
      target &&
      !target.isGhost &&
      target.alive === alive &&
      (alive || !target.reviveUsed) &&
      (!applyConditions || supportConditionApplies(skill, target))
    );
  });
}

function continuationEffectSources(effects, ownerId, types = []) {
  return effects.filter((effect) => (
    (!types.length || types.includes(effect.type)) &&
    Number(effect.duration) > Number(effect.remainingTurns) &&
    effect.sourceCharacterId
  )).map((effect) => ({
    sourceCharacterId: String(effect.sourceCharacterId),
    carried: String(effect.sourceCharacterId) !== String(ownerId),
  }));
}

function resolveRedirectIndex(combatants, attacker) {
  if (attacker.isGhost) return undefined;
  let selected;
  for (let index = 0; index < combatants.length; index += 1) {
    const combatant = combatants[index];
    if (!combatant.alive || combatant.isGhost) continue;
    for (const effect of combatant.buffs) {
      if (!defenseTypes.has(effect.type) || effect.type === "damage_reduction") continue;
      if (!effectApplies(effect, combatant.attributes, attacker.attributes)) continue;
      const activationOrder = Number(effect.activationOrder) || 0;
      if (!selected || activationOrder >= selected.activationOrder) {
        selected = { index, activationOrder };
      }
    }
  }
  return selected?.index;
}

function addEffect(combatant, type, skill, activationOrder, sourceCharacterId) {
  const refreshAttackMode = ["aoe_attack", "multi_hit_attack"].includes(type);
  return {
    ...combatant,
    buffs: [
      ...combatant.buffs.filter((effect) => (
        !refreshAttackMode || effect.type !== type || String(effect.sourceCharacterId) !== String(sourceCharacterId)
      )),
      {
        type,
        multiplier: skill.multiplier,
        amount: skill.amount,
        hits: skill.hits,
        remainingTurns: skill.duration,
        duration: skill.duration,
        sourceCharacterId,
        conditions: structuredClone(skill.conditions ?? []),
        attributes: (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []),
        activationOrder,
      },
    ],
  };
}

function consumeSkillInPlace(state, actorSide, actorIndex) {
  const actor = state[actorSide]?.[actorIndex];
  if (!actor || actor.isGhost) return;
  actor.skillUses += 1;
  actor.skillCounter = 0;
}

export function consumeSkill(state, actorSide, actorIndex) {
  const next = structuredClone(state);
  consumeSkillInPlace(next, actorSide, actorIndex);
  return next;
}

export function resolveAttackAction(state, actorSide, actorIndex, rules, skill, options = {}) {
  const next = structuredClone(state);
  const targetSide = actorSide === "allies" ? "enemies" : "allies";
  const actor = structuredClone(options.actorSnapshot ?? next[actorSide]?.[actorIndex]);
  const preferredTargetIndex = options.targetIndex;
  const hits = [];
  if (!actor || (!actor.alive && !options.actorSnapshot)) {
    return { state: next, hits, actorName: actor?.character?.name ?? "不明", skillType: skill.type };
  }

  const livingTargets = () => targetableIndexes(next[targetSide]);
  const initialTargetIndex = preferredTargetIndex ?? livingTargets()[0];
  const random = typeof options.random === "function" ? options.random : Math.random;
  const randomLivingTargetIndex = () => {
    const targets = livingTargets();
    if (!targets.length) return undefined;
    const roll = Number(random());
    const normalized = Number.isFinite(roll) ? Math.min(0.999999999, Math.max(0, roll)) : 0;
    return targets[Math.floor(normalized * targets.length)];
  };
  const nextTargetIndex = () => {
    const targets = livingTargets();
    return targets.includes(initialTargetIndex) ? initialTargetIndex : targets[0];
  };
  const attackTarget = (targetIndex, redirected = false, targetMode = "priority") => {
    const defender = next[targetSide][targetIndex];
    if (!defender?.alive || defender.isGhost) return;
    const attackEffects = actor.isGhost ? [] : actor.buffs.filter(
      (effect) => effect.type === "attack_buff" && effectApplies(effect, actor.attributes, defender.attributes),
    );
    const defenseEffects = actor.isGhost ? [] : defender.buffs.filter(
      (effect) => defenseTypes.has(effect.type) && effectApplies(effect, defender.attributes, actor.attributes),
    );
    const attackMultiplier = actor.isGhost ? 1 : resolveAttackBuffMultiplier(attackEffects);
    const defenseMultiplier = actor.isGhost ? 1 : resolveDefenseMultiplier(defenseEffects);
    const damage = calculateMinimumDamage({
      attacker: {
        ...actor.character,
        attributes: actor.attributes,
        survivalTurns: actor.isGhost ? 0 : actor.survivalTurns,
        isGhost: actor.isGhost,
      },
      defender: { ...defender.character, attributes: defender.attributes },
      skillMultiplier: skill.multiplier,
      attackMultiplier,
      defenseMultiplier,
      randomMultiplier: options.damageMultiplier,
      rules,
    });
    const hpBefore = defender.currentHp;
    const hpAfter = Math.max(0, hpBefore - damage.value);
    const defeated = hpAfter === 0;
    const damaged = { ...defender, currentHp: hpAfter, alive: !defeated };
    next[targetSide][targetIndex] = defeated && !options.deferReplacement
      ? activateNextCharacter(damaged)
      : damaged;
    hits.push({
      targetIndex,
      targetName: defender.character.name,
      damage: damage.value,
      damageRaw: damage.raw,
      rounding: rules.damage.rounding,
      survivalTurns: actor.isGhost ? 0 : actor.survivalTurns,
      survivalBaseMultiplier: rules.damage.survivalBaseMultiplier,
      attribute: damage.attribute,
      hpBefore,
      hpAfter,
      defeated,
      redirected,
      targetMode,
      factors: damage.factors,
      continuation: {
        attackSources: continuationEffectSources(
          [...attackEffects, ...actor.buffs.filter((effect) => (
            ["aoe_attack", "multi_hit_attack", "attribute_change"].includes(effect.type)
            && effectApplies(effect, actor.attributes, defender.attributes)
          ))],
          actor.activeCharacterId,
          ["attack_buff", "aoe_attack", "multi_hit_attack", "attribute_change"],
        ),
        defenseSources: continuationEffectSources(defenseEffects, defender.activeCharacterId, ["damage_reduction", "guard", "attribute_guard"]),
      },
    });
  };

  if (skill.type === "aoe_attack") {
    const initialTargets = livingTargets();
    for (const targetIndex of initialTargets) {
      for (let hit = 0; hit < Math.max(1, Number(skill.hits) || 1); hit += 1) {
        // 全体攻撃は生存中の各敵へ一発ずつ飛ぶ。かばわれた場合も
        // 各一発がかばう役へ向かうため、敵が5人なら5発を受ける。
        const redirectIndex = resolveRedirectIndex(next[targetSide], actor);
        attackTarget(
          redirectIndex ?? targetIndex,
          redirectIndex !== undefined,
          redirectIndex !== undefined ? "guard" : "aoe_target",
        );
      }
    }
  } else if (skill.type === "multi_hit_attack") {
    for (let hit = 0; hit < Math.max(1, skill.hits); hit += 1) {
      const primaryAlive = livingTargets().includes(initialTargetIndex);
      const fallbackIndex = primaryAlive ? initialTargetIndex : randomLivingTargetIndex();
      const redirectIndex = resolveRedirectIndex(next[targetSide], actor);
      const targetIndex = redirectIndex ?? fallbackIndex;
      if (targetIndex === undefined) break;
      attackTarget(
        targetIndex,
        redirectIndex !== undefined,
        redirectIndex !== undefined ? "guard" : primaryAlive ? "priority" : "random_after_defeat",
      );
    }
  } else {
    const fallbackIndex = nextTargetIndex();
    const redirectIndex = resolveRedirectIndex(next[targetSide], actor);
    const targetIndex = redirectIndex ?? fallbackIndex;
    if (targetIndex !== undefined) attackTarget(targetIndex, redirectIndex !== undefined);
  }

  if (options.consumeSkill) consumeSkillInPlace(next, actorSide, actorIndex);
  return {
    state: next,
    actorName: actor.character.name,
    actorId: actor.activeCharacterId,
    actorIndex,
    side: actorSide,
    targetSide,
    targetIndex: hits[0]?.targetIndex,
    skillType: skill.type,
    hits,
  };
}

export function applySupportSkill(state, actorSide, actorIndex, skill, options = {}) {
  const next = structuredClone(state);
  const allies = next[actorSide];

  const sourceCharacterId = allies[actorIndex]?.activeCharacterId;
  const attackMode = ["aoe_attack", "multi_hit_attack"].includes(skill.type);
  if (["attack_buff", "damage_reduction", "guard", "attribute_guard", "aoe_attack", "multi_hit_attack"].includes(skill.type)) {
    const activationOrder = next.nextEffectOrder ?? 1;
    const targetAllies = skill.type === "multi_hit_attack"
      ? skill.target === "ally_all"
      : skill.type === "aoe_attack"
        ? (skill.conditions ?? []).some((condition) => condition.type === "ally_attribute")
        : false;
    const effectSkill = attackMode ? { ...skill, target: targetAllies ? "ally_all" : "self" } : skill;
    next.nextEffectOrder = activationOrder + 1;
    for (const index of supportTargetIndexes(allies, actorIndex, effectSkill, { applyConditions: false })) {
      allies[index] = addEffect(allies[index], skill.type, effectSkill, activationOrder, sourceCharacterId);
    }
  } else if (skill.type === "heal") {
    for (const index of supportTargetIndexes(allies, actorIndex, skill)) {
      const target = allies[index];
      target.currentHp = recoveredHp(
        target.currentHp,
        target.maxHp,
        target.maxHp * (Number(skill.multiplier) || 0),
      );
    }
  } else if (skill.type === "revive") {
    for (const index of supportTargetIndexes(allies, actorIndex, skill, { alive: false })) {
      const target = allies[index];
      target.alive = true;
      target.reviveUsed = true;
      target.currentHp = Math.min(target.maxHp * 2, Math.max(1, target.maxHp * skill.multiplier));
    }
  } else if (skill.type === "attribute_change") {
    const attributes = (skill.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
    if (attributes.length) {
      const activationOrder = next.nextEffectOrder ?? 1;
      next.nextEffectOrder = activationOrder + 1;
      for (const index of supportTargetIndexes(allies, actorIndex, skill)) {
        allies[index] = addEffect(allies[index], skill.type, skill, activationOrder, sourceCharacterId);
        allies[index].attributes = [...attributes];
      }
    }
  }
  if (options.consumeSkill) consumeSkillInPlace(next, actorSide, actorIndex);
  return next;
}

export function canUseSkill(state, actorSide, actorIndex) {
  const actor = state[actorSide]?.[actorIndex];
  const rawMaxUses = Number(actor?.character.maxUses);
  const maxUses = Number.isFinite(rawMaxUses) ? Math.min(2, Math.max(0, rawMaxUses)) : 2;
  const skill = actor?.character.skill;
  return Boolean(
    actor?.alive &&
    !actor.isGhost &&
    skill &&
    (attackTypes.has(skill.type) || supportTypes.has(skill.type)) &&
    !isExcludedSkill(skill) &&
    actor.skillUses < maxUses &&
    actor.skillCounter >= actor.character.skillTurn
  );
}

export function applyBasicAttack(state, actorSide, actorIndex, rules, options = {}) {
  const actor = state[actorSide]?.[actorIndex];
  if (!actor?.alive) return structuredClone(state);
  return resolveAttackAction(
    state,
    actorSide,
    actorIndex,
    rules,
    { type: "single_attack", multiplier: 1, hits: 1 },
    { ...options, consumeSkill: false },
  ).state;
}

export function applySkill(state, actorSide, actorIndex, rules, options = {}) {
  if (!canUseSkill(state, actorSide, actorIndex)) return structuredClone(state);
  const skill = state[actorSide][actorIndex].character.skill;
  if (attackTypes.has(skill.type)) {
    return resolveAttackAction(
      state,
      actorSide,
      actorIndex,
      rules,
      skill,
      { ...options, consumeSkill: true },
    ).state;
  }
  return applySupportSkill(state, actorSide, actorIndex, skill, { consumeSkill: true });
}

export function evaluateSkillImpact(state, actorSide, actorIndex, rules) {
  const before = evaluateBoard(state, actorSide);
  const afterState = applySkill(state, actorSide, actorIndex, rules);
  const after = evaluateBoard(afterState, actorSide);
  const skill = state[actorSide][actorIndex].character.skill;
  const futureMultiplier = rules.continuousEffectDiscounts
    .slice(0, Math.max(1, skill.duration))
    .reduce((sum, discount) => sum + discount, 0);
  const immediateDelta = after - before;
  return {
    value: immediateDelta + Math.max(0, immediateDelta) * Math.max(0, futureMultiplier - 1) * 0.35,
    immediateDelta,
    futureMultiplier,
    state: afterState,
  };
}

export function isAttackSkill(skill) {
  return attackTypes.has(skill?.type);
}
