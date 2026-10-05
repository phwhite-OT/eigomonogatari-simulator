import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceOrigin = "https://eigomonogatari.com";
const imageDirectory = resolve(projectRoot, "character-images");
const sourceRegistryPath = resolve(imageDirectory, "official-sources.json");
const unmatchedPath = resolve(imageDirectory, "official-unmatched.json");
const supportedExtensions = new Set([".avif", ".jpg", ".jpeg", ".png", ".webp"]);
const requestHeaders = { "User-Agent": "DeckCompass official-site image importer" };

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s　]/gu, "")
    .toLocaleLowerCase("ja-JP");
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function textFromHtml(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " "))
    .trim();
}

function readAttribute(tag, name) {
  const matched = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return matched ? decodeHtml(matched[2]).trim() : "";
}

function sameOfficialUrl(value) {
  try {
    const url = new URL(value, sourceOrigin);
    return url.origin === sourceOrigin ? url : null;
  } catch {
    return null;
  }
}

async function officialFetch(value, options = {}) {
  const url = sameOfficialUrl(String(value));
  if (!url) throw new Error(`Blocked non-official URL: ${String(value)}`);
  return fetch(url, options);
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
    const content = await readFile(path, "utf8");
    return content.trim() ? JSON.parse(content) : fallback;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
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

async function fetchPaginated(endpoint, label) {
  const requestUrl = new URL(endpoint, sourceOrigin);
  requestUrl.searchParams.set("per_page", "100");
  requestUrl.searchParams.set("page", "1");
  const first = await officialFetch(requestUrl, { headers: requestHeaders });
  if (!first.ok) throw new Error(`${label} page 1: HTTP ${first.status}`);
  const firstItems = await first.json();
  const pageCount = Math.max(1, Number(first.headers.get("x-wp-totalpages") ?? 1));
  const items = [...firstItems];
  for (let page = 2; page <= pageCount; page += 1) {
    requestUrl.searchParams.set("page", String(page));
    const response = await officialFetch(requestUrl, { headers: requestHeaders });
    if (!response.ok) throw new Error(`${label} page ${page}: HTTP ${response.status}`);
    items.push(...await response.json());
    if (page % 20 === 0 || page === pageCount) console.log(`Fetched ${label}: ${page}/${pageCount}`);
  }
  return items;
}

function imageEntriesFromHtml(html, pageUrl) {
  const entries = [];
  for (const tag of String(html).matchAll(/<img\b[^>]*>/giu)) {
    const sourceUrl = sameOfficialUrl(readAttribute(tag[0], "data-src") || readAttribute(tag[0], "src"));
    const name = readAttribute(tag[0], "alt");
    if (!sourceUrl || !name) continue;
    entries.push({ name, sourceUrl: sourceUrl.href, pageUrl, sourceKind: "html-alt" });
  }

  for (const figure of String(html).matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/giu)) {
    const body = figure[1];
    const imageTag = body.match(/<img\b[^>]*>/iu)?.[0] ?? "";
    const sourceUrl = sameOfficialUrl(readAttribute(imageTag, "data-src") || readAttribute(imageTag, "src"));
    const caption = textFromHtml(body.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/iu)?.[1] ?? "");
    if (sourceUrl && caption) {
      entries.push({ name: caption, sourceUrl: sourceUrl.href, pageUrl, sourceKind: "figure-caption" });
    }
  }
  return entries;
}

const byName = new Map();
for (const character of CHARACTER_CATALOG) {
  const key = normalizeName(character.name);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(character);
}

await mkdir(imageDirectory, { recursive: true });
const missingCharacters = [];
for (const character of CHARACTER_CATALOG) {
  if (!await existingImagePath(String(character.id))) missingCharacters.push(character);
}
const missingIds = new Set(missingCharacters.map((character) => String(character.id)));
console.log(`Missing before official import: ${missingCharacters.length}/${CHARACTER_CATALOG.length}`);

const OFFICIAL_NAME_ALIASES = new Map([
  // Confirmed official-site spellings that differ from the current catalogue.
  [normalizeName("はみぎタンさん"), normalizeName("はぎみタンさん")],
  [normalizeName("νにゅーさん"), normalizeName("vにゅーさん")],
]);

