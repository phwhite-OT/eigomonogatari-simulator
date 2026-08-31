import fs from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(import.meta.dirname, "../src/core/simulate.js");
let source = await fs.readFile(filePath, "utf8");
const start = source.indexOf("function projectedTeamAttackOutcome(state, attackingSide, rules, options = {}) {");
const end = source.indexOf("\nfunction healDecision(", start);
if (start < 0 || end < 0) throw new Error("Strategic support projection block was not found");

const replacement = `const projectedTeamAttackOutcomeCache = new WeakMap();

function projectedTeamAttackOutcome(state, attackingSide, rules, options = {}) {
  const cacheKey = \`${"${attackingSide}"}:\${options.targetPolicy ?? TARGET_POLICIES.EXPERT}:\${options.attackOrderPolicy ?? ATTACK_ORDER_POLICIES.TACTICAL}\`;
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
  const hits = resolved.actions.flatMap((action) => action.hits ?? []);
  const outcome = {
    defeats: hits.filter((hit) => hit.defeated).length,
    effectiveDamage: hits.reduce((sum, hit) => sum + Math.min(hit.damage, hit.hpBefore), 0),
    overkill: hits.reduce((sum, hit) => sum + Math.max(0, hit.damage - hit.hpBefore), 0),
    state: resolved.state,
  };
  if (!cache) {
    cache = new Map();
    projectedTeamAttackOutcomeCache.set(state, cache);
  }
  cache.set(cacheKey, outcome);
  return outcome;
}

function expertSupportBenefit(state, side, actorIndex, skill, rules, options = {}) {
  const after = applySupportSkill(state, side, actorIndex, skill, { consumeSkill: false });
  const attackRelevant = ATTACK_MODE_TYPES.has(skill.type) || skill.type === "attack_buff" || skill.type === "attribute_change";
  const defenseRelevant = DEFENSE_SKILL_TYPES.has(skill.type) || skill.type === "attribute_change";
  let outgoingDefeatGain = 0;
  let outgoingGain = 0;
  let preventedDefeats = 0;
  let preventedDamage = 0;
  if (attackRelevant) {
    const before = projectedTeamAttackOutcome(state, side, rules, options);
    const afterOutcome = projectedTeamAttackOutcome(after, side, rules, options);
    outgoingDefeatGain = afterOutcome.defeats - before.defeats;
    outgoingGain = afterOutcome.effectiveDamage - before.effectiveDamage;
  }
  if (defenseRelevant) {
    const before = projectedTeamAttackOutcome(state, opponentSide(side), rules, options);
    const afterOutcome = projectedTeamAttackOutcome(after, opponentSide(side), rules, options);
    preventedDefeats = before.defeats - afterOutcome.defeats;
    preventedDamage = before.effectiveDamage - afterOutcome.effectiveDamage;
  }
  const healingGain = totalCurrentHp(after, side) - totalCurrentHp(state, side);
  return { after, outgoingDefeatGain, outgoingGain, preventedDefeats, preventedDamage, healingGain };
}
`;
source = source.slice(0, start) + replacement + source.slice(end);
await fs.writeFile(filePath, source, "utf8");
console.log("optimized strategic support projection");
