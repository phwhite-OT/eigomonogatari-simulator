import { calculateCharacterStatStages, createManualCharacter } from "../data/characters.js";

const SKILL_DETAIL_CONFIG = Object.freeze({
  none: { fields: [], summary: "詳細設定はありません" },
  single_attack: { fields: ["multiplier", "allyAttribute", "enemyAttribute"], summary: "倍率・属性条件" },
  aoe_attack: { fields: ["duration", "allyAttribute", "enemyAttribute"], summary: "継続ターン・属性条件" },
  multi_hit_attack: { fields: ["hits", "duration", "allyAttribute", "enemyAttribute"], summary: "ヒット数・継続ターン・属性条件" },
  attack_buff: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "倍率・継続ターン・属性条件" },
  damage_reduction: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・継続ターン・属性条件" },
  guard: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・継続ターン・属性条件" },
  attribute_guard: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・継続ターン・属性条件" },
  heal: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "回復率・継続ターン・属性条件" },
  revive: { fields: ["multiplier", "allyAttribute", "enemyAttribute"], summary: "蘇生率・属性条件" },
  attribute_change: { fields: ["duration", "allyAttribute", "enemyAttribute", "effectAttribute"], summary: "継続ターン・属性条件・変更先属性" },
  skill_reduction: { fields: ["amount", "allyAttribute", "enemyAttribute"], summary: "短縮量・属性条件" },
  delay: { fields: ["amount", "allyAttribute", "enemyAttribute"], summary: "遅延量・属性条件" },
});

export function getSkillDetailConfig(skillType) {
  return SKILL_DETAIL_CONFIG[skillType] ?? SKILL_DETAIL_CONFIG.none;
}

function formValues(form) {
  return {
    name: form.elements.manualName.value,
    attributeClass: form.elements.manualAttribute.value,
    cost: form.elements.manualCost.value,
    hp: form.elements.manualHp.value,
    pow: form.elements.manualPow.value,
    statGrowth: form.elements.manualStatGrowth.value,
    baseHp: form.elements.manualNonLimitMaxHp.value,
    basePow: form.elements.manualNonLimitMaxPow.value,
    fullLimitBreakHp: form.elements.manualFullLimitMaxHp.value,
    fullLimitBreakPow: form.elements.manualFullLimitMaxPow.value,
    rarity: form.elements.manualRarity.value,
    region: form.elements.manualRegion.value,
    owned: form.elements.manualOwned.checked,
    skillTurn: form.elements.manualSkillTurn.value,
    skillType: form.elements.manualSkillType.value,
    skillName: form.elements.manualSkillName.value,
    skillCategory: form.elements.manualSkillCategory.value,
    multiplier: form.elements.manualSkillMultiplier.value,
    hits: form.elements.manualSkillHits.value,
    duration: form.elements.manualSkillDuration.value,
    amount: form.elements.manualSkillAmount.value,
    target: form.elements.manualSkillTarget.value,
    targetCount: form.elements.manualSkillTargetCount.value,
    allyAttribute: form.elements.manualSkillAllyAttribute.value,
    enemyAttribute: form.elements.manualSkillEnemyAttribute.value,
    effectAttribute: form.elements.manualSkillEffectAttribute.value,
  };
}

function syncSkillDefaults(form) {
  const skillType = form.elements.manualSkillType.value;
  form.elements.manualSkillTargetCount.value = skillType === "aoe_attack" ? "5" : "1";
  const config = getSkillDetailConfig(skillType);
  const details = form.querySelector("[data-character-editor-details]");
  const summary = form.querySelector("[data-character-editor-skill-details-summary]");
  if (details) {
    details.hidden = skillType === "none";
    if (details.hidden) details.removeAttribute("open");
  }
  if (summary) summary.textContent = "スキルの詳細設定（" + config.summary + "）";
  form.querySelectorAll("[data-skill-detail]").forEach((field) => {
    field.hidden = !config.fields.includes(field.dataset.skillDetail);
  });
}

