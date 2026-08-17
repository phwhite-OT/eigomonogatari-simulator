import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { CHARACTER_CATALOG } from "../src/data/character-catalog.js";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceOrigin = "https://lets-eiigo.com";
const officialOrigin = "https://eigomonogatari.com";
const catalogueIndexUrl = `${sourceOrigin}/zukan-kanto`;
const imageDirectory = resolve(projectRoot, "character-images");
const sourceRegistryPath = resolve(imageDirectory, "lets-eiigo-sources.json");
const officialSourceRegistryPath = resolve(imageDirectory, "official-eigomonogatari-sources.json");
const unmatchedPath = resolve(imageDirectory, "lets-eiigo-unmatched.json");
const supportedExtensions = new Set([".avif", ".jpg", ".jpeg", ".png", ".webp"]);
const requestHeaders = { "User-Agent": "DeckCompass authorised image importer" };

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

function isColourVariantName(value) {
  return /[（(]\s*色違い\s*[）)]\s*$/u.test(String(value ?? ""));
}

function baseCharacterName(value) {
  return String(value ?? "").replace(/[（(]\s*色違い\s*[）)]\s*$/u, "").trim();
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

function extractImageEntries(html, pageUrl, sourceRegistry = "lets-eiigo") {
  const entries = [];
  for (const tag of html.matchAll(/<img\b[^>]*>/giu)) {
    const sourceUrl = sameOriginUrl(readAttribute(tag[0], "data-src") || readAttribute(tag[0], "src"));
    const name = readAttribute(tag[0], "alt");
    if (!sourceUrl || !name || !sourceUrl.pathname.includes("/wp-content/uploads/")) continue;
    entries.push({ name, sourceUrl: sourceUrl.href, pageUrl, sourceRegistry });
  }
  return entries;
}

function textFromHtml(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " "))
    .trim();
}

function officialCharacterName(value) {
  return textFromHtml(value).replace(/[【\[][^】\]]*[】\]]\s*$/gu, "").trim();
}

function extractOfficialImageEntries(html, pageUrl) {
  const entries = [];
  const seenEntries = new Set();
  const addEntry = (name, sourceValue) => {
    let sourceUrl;
    try {
      sourceUrl = new URL(sourceValue, officialOrigin);
    } catch {
      return;
    }
    if (!name || !/^https?:$/iu.test(sourceUrl.protocol) || !/(^|\.)englishstoryserver\.com$/iu.test(sourceUrl.hostname)) return;
    const key = `${name}\u0000${sourceUrl.href}`;
    if (seenEntries.has(key)) return;
    seenEntries.add(key);
    entries.push({ name, sourceUrl: sourceUrl.href, pageUrl, sourceRegistry: "official-eigomonogatari" });
  };
  for (const row of String(html ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const imageTag = row[1].match(/<img\b[^>]*>/iu)?.[0];
    const sourceValue = imageTag ? (readAttribute(imageTag, "data-src") || readAttribute(imageTag, "src")) : "";
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => textFromHtml(cell[1]));
    const name = officialCharacterName(cells[1]);
    addEntry(name, sourceValue);
  }
  for (const tag of String(html ?? "").matchAll(/<img\b[^>]*>/giu)) {
    const name = officialCharacterName(readAttribute(tag[0], "alt"));
    const sourceValue = readAttribute(tag[0], "data-src") || readAttribute(tag[0], "src");
    addEntry(name, sourceValue);
  }
  return entries;
}

async function fetchWordPressJson(url) {
  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  return { response, json: await response.json() };
}

async function fetchDetailPages() {
  const categoryUrl = new URL("/wp-json/wp/v2/categories", sourceOrigin);
  categoryUrl.searchParams.set("slug", "zukan");
  categoryUrl.searchParams.set("per_page", "1");
  const { json: categories } = await fetchWordPressJson(categoryUrl);
  const categoryId = categories[0]?.id;
  if (!categoryId) return [];

  const postUrl = new URL("/wp-json/wp/v2/posts", sourceOrigin);
  postUrl.searchParams.set("categories", String(categoryId));
  postUrl.searchParams.set("per_page", "100");
  postUrl.searchParams.set("page", "1");
  const { response: firstResponse, json: firstPage } = await fetchWordPressJson(postUrl);
  const pageCount = Math.max(1, Number(firstResponse.headers.get("x-wp-totalpages") ?? 1));
  const posts = [...firstPage];
  for (let page = 2; page <= pageCount; page += 1) {
    postUrl.searchParams.set("page", String(page));
    const { json } = await fetchWordPressJson(postUrl);
    posts.push(...json);
  }
  return posts.map((post) => ({
    pageUrl: String(post.link ?? ""),
    html: String(post.content?.rendered ?? ""),
  })).filter(({ pageUrl, html }) => pageUrl && html);
}

