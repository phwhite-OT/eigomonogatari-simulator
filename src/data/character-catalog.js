import { WORKBOOK_CHARACTERS, WORKBOOK_DATA_SUMMARY } from "./workbook-characters.js";
import { VERIFIED_2026_CHARACTER_SUPPLEMENTS } from "./character-supplements-2026.js";

// The workbook is the primary source. Keep exceptional, externally verified
// characters separate so regenerating Book1.xlsx never silently drops them.
export const MANUAL_CHARACTER_SUPPLEMENTS = Object.freeze([
  Object.freeze({
    source: Object.freeze({ sheet: "手動補完", row: "二条嬢☆浴衣モード" }),
    id: "manual-nijo-yukata-mode",
    name: "二条嬢☆浴衣モード",
    attributes: Object.freeze(["fire", "water"]),
    cost: 19,
    hp: 2656,
    pow: 2495,
    baseHp: 1650,
    basePow: 1550,
    maxLevel: 132,
    limitBreak: 6,
    rarity: "CR",
    region: "協力",
    owned: true,
    pvpTier: "normal",
    allowedPositions: Object.freeze([1, 2, 3, 4, 5]),
    preferredPositions: Object.freeze([1, 2, 3, 4, 5]),
    positionRule: "free",
    skillTurn: 1,
    maxUses: 2,
    skill: Object.freeze({
      type: "attribute_guard",
      multiplier: 0.2,
      hits: 1,
      amount: 0,
      target: "self",
      targetCount: 1,
      duration: 1,
      priority: "normal",
      conditions: Object.freeze([Object.freeze({ type: "enemy_attribute", attribute: "wind" })]),
      effects: Object.freeze([Object.freeze({ attribute: "wind" })]),
    }),
    skillName: "1ターンの間、風属性の攻撃を自身に集中させる(80%カット)",
    skillCategory: "敵色かばう",
    roleTags: Object.freeze(["attribute_guard", "tank"]),
    notes: "協力：夏祭り2019ボス。Book1.xlsx未収録のため手動補完。",
  }),
]);

export const CHARACTER_NAME_CORRECTIONS = Object.freeze({
  "em-7b3f53eed84e": "πちゃん先輩",
  "em-e49404c0e4be": "πてぃしえ先生",
  "em-6cd949ff7539": "πんしゅたいん教授",
  "em-dd80c8492923": "どろたにょん",
  "em-2c2759ede728": "どろんにょ先輩",
  "em-d77542ffe604": "女天下！どろーニャ",
  "em-c4b0b6848f16": "ぴんおんぱんちゃん",
  "em-215080a7a05b": "饅頭祭ぴよ子",
  "em-cc1dd429dace": "ぴんおんぱん娘。",
  "em-5e67f5f55234": "四悪妖★土蜘蛛",
  "em-3de6064f1850": "俊敏源氏！牛若。",
  "em-5b1667b398d0": "ソルジャーL.RED",
  "em-bc2106c87bcd": "カ",
  "em-0f3dc5f343f5": "カマドウマ",
  "em-628e695d4365": "カラクム先生",
});

export const CHARACTER_ATTRIBUTE_CORRECTIONS = Object.freeze({
  "em-c87499b64151": Object.freeze(["water", "wind"]),
});

// Verified post-import corrections. Keep these separate from the generated
// workbook export so that a future Book1.xlsx refresh does not reintroduce a
// known incorrect skill turn.
export const CHARACTER_SKILL_TURN_CORRECTIONS = Object.freeze({
  "em-8cafabee26c4": 4, // ホルトバージ君
  "em-dec390a52ee6": 2, // 英国ストヘン技師
});

const ATTACK_MODE_SKILL_TYPES = new Set(["aoe_attack", "multi_hit_attack"]);

// Book1 classifies attack-mode skills by who receives the mode (自身 / リーダー /
// 味方色 / 全員), while older generated exports stored enemy_one/enemy_all because
// those fields originally described the eventual attack target. Convert that legacy
// representation into the actual buff recipient before any simulator consumes it.
function correctWorkbookAttackModeTarget(character) {
  if (!ATTACK_MODE_SKILL_TYPES.has(character?.skill?.type)) return character;
  const category = String(character.skillCategory ?? "");
  let target;
  if (category.startsWith("自身")) target = "self";
  else if (category.startsWith("リーダー")) target = "leader";
  else if (category.startsWith("味方色") || category.startsWith("全員")) target = "ally_all";
  else return character;
  const targetCount = target === "ally_all" ? 5 : 1;
  if (character.skill.target === target && Number(character.skill.targetCount) === targetCount) return character;
  return Object.freeze({
    ...character,
    skill: Object.freeze({
      ...character.skill,
      target,
      targetCount,
    }),
  });
}

export const CHARACTER_CATALOG = Object.freeze([
  ...WORKBOOK_CHARACTERS.map((rawCharacter) => {
    const character = correctWorkbookAttackModeTarget(rawCharacter);
    const name = CHARACTER_NAME_CORRECTIONS[character.id];
    const attributes = CHARACTER_ATTRIBUTE_CORRECTIONS[character.id];
    const skillTurn = CHARACTER_SKILL_TURN_CORRECTIONS[character.id];
    if (!name && !attributes && skillTurn === undefined) return character;
    return Object.freeze({
      ...character,
      ...(name ? { name } : {}),
      ...(attributes ? { attributes } : {}),
      ...(skillTurn === undefined ? {} : { skillTurn }),
    });
  }),
  ...MANUAL_CHARACTER_SUPPLEMENTS,
  ...VERIFIED_2026_CHARACTER_SUPPLEMENTS,
]);

export const CHARACTER_CATALOG_SUMMARY = Object.freeze({
  ...WORKBOOK_DATA_SUMMARY,
  manualSupplements: MANUAL_CHARACTER_SUPPLEMENTS.length,
  verified2026Supplements: VERIFIED_2026_CHARACTER_SUPPLEMENTS.length,
  totalCharacters: CHARACTER_CATALOG.length,
});