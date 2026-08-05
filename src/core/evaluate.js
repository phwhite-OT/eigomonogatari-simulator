import { calculateMinimumDamage, resolveAttack } from "./damage.js";
import { createBattleState } from "./battleState.js";
import { isSkillTurnAllowedAtPosition, skillTurnRangeForPosition } from "./filter.js";
import { evaluateSkillImpact, isAttackSkill, isExcludedSkill } from "./skills.js";
import { scoreSimulationResult, simulateBattle } from "./simulate.js";

const synergyPairs = [
  ["setup", "single_attacker"],
  ["setup", "aoe_attacker"],
  ["aoe_attacker", "finisher"],
  ["skill_reduction", "late_game"],
  ["guard", "finisher"],
  ["attribute_guard", "late_game"],
  ["debuff", "multi_hit_attacker"],
  ["heal", "tank"],
];

const excludedRoleTagsBySkillType = {
  delay: new Set(["delay", "debuff"]),
  skill_reduction: new Set(["skill_reduction", "setup"]),
};

function effectiveRoleTags(character) {
  const excludedTags = excludedRoleTagsBySkillType[character.skill?.type];
  return excludedTags
    ? character.roleTags.filter((role) => !excludedTags.has(role))
    : character.roleTags;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

function quantile(sortedValues, ratio) {
  if (!sortedValues.length) return 1;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * ratio)));
  return sortedValues[index];
}

export function buildRepresentativeEnemies(candidates, rules) {
  const hpValues = candidates.map((character) => character.hp).sort((left, right) => left - right);
  const powValues = candidates.map((character) => character.pow).sort((left, right) => left - right);
  const fallbackAttribute = candidates[0]?.attributes?.[0] ?? "neutral";
  const profile = (key, name, ratio, danger) => ({
    id: `profile-${key}`,
    name,
    attributes: [fallbackAttribute],
    cost: 0,
    hp: quantile(hpValues, ratio),
    pow: quantile(powValues, ratio),
    rarity: "profile",
    region: "想定敵",
    roleTags: danger > 1 ? ["single_attacker"] : [],
    allowedPositions: [1, 2, 3, 4, 5],
    preferredPositions: [1],
    skillTurn: 2,
    maxUses: 2,
    skill: { type: "single_attack", multiplier: danger, duration: 1, hits: 1 },
  });

  return [
    { key: "worst", weight: rules.representativeEnemyWeights.worst, character: profile("worst", "高耐久・高火力想定", 0.85, 1.35) },
    { key: "standard", weight: rules.representativeEnemyWeights.standard, character: profile("standard", "標準想定", 0.5, 1.1) },
    { key: "favorable", weight: rules.representativeEnemyWeights.favorable, character: profile("favorable", "低耐久想定", 0.25, 1) },
  ];
}

export function positionFitness(character, position, rules) {
  if (!character.allowedPositions.includes(position) || !isSkillTurnAllowedAtPosition(character, position)) return 0;
  let score = character.preferredPositions.includes(position) ? 100 : 76;
  const expectedCharge = rules.position.expectedSkillChargeByPosition[position - 1] ?? position - 1;
  const wait = isExcludedSkill(character.skill) ? 0 : Math.max(0, character.skillTurn - expectedCharge);
  score -= wait * rules.position.lateSkillPenalty;
  if (character.positionRule === "early" && position >= 4) score -= 18;
  if (character.positionRule === "late" && position <= 2) score -= 18;
  return clamp(score);
}

function characterProfileMetrics(character, profile, rules, skillMultiplier = 1) {
  const attack = resolveAttack({ attacker: character, defender: profile.character, skillMultiplier, rules });
  const incoming = calculateMinimumDamage({
    attacker: profile.character,
    defender: character,
    skillMultiplier: profile.character.skill.multiplier,
    rules,
  });
  const attackRatio = profile.character.hp > 0 ? attack.value / profile.character.hp : 0;
  const survivalRatio = incoming.value > 0 ? character.hp / incoming.value : 2;
  return {
    key: profile.key,
    name: profile.character.name,
    weight: profile.weight,
    damage: attack.value,
    guaranteedDefeat: attack.guaranteedDefeat,
    remainingHp: attack.remainingHp,
    incomingDamage: incoming.value,
    guaranteedSurvive: character.hp > incoming.value,
    attackScore: clamp(attackRatio * 76),
    defenseScore: clamp(survivalRatio * 58),
  };
}

