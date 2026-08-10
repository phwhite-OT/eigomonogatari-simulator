import { WORKBOOK_CHARACTERS, WORKBOOK_DATA_SUMMARY } from "./workbook-characters.js";

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

export const CHARACTER_CATALOG = Object.freeze([
  ...WORKBOOK_CHARACTERS,
  ...MANUAL_CHARACTER_SUPPLEMENTS,
]);

export const CHARACTER_CATALOG_SUMMARY = Object.freeze({
  ...WORKBOOK_DATA_SUMMARY,
  manualSupplements: MANUAL_CHARACTER_SUPPLEMENTS.length,
  totalCharacters: CHARACTER_CATALOG.length,
});
