import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_CHARACTERS } from "../src/data/characters.js";
import { resolveAttributeClass } from "../src/data/rules.js";
import { filterCandidates, isSkillTurnAllowedAtPosition, validateDeck } from "../src/core/filter.js";

test("exclude・属性・所持条件を探索前に適用する", () => {
  const { candidates } = filterCandidates(DEMO_CHARACTERS, {
    totalCost: 150,
    deckSize: 5,
    allowedAttributes: ["water"],
    ownedOnly: true,
  });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((character) => character.pvpTier !== "exclude"));
  assert.ok(candidates.every((character) => character.pvpTier !== "low"));
  assert.ok(candidates.every((character) => character.attributes.includes("water")));
  assert.ok(candidates.every((character) => character.owned));
});

test("コスト超過・重複・配置違反を拒否する", () => {
  const character = DEMO_CHARACTERS.find((candidate) => candidate.pvpTier === "normal");
  const deck = Array(5).fill(character);
  const validation = validateDeck(deck, { totalCost: character.cost * 4, deckSize: 5 });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("重複")));
  assert.ok(validation.errors.some((error) => error.includes("超過")));
});


test("最終枠だけ想定ターン以降の重いスキルも許可する", () => {
  const character = (skillTurn) => ({ skillTurn });
  assert.equal(isSkillTurnAllowedAtPosition(character(99), 1), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(1), 2), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(2), 2), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(3), 2), false);
  assert.equal(isSkillTurnAllowedAtPosition(character(2), 3), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(3), 3), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(4), 3), false);
  assert.equal(isSkillTurnAllowedAtPosition(character(4), 5), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(5), 5), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(6), 5), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(99), 5), true);
  assert.equal(isSkillTurnAllowedAtPosition(character(3), 5), false);
});


test("属性縛りは選択した火・水・風のいずれかを含むキャラを対象にする", () => {
  const base = {
    pvpTier: "normal",
    cost: 1,
    rarity: "R",
    region: "対戦",
    owned: true,
    allowedPositions: [1, 2, 3, 4, 5],
  };
  const characters = [
    { ...base, id: "fire", attributes: ["fire"] },
    { ...base, id: "fire-water", attributes: ["fire", "water"] },
    { ...base, id: "all", attributes: ["fire", "water", "wind"] },
  ];
  const fire = filterCandidates(characters, { totalCost: 10, allowedAttributes: ["fire"], includeLow: true });
  const water = filterCandidates(characters, { totalCost: 10, allowedAttributes: ["water"], includeLow: true });
  const wind = filterCandidates(characters, { totalCost: 10, allowedAttributes: ["wind"], includeLow: true });
  assert.deepEqual(fire.candidates.map(({ id }) => id), ["fire", "fire-water", "all"]);
  assert.deepEqual(water.candidates.map(({ id }) => id), ["fire-water", "all"]);
  assert.deepEqual(wind.candidates.map(({ id }) => id), ["all"]);
});