function weightedAverage(items, selector) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  return items.reduce((sum, item) => sum + selector(item) * item.weight, 0) / totalWeight;
}

function representativeCharacter(source, id, name, attributes) {
  return {
    ...source,
    id,
    name,
    attributes,
    maxUses: 2,
    skillTurn: 0,
    skill: { type: "none", multiplier: 1, duration: 1, hits: 1 },
    roleTags: [],
  };
}

function buildSkillImpactState(deck, position, profiles, rules) {
  const standard = profiles.find((profile) => profile.key === "standard")?.character ?? profiles[0].character;
  const teammateAttributes = [
    ["fire"],
    ["water"],
    ["wind"],
    ["fire", "water", "wind"],
  ];
  const teammateDecks = teammateAttributes.map((attributes, index) => [
    representativeCharacter(
      standard,
      `profile-teammate-${index + 1}`,
      `代表味方${index + 1}`,
      attributes,
    ),
  ]);
  const enemyDecks = Array.from({ length: 5 }, (_, index) => {
    const profile = profiles[index % profiles.length].character;
    return [representativeCharacter(
      profile,
      `profile-enemy-${index + 1}`,
      `代表敵${index + 1}`,
      profile.attributes,
    )];
  });
  const actorIndex = 1;
  const state = createBattleState(
    [teammateDecks[0], deck.slice(position), ...teammateDecks.slice(1)],
    enemyDecks,
  );
  const skill = state.allies[actorIndex].character.skill;
  if (skill.type === "heal") {
    for (const combatant of state.allies) combatant.currentHp = combatant.maxHp * 0.5;
  } else if (skill.type === "revive") {
    const targetIndexes = skill.target === "leader" ? [0] : [0, 2, 3, 4];
    for (const index of targetIndexes) {
      state.allies[index].alive = false;
      state.allies[index].currentHp = 0;
      state.allies[index].attributes = [];
    }
  }
  const expectedCharge = rules.position.expectedSkillChargeByPosition[position] ?? position;
  state.allies[actorIndex].skillCounter = expectedCharge;
  state.allies[actorIndex].naturalSkillCharge = expectedCharge;
  return { state, actorIndex };
}

function representativeDeck(source, prefix, name, attributes) {
  return Array.from({ length: 5 }, (_, index) => representativeCharacter(
    source,
    `${prefix}-${index + 1}`,
    `${name}${index + 1}`,
    attributes,
  ));
}

function buildSimulationState(deck, profiles, profile) {
  const standard = profiles.find((candidate) => candidate.key === "standard")?.character ?? profiles[0].character;
  const teammateAttributes = [
    ["fire"],
    ["water"],
    ["wind"],
    ["fire", "water", "wind"],
  ];
  const teammateDecks = teammateAttributes.map((attributes, index) => representativeDeck(
    standard,
    `simulation-teammate-${index + 1}`,
    `代表味方${index + 1}-`,
    attributes,
  ));
  const enemyAttributes = [
    profile.character.attributes,
    ["fire"],
    ["water"],
    ["wind"],
    ["fire", "water", "wind"],
  ];
  const enemyDecks = enemyAttributes.map((attributes, index) => representativeDeck(
    profile.character,
    `simulation-${profile.key}-enemy-${index + 1}`,
    `${profile.character.name}${index + 1}-`,
    attributes,
  ));
  return createBattleState(
    [teammateDecks[0], deck, ...teammateDecks.slice(1)],
    enemyDecks,
  );
}

function evaluateBattleSimulation(deck, profiles, rules) {
  const scenarios = [];
  let trace;
  for (const profile of profiles) {
    const result = simulateBattle(buildSimulationState(deck, profiles, profile), rules, {
      turns: rules.simulation?.turns ?? 8,
    });
    scenarios.push({
      profile: profile.key,
      weight: profile.weight,
      score: scoreSimulationResult(result),
      turnsCompleted: result.turnsCompleted,
      outcome: result.outcome,
      attackModel: result.attackModel,
      metrics: result.metrics,
    });
    if (profile.key === "standard") {
      trace = {
        profile: profile.key,
        profileName: profile.character.name,
        assumptions: result.assumptions,
        history: result.history,
      };
    }
  }
  return {
    score: weightedAverage(scenarios, (scenario) => scenario.score),
    scenarios,
    trace,
  };
}

