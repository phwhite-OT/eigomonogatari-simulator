import fs from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(import.meta.dirname, "../src/core/simulate.js");
let source = await fs.readFile(filePath, "utf8");

function replaceFunction(name, nextName, replacement) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

replaceFunction(
  "projectedTeamAttackOutcome",
  "totalCurrentHp",
  `const projectedTeamAttackOutcomeCache = new WeakMap();

function projectedTeamAttackOutcome(state, attackingSide, rules, options = {}) {
  const cacheKey = \`${"${attackingSide}"}:\${options.targetPolicy ?? TARGET_POLICIES.EXPERT}\`;
  let cache = projectedTeamAttackOutcomeCache.get(state);
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const intents = attackIntents(state, [], rules, {
    ...options,
    playStyle: PLAY_STYLES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
  }).filter((intent) => intent.side === attackingSide);
  const resolved = resolveAttacks(state, intents, rules, {
    ...options,
    targetPolicy: options.targetPolicy ?? TARGET_POLICIES.EXPERT,
    random: () => 0,
  });
  const outcome = summarizeAttackActions(resolved.actions);
  if (!cache) {
    cache = new Map();
    projectedTeamAttackOutcomeCache.set(state, cache);
  }
  cache.set(cacheKey, outcome);
  return outcome;
}
`,
);

replaceFunction(
  "expertSupportBenefit",
  "healDecision",
  `function expertSupportBenefit(state, side, actorIndex, skill, rules, options = {}) {
  const after = applySupportSkill(state, side, actorIndex, skill, { consumeSkill: false });
  const attackRelevant = ATTACK_MODE_TYPES.has(skill.type) || skill.type === "attack_buff" || skill.type === "attribute_change";
  const defenseRelevant = DEFENSE_SKILL_TYPES.has(skill.type) || skill.type === "attribute_change";
  let outgoingDefeatGain = 0;
  let outgoingEffectiveDamageGain = 0;
  let preventedDefeats = 0;
  let preventedDamage = 0;
  if (attackRelevant) {
    const before = projectedTeamAttackOutcome(state, side, rules, options);
    const improved = projectedTeamAttackOutcome(after, side, rules, options);
    outgoingDefeatGain = improved.defeats - before.defeats;
    outgoingEffectiveDamageGain = improved.effectiveDamage - before.effectiveDamage;
  }
  if (defenseRelevant) {
    const before = projectedTeamAttackOutcome(state, opponentSide(side), rules, options);
    const improved = projectedTeamAttackOutcome(after, opponentSide(side), rules, options);
    preventedDefeats = before.defeats - improved.defeats;
    preventedDamage = before.effectiveDamage - improved.effectiveDamage;
  }
  const healingGain = totalCurrentHp(after, side) - totalCurrentHp(state, side);
  return {
    after,
    outgoingDefeatGain,
    outgoingEffectiveDamageGain,
    preventedDefeats,
    preventedDamage,
    healingGain,
  };
}
`,
);

await fs.writeFile(filePath, source, "utf8");
console.log("cached V12.3 tactical projections");
