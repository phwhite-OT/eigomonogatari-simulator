import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) {
    throw new Error(`Expected snippet not found in ${path}: ${before.slice(0, 120)}`);
  }
  fs.writeFileSync(path, source.replace(before, after));
}

replaceOnce(
  'src/core/simulate.js',
`function effectApplies(effect, ownerAttributes, opponentAttributes) {
  return (effect.conditions ?? []).every((condition) => {
    const attributes = condition.type === "ally_attribute" ? ownerAttributes : opponentAttributes;
    return attributes.includes(condition.attribute);
  });
}`,
`function conditionGroupApplies(conditions, type, attributes) {
  const requiredAttributes = (conditions ?? [])
    .filter((condition) => condition.type === type && condition.attribute)
    .map((condition) => condition.attribute);
  return requiredAttributes.length === 0 || requiredAttributes.some((attribute) => (
    (attributes ?? []).includes(attribute)
  ));
}

function effectApplies(effect, ownerAttributes, opponentAttributes) {
  const conditions = effect.conditions ?? [];
  return conditionGroupApplies(conditions, "ally_attribute", ownerAttributes)
    && conditionGroupApplies(conditions, "enemy_attribute", opponentAttributes);
}`,
);

replaceOnce(
  'src/core/simulate.js',
`  const candidates = targetableIndexes(targets).map((index) => {
    const target = targets[index];`,
`  const candidates = targetableIndexes(targets)
    .filter((index) => conditionGroupApplies(skill.conditions ?? [], "enemy_attribute", targets[index].attributes))
    .map((index) => {
    const target = targets[index];`,
);

replaceOnce(
  'src/core/simulate.js',
`function skillScopeMatches(skill, combatant, actorIndex, targetIndex, attributes = combatant.attributes) {
  if (combatant.isGhost || combatant.reviveUsed) return false;
  if (skill.target === "self" && actorIndex !== targetIndex) return false;
  if (skill.target === "leader" && targetIndex !== 0) return false;
  return (skill.conditions ?? []).every((condition) => (
    condition.type !== "ally_attribute" ||
    (attributes ?? combatant.character?.attributes ?? []).includes(condition.attribute)
  ));
}`,
`function skillScopeMatches(skill, combatant, actorIndex, targetIndex, attributes = combatant.attributes) {
  if (combatant.isGhost || (skill.type === "revive" && combatant.reviveUsed)) return false;
  if (skill.target === "self" && actorIndex !== targetIndex) return false;
  if (skill.target === "leader" && targetIndex !== 0) return false;
  return conditionGroupApplies(
    skill.conditions ?? [],
    "ally_attribute",
    attributes ?? combatant.character?.attributes ?? [],
  );
}

function skillHasApplicableTargets(state, side, actorIndex, skill, attributeIntents = []) {
  const conditions = skill.conditions ?? [];
  const allyConditions = conditions.filter((condition) => condition.type === "ally_attribute");
  if (allyConditions.length) {
    const hasAllyTarget = state[side].some((target, targetIndex) => {
      if (!target?.alive || target.isGhost || (skill.type === "revive" && target.reviveUsed)) return false;
      if (skill.target === "self" && actorIndex !== targetIndex) return false;
      if (skill.target === "leader" && targetIndex !== 0) return false;
      const attributes = attributesAfterPlannedChanges(state, side, targetIndex, attributeIntents);
      return conditionGroupApplies(conditions, "ally_attribute", attributes);
    });
    if (!hasAllyTarget) return false;
  }

  const enemyConditions = conditions.filter((condition) => condition.type === "enemy_attribute");
  if (enemyConditions.length) {
    const hasEnemyTarget = state[opponentSide(side)].some((target) => (
      target?.alive &&
      !target.isGhost &&
      conditionGroupApplies(conditions, "enemy_attribute", target.attributes ?? target.character?.attributes ?? [])
    ));
    if (!hasEnemyTarget) return false;
  }
  return true;
}`,
);