function matchingCharacters(name) {
  const normalized = normalizeName(name)
    .replace(/[【\[][^】\]]*[】\]]$/u, "")
    .replace(/アイコン$/u, "");
  const lookup = OFFICIAL_NAME_ALIASES.get(normalized) ?? normalized;
  return (byName.get(lookup) ?? []).filter((character) => missingIds.has(String(character.id)));
}

const normalizedMissingNames = missingCharacters.map((character) => ({
  character,
  normalized: normalizeName(character.name),
}));
for (const [officialName, catalogueName] of OFFICIAL_NAME_ALIASES) {
  const character = (byName.get(catalogueName) ?? []).find((entry) => missingIds.has(String(entry.id)));
  if (character) normalizedMissingNames.push({ character, normalized: officialName });
}

function mentionedMissingCharacters(value) {
  const normalizedText = normalizeName(textFromHtml(value));
  if (!normalizedText) return [];
  const found = new Map();
  for (const entry of normalizedMissingNames) {
    if (entry.normalized && normalizedText.includes(entry.normalized)) {
      found.set(String(entry.character.id), entry.character);
    }
  }
  return [...found.values()];
}

function imageSourceFromTag(tag) {
  return sameOfficialUrl(
    readAttribute(tag, "data-src")
    || readAttribute(tag, "data-lazy-src")
    || readAttribute(tag, "src"),
  );
}

function contextualImageEntriesFromHtml(html, pageUrl) {
  const entries = [];
  const source = String(html ?? "");

  // Official gacha/event tables often have a generic image alt and put the
  // character name elsewhere in the same row.
  for (const rowMatch of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const row = rowMatch[1];
    const characters = mentionedMissingCharacters(row);
    const imageTags = [...row.matchAll(/<img\b[^>]*>/giu)].map((match) => match[0]);
    if (characters.length !== 1 || imageTags.length !== 1) continue;
    const sourceUrl = imageSourceFromTag(imageTags[0]);
    if (!sourceUrl) continue;
    entries.push({
      name: characters[0].name,
      sourceUrl: sourceUrl.href,
      pageUrl,
      sourceKind: "official-table-context",
    });
  }

  // Many event articles use: character name -> image -> next character name -> image.
  // Only associate an image when the text since the previous image identifies
  // exactly one missing character.
  const withoutTables = source.replace(/<table\b[^>]*>[\s\S]*?<\/table>/giu, " ");
  const imageMatches = [...withoutTables.matchAll(/<img\b[^>]*>/giu)];
  let previousEnd = 0;
  for (const match of imageMatches) {
    const before = withoutTables.slice(Math.max(previousEnd, match.index - 1200), match.index);
    const characters = mentionedMissingCharacters(before);
    const sourceUrl = imageSourceFromTag(match[0]);
    if (sourceUrl && characters.length === 1) {
      entries.push({
        name: characters[0].name,
        sourceUrl: sourceUrl.href,
        pageUrl,
        sourceKind: "official-sequential-context",
      });
    }
    previousEnd = match.index + match[0].length;
  }
  return entries;
}

const candidates = [];
const seenCandidateKeys = new Set();
function addEntry(entry) {
  const sourceUrl = sameOfficialUrl(entry.sourceUrl);
  const pageUrl = sameOfficialUrl(entry.pageUrl);
  if (!sourceUrl || !pageUrl) return;
  for (const character of matchingCharacters(entry.name)) {
    const key = `${character.id}\n${sourceUrl.href}`;
    if (seenCandidateKeys.has(key)) continue;
    seenCandidateKeys.add(key);
    candidates.push({ ...entry, sourceUrl: sourceUrl.href, pageUrl: pageUrl.href, character });
  }
}