function updateStatPreview(form) {
  const preview = form.querySelector("[data-character-stat-preview]");
  if (!preview) return;
  const hp = Number(form.elements.manualHp.value);
  const pow = Number(form.elements.manualPow.value);
  if (!Number.isFinite(hp) || hp <= 0 || !Number.isFinite(pow) || pow < 0) {
    preview.textContent = "無凸Lv1のHPとPowerを入力すると、選択中の育成状態で使う数値を表示します。";
    return;
  }
  const stages = calculateCharacterStatStages(hp, pow, {
    rarity: form.elements.manualRarity.value,
    nonLimitMaxHp: form.elements.manualNonLimitMaxHp.value,
    nonLimitMaxPow: form.elements.manualNonLimitMaxPow.value,
    fullLimitBreakHp: form.elements.manualFullLimitMaxHp.value,
    fullLimitBreakPow: form.elements.manualFullLimitMaxPow.value,
  });
  const stats = stages[form.elements.manualStatGrowth.value];
  if (!stats) {
    preview.textContent = "完凸LvMAXの数値を出すには、標準レア度（N/R/CR/ZR/MZR/伝）か個別の松ステータスを入力してください。";
    return;
  }
  const profile = stages.profile
    ? "標準上限: Lv" + stages.profile.normalMaxLevel + " → Lv" + stages.profile.fullLimitBreakMaxLevel
    : "個別ステータスを使用";
  preview.textContent = profile + " / 探索で使う値: HP " + stats.hp.toLocaleString("ja-JP") + " / Power " + stats.pow.toLocaleString("ja-JP");
}

function resetForm(form) {
  form.reset();
  form.elements.manualOwned.checked = true;
  form.elements.manualStatGrowth.value = "max_limit_break";
  form.elements.manualSkillTurn.value = "3";
  form.elements.manualSkillMultiplier.value = "1";
  form.elements.manualSkillHits.value = "1";
  form.elements.manualSkillDuration.value = "1";
  form.elements.manualSkillAmount.value = "0";
  form.elements.manualSkillTargetCount.value = "1";
  form.querySelectorAll("[data-character-editor-details]").forEach((details) => details.removeAttribute("open"));
  syncSkillDefaults(form);
  updateStatPreview(form);
}

export function initializeCharacterEditor(dialog, { getExistingIds, onAdd }) {
  if (!dialog) return { open() {} };
  const form = dialog.querySelector("[data-character-editor-form]");
  const message = dialog.querySelector("[data-character-editor-message]");
  const openButtons = document.querySelectorAll("[data-character-editor-open]");
  const closeButtons = dialog.querySelectorAll("[data-character-editor-close]");

  const showMessage = (text, error = false) => {
    message.textContent = text;
    message.classList.toggle("is-error", error);
  };
  const open = () => {
    resetForm(form);
    showMessage("無凸Lv1のHP・Powerと育成状態から最終値を自動計算し、すべての探索で共通利用します。");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    form.elements.manualName.focus();
  };
  const close = () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  openButtons.forEach((button) => button.addEventListener("click", open));
  closeButtons.forEach((button) => button.addEventListener("click", close));
  form.elements.manualSkillType.addEventListener("change", () => syncSkillDefaults(form));
  [
    form.elements.manualHp,
    form.elements.manualPow,
    form.elements.manualRarity,
    form.elements.manualNonLimitMaxHp,
    form.elements.manualNonLimitMaxPow,
    form.elements.manualFullLimitMaxHp,
    form.elements.manualFullLimitMaxPow,
  ].forEach((input) => {
    input.addEventListener("input", () => updateStatPreview(form));
  });
  form.elements.manualStatGrowth.addEventListener("change", () => updateStatPreview(form));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const character = createManualCharacter(formValues(form), getExistingIds());
      onAdd(character);
      close();
    } catch (error) {
      showMessage(error.message ?? String(error), true);
    }
  });

  return { open };
}