replaceOnce(
  'src/core/simulate.js',
`function predictedIncomingMinimumDamage(state, side, targetIndex, rules, options = {}) {`,
`function predictedAttackPhaseState(state, defendingSide, rules, options = {}) {
  const plannedIntents = options.plannedIntents;
  if (!Array.isArray(plannedIntents)) return undefined;

  let preview = structuredClone(state);
  for (const skillTypes of [
    ["attribute_change"],
    ["heal"],
    ["attack_buff", "aoe_attack", "multi_hit_attack"],
    ["damage_reduction", "guard", "attribute_guard"],
  ]) {
    preview = applySupportPhase(preview, plannedIntents, skillTypes).state;
  }

  const enemySide = opponentSide(defendingSide);
  const scheduledAttacks = attackIntents(preview, plannedIntents, rules, {
    ...options,
    targetPolicy: options.targetPolicy ?? TARGET_POLICIES.EXPERT,
    attackOrderPolicy: options.attackOrderPolicy ?? ATTACK_ORDER_POLICIES.TACTICAL,
  }).filter((intent) => intent.side === enemySide);
  return resolveAttacks(preview, scheduledAttacks, rules, {
    ...options,
    targetPolicy: options.targetPolicy ?? TARGET_POLICIES.EXPERT,
    random: () => 0,
  }).state;
}

function predictedIncomingMinimumDamage(state, side, targetIndex, rules, options = {}) {`,
);

replaceOnce(
  'src/core/simulate.js',
`function reviveMayApply(state, side, actorIndex, skill, rules, options = {}) {
  const attributeIntents = options.plannedAttributeIntents ?? [];
  return state[side].some((target, targetIndex) => {
    const attributes = attributesAfterPlannedChanges(state, side, targetIndex, attributeIntents);
    if (!target.alive || !skillScopeMatches(skill, target, actorIndex, targetIndex, attributes)) return false;
    return predictedIncomingMinimumDamage(state, side, targetIndex, rules, options) >= target.currentHp;
  });
}

function actorWillBeRevivedThisTurn(state, side, actorIndex, rules, options = {}) {
  const target = state[side][actorIndex];
  if (!target?.alive || target.isGhost || target.reviveUsed) return false;
  if (predictedIncomingMinimumDamage(state, side, actorIndex, rules, options) < target.currentHp) return false;
  const attributes = attributesAfterPlannedChanges(
    state,
    side,
    actorIndex,
    options.plannedAttributeIntents ?? [],
  );
  return state[side].some((reviver, reviverIndex) => (
    canUseSkill(state, side, reviverIndex) &&
    reviver.character.skill?.type === "revive" &&
    skillScopeMatches(reviver.character.skill, target, reviverIndex, actorIndex, attributes)
  ));
}`,
`function reviveMayApply(state, side, actorIndex, skill, rules, options = {}) {
  const attributeIntents = options.plannedAttributeIntents ?? [];
  const predicted = predictedAttackPhaseState(state, side, rules, options);
  return state[side].some((target, targetIndex) => {
    const attributes = attributesAfterPlannedChanges(state, side, targetIndex, attributeIntents);
    if (!target.alive || !skillScopeMatches(skill, target, actorIndex, targetIndex, attributes)) return false;
    if (predicted) return predicted[side]?.[targetIndex]?.alive === false;
    return predictedIncomingMinimumDamage(state, side, targetIndex, rules, options) >= target.currentHp;
  });
}

function actorWillBeRevivedThisTurn(state, side, actorIndex, rules, options = {}) {
  const target = state[side][actorIndex];
  if (!target?.alive || target.isGhost || target.reviveUsed) return false;
  const predicted = predictedAttackPhaseState(state, side, rules, options);
  const predictedDefeat = predicted
    ? predicted[side]?.[actorIndex]?.alive === false
    : predictedIncomingMinimumDamage(state, side, actorIndex, rules, options) >= target.currentHp;
  if (!predictedDefeat) return false;
  const attributes = attributesAfterPlannedChanges(
    state,
    side,
    actorIndex,
    options.plannedAttributeIntents ?? [],
  );
  return state[side].some((reviver, reviverIndex) => (
    canUseSkill(state, side, reviverIndex) &&
    reviver.character.skill?.type === "revive" &&
    skillScopeMatches(reviver.character.skill, target, reviverIndex, actorIndex, attributes)
  ));
}`,
);