async function fetchPaginatedWordPressJson(origin, endpoint, label) {
  const requestUrl = new URL(endpoint, origin);
  requestUrl.searchParams.set("per_page", "100");
  requestUrl.searchParams.set("page", "1");
  const { response: firstResponse, json: firstPage } = await fetchWordPressJson(requestUrl);
  const pageCount = Math.max(1, Number(firstResponse.headers.get("x-wp-totalpages") ?? 1));
  const items = [...firstPage];
  const pages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
  const concurrency = 4;
  for (let index = 0; index < pages.length; index += concurrency) {
    const batch = pages.slice(index, index + concurrency);
    const pageItems = await Promise.all(batch.map(async (page) => {
      const url = new URL(requestUrl);
      url.searchParams.set("page", String(page));
      const { json } = await fetchWordPressJson(url);
      return json;
    }));
    items.push(...pageItems.flat());
    console.log(`Fetched ${label} article pages ${Math.min(index + concurrency + 1, pageCount)}/${pageCount}.`);
  }
  return items;
}

async function fetchWordPressPosts(origin, label, endpoint = "/wp-json/wp/v2/posts") {
  const posts = await fetchPaginatedWordPressJson(origin, endpoint, label);
  return posts.map((post) => ({
    pageUrl: String(post.link ?? ""),
    html: String(post.content?.rendered ?? ""),
  })).filter(({ pageUrl, html }) => pageUrl && html);
}

async function fetchLetsMediaEntries() {
  const media = await fetchPaginatedWordPressJson(sourceOrigin, "/wp-json/wp/v2/media", "lets-eiigo media");
  const entries = [];
  for (const item of media) {
    if (!String(item.mime_type ?? "").startsWith("image/")) continue;
    const sourceUrl = String(item.source_url ?? "").trim();
    if (!sourceUrl) continue;
    const names = new Set([
      textFromHtml(item.alt_text),
      textFromHtml(item.title?.rendered),
    ]);
    for (const name of names) {
      if (!name) continue;
      entries.push({
        name,
        sourceUrl,
        pageUrl: String(item.link ?? sourceUrl),
        sourceRegistry: "lets-eiigo",
        recordUnmatched: false,
      });
    }
  }
  return entries;
}

async function fetchLetsPosts() {
  return fetchWordPressPosts(sourceOrigin, "lets-eiigo");
}

async function fetchLetsPages() {
  return fetchWordPressPosts(sourceOrigin, "lets-eiigo fixed", "/wp-json/wp/v2/pages");
}

async function fetchOfficialPosts() {
  return fetchWordPressPosts(officialOrigin, "official");
}

