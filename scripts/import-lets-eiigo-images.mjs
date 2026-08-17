import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceOrigin = "https://lets-eiigo.com";
const catalogueIndexUrl = `${sourceOrigin}/zukan-kanto`;
const imageDirectory = resolve(projectRoot, "character-images");
const sourceRegistryPath = resolve(imageDirectory, "lets-eiigo-sources.json");
const unmatchedPath = resolve(imageDirectory, "lets-eiigo-unmatched.json");
const supportedExtensions = new Set([".avif", ".jpg", ".jpeg", ".png", ".webp"]);

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function positiveInteger(value, fallback, minimum = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s　]/gu, "")
    .toLocaleLowerCase("ja-JP");
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function readAttribute(tag, name) {
  const matched = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return matched ? decodeHtml(matched[2]).trim() : "";
}

function sameOriginUrl(value) {
  try {
    const url = new URL(value, sourceOrigin);
    return url.origin === sourceOrigin ? url : null;
  } catch {
    return null;
  }
}

function extractCatalogueUrls(html) {
  const urls = new Set([catalogueIndexUrl]);
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/giu)) {
    const url = sameOriginUrl(decodeHtml(match[2]));
    if (url?.pathname.startsWith("/zukan-")) urls.add(url.href);
  }
  return [...urls].sort();
}

function extractImageEntries(html, pageUrl) {
  const entries = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/giu)) {
    const sourceUrl = sameOriginUrl(readAttribute(tag[0], "data-src") || readAttribute(tag[0], "src"));
    const name = readAttribute(tag[0], "alt");
    if (!sourceUrl || !name || !sourceUrl.pathname.includes("/wp-content/uploads/")) continue;
    entries.push({ name, sourceUrl: sourceUrl.href, pageUrl });
  }
  return entries;
}

function extensionFor(response, sourceUrl) {
  const contentType = String(response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  const fromType = {
    "image/avif": ".avif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  }[contentType];
  if (fromType) return fromType;
  const extension = extname(new URL(sourceUrl).pathname).toLowerCase();
  return supportedExtensions.has(extension) ? extension : ".jpg";
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function existingImagePath(characterId) {
  const stem = encodeURIComponent(characterId);
  for (const extension of supportedExtensions) {
    const path = resolve(imageDirectory, `${stem}${extension}`);
    if (await fileExists(path)) return path;
  }
  return "";
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

const imageLimit = positiveInteger(readArgument("image-limit", "0"), 0);
const delayMilliseconds = positiveInteger(readArgument("delay-ms", "175"), 175);
const imagePages = new Set();
const byName = new Map();
for (const character of CHARACTER_CATALOG) {
  const key = normalizeName(character.name);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(character);
}

const indexResponse = await fetch(catalogueIndexUrl, {
  headers: { "User-Agent": "DeckCompass authorised image importer" },
});
if (!indexResponse.ok) throw new Error(`Could not fetch catalogue index: ${indexResponse.status}`);
const indexHtml = await indexResponse.text();
for (const url of extractCatalogueUrls(indexHtml)) imagePages.add(url);

const candidates = [];
const seenSources = new Set();
for (const pageUrl of [...imagePages]) {
  const response = pageUrl === catalogueIndexUrl
    ? { ok: true, text: async () => indexHtml }
    : await fetch(pageUrl, { headers: { "User-Agent": "DeckCompass authorised image importer" } });
  if (!response.ok) {
    console.warn(`Skipped page ${pageUrl}: ${response.status}`);
    continue;
  }
  for (const entry of extractImageEntries(await response.text(), pageUrl)) {
    const matchedCharacters = byName.get(normalizeName(entry.name)) ?? [];
    if (matchedCharacters.length !== 1) {
      candidates.push({ ...entry, status: matchedCharacters.length ? "ambiguous" : "unmatched" });
      continue;
    }
    const character = matchedCharacters[0];
    if (seenSources.has(character.id)) continue;
    seenSources.add(character.id);
    candidates.push({ ...entry, character, status: "matched" });
  }
}

const unmatched = candidates.filter(({ status }) => status !== "matched").map(({ name, sourceUrl, pageUrl, status }) => ({ name, sourceUrl, pageUrl, status }));
const matched = candidates.filter(({ status }) => status === "matched");
const selected = imageLimit ? matched.slice(0, imageLimit) : matched;
await mkdir(imageDirectory, { recursive: true });
const sources = await readJson(sourceRegistryPath, {});
let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const [index, entry] of selected.entries()) {
  const existing = await existingImagePath(String(entry.character.id));
  if (existing) {
    skipped += 1;
    continue;
  }
  try {
    const response = await fetch(entry.sourceUrl, { headers: { "User-Agent": "DeckCompass authorised image importer" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const extension = extensionFor(response, entry.sourceUrl);
    const fileName = `${encodeURIComponent(String(entry.character.id))}${extension}`;
    await writeFile(resolve(imageDirectory, fileName), new Uint8Array(await response.arrayBuffer()));
    sources[String(entry.character.id)] = {
      characterName: entry.character.name,
      sourcePage: entry.pageUrl,
      sourceImage: entry.sourceUrl,
      file: fileName,
    };
    downloaded += 1;
  } catch (error) {
    failed += 1;
    console.warn(`Failed ${entry.character.name}: ${error.message}`);
  }
  if ((index + 1) % 100 === 0 || index + 1 === selected.length) {
    console.log(`Processed ${index + 1}/${selected.length} images (downloaded ${downloaded}, skipped ${skipped}, failed ${failed}).`);
  }
  if (delayMilliseconds && index + 1 < selected.length) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMilliseconds));
  }
}

await writeFile(sourceRegistryPath, `${JSON.stringify(sources, null, 2)}\n`, "utf8");
await writeFile(unmatchedPath, `${JSON.stringify(unmatched, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  pages: imagePages.size,
  matched: matched.length,
  selected: selected.length,
  downloaded,
  skipped,
  failed,
  unmatched: unmatched.length,
}, null, 2));
