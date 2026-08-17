import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildMetagameSimulatorData } from "./build-metagame-simulator-data.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
if (!process.argv.includes("--skip-metagame-data")) {
  await buildMetagameSimulatorData();
}
const sourceFiles = [
  "src/data/rules.js",
  "src/data/characters.js",
  "src/data/character-database.js",
  "src/data/workbook-characters.js",
  "src/data/character-catalog.js",
  "src/data/character-image-manifest.js",
  "src/data/character-images.js",
  "src/data/metagame-simulator-data.js",
  "src/core/damage.js",
  "src/core/filter.js",
  "src/core/battleState.js",
  "src/core/skills.js",
  "src/core/simulate.js",
  "src/core/evaluate.js",
  "src/core/environment-rating.js",
  "src/core/search-fast.js",
  "src/core/metagame-deck.js",
  "src/core/lightest-exact.js",
  "src/core/lightest-guidance.js",
  "src/core/lightest.js",
  "src/core/character-catalogue.js",
  "src/core/character-search.js",
  "src/ui/form.js",
  "src/ui/result.js",
  "src/ui/metagame-simulator.js",
  "src/ui/lightest.js",
  "src/ui/character-search.js",
  "src/ui/character-editor.js",
  "src/ui/tabs.js",
  "src/auth/admin.js",
  "src/auth/supabase-auth.js",
  "src/app.js",
];

function stripModuleSyntax(source, fileName) {
  return source
    .replace(/import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?\s*/g, "")
    .replace(/^export\s+/gm, "")
    .replace(/^/gm, "  ")
    .replace(/[ \t]+$/gm, "")
    .concat(`\n  //# sourceURL=${fileName}\n`);
}

const [template, styles, ...sources] = await Promise.all([
  readFile(resolve(projectRoot, "src/index.template.html"), "utf8"),
  readFile(resolve(projectRoot, "src/styles.css"), "utf8"),
  ...sourceFiles.map((fileName) => readFile(resolve(projectRoot, fileName), "utf8")),
]);

for (const [index, source] of sources.entries()) {
  for (const match of source.matchAll(/import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const dependency = relative(
      projectRoot,
      resolve(projectRoot, dirname(sourceFiles[index]), specifier),
    ).replaceAll("\\", "/");
    const dependencyIndex = sourceFiles.indexOf(dependency);
    if (dependencyIndex === -1) {
      throw new Error(`${sourceFiles[index]} の依存ファイル ${dependency} がビルド対象に含まれていません。`);
    }
    if (dependencyIndex > index) {
      throw new Error(`${dependency} は ${sourceFiles[index]} より前に配置してください。`);
    }
  }
}

const script = `(function () {\n  "use strict";\n${sources
  .map((source, index) => stripModuleSyntax(source, sourceFiles[index]))
  .join("\n")}\n})();`;
const output = template
  .replace("/*__INLINE_STYLES__*/", () => styles)
  .replace("//__INLINE_SCRIPT__", () => script);

await writeFile(resolve(projectRoot, "index.html"), output, "utf8");
console.log(`Built index.html (${Buffer.byteLength(output).toLocaleString("en-US")} bytes)`);