replaceOnce(
  'src/core/simulate.js',
`  if (skill.type === "delay" || skill.type === "skill_reduction") {
    return { use: false, reason: "今回の評価では短縮・遅延効果を使用しない" };
  }
  if (options.playStyle === PLAY_STYLES.EXPERT) {`,
`  if (skill.type === "delay" || skill.type === "skill_reduction") {
    return { use: false, reason: "今回の評価では短縮・遅延効果を使用しない" };
  }
  if (!skillHasApplicableTargets(
    state,
    side,
    actorIndex,
    skill,
    options.plannedAttributeIntents ?? [],
  )) {
    return { use: false, reason: "現在の盤面にスキル条件を満たす対象がいないため温存" };
  }
  if (options.playStyle === PLAY_STYLES.EXPERT) {`,
);

replaceOnce(
  'src/core/simulate.js',
`  return {
    type: aoe ? "aoe_attack" : hits > 1 ? "multi_hit_attack" : "single_attack",
    multiplier: Number(baseSkill.multiplier) || 1,
    hits,
  };`,
`  return {
    type: aoe ? "aoe_attack" : hits > 1 ? "multi_hit_attack" : "single_attack",
    multiplier: Number(baseSkill.multiplier) || 1,
    hits,
    conditions: structuredClone(baseSkill.conditions ?? []),
  };`,
);

replaceOnce(
  'src/core/simulate.js',
`function expertSkillDecision(state, side, actorIndex, rules, options = {}) {
  const actor = state[side][actorIndex];
  const skill = actor.character.skill;
  if (skill.type === "revive") {`,
`function expertSkillDecision(state, side, actorIndex, rules, options = {}) {
  const actor = state[side][actorIndex];
  const skill = actor.character.skill;
  if (!skillHasApplicableTargets(
    state,
    side,
    actorIndex,
    skill,
    options.plannedAttributeIntents ?? [],
  )) {
    return { use: false, reason: "現在の盤面にスキル条件を満たす対象がいないため温存" };
  }
  if (skill.type === "revive") {`,
);

replaceOnce(
  'src/core/simulate.js',
`function chooseSkills(state, rules, options) {
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
      const use = reviveMayApply(state, intent.side, intent.actorIndex, intent.skill, rules, { ...options, plannedAttributeIntents: attributeIntents });
      intent.use = use;
      intent.reason = use
        ? "このターンの属性変更後に蘇生対象となる撃破予測があるため使用"
        : "このターンの属性変更後に蘇生対象となる撃破予測がないため温存";
    } else if (intent.skill.type === "heal") {
      const decision = options.playStyle === PLAY_STYLES.EXPERT
        ? expertSkillDecision(state, intent.side, intent.actorIndex, rules, {
          ...options,
          plannedAttributeIntents: attributeIntents,
        })
        : healDecision(state, intent.side, intent.actorIndex, intent.skill, rules, {
          plannedAttributeIntents: attributeIntents,
        });
      intent.use = Boolean(decision.use);
      intent.reason = decision.reason;
    }
  }
  const events = candidates.map((intent) => ({
    type: intent.use ? "skill_use" : "skill_hold",
    side: intent.side,
    actorIndex: intent.actorIndex,
    actorId: intent.actorId,
    actorName: intent.actorName,
    skillType: intent.skill.type,
    reason: intent.reason,
  }));
  const intents = candidates.filter((intent) => intent.use);
  return { intents, events };
}`,
`function chooseSkills(state, rules, options) {
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

  let attributeIntents = candidates.filter(({ use, skill }) => use && skill.type === "attribute_change");
  for (const intent of candidates) {
    if (!intent.use) continue;
    if (!skillHasApplicableTargets(state, intent.side, intent.actorIndex, intent.skill, attributeIntents)) {
      intent.use = false;
      intent.reason = "このターンの属性変更後もスキル条件を満たす対象がいないため温存";
    }
  }
  attributeIntents = candidates.filter(({ use, skill }) => use && skill.type === "attribute_change");

  const plannedNonRecoveryIntents = candidates.filter(({ use, skill }) => (
    use && skill.type !== "heal" && skill.type !== "revive"
  ));
  for (const intent of candidates.filter(({ skill }) => skill.type === "heal")) {
    const decision = options.playStyle === PLAY_STYLES.EXPERT
      ? expertSkillDecision(state, intent.side, intent.actorIndex, rules, {
        ...options,
        plannedAttributeIntents: attributeIntents,
        plannedIntents: plannedNonRecoveryIntents,
      })
      : healDecision(state, intent.side, intent.actorIndex, intent.skill, rules, {
        ...options,
        plannedAttributeIntents: attributeIntents,
        plannedIntents: plannedNonRecoveryIntents,
      });
    intent.use = Boolean(decision.use);
    intent.reason = decision.reason;
  }

  const plannedForRevive = candidates.filter(({ use, skill }) => use && skill.type !== "revive");
  for (const intent of candidates.filter(({ skill }) => skill.type === "revive")) {
    const use = reviveMayApply(state, intent.side, intent.actorIndex, intent.skill, rules, {
      ...options,
      plannedAttributeIntents: attributeIntents,
      plannedIntents: plannedForRevive,
    });
    intent.use = use;
    intent.reason = use
      ? "このターンの支援・攻撃フェーズを予行すると蘇生対象が倒れるため使用"
      : "このターンの支援・攻撃フェーズを予行しても蘇生対象が倒れないため温存";
  }

  const events = candidates.map((intent) => ({
    type: intent.use ? "skill_use" : "skill_hold",
    side: intent.side,
    actorIndex: intent.actorIndex,
    actorId: intent.actorId,
    actorName: intent.actorName,
    skillType: intent.skill.type,
    reason: intent.reason,
  }));
  const intents = candidates.filter((intent) => intent.use);
  return { intents, events };
}`,
);