function pairSynergy(left, right) {
  if (!left || !right) return 0;
  const leftRoles = effectiveRoleTags(left);
  const rightRoles = effectiveRoleTags(right);
  let score = 0;
  for (const [sourceRole, targetRole] of synergyPairs) {
    if (leftRoles.includes(sourceRole) && rightRoles.includes(targetRole)) score += 14;
  }
  if (left.skill?.type === "aoe_attack" && right.skill?.type === "aoe_attack") score += 6;
  if (left.attributes.some((attribute) => right.attributes.includes(attribute))) score += 2;
  return Math.min(28, score);
}

export function scoreDeckLight(deck, context) {
  const { constraints, rules, profiles } = context;
  const positionScores = deck.map((character, index) => positionFitness(character, index + 1, rules));
  const attackScores = deck.map((character) => {
    const multiplier = isAttackSkill(character.skill) ? Math.max(1, character.skill.multiplier) : 1;
    const metrics = profiles.map((profile) => characterProfileMetrics(character, profile, rules, multiplier));
    return weightedAverage(metrics, (metric) => metric.attackScore);
  });
  const defenseScores = deck.map((character) => {
    const metrics = profiles.map((profile) => characterProfileMetrics(character, profile, rules));
    return weightedAverage(metrics, (metric) => metric.defenseScore);
  });
  const synergy = deck.slice(0, -1).reduce((sum, character, index) => sum + pairSynergy(character, deck[index + 1]), 0);
  const roleCoverage = new Set(deck.flatMap(effectiveRoleTags)).size;
  const priorityBonus = deck.filter((character) => character.pvpTier === "priority").length * 1.5;
  const costUse = constraints.totalCost > 0
    ? deck.reduce((sum, character) => sum + character.cost, 0) / constraints.totalCost
    : 1;
  const score =
    positionScores.reduce((sum, value) => sum + value, 0) / deck.length * 0.3 +
    attackScores.reduce((sum, value) => sum + value, 0) / deck.length * 0.3 +
    defenseScores.reduce((sum, value) => sum + value, 0) / deck.length * 0.18 +
    clamp(45 + synergy + roleCoverage * 3) * 0.17 +
    clamp(costUse * 100 + priorityBonus) * 0.05;

  return rounded(clamp(score));
}

function slotReason(character, position, metrics, fitness, deck) {
  const reasons = [];
  const defeated = metrics.filter((metric) => metric.guaranteedDefeat).map((metric) => metric.name);
  const survived = metrics.filter((metric) => metric.guaranteedSurvive).map((metric) => metric.name);
  if (defeated.length) reasons.push(`最低保証ダメージで「${defeated.join("・")}」を確定撃破`);
  else reasons.push(`標準想定へ最低保証${Math.round(metrics.find((metric) => metric.key === "standard")?.damage ?? 0)}ダメージ`);
  if (survived.length) reasons.push(`「${survived.join("・")}」の代表攻撃を確定で耐える`);
  if (character.preferredPositions.includes(position)) reasons.push(`${position}枠目が推奨配置`);
  if (position > 1) {
    const [minimum, maximum] = skillTurnRangeForPosition(position);
    reasons.push(`スキルターン${character.skillTurn}が${position}枠目の許容範囲${minimum}〜${maximum}内`);
  }
  if (position > 1 && pairSynergy(deck[position - 2], character) > 0) reasons.push(`前枠の${deck[position - 2].name}と役割が接続`);
  if (fitness < 60) reasons.push(`スキルターンと${position}枠目の相性には注意`);
  return reasons;
}

