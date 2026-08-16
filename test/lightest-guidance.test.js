import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildLightestGuidedCandidatePool } from "../src/core/lightest-guidance.js";

function character(id, cost, pow, skillTurn) {
  return {
    id,
    name: id,
    attributes: ["fire"],
    rarity: "N",
    cost,
    hp: 100,
    pow,
    owned: true,
    skillTurn,
    skill: { type: "none", target: "self" },
  };
}

test("攻略候補は同型でコスト・火力・耐久・発動ターンが劣るキャラを外す", () => {
  const superior = character("guided-superior", 2, 300, 1);
  const dominated = character("guided-dominated", 4, 200, 2);
  const reference = character("guided-reference", 5, 100, 9);
  const guidance = buildLightestGuidedCandidatePool([superior, dominated, reference], {
    enemies: [{ attributes: ["fire"], hp: 500, pow: 100 }],
    maxCost: 10,
    referenceDecks: [[reference]],
  }, {
    candidateGuidance: "stage",
    answerMultiplier: 1,
  });

  assert.equal(guidance.applied, true);
  assert.equal(guidance.sourceCandidateCount, 3);
  assert.deepEqual(guidance.characters.map((entry) => entry.id), ["guided-superior", "guided-reference"]);
});

test("公開上位デッキ中心では上位デッキの役割だけを低コスト候補へ広げる", () => {
  const attacker = { ...character("guided-attacker", 5, 200, 2), skill: { type: "attack_buff", target: "self" } };
  const cheaperAttacker = { ...character("guided-cheaper-attacker", 3, 150, 1), skill: { type: "attack_buff", target: "self" } };
  const reviver = { ...character("guided-reviver", 4, 10, 4), skill: { type: "revive", target: "ally_all" } };
  const unrelated = character("guided-unrelated", 1, 500, 0);
  const guidance = buildLightestGuidedCandidatePool([attacker, cheaperAttacker, reviver, unrelated], {
    enemies: [{ attributes: ["fire"], hp: 500, pow: 100 }],
    maxCost: 10,
    referenceDecks: [[attacker, reviver]],
  }, { candidateGuidance: "stage", referenceDeckCore: true, answerMultiplier: 1 });

  assert.equal(guidance.mode, "reference");
  assert.deepEqual(guidance.characters.map((entry) => entry.id), ["guided-attacker", "guided-cheaper-attacker", "guided-reviver"]);
});

test("複数の公開デッキ登録欄と攻略候補スイッチを表示する", () => {
  const template = readFileSync(new URL("../src/index.template.html", import.meta.url), "utf8");
  assert.match(template, /name="lightestReferenceDecks"/);
  assert.match(template, /name="lightestCandidateGuidance"/);
  assert.match(template, /name="lightestReferenceDeckCore"/);
  assert.match(template, /data-lightest-picker-open="event"/);
  assert.match(template, /data-lightest-picker-open="reference"/);
  assert.match(template, /data-lightest-picker-results/);
  assert.match(template, /data-lightest-picker-form/);
  assert.match(template, /data-lightest-picker-submit/);
  assert.match(template, /公開デッキを登録/);
  assert.match(template, /data-lightest-reference-count/);
  assert.doesNotMatch(template, /<form data-lightest-picker-form>/);
});
