import { resolveAttributeMultiplier } from "./damage.js";
import { DEFAULT_RULES } from "../data/rules.js";

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function attributes(character) {
  return Array.isArray(character?.attributes) ? character.attributes : [];
}

function skill(character) {
  return character?.skill ?? { type: "none" };
}

function conditionsKey(value) {
  return (value ?? []).map((condition) => condition.type + ":" + (condition.attribute ?? "")).sort().join("|");
}

function effectsKey(value) {
  return (value ?? []).map((effect) => (effect.attribute ?? "") + ":" + (effect.type ?? "")).sort().join("|");
}

function profileKey(character) {
  const value = skill(character);
  return [value.type ?? "none", value.target ?? "self"].join("/");
}

function matchesStage(character, stage, options) {
  const allowedAttributes = stage.allowedAttributes ?? [];
  const rarities = stage.rarities ?? [];
  const candidateIds = new Set((stage.candidateIds ?? []).map(String));
  return (
    (!allowedAttributes.length || attributes(character).some((attribute) => allowedAttributes.includes(attribute))) &&
    (!rarities.length || rarities.includes(character.rarity)) &&
    (!options.ownedOnly || character.owned !== false) &&
    (!candidateIds.size || candidateIds.has(String(character.id))) &&
    number(character.cost) <= number(stage.maxCost, Infinity)
  );
}

function eventMultiplier(character, stage, options) {
  return new Set((stage.eventBonusIds ?? []).map(String)).has(String(character.id))
    ? number(options.eventBonusMultiplier, 1.5)
    : 1;
}

function enemies(stage) {
  return Array.isArray(stage.enemies) && stage.enemies.length
    ? stage.enemies
    : [{ attributes: [], hp: 1, pow: 0 }];
}

function averageDamage(character, stage, options) {
  const power = number(character.pow) * eventMultiplier(character, stage, options);
  const attributeMultiplier = enemies(stage).reduce((sum, enemy) => (
    sum + resolveAttributeMultiplier(attributes(character), attributes(enemy), DEFAULT_RULES)
  ), 0) / enemies(stage).length;
  return power * number(options.answerMultiplier, 1) * attributeMultiplier;
}

function enemyThreat(character, stage) {
  return Math.max(1, ...enemies(stage).map((enemy) => (
    number(enemy.pow) * resolveAttributeMultiplier(attributes(enemy), attributes(character), DEFAULT_RULES)
  )));
}

function enemyConditionCoverage(value, stage) {
  const conditions = (value.conditions ?? []).filter((condition) => condition.type === "enemy_attribute");
  if (!conditions.length) return 1;
  return enemies(stage).filter((enemy) => conditions.every((condition) => (
    attributes(enemy).includes(condition.attribute)
  ))).length / enemies(stage).length;
}

function skillImpact(character, stage, options, damage) {
  const value = skill(character);
  const multiplier = Math.max(0, number(value.multiplier, 1));
  const hits = Math.max(1, number(value.hits, 1));
  const targets = Math.max(1, number(value.targetCount, value.target === "ally_all" ? 5 : 1));
  const duration = Math.max(1, number(value.duration, 1));
  const readiness = 1 / (Math.max(0, number(character.skillTurn, 99)) + 1);
  const hp = number(character.hp) * eventMultiplier(character, stage, options);
  let impact = 0;
  if (value.type === "attack_buff") impact = damage * Math.max(0, multiplier - 1) * targets * duration;
  if (value.type === "aoe_attack") impact = damage * Math.max(1, Math.min(3, enemies(stage).length)) * duration;
  if (value.type === "multi_hit_attack") impact = damage * Math.max(0, hits - 1) * duration;
  if (["damage_reduction", "guard", "attribute_guard"].includes(value.type)) {
    impact = hp * Math.max(0, 1 - multiplier) * duration + enemyThreat(character, stage);
  }
  if (value.type === "heal") impact = hp * multiplier * targets * duration;
  if (value.type === "revive") impact = hp * Math.max(1, multiplier) * targets;
  if (value.type === "attribute_change") {
    const changedAttributes = (value.effects ?? []).flatMap((effect) => effect.attribute ? [effect.attribute] : []);
    const bestMultiplier = changedAttributes.length
      ? Math.max(...enemies(stage).map((enemy) => resolveAttributeMultiplier(changedAttributes, attributes(enemy), DEFAULT_RULES)))
      : 1;
    impact = damage * Math.max(0, bestMultiplier - 1) * targets * duration;
  }
  if (value.type === "skill_reduction") impact = damage * Math.max(0, number(value.amount)) * targets * 0.75;
  if (value.type === "delay") impact = enemyThreat(character, stage) * Math.max(0, number(value.amount)) * targets;
  return impact * readiness * enemyConditionCoverage(value, stage);
}