async function fetchOfficialPages() {
  return fetchWordPressPosts(officialOrigin, "official fixed", "/wp-json/wp/v2/pages");
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

async function pruneMissingSourceRecords(sourceRegistry) {
  for (const characterId of Object.keys(sourceRegistry)) {
    if (!await existingImagePath(characterId)) delete sourceRegistry[characterId];
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

function charactersForImageName(name) {
  const isColourVariant = isColourVariantName(name);
  const characters = byName.get(normalizeName(baseCharacterName(name))) ?? [];
  const matchingVariation = characters.filter((character) => (
    String(character.source?.sheet ?? "") === "色違い"
  ) === isColourVariant);
  return matchingVariation.length ? matchingVariation : isColourVariant ? [] : characters;
}

function addCandidate(entry, candidates, seenCharacters) {
  const matchedCharacters = charactersForImageName(entry.name);
  if (!matchedCharacters.length) {
    if (entry.recordUnmatched !== false) candidates.push({ ...entry, status: "unmatched" });
    return;
  }
  for (const character of matchedCharacters) {
    if (seenCharacters.has(character.id)) continue;
    seenCharacters.add(character.id);
    candidates.push({ ...entry, character, status: "matched" });
  }
}

const indexResponse = await fetch(catalogueIndexUrl, {
  headers: requestHeaders,
});
if (!indexResponse.ok) throw new Error(`Could not fetch catalogue index: ${indexResponse.status}`);
const indexHtml = await indexResponse.text();
for (const url of extractCatalogueUrls(indexHtml)) imagePages.add(url);

const candidates = [];
const seenCharacters = new Set();
for (const pageUrl of [...imagePages]) {
  const response = pageUrl === catalogueIndexUrl
    ? { ok: true, text: async () => indexHtml }
    : await fetch(pageUrl, { headers: requestHeaders });
  if (!response.ok) {
    console.warn(`Skipped page ${pageUrl}: ${response.status}`);
    continue;
  }
  for (const entry of extractImageEntries(await response.text(), pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const detailPages = await fetchDetailPages();
for (const { pageUrl, html } of detailPages) {
  for (const entry of extractImageEntries(html, pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const letsPosts = await fetchLetsPosts();
for (const { pageUrl, html } of letsPosts) {
  for (const entry of extractImageEntries(html, pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const letsPages = await fetchLetsPages();
for (const { pageUrl, html } of letsPages) {
  for (const entry of extractImageEntries(html, pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const letsMediaEntries = await fetchLetsMediaEntries();
for (const entry of letsMediaEntries) {
  addCandidate(entry, candidates, seenCharacters);
}

const officialPosts = await fetchOfficialPosts();
for (const { pageUrl, html } of officialPosts) {
  for (const entry of extractOfficialImageEntries(html, pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const officialPages = await fetchOfficialPages();
for (const { pageUrl, html } of officialPages) {
  for (const entry of extractOfficialImageEntries(html, pageUrl)) {
    addCandidate(entry, candidates, seenCharacters);
  }
}

const unmatched = candidates.filter(({ status }) => status !== "matched").map(({ name, sourceUrl, pageUrl, sourceRegistry, status }) => ({ name, sourceUrl, pageUrl, sourceRegistry, status }));
const matched = candidates.filter(({ status }) => status === "matched");
const selected = imageLimit ? matched.slice(0, imageLimit) : matched;
await mkdir(imageDirectory, { recursive: true });
const sources = await readJson(sourceRegistryPath, {});
const officialSources = await readJson(officialSourceRegistryPath, {});
let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const [index, entry] of selected.entries()) {
  const sourceRegistry = entry.sourceRegistry === "official-eigomonogatari" ? officialSources : sources;
  const sourceRecord = {
    characterName: entry.character.name,
    sourcePage: entry.pageUrl,
    sourceImage: entry.sourceUrl,
    file: "",
  };
  const existing = await existingImagePath(String(entry.character.id));
  if (existing) {
    if (!sourceRegistry[String(entry.character.id)]) {
      sourceRecord.file = existing.split(/[\\/]/u).at(-1);
      sourceRegistry[String(entry.character.id)] = sourceRecord;
    }
    skipped += 1;
    continue;
  }
  try {
    const response = await fetch(entry.sourceUrl, { headers: requestHeaders });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const extension = extensionFor(response, entry.sourceUrl);
    const fileName = `${encodeURIComponent(String(entry.character.id))}${extension}`;
    await writeFile(resolve(imageDirectory, fileName), new Uint8Array(await response.arrayBuffer()));
    sourceRecord.file = fileName;
    sourceRegistry[String(entry.character.id)] = sourceRecord;
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

await pruneMissingSourceRecords(sources);
await pruneMissingSourceRecords(officialSources);
await writeJson(sourceRegistryPath, sources);
await writeJson(officialSourceRegistryPath, officialSources);
await writeJson(unmatchedPath, unmatched);
console.log(JSON.stringify({
  pages: imagePages.size,
  detailPages: detailPages.length,
  letsPosts: letsPosts.length,
  letsPages: letsPages.length,
  letsMediaEntries: letsMediaEntries.length,
  officialPosts: officialPosts.length,
  officialPages: officialPages.length,
  matched: matched.length,
  selected: selected.length,
  downloaded,
  skipped,
  failed,
  unmatched: unmatched.length,
}, null, 2));
