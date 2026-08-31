import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Missing patch target: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) throw new Error(`Ambiguous patch target: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replaceRegexOnce(source, regex, replacement, label) {
  const matches = [...source.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected one match for ${label}, found ${matches.length}`);
  return source.replace(regex, replacement);
}

async function patchFile(relativePath, transform) {
  const filePath = path.join(root, relativePath);
  const before = await fs.readFile(filePath, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Patch made no change: ${relativePath}`);
  await fs.writeFile(filePath, after, "utf8");
  console.log(`patched ${relativePath}`);
}

await patchFile("src/core/simulate.js", (input) => {
  let source = input;
  source = replaceOnce(
    source,
    '  return "敵の残りキャラ数を最優先にし、低火力側から攻撃して高火力を後詰めに残す";',
    '  return "敵の残りキャラ数を最優先にする。通常は融通の利かない低火力側から割り当てるが、かばう突破など前処理が必要なら必要火力を先行させる";',
    "target policy reason",
  );

  source = replaceRegexOnce(
    source,
    /function projectedSkillDamage\(state, side, actor, skill, rules, options = \{\}\) \{[\s\S]*?\n\}/,
    `function projectedSkillDamage(state, side, actor, skill, rules, options = {}) {
  const targets = state[opponentSide(side)].filter((combatant) => combatant.alive && !combatant.isGhost);
  const effectiveSkill = options.effective ? skill : attackSkillWithEffects(actor, skill, targets[0]);
  const rows = targets.map((target) => ({
    target,
    perHitDamage: estimateDamage(actor, target, effectiveSkill, rules),
  }));
  const hits = Math.max(1, Number(effectiveSkill.hits) || 1);
  if (effectiveSkill.type === "aoe_attack") {
    return rows.reduce((sum, row) => (
      sum + Math.min(row.target.currentHp, row.perHitDamage * hits)
    ), 0);
  }
  const bestEffectiveDamage = Math.max(0, ...rows.map((row) => (
    Math.min(row.target.currentHp, row.perHitDamage * (effectiveSkill.type === "multi_hit_attack" ? hits : 1))
  )));
  return bestEffectiveDamage;
}`,
    "effective projected damage",
  );

  source = replaceOnce(
    source,
    "  return action.hits.reduce((sum, hit) => sum + hit.damage, 0);",
    "  return action.hits.reduce((sum, hit) => sum + Math.min(hit.damage, hit.hpBefore), 0);",
    "single attack effective damage",
  );

  source = replaceRegexOnce(
    source,
    /function expertSupportBenefit\(state, side, actorIndex, skill, rules\) \{[\s\S]*?\n\}/,
    `function projectedTeamAttackOutcome(state, attackingSide, rules, options = {}) {
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
  return {
    defeats: hits.filter((hit) => hit.defeated).length,
    effectiveDamage: hits.reduce((sum, hit) => sum + Math.min(hit.damage, hit.hpBefore), 0),
    overkill: hits.reduce((sum, hit) => sum + Math.max(0, hit.damage - hit.hpBefore), 0),
    state: resolved.state,
  };
}

function expertSupportBenefit(state, side, actorIndex, skill, rules, options = {}) {
  const after = applySupportSkill(state, side, actorIndex, skill, { consumeSkill: false });
  const outgoingBefore = projectedTeamAttackOutcome(state, side, rules, options);
  const outgoingAfter = projectedTeamAttackOutcome(after, side, rules, options);
  const incomingBefore = projectedTeamAttackOutcome(state, opponentSide(side), rules, options);
  const incomingAfter = projectedTeamAttackOutcome(after, opponentSide(side), rules, options);
  const healingGain = totalCurrentHp(after, side) - totalCurrentHp(state, side);
  return {
    after,
    outgoingDefeatGain: outgoingAfter.defeats - outgoingBefore.defeats,
    outgoingGain: outgoingAfter.effectiveDamage - outgoingBefore.effectiveDamage,
    preventedDefeats: incomingBefore.defeats - incomingAfter.defeats,
    preventedDamage: incomingBefore.effectiveDamage - incomingAfter.effectiveDamage,
    healingGain,
  };
}`,
    "team outcome support benefit",
  );

  source = replaceOnce(
    source,
    "    const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules);",
    "    const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules, options);",
    "attack mode support options",
  );
  source = replaceOnce(
    source,
    `    return benefit.outgoingGain > 0
      ? {
          use: true,
          reason: \`対象味方の今ターン総与ダメージが\${benefit.outgoingGain}増えるため使用\`,
        }
      : {
          use: false,
          reason: "対象味方の攻撃形態が実際には改善しないため温存",
        };`,
    `    return benefit.outgoingDefeatGain > 0 || (benefit.outgoingDefeatGain === 0 && benefit.outgoingGain > 0)
      ? {
          use: true,
          reason: benefit.outgoingDefeatGain > 0
            ? \`今ターンの撃破数が\${benefit.outgoingDefeatGain}増えるため使用\`
            : \`オーバーキルを除いた有効与ダメージが\${benefit.outgoingGain}増えるため使用\`,
        }
      : {
          use: false,
          reason: "撃破数も有効削り量も改善しないため温存",
        };`,
    "attack mode kill-first decision",
  );

  source = replaceOnce(
    source,
    "          reason: `通常攻撃より今ターンの実与ダメージが${benefit.gain}増えるため使用`,",
    "          reason: `通常攻撃よりオーバーキルを除いた有効与ダメージが${benefit.gain}増えるため使用`,",
    "single attack reason",
  );
  source = replaceOnce(
    source,
    "          reason: \"通常攻撃を上回る今ターンの実与ダメージがないため温存\",",
    "          reason: \"通常攻撃と比べて撃破・有効削りが改善しないため温存\",",
    "single attack hold reason",
  );

  source = replaceOnce(
    source,
    "  const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules);\n  const useful = skill.type === \"heal\"\n    ? benefit.healingGain > 0\n    : benefit.outgoingGain > 0 || benefit.preventedDamage > 0;\n  return useful\n    ? { use: true, reason: \"このターン以降の与ダメージ増加または被ダメージ軽減に寄与するため使用\" }\n    : { use: false, reason: \"適用対象・属性条件・盤面効果が不足するため温存\" };",
    "  const benefit = expertSupportBenefit(state, side, actorIndex, skill, rules, options);\n  const useful = skill.type === \"heal\"\n    ? benefit.healingGain > 0\n    : benefit.outgoingDefeatGain > 0 || benefit.preventedDefeats > 0 || benefit.outgoingGain > 0 || benefit.preventedDamage > 0;\n  return useful\n    ? {\n        use: true,\n        reason: benefit.outgoingDefeatGain > 0 || benefit.preventedDefeats > 0\n          ? \"今ターンの撃破数または味方生存数を改善するため使用\"\n          : \"オーバーキルを除いた有効削りまたは実被ダメージを改善するため使用\",\n      }\n    : { use: false, reason: \"撃破・生存・有効削りのいずれも改善しないため温存\" };",
    "generic support kill-first decision",
  );

  source = replaceOnce(
    source,
    "function chooseSkills(state, rules, options) {",
    `function predictAttackStateWithSelectedSkills(state, intents, rules, options = {}) {
  let next = structuredClone(state);
  for (const skillTypes of [
    ["attribute_change"],
    ["heal"],
    ["attack_buff", "aoe_attack", "multi_hit_attack"],
    ["damage_reduction", "guard", "attribute_guard"],
  ]) {
    next = applySupportPhase(next, intents, skillTypes).state;
  }
  const scheduled = attackIntents(next, intents, rules, {
    ...options,
    playStyle: PLAY_STYLES.EXPERT,
    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,
  });
  return resolveAttacks(next, scheduled, rules, {
    ...options,
    targetPolicy: options.targetPolicy ?? TARGET_POLICIES.EXPERT,
    random: () => 0,
  }).state;
}

function reviveMatchesPredictedDefeat(predictedState, side, actorIndex, skill) {
  return predictedState[side].some((target, targetIndex) => (
    !target.alive &&
    !target.isGhost &&
    !target.reviveUsed &&
    skillScopeMatches(skill, target, actorIndex, targetIndex, target.attributes)
  ));
}

function chooseSkills(state, rules, options) {`,
    "revive attack prediction helpers",
  );

  source = replaceRegexOnce(
    source,
    /  const attributeIntents = candidates\.filter\([\s\S]*?\n  const events = candidates\.map/,
    `  const attributeIntents = candidates.filter(({ use, skill }) => use && skill.type === "attribute_change");
  for (const intent of candidates) {
    if (intent.skill.type === "heal") {
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

  const plannedNonReviveIntents = candidates.filter(({ use, skill }) => use && skill.type !== "revive");
  const predictedAttackState = predictAttackStateWithSelectedSkills(state, plannedNonReviveIntents, rules, options);
  for (const intent of candidates) {
    if (intent.skill.type !== "revive") continue;
    const use = reviveMatchesPredictedDefeat(
      predictedAttackState,
      intent.side,
      intent.actorIndex,
      intent.skill,
    );
    intent.use = use;
    intent.reason = use
      ? "両軍の発動予定スキル・攻撃順・かばうを反映した今ターン予測で蘇生対象が倒れるため使用"
      : "両軍の発動予定スキルを反映した今ターン予測で蘇生対象が倒れないため温存";
  }

  const events = candidates.map`,
    "full-turn revive decision",
  );

  source = replaceOnce(
    source,
    '        ? "チーム内は倒せる相手が少ない・火力が低い攻撃者から処理し、高火力を後詰めに残す"',
    '        ? "通常は融通の利かない低火力側から割り当てるが、かばう突破など前処理が必要な場面では必要火力を先行させる"',
    "battle assumption attack order",
  );
  return source;
});

await patchFile("src/core/metagame-v7.js", (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "    attackOrderPolicy: ATTACK_ORDER_POLICIES.STRONGEST_FIRST,",
    "    attackOrderPolicy: ATTACK_ORDER_POLICIES.TACTICAL,",
    "third battle profile tactical order",
  );

  source = source.replace(
    /  const minimumRandomMultiplier = Math\.min\(1, Math\.max\(0, Number\(rules\.damage\?\.randomMinimum\) \|\| 0\.9\)\);\n  const damageMultipliers = \[minimumRandomMultiplier, \(minimumRandomMultiplier \+ 1\) \/ 2, 1\];\n/,
    "",
  );
  source = source.replace(
    /\n      const damageMultiplier = damageMultipliers\[Math\.floor\(index \/ V7_BATTLE_PROFILES\.length\) % damageMultipliers\.length\];/,
    "",
  );
  source = source.replace(/\n      damageMultiplier,/, "");

  source = replaceRegexOnce(
    source,
    /  const partnerRatingsByPosition = ratingsByPosition\.map\(\(ratings, index\) => \{[\s\S]*?\n  \}\);\n  const anchorRatingsByPosition/,
    `  const partnerRatingsByPosition = ratingsByPosition.map((ratings) => (
    [...ratings.values()]
      .sort((left, right) => (
        (Number(right.individualScore ?? right.practicalValue) || 0) -
          (Number(left.individualScore ?? left.practicalValue) || 0) ||
        (Number(right.roleFit) || 0) - (Number(left.roleFit) || 0) ||
        Number(left.cost) - Number(right.cost) ||
        String(left.id).localeCompare(String(right.id))
      ))
      .slice(0, partnerLimit)
  ));
  const anchorRatingsByPosition`,
    "top partner candidates",
  );
  return source;
});

await patchFile("scripts/build-final.mjs", (source) => replaceOnce(
  source,
  '  "src/ui/metagame-v12-precomputed-first.js",\n  "src/ui/lightest.js",',
  '  "src/ui/metagame-v12-precomputed-first.js",\n  "src/ui/metagame-v12-fast-live.js",\n  "src/ui/lightest.js",',
  "fast live build inclusion",
));

const roots = ["src", "scripts", "test", ".github"];
const oldVersion = "team-battle-v12.2-threshold-proxy";
const newVersion = "team-battle-v12.3-strategic-actions";
async function walk(directory) {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(relative);
      continue;
    }
    if (!/\.(?:js|mjs|yml|yaml)$/.test(entry.name)) continue;
    const filePath = path.join(root, relative);
    const before = await fs.readFile(filePath, "utf8");
    const after = before.replaceAll(oldVersion, newVersion).replaceAll("V12.2", "V12.3");
    if (after !== before) {
      await fs.writeFile(filePath, after, "utf8");
      console.log(`versioned ${relative}`);
    }
  }
}
for (const directory of roots) await walk(directory);
