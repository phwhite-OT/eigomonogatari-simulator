import fs from "node:fs";

const patchPath = "scripts/apply-skill-revive-fix.mjs";
let source = fs.readFileSync(patchPath, "utf8");
const broken = '["fire", "water", "wind"].map((defense) => [\\`${attack}:${defense}\\`, 1]),';
const fixed = '["fire", "water", "wind"].map((defense) => [attack + ":" + defense, 1]),';
if (!source.includes(broken)) {
  throw new Error("Expected regression-test template snippet was not found");
}
fs.writeFileSync(patchPath, source.replace(broken, fixed));
await import("./apply-skill-revive-fix.mjs");
fs.rmSync("scripts/run-skill-revive-fix.mjs", { force: true });