replaceOnce(
  'src/core/skills.js',
`function effectApplies(effect, ownerAttributes, opponentAttributes) {
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
}`,
`function conditionGroupApplies(conditions, type, attributes) {
  const requiredAttributes = (conditions ?? [])
    .filter((condition) => condition.type === type && condition.attribute)
    .map((condition) => condition.attribute);
  return requiredAttributes.length === 0 || requiredAttributes.some((attribute) => (
    (attributes ?? []).includes(attribute)
  ));
}

function effectApplies(effect, ownerAttributes, opponentAttributes) {
  const conditions = effect.conditions ?? [];
  return conditionGroupApplies(conditions, "ally_attribute", ownerAttributes)
    && conditionGroupApplies(conditions, "enemy_attribute", opponentAttributes);
}

function supportConditionApplies(skill, target) {
  // 属性条件は、戦闘中の現在属性で判定する。死亡直後も色変更の効果は
  // 蘇生フェーズまで残るため、ここで元のキャラクター属性へ戻してはいけない。
  const targetAttributes = target.attributes ?? target.character?.attributes ?? [];
  return conditionGroupApplies(skill.conditions ?? [], "ally_attribute", targetAttributes);
}

function attackSkillConditionApplies(skill, actor, target) {
  const conditions = skill.conditions ?? [];
  return conditionGroupApplies(conditions, "ally_attribute", actor.attributes ?? actor.character?.attributes ?? [])
    && conditionGroupApplies(conditions, "enemy_attribute", target.attributes ?? target.character?.attributes ?? []);
}`,
);

replaceOnce(
  'src/core/skills.js',
`  const livingTargets = () => targetableIndexes(next[targetSide]);`,
`  const livingTargets = () => targetableIndexes(next[targetSide]).filter((index) => (
    attackSkillConditionApplies(skill, actor, next[targetSide][index])
  ));`,
);

replaceOnce(
  'scripts/convert_workbook.py',
`def skill_conditions(text):
    conditions = []
    ally_attributes = re.findall(r"([火水風])属性の味方", text or "")
    enemy_attributes = re.findall(r"([火水風])属性の(?:敵|攻撃)", text or "")
    for japanese in dict.fromkeys(ally_attributes):
        conditions.append({"type": "ally_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    for japanese in dict.fromkeys(enemy_attributes):
        conditions.append({"type": "enemy_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    return conditions`,
`def skill_conditions(text):
    text = text or ""
    conditions = []
    ally_attributes = []
    enemy_attributes = []
    for pattern in (
        r"([火水風])属性の味方",
        r"([火水風])の味方",
        r"味方の([火水風])属性",
    ):
        ally_attributes.extend(re.findall(pattern, text))
    for pattern in (
        r"([火水風])属性の(?:敵|攻撃)",
        r"([火水風])の(?:敵|攻撃)",
        r"(?:敵|攻撃)の([火水風])属性",
    ):
        enemy_attributes.extend(re.findall(pattern, text))
    for japanese in dict.fromkeys(ally_attributes):
        conditions.append({"type": "ally_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    for japanese in dict.fromkeys(enemy_attributes):
        conditions.append({"type": "enemy_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    return conditions`,
);

