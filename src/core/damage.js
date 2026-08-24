function resolvePairMultiplier(attackAttribute, defenseAttribute, rules) {
  return Number(rules.damage.attributeMultipliers?.[`${attackAttribute}:${defenseAttribute}`] ?? 1);
}

export function resolveAttributeMultiplier(attackerAttributes, defenderAttributes, rules) {
  return resolveAttributeMultiplierDetails(attackerAttributes, defenderAttributes, rules).multiplier;
}

export function resolveAttributeMultiplierDetails(attackerAttributes, defenderAttributes, rules) {
  const attacks = attackerAttributes?.length ? attackerAttributes : ["neutral"];
  const defenses = defenderAttributes?.length ? defenderAttributes : ["neutral"];
  const pairs = attacks.flatMap((attack) =>
    defenses.map((defense) => ({
      attack,
      defense,
      multiplier: resolvePairMultiplier(attack, defense, rules),
    })),
  );
  const multipliers = pairs.map((pair) => pair.multiplier);

  let multiplier;
  if (rules.damage.attributeResolution === "best") multiplier = Math.max(...multipliers);
  else if (rules.damage.attributeResolution === "worst") multiplier = Math.min(...multipliers);
  else if (rules.damage.attributeResolution === "average") {
    multiplier = multipliers.reduce((sum, entry) => sum + entry, 0) / multipliers.length;
  } else {
    multiplier = multipliers[0] ?? 1;
  }
  return {
    attacks: [...attacks],
    defenses: [...defenses],
    pairs,
    resolution: rules.damage.attributeResolution,
    multiplier,
  };
}

function normalizeMultiplier(value, fallback = 1) {
  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : fallback;
}

function resolveEventMultiplier(attacker, rules) {
  if (Number.isFinite(Number(attacker.eventMultiplier))) return Number(attacker.eventMultiplier);
  return attacker.eventBonus ? rules.damage.eventBonusMultiplier : 1;
}

export function resolveAttackBuffMultiplier(effects = []) {
  return effects.reduce(
    (product, effect) => product * normalizeMultiplier(effect?.multiplier ?? effect),
    1,
  );
}

export function resolveDefenseMultiplier(effects = []) {
  const cutRates = effects
    .map((effect) => 1 - Math.min(1, normalizeMultiplier(effect?.multiplier ?? effect)))
    .sort((left, right) => right - left);

  return cutRates.reduce((remaining, cutRate, index) => {
    const effectiveness = 3 / (2 * index + 3);
    return remaining * (1 - cutRate * effectiveness);
  }, 1);
}

export function applyRounding(value, rounding) {
  const nearestInteger = Math.round(value);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  const stableValue = Math.abs(value - nearestInteger) <= tolerance ? nearestInteger : value;
  if (rounding === "floor") return Math.floor(stableValue);
  if (rounding === "round") return Math.round(stableValue);
  if (rounding === "ceil") return Math.ceil(stableValue);
  return stableValue;
}

export function calculateMinimumDamage({
  attacker,
  defender,
  skillMultiplier = 1,
  attackMultiplier = 1,
  defenseMultiplier = 1,
  randomMultiplier,
  rules,
}) {
  const attribute = resolveAttributeMultiplierDetails(
    attacker.attributes,
    defender.attributes,
    rules,
  );
  const attributeMultiplier = attribute.multiplier;
  const factors = {
    pow: Number(attacker.pow) || 0,
    skill: Number(skillMultiplier) || 0,
    attack: Number(attackMultiplier) || 0,
    self: rules.damage.selfMultiplier,
    excellent: rules.damage.excellentMultiplier,
    questionLevel: rules.damage.questionLevelMultiplier,
    attribute: attributeMultiplier,
    event: resolveEventMultiplier(attacker, rules),
    special: rules.damage.specialAttackMultiplier,
    random: Number.isFinite(Number(randomMultiplier))
        ? Math.min(1, Math.max(Number(rules.damage.randomMinimum) || 0, Number(randomMultiplier)))
        : rules.damage.randomMinimum,
    pvp: rules.damage.pvpMultiplier,
    survival: rules.damage.survivalBaseMultiplier ** Math.max(0, Number(attacker.survivalTurns) || 0),
    defense: Number(defenseMultiplier) || 0,
  };
  const raw = Object.values(factors).reduce((product, factor) => product * factor, 1);
  return {
    value: applyRounding(raw, rules.damage.rounding),
    raw,
    factors,
    attribute,
  };
}

export function resolveAttack(params) {
  const damage = calculateMinimumDamage(params);
  const currentHp = Math.max(0, Number(params.defender.currentHp ?? params.defender.hp) || 0);
  const remainingHp = Math.max(0, currentHp - damage.value);
  return {
    ...damage,
    currentHp,
    remainingHp,
    guaranteedDefeat: damage.value >= currentHp,
    overkill: Math.max(0, damage.value - currentHp),
  };
}
