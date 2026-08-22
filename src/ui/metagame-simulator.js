import { attributeClassLabel } from "../data/rules.js";
import {
  applyMetagameStatBoost,
  findBestMetagameDeck,
  inspectMetagameDeckEvidence,
  matchesMetagameFixedConstraint,
  resolveMetagameConstraint,
} from "../core/metagame-deck.js";
import { isSkillTurnAllowedAtPosition } from "../core/filter.js";
import { createCharacterSearchIndex, searchCharacters } from "../core/character-search.js";
import { renderSimulationTrace } from "./result.js";
import { calculateMinimumDamage } from "../core/damage.js";
import { DEFAULT_RULES } from "../data/rules.js";

function metagameUiElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metagameUiPercent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function metagameUiSigned(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

const METAGAME_ROLE_LABELS = Object.freeze({
  precision_attack: "単体高耐久対策",
  sweep_attack: "盤面制圧攻撃",
  defense: "防御",
  revive: "蘇生",
  recovery: "回復",
  support: "支援",
  neutral: "基礎性能",
});

function metagameUiRoleLabel(rating) {
  if (rating?.role) return METAGAME_ROLE_LABELS[rating.role] ?? rating.role;
  if (rating?.skillType === "single_attack") return METAGAME_ROLE_LABELS.precision_attack;
  if (["aoe_attack", "multi_hit_attack"].includes(rating?.skillType)) return METAGAME_ROLE_LABELS.sweep_attack;
  if (["damage_reduction", "guard", "attribute_guard"].includes(rating?.skillType)) return METAGAME_ROLE_LABELS.defense;
  if (rating?.skillType === "revive") return METAGAME_ROLE_LABELS.revive;
  return METAGAME_ROLE_LABELS.neutral;
}

function metagameUiModelLabel(data) {
  const version = String(data.sourceModelVersion ?? "").match(/v\d+/i)?.[0]?.toUpperCase();
  return version ? `GitHub環境${version}` : data.sourceIsLegacy ? "旧評価" : "環境評価";
}

function metagameUiUsesInvalidPreV8Data(data) {
  const version = String(data.sourceModelVersion ?? "");
  return /^fixed-environment-v7\./.test(version);
}

function metagameUiCalculationState(data) {
  if (metagameUiUsesInvalidPreV8Data(data)) return "V7.5 results invalid; V8 5v5 recalculating";
  const status = data.sourceStatus;
  return {
    complete: "完了",
    in_progress: "計算中",
    paused: "一時停止",
  }[status] ?? "集計済み";
}

function metagameUiDateTime(value) {
  if (!value) return "取得日時なし";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "取得日時なし";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

function renderMetagameCalculationStatus(container, data) {
  container.replaceChildren();
  const totalRuns = Number(data.sourceTotalRuns) || 0;
  const completedRuns = Number(data.sourceCompletedRuns) || 0;
  const completion = totalRuns ? completedRuns / totalRuns : 0;
  const heading = metagameUiElement("div", "metagame-calculation-heading");
  heading.append(
    metagameUiElement("strong", "", "現在の環境データ"),
    metagameUiElement("span", "", `${metagameUiModelLabel(data)}・${metagameUiCalculationState(data)}`),
  );
  const metrics = metagameUiElement("div", "metagame-calculation-metrics");
  [
    ["全体進捗", `${completedRuns}/${totalRuns} タスク (${metagameUiPercent(completion)})`],
    ["利用可能", `${data.constraints.length} 条件`],
    ["更新", metagameUiDateTime(data.sourceUpdatedAt ?? data.generatedAt)],
  ].forEach(([label, value]) => {
    const metric = metagameUiElement("div", "metagame-calculation-metric");
    metric.append(
      metagameUiElement("span", "", label),
      metagameUiElement("strong", "", value),
    );
    metrics.append(metric);
  });
  const availableLabels = data.constraints.map((constraint) => constraint.label).join("、");
  const passLabel = data.sourcePasses ? `第1〜第${data.sourcePasses}パス` : "全パス";
  const note = metagameUiElement(
    "p",
    "metagame-calculation-note",
    metagameUiUsesInvalidPreV8Data(data)
      ? "旧V7.5の1対1結果は無効です。5対5・継続ありのV8評価を再計算中のため、完了まで候補デッキは表示しません。"
      : data.constraints.length
      ? `${availableLabels}は${passLabel}の全5枠が完了済みです。未完了の条件は表示・デッキ計算に含めません。`
      : "完了済みの5枠セットがまだないため、環境データは表示できません。",
  );
  const methodology = metagameUiElement(
    "p",
    "metagame-calculation-methodology",
    "実戦補正: 初手の被ターゲット、早すぎるスキルターン、コスト圧迫、火力過多の減衰、盤面制圧と高耐久対策の役割差、防御・蘇生による有利維持、継続効果の受け先を評価に反映。",
  );
  container.append(heading, metrics, note, methodology);
}

function metagameUiImpactReasons(character, rating, environment, deck) {
  const reasons = [
    `このキャラを${rating.scenarioCount}盤面で固定評価: 12ターン評価値 ${metagameUiPercent(rating.expectedWinRate)} / 信頼下限 ${metagameUiPercent(rating.expectedWinLowerBound)}`,
    `スキル有効時と無効時の評価値差 ${metagameUiSigned((Number(rating.skillWinGain) || 0) * 100)}pt / 実発動率 ${metagameUiPercent(rating.skillActivationRate)}`,
    `1盤面あたりの差分: 味方交代抑制 ${metagameUiSigned(rating.allyPreservationNet)} / 敵交代増加 ${metagameUiSigned(rating.enemyRemovalNet)}`,
    `味方維持率 ${metagameUiPercent(rating.allyRetentionRate)} / 敵への進行率 ${metagameUiPercent(rating.enemyPressureRate)}`,
  ];
  const individualScore = Number(rating.individualScore);
  const roleFit = Number(rating.roleFit);
  if (Number.isFinite(individualScore) || Number.isFinite(roleFit)) {
    const individualText = Number.isFinite(individualScore) ? metagameUiPercent(individualScore) : "未計測";
    const roleFitText = Number.isFinite(roleFit) ? metagameUiPercent(roleFit) : "未計測";
    reasons.unshift(
      `単体役割: ${metagameUiRoleLabel(rating)} / 単体環境適性 ${individualText} / 役割遂行 ${roleFitText}`,
    );
  }
  const roleBreakdown = rating.roleBreakdown ?? {};
  if (Number.isFinite(Number(roleBreakdown.skillReadiness))) {
    reasons.push(
      `スキル再現率 ${metagameUiPercent(roleBreakdown.skillReadiness)} / 発動待ちリスク ${metagameUiPercent(roleBreakdown.lateSkillRisk)}`,
    );
  }
  if (Number(roleBreakdown.highDurabilityCoverage) > 0 || Number(roleBreakdown.boardCoverage) > 0) {
    reasons.push(
      `攻撃適性: 高耐久への到達 ${metagameUiPercent(roleBreakdown.highDurabilityCoverage)} / 盤面制圧 ${metagameUiPercent(roleBreakdown.boardCoverage)}`,
    );
  }
  if (["delay", "skill_reduction"].includes(character.skill?.type)) {
    reasons.push("短縮・遅延効果は今回の評価対象外です。採用された場合は、通常攻撃・耐久・他枠との組み合わせが主因です。");
  }
  const enemyConditions = (character.skill?.conditions ?? [])
    .filter((condition) => condition.type === "enemy_attribute");
  for (const condition of enemyConditions) {
    const matched = environment.filter((entry) => entry.attributes.includes(condition.attribute));
    const names = matched.slice(0, 4).map((entry) => entry.name).join("、");
    const share = matched.reduce((sum, entry) => sum + Number(entry.projectedUsageShare || 0), 0);
    reasons.push(matched.length
      ? `敵${attributeClassLabel([condition.attribute])}条件が、上位10体では${names}などに一致（表示範囲の合計使用率 ${metagameUiPercent(share)}）`
      : `敵${attributeClassLabel([condition.attribute])}条件は、表示中の使用率上位10体には直接一致していません。`);
  }
  const allyConditions = (character.skill?.conditions ?? [])
    .filter((condition) => condition.type === "ally_attribute");
  for (const condition of allyConditions) {
    const matched = deck.filter((ally) => ally.attributes.includes(condition.attribute));
    reasons.push(`味方${attributeClassLabel([condition.attribute])}条件は、このデッキの${matched.length}/5体に一致: ${matched.map((ally) => ally.name).join("、")}`);
  }
  if (!enemyConditions.length && !allyConditions.length) {
    reasons.push("特定色への条件一致ではなく、全対象または自身への効果として評価されています。");
  }
  return reasons;
}

const METAGAME_UI_BASIC_ATTACK = Object.freeze({ type: "single_attack", multiplier: 1, hits: 1 });
const METAGAME_UI_ATTACK_TYPES = new Set(["single_attack", "aoe_attack", "multi_hit_attack"]);

function metagameUiNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function metagameUiPublishedRoleMetrics(constraint) {
  const metrics = new Map();
  for (const publishedDeck of constraint.precomputedDecks ?? []) {
    const ids = publishedDeck.i ?? publishedDeck.ids;
    const ratings = publishedDeck.r ?? publishedDeck.ratings ?? [];
    if (!Array.isArray(ids) || ids.length !== 5) continue;
    for (let index = 0; index < ids.length; index += 1) {
      const rating = ratings[index] ?? {};
      const breakdown = rating.b ?? rating.roleBreakdown ?? {};
      const role = rating.k ?? rating.role ?? "neutral";
      const lowerBound = metagameUiNumber(
        publishedDeck.l ?? publishedDeck.expectedWinLowerBound,
      );
      const readiness = metagameUiNumber(breakdown.r ?? breakdown.skillReadiness);
      const roleFit = metagameUiNumber(rating.f ?? rating.roleFit);
      const defenseMatchup = metagameUiNumber(breakdown.d ?? breakdown.defenseMatchup);
      const hardTargetCoverage = metagameUiNumber(
        breakdown.h ?? breakdown.highDurabilityCoverage,
      );
      const boardCoverage = metagameUiNumber(breakdown.a ?? breakdown.boardCoverage);
      const practicalDurability = role === "defense"
        ? defenseMatchup * (0.35 + roleFit * 0.35 + readiness * 0.3) * (0.5 + lowerBound * 0.5)
        : 0;
      const practicalFirepower = ["precision_attack", "sweep_attack"].includes(role)
        ? (hardTargetCoverage * 0.55 + boardCoverage * 0.45) *
          (0.35 + roleFit * 0.35 + readiness * 0.3) * (0.5 + lowerBound * 0.5)
        : 0;
      const key = `${String(ids[index])}:${index + 1}`;
      const current = metrics.get(key) ?? { durability: 0, firepower: 0, lowerBound: 0 };
      metrics.set(key, {
        durability: Math.max(current.durability, practicalDurability),
        firepower: Math.max(current.firepower, practicalFirepower),
        lowerBound: Math.max(current.lowerBound, lowerBound),
      });
    }
  }
  return metrics;
}

function metagameUiEnvironmentCharacters(
  constraint,
  characters,
  environmentCharacterIds,
  boostedCharacterIds,
  environmentCombatants,
) {
  const fallbackIds = [
    ...(constraint.teamScenarios ?? []).flatMap((scenario) => [
      ...(scenario.a ?? scenario.allyDecks ?? []).flat(),
      ...(scenario.e ?? scenario.enemyDecks ?? []).flat(),
    ]),
    ...(constraint.environmentScenarios ?? []).flatMap((scenario) => scenario.flat()),
    ...(constraint.slots ?? []).flatMap((slot) => (slot.environment ?? []).map((entry) => entry.id)),
  ];
  const combatants = environmentCombatants?.length
    ? environmentCombatants
    : (environmentCharacterIds?.length ? environmentCharacterIds : fallbackIds).map((id) => ({ id }));
  const byId = new Map((characters ?? []).map((character) => [String(character.id), character]));
  const appearances = new Map();
  combatants.forEach(({ id }) => appearances.set(String(id), (appearances.get(String(id)) ?? 0) + 1));
  const roleMetrics = metagameUiPublishedRoleMetrics(constraint);
  const unique = new Map();
  for (const combatant of combatants) {
    const id = String(combatant.id);
    const position = Number(combatant.position) || 0;
    const character = byId.get(id);
    if (!character) continue;
    const key = `${id}:${position}`;
    if (unique.has(key)) continue;
    unique.set(key, {
      ...applyMetagameStatBoost(character, boostedCharacterIds),
      metagameEnvironmentAppearances: appearances.get(id) ?? 0,
      metagameEnvironmentPosition: position || undefined,
      metagamePracticalRoleMetrics: roleMetrics.get(key) ?? {
        durability: 0,
        firepower: 0,
        lowerBound: 0,
      },
    });
  }
  return [...unique.values()];
}

function metagameUiConditionMatches(skill, ally, enemy) {
  return (skill?.conditions ?? []).every((condition) => {
    const target = condition.type === "enemy_attribute" ? enemy : ally;
    return (target?.attributes ?? []).includes(condition.attribute);
  });
}

function metagameUiAttackSkill(character, position) {
  const skill = character.skill ?? {};
  // Only a 0-turn attack skill in P1 is guaranteed to replace the opening
  // basic attack. Later-slot timing is battle-dependent, so keep those
  // examples conservative and show their basic attack instead.
  if (position === 1 && Number(character.skillTurn) === 0 && METAGAME_UI_ATTACK_TYPES.has(skill.type)) {
    return {
      type: skill.type,
      multiplier: Number(skill.multiplier) || 1,
      hits: Math.max(1, Number(skill.hits) || 1),
      label: `${character.skillName || "スキル"}（初手）`,
    };
  }
  return { ...METAGAME_UI_BASIC_ATTACK, label: position === 1 ? "基本攻撃（初手）" : "基本攻撃（登場時）" };
}

function metagameUiDamage(attacker, defender, skill = METAGAME_UI_BASIC_ATTACK, options = {}) {
  const attackMultiplier = Number(options.attackMultiplier) || 1;
  const defenseMultiplier = Number(options.defenseMultiplier) || 1;
  const singleHit = calculateMinimumDamage({
    attacker: { ...attacker, survivalTurns: 0 },
    defender,
    skillMultiplier: Number(skill.multiplier) || 1,
    attackMultiplier,
    defenseMultiplier,
    rules: DEFAULT_RULES,
  }).value;
  const hits = skill.type === "multi_hit_attack"
    ? Math.max(1, Number(skill.hits) || 1)
    : 1;
  return singleHit * hits;
}

function metagameUiSupportTargets(source, position, deck, enemy) {
  const skill = source.skill ?? {};
  const targetIndexes = skill.target === "self"
    ? [position - 1]
    : skill.target === "leader"
      ? [0]
      : deck.map((_, index) => index);
  return targetIndexes
    .map((index) => deck[index])
    .filter((target) => target && metagameUiConditionMatches(skill, target, enemy));
}

function metagameUiConcreteMatchups(
  character,
  position,
  constraint,
  deck,
  characters,
  environmentCharacterIds,
  boostedCharacterIds,
  environmentCombatants,
) {
  // Use only the actual opponent teams sampled for this recommendation.  The
  // "top" examples below are published 5v5 role evidence, never a raw HP or
  // Power ordering (a high-Power guard is not automatically a top attacker).
  const environment = metagameUiEnvironmentCharacters(
    constraint,
    characters,
    environmentCharacterIds,
    boostedCharacterIds,
    environmentCombatants,
  );
  if (!environment.length) return null;
  const topDurable = environment
    .filter((entry) => metagameUiNumber(entry.metagamePracticalRoleMetrics?.durability) > 0)
    .sort((left, right) => (
      metagameUiNumber(right.metagamePracticalRoleMetrics?.durability) -
        metagameUiNumber(left.metagamePracticalRoleMetrics?.durability) ||
      metagameUiNumber(right.metagamePracticalRoleMetrics?.lowerBound) -
        metagameUiNumber(left.metagamePracticalRoleMetrics?.lowerBound)
    ));
  const topAttackers = environment
    .filter((entry) => metagameUiNumber(entry.metagamePracticalRoleMetrics?.firepower) > 0)
    .sort((left, right) => (
      metagameUiNumber(right.metagamePracticalRoleMetrics?.firepower) -
        metagameUiNumber(left.metagamePracticalRoleMetrics?.firepower) ||
      metagameUiNumber(right.metagamePracticalRoleMetrics?.lowerBound) -
        metagameUiNumber(left.metagamePracticalRoleMetrics?.lowerBound)
    ));
  const attackSkill = metagameUiAttackSkill(character, position);
  const attackExamples = topDurable.slice(0, 12).map((target) => ({
    target,
    damage: metagameUiDamage(character, target, attackSkill),
  }));
  const strongestDefeated = environment.map((target) => ({
    target,
    damage: metagameUiDamage(character, target, attackSkill),
  }))
    .filter(({ target, damage }) => damage >= (Number(target.hp) || 0))
    .sort((left, right) => (Number(right.target.hp) || 0) - (Number(left.target.hp) || 0))[0];
  const toughestExample = attackExamples[0];
  const threatExamples = topAttackers.slice(0, 12).map((attacker) => ({
    attacker,
    damage: metagameUiDamage(attacker, character),
  }));
  const strongestSurvived = threatExamples.find(({ damage }) => damage < (Number(character.hp) || 0));
  const biggestThreat = [...threatExamples].sort((left, right) => right.damage - left.damage)[0];
  const lines = [];

  if (strongestDefeated) {
    lines.push(`火力例: ${attackSkill.label}で、今回の環境内で一撃撃破できる最大HPの${strongestDefeated.target.name}（HP ${strongestDefeated.target.hp}）へ ${strongestDefeated.damage}。確定撃破。`);
  } else if (toughestExample) {
    const remaining = Math.max(0, (Number(toughestExample.target.hp) || 0) - toughestExample.damage);
    lines.push(`火力例: ${attackSkill.label}で、実戦の防御寄与が高い${toughestExample.target.name}（HP ${toughestExample.target.hp}）へ ${toughestExample.damage}。残HP ${remaining}で、一撃では倒せません。`);
  }

  if (strongestSurvived) {
    const remaining = Math.max(0, (Number(character.hp) || 0) - strongestSurvived.damage);
    lines.push(`耐久例: 実戦の攻撃寄与が高い${strongestSurvived.attacker.name}（攻撃 ${strongestSurvived.attacker.pow}）の基本攻撃 ${strongestSurvived.damage}を耐え、残HP ${remaining}。`);
  } else if (biggestThreat) {
    lines.push(`耐久例: 実戦の攻撃寄与が高い${biggestThreat.attacker.name}（攻撃 ${biggestThreat.attacker.pow}）の基本攻撃 ${biggestThreat.damage}で撃破されます。`);
  }

  if (biggestThreat) {
    const result = biggestThreat.damage >= (Number(character.hp) || 0)
      ? "一撃で倒されるため明確な苦手相手です"
      : `残HP ${Math.max(0, (Number(character.hp) || 0) - biggestThreat.damage)}で最大圧力を受けます`;
    lines.push(`弱点例: ${biggestThreat.attacker.name}（${attributeClassLabel(biggestThreat.attacker.attributes)}・攻撃 ${biggestThreat.attacker.pow}）は ${biggestThreat.damage} ダメージ。${result}。`);
  }

  const skill = character.skill ?? {};
  if (skill.type === "revive") {
    const reviveTargets = metagameUiSupportTargets(character, position, deck, topAttackers[0]);
    const examples = reviveTargets.slice(0, 2).map((target) => {
      const restoredHp = Math.min(
        (Number(target.hp) || 0) * 2,
        Math.max(1, (Number(target.hp) || 0) * (Number(skill.multiplier) || 0)),
      );
      const rescuedThreat = topAttackers.map((attacker) => ({
        attacker,
        damage: metagameUiDamage(attacker, target),
      })).find(({ damage }) => damage < restoredHp);
      return rescuedThreat
        ? `${target.name}をHP ${Math.floor(restoredHp)}で復帰させ、${rescuedThreat.attacker.name}の ${rescuedThreat.damage} ダメージを耐えられる`
        : `${target.name}をHP ${Math.floor(restoredHp)}で復帰させるが、実戦攻撃寄与が高い相手の一撃を耐える例はありません`;
    });
    lines.push(`蘇生例: この編成で救える対象は ${reviveTargets.length}/5体。${examples.join(" / ") || "対象条件に合う味方がいません"}。`);
  } else if (skill.type === "attack_buff") {
    const recipients = metagameUiSupportTargets(character, position, deck, topDurable[0]);
    const recipient = [...recipients].sort((left, right) => (Number(right.pow) || 0) - (Number(left.pow) || 0))[0];
    if (recipient && toughestExample) {
      const boostedDamage = metagameUiDamage(recipient, toughestExample.target, METAGAME_UI_BASIC_ATTACK, {
        attackMultiplier: Number(skill.multiplier) || 1,
      });
      lines.push(`支援例: ${recipients.length}/5体へ攻撃補正。最大火力の${recipient.name}は${toughestExample.target.name}へ基本攻撃 ${boostedDamage}まで伸びます。`);
    }
  } else if (["damage_reduction", "guard", "attribute_guard"].includes(skill.type)) {
    const recipients = metagameUiSupportTargets(character, position, deck, topAttackers[0]);
    const recipient = recipients[0];
    const threat = topAttackers.find((attacker) => metagameUiConditionMatches(skill, recipient, attacker));
    if (recipient && threat) {
      const before = metagameUiDamage(threat, recipient);
      const after = metagameUiDamage(threat, recipient, METAGAME_UI_BASIC_ATTACK, {
        defenseMultiplier: Number(skill.multiplier) || 1,
      });
      lines.push(`防御スキル例: ${recipient.name}が${threat.name}の基本攻撃を ${before} → ${after} に軽減します（発動・対象条件が満たされる場合）。`);
    }
  }
  return lines;
}

function metagameUiSlot(
  character,
  rating,
  position,
  environment,
  deck,
  constraint,
  characters,
  environmentCharacterIds,
  boostedCharacterIds,
  environmentCombatants,
) {
  const card = metagameUiElement("article", "metagame-slot-card");
  const number = metagameUiElement("span", "metagame-slot-number", String(position));
  const copy = metagameUiElement("div", "metagame-slot-copy");
  const heading = metagameUiElement("div", "metagame-slot-heading");
  heading.append(
    metagameUiElement("h4", "", character.name),
    metagameUiElement("span", "", `${attributeClassLabel(character.attributes)}・${character.rarity}`),
  );
  const boostLabel = character.metagameStatBoost
    ? ` / 補正 HP・攻撃×${character.metagameStatBoost.multiplier}`
    : "";
  const details = metagameUiElement("p", "", `コスト ${character.cost} / スキル ${character.skillTurn}ターン${boostLabel}`);
  const skill = metagameUiElement("small", "", character.skillName || "スキルなし");
  const ratingLine = metagameUiElement(
    "small",
    "metagame-slot-rating",
    `枠単体の12ターン評価値 ${metagameUiPercent(rating.expectedWinRate)}・総合${rating.overallRank}位`,
  );
  const impact = metagameUiElement("details", "metagame-impact");
  impact.append(metagameUiElement("summary", "", "この枠での採用根拠を見る"));
  const reasonList = metagameUiElement("ul", "");
  metagameUiImpactReasons(character, rating, environment, deck).forEach((reason) => (
    reasonList.append(metagameUiElement("li", "", reason))
  ));
  impact.append(reasonList);
  const matchupLines = metagameUiConcreteMatchups(
    character,
    position,
    constraint,
    deck,
    characters,
    environmentCharacterIds,
    boostedCharacterIds,
    environmentCombatants,
  );
  const matchups = metagameUiElement("section", "metagame-concrete-matchups");
  matchups.append(metagameUiElement("strong", "", "今回の対戦環境との具体例（効果発動前）"));
  const matchupList = metagameUiElement("ul", "");
  (matchupLines ?? ["環境キャラの対戦データが不足しているため、具体例を作成できません。"]).forEach((line) => {
    matchupList.append(metagameUiElement("li", "", line));
  });
  matchups.append(matchupList);
  copy.append(heading, details, skill, ratingLine, matchups, impact);
  card.append(number, copy);
  return card;
}

function metagameUiDeckEnvironmentOverlap(deck, constraint) {
  const environmentById = new Map((constraint.slots ?? []).flatMap((slot) => slot.environment ?? []).map((entry) => [
    String(entry.id), entry,
  ]));
  return deck.map((character) => environmentById.get(String(character.id))).filter(Boolean);
}

function metagameUiTeamList(title, decks) {
  const section = metagameUiElement("section", "metagame-evidence-team");
  section.append(metagameUiElement("strong", "", title));
  const list = metagameUiElement("ol", "");
  decks.forEach((deck, index) => {
    list.append(metagameUiElement(
      "li",
      "",
      `P${index + 1}: ${deck.map((character) => character.name).join(" → ")}`,
    ));
  });
  section.append(list);
  return section;
}

function metagameUiEvidenceSample(sample) {
  const section = metagameUiElement("section", "metagame-evidence-sample");
  section.append(metagameUiElement(
    "h5",
    "",
    `${sample.label} #${sample.scenarioIndex + 1} — 12ターン評価値 ${metagameUiPercent(sample.value)}`,
  ));
  section.append(metagameUiElement(
    "p",
    "metagame-evidence-outcome",
    `決着: ${sample.result.outcome} / 操作方針: ${sample.profile.id} / 推薦デッキは味方P${sample.actorIndex + 1}`,
  ));
  const teams = metagameUiElement("div", "metagame-evidence-teams");
  teams.append(
    metagameUiTeamList("味方5人のデッキ", sample.allyDecks),
    metagameUiTeamList("敵5人のデッキ", sample.enemyDecks),
  );
  section.append(teams, renderSimulationTrace({
    profileName: sample.profile.id,
    assumptions: sample.result.assumptions,
    history: sample.result.history,
    note: `この記録はクラウド評価で使った5対5の対戦組です。推薦デッキを味方P${sample.actorIndex + 1}へ入れ、表示した味方4人・敵5人の完成デッキをそのまま再生しています。`,
  }));
  return section;
}

function metagameUiEvidence(result, constraint, characters) {
  const details = metagameUiElement("details", "metagame-evidence");
  details.append(metagameUiElement("summary", "", "この評価の対戦根拠を再生する"));

  const description = metagameUiElement(
    "p",
    "metagame-evidence-note",
    "全対戦を再生して、厳しい例・中央値・有利な例のターン別ログを表示します。12ターンで決着しない対戦は、残り人数と残HPから評価値を算出します。",
  );
  const overlap = metagameUiDeckEnvironmentOverlap(result.deck, constraint);
  const overlapLine = metagameUiElement(
    "p",
    "metagame-evidence-overlap",
    overlap.length
      ? `環境提示キャラの採用: ${overlap.length}/5（${overlap.map((character) => character.name).join(" / ")}）`
      : "環境提示キャラの採用: 0/5。現行の候補生成は環境キャラを必須にしていないため、この結果は別途検証が必要です。",
  );
  const button = metagameUiElement("button", "metagame-evidence-button", "全対戦を再生して根拠を表示");
  button.type = "button";
  const output = metagameUiElement("div", "metagame-evidence-output");
  button.addEventListener("click", async () => {
    button.disabled = true;
    output.replaceChildren(metagameUiElement("p", "metagame-evidence-note", "対戦記録を再生しています…"));
    try {
      const evidence = await inspectMetagameDeckEvidence(result.deck, constraint, characters, {
        boostedCharacterIds: result.boostedCharacterIds,
        boostedScenarioCount: result.boostedScenarioCount,
        interactiveScenarioCount: result.interactiveScenarioCount,
        automaticCharacterIds: result.automaticCharacterIds,
        automaticEnvironmentCharacterIds: result.automaticEnvironmentCharacterIds,
        automaticEnvironmentDecks: result.automaticEnvironmentDecks,
        maxPrecomputedEnvironmentDecks: result.environmentMix?.precomputedTopDeckCount,
        onScenarioCompleted: ({ completed, total }) => {
          output.replaceChildren(metagameUiElement(
            "p",
            "metagame-evidence-note",
            `対戦記録を再生しています… ${completed}/${total}`,
          ));
        },
      });
      const summary = metagameUiElement("p", "metagame-evidence-summary");
      const sourceLabel = evidence.source === "cloud-v8-team-scenario"
        ? "クラウド保存済みの5対5組合せ"
        : evidence.source === "reconstructed-v8-team-scenario"
          ? "保存済みの環境デッキ順から復元したV8の5対5組合せ"
          : "旧形式の9デッキ組合せ";
      const replayGap = evidence.expectedWinRate - Number(result.expectedWinRate || 0);
      summary.textContent =
        `再生結果（${evidence.scenarioCount}戦 / ${sourceLabel}）: 保存値 ${metagameUiPercent(result.expectedWinRate)} ` +
        `/ 再生値 ${metagameUiPercent(evidence.expectedWinRate)}（差 ${metagameUiSigned(replayGap * 100)}pt）` +
        `/ 信頼下限 ${metagameUiPercent(evidence.expectedWinLowerBound)} ` +
        `/ 勝 ${metagameUiPercent(evidence.decisiveWinRate)} ` +
        `/ 分 ${metagameUiPercent(evidence.decisiveDrawRate)} ` +
        `/ 負 ${metagameUiPercent(evidence.decisiveLossRate)} ` +
        `/ 未決着 ${metagameUiPercent(evidence.ongoingRate)}`;
      output.replaceChildren(summary, ...evidence.samples.map(metagameUiEvidenceSample));
    } catch (error) {
      output.replaceChildren(metagameUiElement(
        "p",
        "metagame-evidence-error",
        error.message ?? String(error),
      ));
    } finally {
      button.disabled = false;
    }
  });
  details.append(description, overlapLine, button, output);
  return details;
}

function metagameUiResultCard(result, rank, constraint, characters) {
  const card = metagameUiElement("article", `metagame-deck-result${rank === 1 ? " is-best" : ""}`);
  const header = metagameUiElement("header", "metagame-result-header");
  const title = metagameUiElement("div", "");
  title.append(
    metagameUiElement("span", "metagame-result-rank", rank === 1 ? "BEST DECK" : `NEXT ${rank}`),
    metagameUiElement("h3", "", rank === 1 ? "最高12ターン評価値デッキ" : "次点デッキ"),
  );
  const winRate = metagameUiElement("div", "metagame-win-rate");
  winRate.append(
    metagameUiElement("strong", "", metagameUiPercent(result.expectedWinRate)),
    metagameUiElement("span", "", `12ターン評価値・下限 ${metagameUiPercent(result.expectedWinLowerBound)}`),
  );
  header.append(title, winRate);
  const summary = metagameUiElement("div", "metagame-result-summary");
  summary.append(
    metagameUiElement("span", "", `総コスト ${result.totalCost} / ${constraint.totalCost}`),
    metagameUiElement("span", "", `勝 ${metagameUiPercent(result.decisiveWinRate)}`),
    metagameUiElement("span", "", `分 ${metagameUiPercent(result.decisiveDrawRate)}`),
    metagameUiElement("span", "", `敗 ${metagameUiPercent(result.decisiveLossRate)}`),
    metagameUiElement("span", "", `継続判定 ${metagameUiPercent(result.ongoingRate)}`),
  );
  const slots = metagameUiElement("div", "metagame-slot-list");
  result.deck.forEach((character, index) => slots.append(
    metagameUiSlot(
      character,
      result.ratings[index],
      index + 1,
      constraint.slots[index].environment,
      result.deck,
      constraint,
      characters,
      result.environmentCharacterIds,
      result.boostedCharacterIds,
      result.environmentCombatants,
    ),
  ));
  card.append(header, summary, slots, metagameUiEvidence(result, constraint, characters));
  return card;
}

function renderMetagameSimulatorResult(container, searchResult, characters) {
  container.replaceChildren();
  const overview = metagameUiElement("section", "metagame-result-overview");
  overview.append(
    metagameUiElement("strong", "", searchResult.constraint.label),
    metagameUiElement(
      "span",
      "",
      `${searchResult.candidateDeckCount.toLocaleString("ja-JP")}候補から${searchResult.simulatedDeckCount}デッキを再対戦・各${searchResult.scenarioCount}環境`,
    ),
    metagameUiElement("span", "", `評価モデル ${searchResult.constraint.modelVersion ?? "unknown"}`),
  );
  if (searchResult.environmentMix) {
    const mix = searchResult.environmentMix;
    overview.append(metagameUiElement(
      "span",
      "metagame-environment-mix",
      `対戦環境: 指定環境 ${mix.baselineScenarioCount}件を主軸 / 事前成績上位の完成デッキ ${mix.precomputedTopDeckCount}件 / 実戦再評価済み補正デッキ ${mix.liveEnvironmentDeckCount}件`,
    ));
  }
  if (Number(searchResult.excludedScenarioCount) > 0) {
    overview.append(metagameUiElement(
      "span",
      "metagame-boost-badge",
      `現在のキャラデータで配置・スキルターン条件を満たさない環境 ${searchResult.excludedScenarioCount} 件を除外しました。`,
    ));
  }
  const boostedIds = new Set((searchResult.boostedCharacterIds ?? []).map(String));
  if (boostedIds.size) {
    const names = characters
      .filter((character) => boostedIds.has(String(character.id)))
      .map((character) => character.name);
    overview.append(metagameUiElement(
      "span",
      "metagame-boost-badge",
      `補正反映: ${names.join(" / ")}（HP・攻撃×1.5）`,
    ));
    overview.append(metagameUiElement(
      "span",
      "",
      `補正時の対戦は提示環境から均等抽出した${searchResult.boostedScenarioCount ?? searchResult.scenarioCount}盤面${searchResult.scenarioCount > (searchResult.boostedScenarioCount ?? searchResult.scenarioCount) ? "と追加環境" : ""}で再評価`,
    ));
  }
  const automaticIds = new Set((searchResult.automaticEnvironmentCharacterIds ?? []).map(String));
  if (automaticIds.size) {
    overview.append(metagameUiElement(
      "span",
      "metagame-boost-badge",
      `自動再検証: 補正・管理DB・枠別高評価など ${automaticIds.size}体を候補と相手環境へ反映`,
    ));
  }
  if (searchResult.constraint.interpolation?.kind === "between") {
    const { lowerCost, upperCost, requestedCost } = searchResult.constraint.interpolation;
    overview.append(metagameUiElement(
      "span",
      "metagame-boost-badge",
      `環境コスト${requestedCost}: コスト${lowerCost}・${upperCost}の調査済み環境を併用`,
    ));
  }
  container.append(overview);
  searchResult.results.forEach((result, index) => container.append(
    metagameUiResultCard(result, index + 1, searchResult.constraint, characters),
  ));
  const note = metagameUiElement("p", "metagame-result-note");
  note.textContent = "採用根拠は、そのキャラを対象枠へ固定した30盤面での差分です。完成デッキは別途環境へ再投入して比較しています。引き分けは0.5、12ターンで未決着の場合は残数と残HPから盤面評価値を算出します。";
  container.append(note);
}

function metagameUiConstraintAttributeKey(constraint) {
  return String(constraint?.attributeKey ?? [...new Set(constraint?.allowedAttributes ?? [])].sort().join("-"));
}

function renderSurveyedMetagameConstraints(container, constraints, selectedId) {
  container.replaceChildren();
  const heading = metagameUiElement("div", "metagame-surveyed-heading");
  heading.append(
    metagameUiElement("strong", "", "実装済みの環境"),
    metagameUiElement("span", "", constraints.length + "縛り・各5枠を選択して確認できます"),
  );
  const list = metagameUiElement("div", "metagame-surveyed-list");
  constraints.forEach((constraint) => {
    const button = metagameUiElement(
      "button",
      "metagame-surveyed-constraint" + (constraint.id === selectedId ? " is-active" : ""),
    );
    button.type = "button";
    button.dataset.metagameSurveyedConstraint = constraint.id;
    button.dataset.metagameSurveyedAttribute = metagameUiConstraintAttributeKey(constraint);
    button.dataset.metagameSurveyedCost = String(constraint.totalCost);
    button.setAttribute("aria-pressed", String(constraint.id === selectedId));
    const environmentCount = constraint.slots[0]?.environment.length ?? 0;
    button.append(
      metagameUiElement("strong", "", constraint.label),
      metagameUiElement(
        "small",
        "",
        "5枠・各上位" + environmentCount + "体・" + constraint.scenarioCount + "環境",
      ),
    );
    list.append(button);
  });
  container.append(heading, list);
}
function renderMetagameSimulatorMessage(container, message, error = false) {
  container.replaceChildren(metagameUiElement(
    "section",
    `metagame-simulator-message${error ? " is-error" : ""}`,
    message,
  ));
}

export function initializeMetagameSimulator(root, data, characters, initialOptions = {}) {
  const form = root.querySelector("[data-metagame-form]");
  const select = form.elements.metagameConstraint;
  const totalCostInput = form.querySelector("[data-metagame-total-cost]");
  const submitButton = form.querySelector("[data-metagame-submit]");
  const cancelButton = form.querySelector("[data-metagame-cancel]");
  const status = root.querySelector("[data-metagame-data-status]");
  const progress = root.querySelector("[data-metagame-sim-progress]");
  const progressLabel = progress.querySelector("[data-metagame-progress-label]");
  const progressValue = progress.querySelector("[data-metagame-progress-value]");
  const progressBar = progress.querySelector("[data-metagame-progress-bar]");
  const resultRoot = root.querySelector("[data-metagame-result]");
  const calculationStatus = root.querySelector("[data-metagame-calculation-status]");
  const surveyedConstraints = root.querySelector("[data-metagame-surveyed-constraints]");
  const fixedSlotList = form.querySelector("[data-metagame-fixed-slot-list]");
  const fixedClearButton = form.querySelector("[data-metagame-fixed-clear]");
  const fixedPicker = form.querySelector("[data-metagame-fixed-picker]");
  const fixedPickerHeading = form.querySelector("[data-metagame-fixed-picker-heading]");
  const fixedPickerCloseButton = form.querySelector("[data-metagame-fixed-picker-close]");
  const fixedPickerQuery = form.querySelector("[data-metagame-fixed-picker-query]");
  const fixedPickerSearchButton = form.querySelector("[data-metagame-fixed-picker-search]");
  const fixedPickerResults = form.querySelector("[data-metagame-fixed-picker-results]");
  const boostedList = form.querySelector("[data-metagame-boosted-list]");
  const boostedClearButton = form.querySelector("[data-metagame-boosted-clear]");
  const boostedQuery = form.querySelector("[data-metagame-boosted-query]");
  const boostedSearchButton = form.querySelector("[data-metagame-boosted-search]");
  const boostedResults = form.querySelector("[data-metagame-boosted-results]");
  const interactiveScenarioSelect = form.querySelector("[data-metagame-interactive-scenarios]");
  let activeCharacters = [...characters];
  let automaticCharacterIds = new Set((initialOptions.automaticCharacterIds ?? []).map(String));
  let fixedSlots = new Map();
  let boostedCharacters = new Map();
  let fixedPickerPosition = null;
  let fixedPickerIndex = createCharacterSearchIndex([]);
  let fixedPickerSearchTimer = null;
  let boostedPickerIndex = createCharacterSearchIndex([]);
  let boostedSearchTimer = null;
  let abortController = null;

  select.replaceChildren();
  const constraintByAttribute = new Map();
  for (const constraint of data.constraints) {
    const attributeKey = metagameUiConstraintAttributeKey(constraint);
    const current = constraintByAttribute.get(attributeKey);
    if (!current || Number(constraint.totalCost) < Number(current.totalCost)) {
      constraintByAttribute.set(attributeKey, constraint);
    }
  }
  for (const [attributeKey, constraint] of constraintByAttribute) {
    const option = document.createElement("option");
    option.value = attributeKey;
    option.textContent = String(constraint.label).replace(/[・\s]*コスト\s*\d+.*$/, "");
    select.append(option);
  }
  // Keep the initial selection valid when a browser restores an old form state
  // after newly published constraint data has been deployed.
  if (data.constraints[0]) select.value = metagameUiConstraintAttributeKey(data.constraints[0]);
  const sourceLabel = metagameUiModelLabel(data);
  status.textContent = data.constraints.length
    ? `利用可能 ${data.constraints.length}条件 / 評価完了 ${data.sourceCompletedRuns}/${data.sourceTotalRuns} / ${sourceLabel}`
    : "利用可能な調査済み環境がありません";
  renderMetagameCalculationStatus(calculationStatus, data);
  submitButton.disabled = data.constraints.length === 0;
  const fixedSlotValues = () => Object.fromEntries(
    [...fixedSlots.entries()].map(([position, character]) => [position, character.id]),
  );
  const boostedCharacterIds = () => [...boostedCharacters.keys()];
  const sourceConstraint = () => constraintByAttribute.get(select.value);
  const selectedConstraint = () => {
    const constraint = sourceConstraint();
    if (!constraint) return constraint;
    const totalCost = Number(totalCostInput.value);
    return resolveMetagameConstraint(data, constraint.id, totalCost);
  };
  const syncTotalCostFromConstraint = () => {
    const constraint = sourceConstraint();
    if (constraint) totalCostInput.value = String(constraint.totalCost);
  };
  const showPublishedV8Cache = data.showPublishedV8Cache === true;
  let displayedPrecomputedConstraintId = null;
  const renderAvailablePrecomputedDeck = () => {
    const constraint = selectedConstraint();
    const hasV8Decks = String(constraint?.modelVersion ?? "").startsWith("team-battle-v8");
    if (!showPublishedV8Cache || !hasV8Decks || constraint.interpolation || fixedSlots.size || boostedCharacters.size || automaticCharacterIds.size) return false;

    const constraintId = constraint.id;
    displayedPrecomputedConstraintId = constraintId;
    renderMetagameSimulatorMessage(resultRoot, "計算済みの推奨デッキを表示しています。");
    void findBestMetagameDeck(data, constraintId, activeCharacters, {
      totalCost: Number(totalCostInput.value),
      usePublishedV8Cache: true,
    }).then((searchResult) => {
      // A prior selection must not overwrite the current selection or a
      // user-initiated calculation if it completes afterwards.
      if (displayedPrecomputedConstraintId !== constraintId || abortController) return;
      renderMetagameSimulatorResult(resultRoot, searchResult, activeCharacters);
    }).catch((error) => {
      if (displayedPrecomputedConstraintId !== constraintId || abortController) return;
      renderMetagameSimulatorMessage(resultRoot, error.message ?? String(error), true);
    });
    return true;
  };
  const fixedSlotCandidates = (constraint, position = fixedPickerPosition) => activeCharacters.filter((character) => (
    matchesMetagameFixedConstraint(character, constraint)
      && (!position || isSkillTurnAllowedAtPosition(character, position))
  ));
  const boostedCharacterCandidates = (constraint) => activeCharacters.filter((character) => {
    if (!matchesMetagameFixedConstraint(character, constraint)) return false;
    const positions = Array.isArray(character.allowedPositions) && character.allowedPositions.length
      ? character.allowedPositions
      : [1, 2, 3, 4, 5];
    return positions.some((position) => isSkillTurnAllowedAtPosition(character, position));
  });
  const renderBoostedPickerMessage = (message) => {
    boostedResults.replaceChildren(metagameUiElement("p", "metagame-boosted-message", message));
  };
  const renderBoostedCharacters = (constraint) => {
    const allowedIds = new Set(boostedCharacterCandidates(constraint).map((character) => String(character.id)));
    for (const id of boostedCharacters.keys()) {
      if (!allowedIds.has(String(id))) boostedCharacters.delete(id);
    }
    boostedList.replaceChildren();
    if (!boostedCharacters.size) {
      boostedList.append(metagameUiElement("span", "metagame-boosted-empty", "補正キャラは未指定です。通常の事前評価済みデッキを表示します。"));
      return;
    }
    for (const character of boostedCharacters.values()) {
      const chip = metagameUiElement("span", "metagame-boosted-chip");
      chip.append(
        metagameUiElement("strong", "", character.name),
        metagameUiElement("span", "", "HP・攻撃×1.5"),
      );
      const remove = metagameUiElement("button", "", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `${character.name}の補正を解除`);
      remove.disabled = Boolean(abortController);
      remove.addEventListener("click", () => {
        boostedCharacters.delete(String(character.id));
        renderBoostedCharacters(selectedConstraint());
        renderBoostedPickerResults();
        displayedPrecomputedConstraintId = null;
        if (!renderAvailablePrecomputedDeck()) {
          renderMetagameSimulatorMessage(resultRoot, "補正キャラを変更しました。候補デッキを評価すると、HP・攻撃×1.5を反映して再対戦します。");
        }
      });
      chip.append(remove);
      boostedList.append(chip);
    }
  };
  const renderBoostedPickerResults = () => {
    const constraint = selectedConstraint();
    const candidates = boostedCharacterCandidates(constraint);
    boostedPickerIndex = createCharacterSearchIndex(candidates);
    const query = boostedQuery.value.trim();
    if (!query) {
      renderBoostedPickerMessage(`${candidates.length.toLocaleString("ja-JP")}体から、補正するキャラを検索できます。`);
      return;
    }
    const response = searchCharacters(boostedPickerIndex, query, { limit: 24 });
    if (!response.total) {
      renderBoostedPickerMessage("選択中の属性・コスト縛りとスキルターン条件に一致するキャラがありません。");
      return;
    }
    const list = metagameUiElement("div", "metagame-boosted-results");
    for (const result of response.results) {
      const character = result.character;
      const card = metagameUiElement("article", "metagame-boosted-result");
      card.append(
        metagameUiElement("strong", "", character.name),
        metagameUiElement("small", "", `${attributeClassLabel(character.attributes)}・${character.rarity}・cost ${character.cost}・HP ${character.hp}→${Number(character.hp) * 1.5}・攻撃 ${character.pow}→${Number(character.pow) * 1.5}`),
      );
      const selected = boostedCharacters.has(String(character.id));
      const choose = metagameUiElement("button", "", selected ? "補正指定済み" : "補正に追加");
      choose.type = "button";
      choose.disabled = selected || Boolean(abortController);
      choose.addEventListener("click", () => {
        boostedCharacters.set(String(character.id), character);
        renderBoostedCharacters(selectedConstraint());
        renderBoostedPickerResults();
        displayedPrecomputedConstraintId = null;
        renderMetagameSimulatorMessage(resultRoot, "補正キャラを追加しました。候補デッキを評価すると、HP・攻撃×1.5を反映して5対5対戦を再計算します。");
      });
      card.append(choose);
      list.append(card);
    }
    boostedResults.replaceChildren(list);
  };
  const renderFixedPickerMessage = (message) => {
    fixedPickerResults.replaceChildren(metagameUiElement("p", "metagame-fixed-picker-message", message));
  };
  const closeFixedPicker = () => {
    fixedPicker.hidden = true;
    fixedPickerPosition = null;
    fixedPickerQuery.value = "";
    fixedPickerResults.replaceChildren();
  };
  const renderFixedPickerResults = () => {
    if (!fixedPickerPosition) return;
    const query = fixedPickerQuery.value.trim();
    if (!query) {
      renderFixedPickerMessage("名前・属性・スキルなどで検索してください。例: 火 回復 / 低コスト 蘇生");
      return;
    }
    const response = searchCharacters(fixedPickerIndex, query, { limit: 24 });
    if (!response.total) {
      renderFixedPickerMessage("選択中の属性・コスト縛りに一致するキャラがありません。");
      return;
    }
    const list = metagameUiElement("div", "metagame-fixed-picker-results");
    for (const result of response.results) {
      const character = result.character;
      const card = metagameUiElement("article", "metagame-fixed-picker-result");
      card.append(
        metagameUiElement("strong", "", character.name),
        metagameUiElement("small", "", `${attributeClassLabel(character.attributes)}・${character.rarity}・cost ${character.cost}・スキル${character.skillTurn}T`),
      );
      const choose = metagameUiElement("button", "", "この枠に固定");
      choose.type = "button";
      choose.addEventListener("click", () => {
        const duplicate = [...fixedSlots.entries()].find(([position, entry]) => (
          position !== fixedPickerPosition && String(entry.id) === String(character.id)
        ));
        if (duplicate) {
          renderFixedPickerMessage(`${duplicate[0]}枠目ですでに固定されています。`);
          return;
        }
        fixedSlots.set(fixedPickerPosition, character);
        renderFixedSlots(selectedConstraint());
        closeFixedPicker();
      });
      card.append(choose);
      list.append(card);
    }
    fixedPickerResults.replaceChildren(list);
  };
  const openFixedPicker = (position) => {
    const candidates = fixedSlotCandidates(selectedConstraint(), position);
    if (!candidates.length) return;
    fixedPickerPosition = position;
    fixedPickerIndex = createCharacterSearchIndex(candidates);
    fixedPickerHeading.textContent = `${position}枠目の固定キャラを検索`;
    fixedPicker.hidden = false;
    fixedPickerQuery.value = "";
    renderFixedPickerMessage(`${candidates.length.toLocaleString("ja-JP")}体の縛り一致キャラを、名前・属性・スキルで検索できます。スキルターンや枠別評価では絞り込みません。`);
    fixedPickerQuery.focus();
  };
  const renderFixedSlots = (constraint) => {
    for (const [position, character] of fixedSlots) {
      if (!fixedSlotCandidates(constraint, position).some((entry) => String(entry.id) === String(character.id))) {
        fixedSlots.delete(position);
      }
    }
    fixedSlotList.replaceChildren();
    for (let position = 1; position <= 5; position += 1) {
      const character = fixedSlots.get(position);
      const card = metagameUiElement("article", "metagame-fixed-slot");
      card.append(metagameUiElement("span", "", `${position}枠目`));
      if (character) {
        card.append(
          metagameUiElement("strong", "", character.name),
          metagameUiElement("small", "", `${attributeClassLabel(character.attributes)}・cost ${character.cost}・スキル${character.skillTurn}T`),
        );
      } else {
        card.append(
          metagameUiElement("strong", "", "自動選択"),
          metagameUiElement("small", "", "縛り一致キャラを検索"),
        );
      }
      const action = metagameUiElement("button", "", character ? "キャラを変更" : "キャラ検索");
      action.type = "button";
      action.disabled = !fixedSlotCandidates(constraint, position).length || Boolean(abortController);
      action.addEventListener("click", () => {
        openFixedPicker(position);
      });
      card.append(action);
      fixedSlotList.append(card);
    }
  };
  const updateEnvironmentPreview = () => {
    const constraint = selectedConstraint();
    renderSurveyedMetagameConstraints(surveyedConstraints, data.constraints, constraint?.id);
    renderFixedSlots(constraint);
    renderBoostedCharacters(constraint);
    renderBoostedPickerResults();
    if (!renderAvailablePrecomputedDeck()) displayedPrecomputedConstraintId = null;
  };
  syncTotalCostFromConstraint();
  updateEnvironmentPreview();
  select.addEventListener("change", () => {
    updateEnvironmentPreview();
  });
  totalCostInput.addEventListener("input", updateEnvironmentPreview);
  fixedClearButton.addEventListener("click", () => {
    fixedSlots.clear();
    closeFixedPicker();
    renderFixedSlots(selectedConstraint());
  });
  fixedPickerCloseButton.addEventListener("click", closeFixedPicker);
  fixedPickerSearchButton.addEventListener("click", renderFixedPickerResults);
  fixedPickerQuery.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    renderFixedPickerResults();
  });
  fixedPickerQuery.addEventListener("input", () => {
    clearTimeout(fixedPickerSearchTimer);
    fixedPickerSearchTimer = setTimeout(renderFixedPickerResults, 120);
  });
  boostedClearButton.addEventListener("click", () => {
    boostedCharacters.clear();
    boostedQuery.value = "";
    renderBoostedCharacters(selectedConstraint());
    renderBoostedPickerResults();
    displayedPrecomputedConstraintId = null;
    if (!renderAvailablePrecomputedDeck()) {
      renderMetagameSimulatorMessage(resultRoot, "補正キャラを解除しました。");
    }
  });
  boostedSearchButton.addEventListener("click", renderBoostedPickerResults);
  boostedQuery.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    renderBoostedPickerResults();
  });
  boostedQuery.addEventListener("input", () => {
    clearTimeout(boostedSearchTimer);
    boostedSearchTimer = setTimeout(renderBoostedPickerResults, 120);
  });
  interactiveScenarioSelect.addEventListener("change", () => {
    displayedPrecomputedConstraintId = null;
    renderMetagameSimulatorMessage(resultRoot, "自動追加環境を含む再検証数を変更しました。計算ボタンで反映します。");
  });
  surveyedConstraints.addEventListener("click", (event) => {
    const button = event.target.closest("[data-metagame-surveyed-constraint]");
    if (!button || button.disabled) return;
    select.value = button.dataset.metagameSurveyedAttribute;
    totalCostInput.value = button.dataset.metagameSurveyedCost;
    updateEnvironmentPreview();
  });
  if (!data.constraints.length) {
    renderMetagameSimulatorMessage(resultRoot, "枠別メタ環境評価が1縛り分完了すると利用できます。");
  }

  const setBusy = (busy) => {
    submitButton.disabled = busy || data.constraints.length === 0;
    select.disabled = busy;
    totalCostInput.disabled = busy;
    fixedSlotList.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
    fixedClearButton.disabled = busy;
    fixedPickerCloseButton.disabled = busy;
    fixedPickerSearchButton.disabled = busy;
    fixedPickerQuery.disabled = busy;
    boostedClearButton.disabled = busy;
    boostedSearchButton.disabled = busy;
    boostedQuery.disabled = busy;
    boostedList.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
    boostedResults.querySelectorAll("button").forEach((control) => { control.disabled = busy; });
    interactiveScenarioSelect.disabled = busy;
    if (busy) closeFixedPicker();
    surveyedConstraints.querySelectorAll("[data-metagame-surveyed-constraint]").forEach((button) => {
      button.disabled = busy;
    });
    cancelButton.hidden = !busy;
    progress.hidden = !busy;
    if (busy) {
      progressLabel.textContent = "環境と候補デッキを準備中";
      progressValue.textContent = "調査データを読み込み中";
      progressBar.style.width = "0%";
    } else {
      renderBoostedCharacters(selectedConstraint());
      renderBoostedPickerResults();
    }
  };

  cancelButton.addEventListener("click", () => abortController?.abort());
  const startCalculation = async (event) => {
    event?.preventDefault();
    if (abortController) return;
    displayedPrecomputedConstraintId = null;
    const baseConstraint = sourceConstraint();
    if (!baseConstraint) {
      renderMetagameSimulatorMessage(resultRoot, "選択した属性縛りの調査データが見つかりません。画面を再読み込みしてから選び直してください。", true);
      return;
    }
    const resolvedConstraint = selectedConstraint();
    abortController = new AbortController();
    setBusy(true);
    renderMetagameSimulatorMessage(resultRoot, `${resolvedConstraint.label}の候補を組み、調査済み環境で再対戦しています。進捗はこの下に表示します。`);
    try {
      const searchResult = await findBestMetagameDeck(data, baseConstraint.id, activeCharacters, {
        signal: abortController.signal,
        totalCost: Number(totalCostInput.value),
        fixedSlots: fixedSlotValues(),
        boostedCharacterIds: boostedCharacterIds(),
        automaticCharacterIds: [...automaticCharacterIds],
        interactiveScenarioCount: Number(interactiveScenarioSelect.value),
        onProgress: ({
          phase,
          completed,
          total,
          valid,
          slot,
          slots,
          checked,
          stageTotal,
          retained,
          deck,
          decks,
        }) => {
          const ratio = total > 0 ? completed / total : 0;
          if (phase === "candidate") {
            const slotNumber = Number(slot) || 1;
            const slotTotal = Number(slots) || 5;
            const checkedCount = Number(checked) || 0;
            const stageCount = Number(stageTotal) || 0;
            const candidateCount = Number(retained || valid || 0).toLocaleString("ja-JP");
            const completedCandidateStage = Number(completed) >= Number(total) && stageCount > 0;
            progressLabel.textContent = completedCandidateStage
              ? "候補デッキの絞り込み完了"
              : `候補デッキを探索中（${slotNumber}/${slotTotal}枠）`;
            progressValue.textContent = completedCandidateStage
              ? `${candidateCount}候補を確定。代表環境との最終対戦へ進みます。`
              : stageCount
                ? `${checkedCount.toLocaleString("ja-JP")} / ${stageCount.toLocaleString("ja-JP")} 通り・候補 ${candidateCount}`
                : "環境データと候補プールを準備中";
            progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 30)}%`;
            return;
          }
          if (phase === "simulation") {
            const deckNumber = Number(deck) || 1;
            const deckTotal = Number(decks) || 1;
            progressLabel.textContent = `最終対戦を検証中（${deckNumber}/${deckTotal}デッキ）`;
            progressValue.textContent = `${Number(completed).toLocaleString("ja-JP")} / ${Number(total).toLocaleString("ja-JP")} 対戦`;
            progressBar.style.width = `${30 + Math.round(Math.min(1, Math.max(0, ratio)) * 70)}%`;
            return;
          }
          if (phase === "environment") {
            const deckNumber = Number(deck) || 1;
            const deckTotal = Number(decks) || 1;
            progressLabel.textContent = `補正・追加キャラを実戦再評価中（${deckNumber}/${deckTotal}デッキ）`;
            progressValue.textContent = `${Number(completed).toLocaleString("ja-JP")} / ${Number(total).toLocaleString("ja-JP")} 対戦`;
            progressBar.style.width = `${30 + Math.round(Math.min(1, Math.max(0, ratio)) * 20)}%`;
            return;
          }
          progressLabel.textContent = phase === "candidate" ? "候補デッキを生成" : "完成デッキを再対戦";
          progressValue.textContent = phase === "candidate"
            ? valid ? `${valid.toLocaleString("ja-JP")}候補` : "組み合わせ中"
            : `${completed} / ${total}`;
          progressBar.style.width = `${Math.round(ratio * 100)}%`;
        },
      });
      renderMetagameSimulatorResult(resultRoot, searchResult, activeCharacters);
    } catch (error) {
      renderMetagameSimulatorMessage(
        resultRoot,
        error.name === "AbortError" ? "シミュレーションを中止しました。" : error.message,
        error.name !== "AbortError",
      );
    } finally {
      abortController = null;
      setBusy(false);
    }
  };
  form.addEventListener("submit", startCalculation);
  submitButton.addEventListener("click", startCalculation);
  return {
    setCharacters(nextCharacters, options = {}) {
      activeCharacters = Array.isArray(nextCharacters) ? [...nextCharacters] : [];
      automaticCharacterIds = new Set((options.automaticCharacterIds ?? []).map(String));
      updateEnvironmentPreview();
    },
  };
}