export function evaluateDeckDetailed(deck, context) {
  const { constraints, rules, profiles } = context;
  const slotEvaluations = deck.map((character, index) => {
    const skillMultiplier = isAttackSkill(character.skill) ? Math.max(1, character.skill.multiplier) : 1;
    const profileMetrics = profiles.map((profile) => characterProfileMetrics(character, profile, rules, skillMultiplier));
    const positionScore = positionFitness(character, index + 1, rules);
    return {
      character,
      position: index + 1,
      positionScore,
      attackScore: weightedAverage(profileMetrics, (metric) => metric.attackScore),
      defenseScore: weightedAverage(profileMetrics, (metric) => metric.defenseScore),
      profileMetrics,
    };
  });

  const openerAttack = slotEvaluations[0].attackScore;
  const openerDefense = slotEvaluations[0].defenseScore;
  const opener = clamp(openerAttack * 0.62 + openerDefense * 0.28 + slotEvaluations[0].positionScore * 0.1);
  const attack = slotEvaluations.reduce((sum, slot) => sum + slot.attackScore, 0) / deck.length;
  const defense = slotEvaluations.reduce((sum, slot) => sum + slot.defenseScore, 0) / deck.length;
  const connectionParts = deck.slice(0, -1).map((character, index) => 52 + pairSynergy(character, deck[index + 1]));
  const readiness = slotEvaluations.reduce((sum, slot) => sum + slot.positionScore, 0) / deck.length;
  let skillConnection = clamp(
    (connectionParts.reduce((sum, value) => sum + value, 0) / Math.max(1, connectionParts.length)) * 0.55 + readiness * 0.45,
  );

  const skillImpacts = deck.map((_, index) => {
    const { state: battleState, actorIndex } = buildSkillImpactState(deck, index, profiles, rules);
    return evaluateSkillImpact(battleState, "allies", actorIndex, rules).value;
  });
  const positiveSkillImpact = skillImpacts.reduce((sum, value) => sum + Math.max(0, value), 0) / deck.length;
  skillConnection = clamp(skillConnection + positiveSkillImpact * 0.3);

  const lateSlots = slotEvaluations.slice(-2);
  const lateRoleBonus = lateSlots.reduce(
    (sum, slot) => sum + (slot.character.roleTags.some((role) => ["late_game", "finisher", "revive", "guard"].includes(role)) ? 12 : 0),
    0,
  );
  const lateGame = clamp(
    lateSlots.reduce((sum, slot) => sum + slot.attackScore * 0.4 + slot.defenseScore * 0.3 + slot.positionScore * 0.3, 0) /
      Math.max(1, lateSlots.length) +
      lateRoleBonus,
  );

  const profileScores = profiles.map((profile) => {
    const slots = slotEvaluations.map((slot) => slot.profileMetrics.find((metric) => metric.key === profile.key));
    return slots.reduce((sum, metric) => sum + metric.attackScore * 0.58 + metric.defenseScore * 0.42, 0) / slots.length;
  });
  const spread = Math.max(...profileScores) - Math.min(...profileScores);
  const stability = clamp(Math.min(...profileScores) + 30 - spread * 0.18);
  const simulationEvaluation = evaluateBattleSimulation(deck, profiles, rules);
  const simulation = simulationEvaluation.score;
  const metrics = { opener, attack, defense, skillConnection, lateGame, stability, simulation };
  const score = Object.entries(rules.scoreWeights).reduce(
    (sum, [key, weight]) => sum + (metrics[key] ?? 0) * weight,
    0,
  );
  const totalCost = deck.reduce((sum, character) => sum + character.cost, 0);
  const weaknesses = [];
  if (opener < 55) weaknesses.push("初手が高耐久想定を倒し切れない可能性があります。");
  if (defense < 55) weaknesses.push("代表的な高火力攻撃への耐久が低めです。");
  if (skillConnection < 58) weaknesses.push("前後キャラ間の役割接続が少なめです。");
  if (lateGame < 55) weaknesses.push("終盤枠のスキルが間に合わない可能性があります。");
  if (simulation < 50) weaknesses.push("対戦再現で残りキャラ数を有利にできない可能性があります。");
  if (!weaknesses.length) weaknesses.push("代表敵以外の属性相性と特殊スキルは別途確認してください。");

  return {
    deck,
    totalCost,
    score: rounded(clamp(score)),
    metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, rounded(value)])),
    slots: slotEvaluations.map((slot) => ({
      ...slot,
      reasons: slotReason(slot.character, slot.position, slot.profileMetrics, slot.positionScore, deck),
    })),
    weaknesses,
    skillImpacts: skillImpacts.map(rounded),
    simulationTrace: simulationEvaluation.trace,
    simulationScenarios: simulationEvaluation.scenarios.map((scenario) => ({
      ...scenario,
      score: rounded(scenario.score),
    })),
  };
}
