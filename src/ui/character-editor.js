import { calculateCharacterStatStages, createManualCharacter, updateManualCharacter } from "../data/characters.js";

const SKILL_DETAIL_CONFIG = Object.freeze({
  none: { fields: [], summary: "詳細設定はありません" },
  single_attack: { fields: ["multiplier", "allyAttribute", "enemyAttribute"], summary: "倍率・属性条件" },
  aoe_attack: { fields: ["duration", "allyAttribute", "enemyAttribute"], summary: "持続ターン・属性条件" },
  multi_hit_attack: { fields: ["hits", "duration", "allyAttribute", "enemyAttribute"], summary: "ヒット数・持続ターン・属性条件" },
  attack_buff: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "倍率・持続ターン・属性条件" },
  damage_reduction: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・持続ターン・属性条件" },
  guard: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・持続ターン・属性条件" },
  attribute_guard: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "軽減率・持続ターン・属性条件" },
  heal: { fields: ["multiplier", "duration", "allyAttribute", "enemyAttribute"], summary: "回復量・持続ターン・属性条件" },
  revive: { fields: ["multiplier", "allyAttribute", "enemyAttribute"], summary: "蘇生量・属性条件" },
  attribute_change: { fields: ["duration", "allyAttribute", "enemyAttribute", "effectAttribute"], summary: "持続ターン・属性条件・変更後属性" },
  skill_reduction: { fields: ["amount", "allyAttribute", "enemyAttribute"], summary: "短縮量・属性条件" },
  delay: { fields: ["amount", "allyAttribute", "enemyAttribute"], summary: "遅延量・属性条件" },
});