const regressionTest = `import test from "node:test";
import assert from "node:assert/strict";
import { createBattleState } from "../src/core/battleState.js";
import { applySkill } from "../src/core/skills.js";
import { PLAY_STYLES, simulateBattle } from "../src/core/simulate.js";
import { DEFAULT_RULES, mergeRules } from "../src/data/rules.js";

function character(name, { pow = 100, hp = 1000, attributes = ["fire"], skill, environmentPosition } = {}) {
  return {
    id: name,
    name,
    pow,
    hp,
    attributes,
    roleTags: [],
    skillTurn: 0,
    maxUses: 2,
    environmentPosition,
    skill: skill ?? { type: "single_attack", multiplier: 1, duration: 1, hits: 1 },
  };
}

const simpleRules = mergeRules(DEFAULT_RULES, {
  damage: {
    selfMultiplier: 1,
    excellentMultiplier: 1,
    questionLevelMultiplier: 1,
    randomMinimum: 1,
    pvpMultiplier: 1,
    rounding: "floor",
    attributeMultipliers: Object.fromEntries(
      ["fire", "water", "wind"].flatMap((attack) =>
        ["fire", "water", "wind"].map((defense) => [\`${attack}:${defense}\`, 1]),
      ),
    ),
  },
  simulation: { turns: 1, ghostPower: 1000 },
});

function selectionEvent(result, side, actorName) {
  return result.history[0].phases
    .find((phase) => phase.id === "skill_selection")
    .events.find((event) => event.side === side && event.actorName === actorName);
}

test("対象属性が盤面にいない直接攻撃スキルは使用しない", () => {
  const conditionalAttack = {
    type: "single_attack",
    multiplier: 2,
    hits: 1,
    duration: 1,
    conditions: [{ type: "enemy_attribute", attribute: "wind" }],
  };
  const state = createBattleState(
    [character("conditional-attacker", { skill: conditionalAttack })],
    [character("fire-target", { attributes: ["fire"] })],
  );
  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: PLAY_STYLES.EXPERT });

  const event = selectionEvent(result, "allies", "conditional-attacker");
  assert.equal(event.type, "skill_hold");
  assert.match(event.reason, /条件を満たす対象がいない/);
  assert.equal(result.history[0].actions[0].hits[0].damage, 100);
});

test("複数の対象属性条件は同種条件内ではORとして扱う", () => {
  const buff = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "ally_all",
    conditions: [
      { type: "ally_attribute", attribute: "fire" },
      { type: "ally_attribute", attribute: "water" },
    ],
  };
  const state = createBattleState(
    [
      character("supporter", { skill: buff, attributes: ["wind"] }),
      character("fire-ally", { attributes: ["fire"] }),
      character("water-ally", { attributes: ["water"] }),
      character("wind-ally", { attributes: ["wind"] }),
    ],
    [character("enemy")],
  );
  const next = applySkill(state, "allies", 0, simpleRules);

  assert.deepEqual(next.allies.map((combatant) => combatant.buffs.length), [0, 1, 1, 0]);
});

test("同ターンの攻撃バフ込みで最終ストックの死亡を予測して蘇生を使う", () => {
  const revive = {
    type: "revive",
    multiplier: 1,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const attackBuff = {
    type: "attack_buff",
    multiplier: 2,
    duration: 1,
    target: "ally_all",
    conditions: [],
  };
  const state = createBattleState(
    [
      character("final-stock", { hp: 150 }),
      character("reviver", { hp: 1000, skill: revive }),
    ],
    [
      character("buffer", { pow: 0, skill: attackBuff }),
      character("attacker", { pow: 100 }),
    ],
  );

  const result = simulateBattle(state, simpleRules, { turns: 1, playStyle: PLAY_STYLES.EXPERT });
  const reviveEvent = selectionEvent(result, "allies", "reviver");

  assert.equal(reviveEvent.type, "skill_use");
  assert.match(reviveEvent.reason, /予行/);
  assert.equal(result.state.allies[0].alive, true);
  assert.equal(result.state.allies[0].reviveUsed, true);
});
`;
fs.writeFileSync('test/skill-use-revive-regression.test.js', regressionTest);

fs.rmSync('scripts/apply-skill-revive-fix.mjs', { force: true });
fs.rmSync('.github/workflows/apply-skill-revive-fix.yml', { force: true });
