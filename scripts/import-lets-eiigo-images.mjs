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
  for (const row of String(html ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const imageTag = row[1].match(/<img\b[^>]*>/iu)?.[0];
    const sourceValue = imageTag ? (readAttribute(imageTag, "data-src") || readAttribute(imageTag, "src")) : "";
    let sourceUrl;
    try {
      sourceUrl = new URL(sourceValue, officialOrigin);
    } catch {
      continue;
    }
    if (!/^https?:$/iu.test(sourceUrl.protocol) || !/(^|\.)englishstoryserver\.com$/iu.test(sourceUrl.hostname)) continue;
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => textFromHtml(cell[1]));
    const name = officialCharacterName(cells[1]);
    if (!name) continue;
    entries.push({ name, sourceUrl: sourceUrl.href, pageUrl, sourceRegistry: "official-eigomonogatari" });
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

async function fetchOfficialPosts() {
  const postUrl = new URL("/wp-json/wp/v2/posts", officialOrigin);
  postUrl.searchParams.set("per_page", "100");
  postUrl.searchParams.set("page", "1");
  const { response: firstResponse, json: firstPage } = await fetchWordPressJson(postUrl);
  const pageCount = Math.max(1, Number(firstResponse.headers.get("x-wp-totalpages") ?? 1));
  const posts = [...firstPage];
  const pages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
  const concurrency = 4;
  for (let index = 0; index < pages.length; index += concurrency) {
    const batch = pages.slice(index, index + concurrency);
    const pagePosts = await Promise.all(batch.map(async (page) => {
      const url = new URL(postUrl);
      url.searchParams.set("page", String(page));
      const { json } = await fetchWordPressJson(url);
      return json;
    }));
    posts.push(...pagePosts.flat());
    console.log(`Fetched official article pages ${Math.min(index + concurrency + 1, pageCount)}/${pageCount}.`);
  }
  return posts.map((post) => ({
    pageUrl: String(post.link ?? ""),
    html: String(post.content?.rendered ?? ""),
  })).filter(({ pageUrl, html }) => pageUrl && html);
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

const indexResponse = await fetch(catalogueIndexUrl, {
  headers: requestHeaders,
});
if (!indexResponse.ok) throw new Error(`Could not fetch catalogue index: ${indexResponse.status}`);
const indexHtml = await indexResponse.text();
for (const url of extractCatalogueUrls(indexHtml)) imagePages.add(url);

const candidates = [];
const seenSources = new Set();
for (const pageUrl of [...imagePages]) {
  const response = pageUrl === catalogueIndexUrl
    ? { ok: true, text: async () => indexHtml }
    : await fetch(pageUrl, { headers: requestHeaders });
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

const detailPages = await fetchDetailPages();
for (const { pageUrl, html } of detailPages) {
  for (const entry of extractImageEntries(html, pageUrl)) {
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

const officialPosts = await fetchOfficialPosts();
for (const { pageUrl, html } of officialPosts) {
  for (const entry of extractOfficialImageEntries(html, pageUrl)) {
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
  officialPosts: officialPosts.length,
  matched: matched.length,
  selected: selected.length,
  downloaded,
  skipped,
  failed,
  unmatched: unmatched.length,
}, null, 2));