function metrics(character, stage, options) {
  return {
    character,
    id: String(character.id),
    profileKey: profileKey(character),
    cost: Math.max(0, number(character.cost)),
    damage: averageDamage(character, stage, options),
    survival: number(character.hp) * eventMultiplier(character, stage, options) / enemyThreat(character, stage),
    skillImpact: skillImpact(character, stage, options, averageDamage(character, stage, options)),
    skillTurn: Math.max(0, number(character.skillTurn, 99)),
  };
}

function dominates(left, right) {
  return left.profileKey === right.profileKey &&
    left.cost <= right.cost &&
    left.damage >= right.damage &&
    left.survival >= right.survival &&
    left.skillImpact >= right.skillImpact &&
    left.skillTurn <= right.skillTurn &&
    (left.cost < right.cost || left.damage > right.damage || left.survival > right.survival ||
      left.skillImpact > right.skillImpact || left.skillTurn < right.skillTurn);
}

function referenceIds(stage) {
  return new Set((stage.referenceDecks ?? []).flat().map((character) => String(character?.id ?? character)).filter(Boolean));
}

function referenceCoreIds(scored, references) {
  const ids = new Set();
  for (const reference of scored.filter((entry) => references.has(entry.id))) {
    const alternatives = scored.filter((entry) => (
      entry.profileKey === reference.profileKey && entry.cost <= reference.cost
    ));
    alternatives.filter((entry) => (
      !alternatives.some((other) => dominates(other, entry))
    )).forEach((entry) => ids.add(entry.id));
    ids.add(reference.id);
  }
  return ids;
}

export function buildLightestGuidedCandidatePool(characters, stage, searchOptions = {}) {
  const options = { candidateGuidance: "all", ...searchOptions };
  const manualCandidates = (stage.candidateIds ?? []).length > 0;
  if (options.candidateGuidance !== "stage" || manualCandidates) {
    return {
      characters,
      applied: false,
      mode: manualCandidates ? "manual" : "all",
      sourceCandidateCount: characters.length,
      candidateCount: characters.length,
      referenceDeckCount: (stage.referenceDecks ?? []).length,
      excludedDominatedCount: 0,
    };
  }
  const available = characters.filter((character) => matchesStage(character, stage, options));
  const references = referenceIds(stage);
  const scored = available.map((character) => metrics(character, stage, options));
  const stageIds = new Set(scored
    .filter((entry) => references.has(entry.id) || !scored.some((other) => dominates(other, entry)))
    .map((entry) => entry.id));
  const referenceCore = Boolean(options.referenceDeckCore && references.size);
  const keptIds = referenceCore ? referenceCoreIds(scored, references) : stageIds;
  const guided = available.filter((character) => keptIds.has(String(character.id)));
  return {
    characters: guided,
    applied: guided.length < available.length,
    mode: referenceCore ? "reference" : "stage",
    sourceCandidateCount: available.length,
    stageCandidateCount: stageIds.size,
    candidateCount: guided.length,
    referenceDeckCount: (stage.referenceDecks ?? []).length,
    referenceCharacterCount: guided.filter((character) => references.has(String(character.id))).length,
    excludedDominatedCount: Math.max(0, available.length - guided.length),
  };
}