let media = [];
try {
  media = await fetchPaginated("/wp-json/wp/v2/media", "official media");
  for (const item of media) {
    if (!String(item.mime_type ?? "").startsWith("image/")) continue;
    const sourceUrl = sameOfficialUrl(String(item.source_url ?? ""));
    if (!sourceUrl) continue;
    const pageUrl = sameOfficialUrl(String(item.link ?? sourceUrl.href)) ?? sourceUrl;
    const names = new Set([
      textFromHtml(item.alt_text),
      textFromHtml(item.title?.rendered),
      textFromHtml(item.caption?.rendered),
    ]);
    for (const name of names) {
      if (name) addEntry({ name, sourceUrl: sourceUrl.href, pageUrl: pageUrl.href, sourceKind: "wp-media" });
    }
  }
} catch (error) {
  console.warn(`Official media API unavailable: ${error.message}`);
}

const contentCollections = new Map([
  ["/wp-json/wp/v2/posts", "official posts"],
  ["/wp-json/wp/v2/pages", "official pages"],
]);

try {
  const response = await officialFetch("/wp-json/wp/v2/types", { headers: requestHeaders });
  if (response.ok) {
    const types = await response.json();
    for (const type of Object.values(types ?? {})) {
      const restBase = String(type?.rest_base ?? "").trim();
      if (!restBase || restBase === "media" || restBase === "posts" || restBase === "pages") continue;
      if (type?.viewable === false) continue;
      contentCollections.set(`/wp-json/wp/v2/${restBase}`, `official ${restBase}`);
    }
  } else {
    console.warn(`Official post-types API unavailable: HTTP ${response.status}`);
  }
} catch (error) {
  console.warn(`Official post-types discovery failed: ${error.message}`);
}

console.log(`Official content collections: ${[...contentCollections.keys()].join(", ")}`);

for (const [endpoint, label] of contentCollections) {
  try {
    const items = await fetchPaginated(endpoint, label);
    for (const item of items) {
      const pageUrl = sameOfficialUrl(String(item.link ?? ""));
      if (!pageUrl) continue;
      const rendered = String(item.content?.rendered ?? "");
      for (const entry of imageEntriesFromHtml(rendered, pageUrl.href)) addEntry(entry);
      for (const entry of contextualImageEntriesFromHtml(rendered, pageUrl.href)) addEntry(entry);
    }
  } catch (error) {
    console.warn(`${label} API unavailable: ${error.message}`);
  }
}

const selectedByCharacter = new Map();
for (const entry of candidates) {
  const id = String(entry.character.id);
  if (!selectedByCharacter.has(id)) selectedByCharacter.set(id, entry);
}

const registry = await readJson(sourceRegistryPath, {});
let downloaded = 0;
let failed = 0;
for (const entry of selectedByCharacter.values()) {
  const id = String(entry.character.id);
  if (await existingImagePath(id)) continue;
  try {
    const response = await officialFetch(entry.sourceUrl, { headers: requestHeaders });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error(`Not an image: ${contentType || "unknown"}`);
    const extension = extensionFor(response, entry.sourceUrl);
    const fileName = `${encodeURIComponent(id)}${extension}`;
    await writeFile(resolve(imageDirectory, fileName), new Uint8Array(await response.arrayBuffer()));
    registry[id] = {
      characterName: entry.character.name,
      sourcePage: entry.pageUrl,
      sourceImage: entry.sourceUrl,
      sourceKind: entry.sourceKind,
      file: fileName,
    };
    downloaded += 1;
  } catch (error) {
    failed += 1;
    console.warn(`Failed ${entry.character.name}: ${error.message}`);
  }
}

const stillMissing = [];
for (const character of CHARACTER_CATALOG) {
  if (!await existingImagePath(String(character.id))) {
    stillMissing.push({
      id: String(character.id),
      name: character.name,
      category: String(character.source?.sheet ?? character.region ?? ""),
    });
  }
}
await writeJson(sourceRegistryPath, registry);
await writeJson(unmatchedPath, stillMissing);

console.log(JSON.stringify({
  officialMedia: media.length,
  candidateImages: candidates.length,
  matchedCharacters: selectedByCharacter.size,
  downloaded,
  failed,
  missingAfter: stillMissing.length,
  missingNames: stillMissing.map(({ name }) => name).slice(0, 150),
}, null, 2));