const ATTRIBUTE_CLASS_BY_KEY = Object.freeze({
  fire: "fire",
  water: "water",
  wind: "wind",
  "fire,water": "fire_water",
  "fire,wind": "fire_wind",
  "water,wind": "water_wind",
  "fire,water,wind": "all",
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

function syncSkillDefaults(form, { preserveTargetCount = false } = {}) {
  const skillType = form.elements.manualSkillType.value;
  if (!preserveTargetCount) form.elements.manualSkillTargetCount.value = skillType === "aoe_attack" ? "5" : "1";
  const config = getSkillDetailConfig(skillType);
  const details = form.querySelector("[data-character-editor-details]");
  const summary = form.querySelector("[data-character-editor-skill-details-summary]");
  if (details) {
    details.hidden = skillType === "none";
    if (details.hidden) details.removeAttribute("open");
  }
  if (summary) summary.textContent = `スキルの詳細設定（${config.summary}）`;
  form.querySelectorAll("[data-skill-detail]").forEach((field) => {
    field.hidden = !config.fields.includes(field.dataset.skillDetail);
  });
}

function updateStatPreview(form) {
  const preview = form.querySelector("[data-character-stat-preview]");
  if (!preview) return;
  const hp = Number(form.elements.manualHp.value);
  const pow = Number(form.elements.manualPow.value);
  const statGrowth = form.elements.manualStatGrowth.value;
  if (!Number.isFinite(hp) || hp <= 0 || !Number.isFinite(pow) || pow < 0) {
    preview.textContent = "HPとPowerを入力すると、選択中の育成状態で使う数値を表示します。";
    return;
  }
  if (statGrowth === "final") {
    preview.textContent = `表示ステータスを直接使用: HP ${hp.toLocaleString("ja-JP")} / Power ${pow.toLocaleString("ja-JP")}`;
    return;
  }
  const stages = calculateCharacterStatStages(hp, pow, {
    rarity: form.elements.manualRarity.value,
    nonLimitMaxHp: form.elements.manualNonLimitMaxHp.value,
    nonLimitMaxPow: form.elements.manualNonLimitMaxPow.value,
    fullLimitBreakHp: form.elements.manualFullLimitMaxHp.value,
    fullLimitBreakPow: form.elements.manualFullLimitMaxPow.value,
  });
  const stats = stages[statGrowth];
  if (!stats) {
    preview.textContent = "完凸LvMAXの数値を使うには、対応するレア度または個別の到達ステータスを入力してください。";
    return;
  }
  const profile = stages.profile
    ? `標準上限: Lv${stages.profile.normalMaxLevel} → Lv${stages.profile.fullLimitBreakMaxLevel}`
    : "個別ステータスを使用";
  preview.textContent = `${profile} / 計算で使う値: HP ${stats.hp.toLocaleString("ja-JP")} / Power ${stats.pow.toLocaleString("ja-JP")}`;
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

function attributeClassFor(character) {
  return ATTRIBUTE_CLASS_BY_KEY[(character.attributes ?? []).join(",")] ?? "fire";
}

function conditionAttribute(character, type) {
  return character.skill?.conditions?.find((condition) => condition?.type === type)?.attribute ?? "";
}

function effectAttribute(character) {
  const attributes = character.skill?.effects?.map((effect) => effect?.attribute).filter(Boolean) ?? [];
  if (attributes.length === 3 && ["fire", "water", "wind"].every((attribute) => attributes.includes(attribute))) return "all";
  return attributes[0] ?? "";
}

function setFormValue(form, name, value) {
  const element = form.elements[name];
  if (element) element.value = value ?? "";
}

export function populateCharacterEditorForm(form, character) {
  const usesManualStages = character.manualStageStats === true;
  setFormValue(form, "manualName", character.name);
  setFormValue(form, "manualAttribute", attributeClassFor(character));
  setFormValue(form, "manualCost", character.cost);
  setFormValue(form, "manualHp", usesManualStages ? character.level1Hp : character.hp);
  setFormValue(form, "manualPow", usesManualStages ? character.level1Pow : character.pow);
  setFormValue(form, "manualStatGrowth", usesManualStages ? character.statGrowth : "final");
  setFormValue(form, "manualNonLimitMaxHp", usesManualStages ? character.baseHp : "");
  setFormValue(form, "manualNonLimitMaxPow", usesManualStages ? character.basePow : "");
  setFormValue(form, "manualFullLimitMaxHp", usesManualStages ? character.fullLimitBreakHp : "");
  setFormValue(form, "manualFullLimitMaxPow", usesManualStages ? character.fullLimitBreakPow : "");
  setFormValue(form, "manualRarity", character.rarity);
  setFormValue(form, "manualRegion", character.region);
  form.elements.manualOwned.checked = character.owned !== false;
  setFormValue(form, "manualSkillType", character.skill?.type ?? "none");
  setFormValue(form, "manualSkillTurn", character.skillTurn ?? 0);
  setFormValue(form, "manualSkillName", character.skillName);
  setFormValue(form, "manualSkillCategory", character.skillCategory === "-" ? "" : character.skillCategory);
  setFormValue(form, "manualSkillTarget", character.skill?.target ?? "");
  setFormValue(form, "manualSkillMultiplier", character.skill?.multiplier ?? 1);
  setFormValue(form, "manualSkillHits", character.skill?.hits ?? 1);
  setFormValue(form, "manualSkillDuration", character.skill?.duration ?? 1);
  setFormValue(form, "manualSkillAmount", character.skill?.amount ?? 0);
  setFormValue(form, "manualSkillTargetCount", character.skill?.targetCount ?? 1);
  setFormValue(form, "manualSkillAllyAttribute", conditionAttribute(character, "ally_attribute"));
  setFormValue(form, "manualSkillEnemyAttribute", conditionAttribute(character, "enemy_attribute"));
  setFormValue(form, "manualSkillEffectAttribute", effectAttribute(character));
  syncSkillDefaults(form, { preserveTargetCount: true });
  updateStatPreview(form);
}

export function initializeCharacterEditor(dialog, { getExistingIds = () => [], isAllowed = () => false, onAdd, onEdit } = {}) {
  if (!dialog) return { open() {}, openForEdit() {}, setAccess() {} };
  const form = dialog.querySelector("[data-character-editor-form]");
  const message = dialog.querySelector("[data-character-editor-message]");
  const mode = dialog.querySelector("[data-character-editor-mode]");
  const title = dialog.querySelector("[data-character-editor-title]");
  const submitButton = dialog.querySelector("[data-character-editor-submit]");
  const openButtons = document.querySelectorAll("[data-character-editor-open]");
  const closeButtons = dialog.querySelectorAll("[data-character-editor-close]");
  let editingCharacter = null;
  let insertionContext = null;
  let busy = false;

  const showMessage = (text, error = false) => {
    message.textContent = text;
    message.classList.toggle("is-error", error);
  };
  const setBusy = (nextBusy) => {
    busy = nextBusy;
    submitButton.disabled = nextBusy;
    form.setAttribute("aria-busy", String(nextBusy));
  };
  const close = () => {
    if (busy) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };
  const assertAllowed = () => {
    if (isAllowed()) return true;
    showMessage("キャラデータベースの追加・編集は管理者アカウント専用です。", true);
    return false;
  };
  const open = () => {
    if (!assertAllowed()) return;
    editingCharacter = null;
    insertionContext = null;
    resetForm(form);
    mode.textContent = "ADD CHARACTER";
    title.textContent = "キャラを追加";
    submitButton.textContent = "追加する";
    showMessage("無凸Lv1のHP・Powerと育成状態から、すべての計算で共通利用します。");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    form.elements.manualName.focus();
  };
  const openAtPosition = (anchor, position) => {
    if (!assertAllowed() || !anchor || !["before", "after"].includes(position)) return;
    editingCharacter = null;
    insertionContext = { anchor, position };
    resetForm(form);
    const direction = position === "before" ? "前" : "後";
    form.elements.manualRegion.value = anchor.region || "手入力";
    mode.textContent = "ADD AT POSITION";
    title.textContent = "指定位置にキャラを追加";
    submitButton.textContent = "この位置に追加";
    showMessage(`「${anchor.name}」（ID ${anchor.id}）の${direction}に追加します。保存後もこの位置を維持します。`);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    form.elements.manualName.focus();
  };
  const openForEdit = (character) => {
    if (!assertAllowed() || !character) return;
    editingCharacter = character;
    insertionContext = null;
    populateCharacterEditorForm(form, character);
    mode.textContent = "EDIT CHARACTER";
    title.textContent = "キャラを編集";
    submitButton.textContent = "変更を保存";
    showMessage(`ID ${character.id} を編集しています。保存するとキャラデータベースへ反映されます。`);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    form.elements.manualName.focus();
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
  ].forEach((input) => input.addEventListener("input", () => updateStatPreview(form)));
  form.elements.manualStatGrowth.addEventListener("change", () => updateStatPreview(form));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !assertAllowed()) return;
    try {
      setBusy(true);
      let character = editingCharacter
        ? updateManualCharacter(formValues(form), editingCharacter)
        : createManualCharacter(formValues(form), getExistingIds());
      if (insertionContext && !editingCharacter) {
        const anchor = insertionContext.anchor;
        character = {
          ...character,
          source: {
            ...(character.source ?? {}),
            sheet: anchor.source?.sheet || anchor.region || "追加キャラ・その他",
            row: "",
          },
          cataloguePlacement: {
            anchorId: String(anchor.id),
            position: insertionContext.position,
          },
        };
      }
      const save = editingCharacter ? onEdit : onAdd;
      if (typeof save !== "function") throw new TypeError("キャラデータベースの保存処理を開始できません。");
      await save(character, editingCharacter);
      setBusy(false);
      close();
    } catch (error) {
      showMessage(error?.message ?? String(error), true);
    } finally {
      setBusy(false);
    }
  });

  return { open, openAtPosition, openForEdit, setAccess() {} };
}
