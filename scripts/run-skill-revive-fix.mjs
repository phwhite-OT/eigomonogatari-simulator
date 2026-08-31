import fs from "node:fs";

const patchPath = "scripts/apply-skill-revive-fix.mjs";
let source = fs.readFileSync(patchPath, "utf8");
const replacements = [
  [
    '["fire", "water", "wind"].map((defense) => [\\`${attack}:${defense}\\`, 1]),',
    '["fire", "water", "wind"].map((defense) => [attack + ":" + defense, 1]),',
  ],
  [
`  const next = applySkill(state, "allies", 0, simpleRules);

  assert.deepEqual(next.allies.map((combatant) => combatant.buffs.length), [0, 1, 1, 0]);`,
`  const buffed = applySkill(state, "allies", 0, simpleRules);
  const fireHit = applySkill(structuredClone(buffed), "allies", 1, simpleRules);
  const waterHit = applySkill(structuredClone(buffed), "allies", 2, simpleRules);
  const windHit = applySkill(structuredClone(buffed), "allies", 3, simpleRules);

  assert.equal(fireHit.enemies[0].currentHp, 800);
  assert.equal(waterHit.enemies[0].currentHp, 800);
  assert.equal(windHit.enemies[0].currentHp, 900);`,
  ],
];

for (const [before, after] of replacements) {
  if (!source.includes(before)) {
    throw new Error(`Expected patch snippet was not found: ${before.slice(0, 100)}`);
  }
  source = source.replace(before, after);
}

fs.writeFileSync(patchPath, source);
await import("./apply-skill-revive-fix.mjs");
fs.rmSync("scripts/run-skill-revive-fix.mjs", { force: true });
