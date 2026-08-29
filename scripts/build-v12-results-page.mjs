import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const resultsRoot = resolve(projectRoot, "reports/metagame-ratings-v12-team-opportunity");
const requiredModelVersion = "team-battle-v12.2-threshold-proxy";
const sourceSha = process.env.V12_RESULTS_SHA ?? "";
const preferredOrder = [
  "fire-100",
  "water-100",
  "wind-100",
  "fire-water-100",
  "fire-wind-100",
  "water-wind-100",
  "all-100",
  "fire-200",
  "water-200",
  "wind-200",
  "fire-water-200",
  "fire-wind-200",
  "water-wind-200",
  "all-200",
];
const attributeLabels = Object.freeze({ fire: "火", water: "水", wind: "風", all: "全属性" });

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function conditionLabel(directory) {
  const pieces = directory.split("-");
  const cost = pieces.pop();
  const attributes = pieces.map((piece) => attributeLabels[piece] ?? piece).join("+");
  return `${attributes}・コスト${cost}`;
}

function compactRow(row) {
  return {
    position: finiteNumber(row["枠"]),
    rank: finiteNumber(row["順位"]),
    id: row["キャラID"],
    name: row["名前"],
    cost: finiteNumber(row["コスト"]),
    hp: finiteNumber(row.HP),
    power: finiteNumber(row.Power),
    skillTurn: finiteNumber(row["スキルターン"]),
    skillType: row["スキル種類"],
    opportunityWinGain: finiteNumber(row["機会勝率差"]),
    robustOpportunityWinGain: finiteNumber(row["安定補正後差"]),
    candidateExpectedWinRate: finiteNumber(row["候補勝率"]),
    benchmarkExpectedWinRate: finiteNumber(row["代替勝率"]),
    candidateDeck: row["候補デッキ"],
    baselineDeck: row["代替デッキ"],
    evaluationStatus: row["評価状態"],
  };
}

async function loadCompletedConditions() {
  const directories = await readdir(resultsRoot, { withFileTypes: true });
  const available = directories.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  available.sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.localeCompare(right, "ja");
  });

  const conditions = [];
  for (const directory of available) {
    try {
      const progress = JSON.parse(await readFile(join(resultsRoot, directory, "progress.json"), "utf8"));
      if (progress.status !== "complete" || progress.context?.version !== requiredModelVersion) continue;
      const csv = await readFile(join(resultsRoot, directory, "ranking.csv"), "utf8");
      const rows = parseCsv(csv).map(compactRow).filter((row) => row.position && row.rank && row.name);
      conditions.push({
        id: progress.context?.inputId ?? directory.replace(/-(\d+)$/, ":$1"),
        directory,
        label: conditionLabel(directory),
        status: progress.status,
        modelVersion: progress.context?.version ?? "unknown",
        updatedAt: progress.updatedAt ?? null,
        environmentCount: progress.context?.environmentCount ?? progress.context?.teamScenarioCount ?? null,
        teamScenarioCount: progress.context?.teamScenarioCount ?? null,
        rows,
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return conditions;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const conditions = await loadCompletedConditions();
if (!conditions.length) {
  throw new Error(`No completed ${requiredModelVersion} results were found in ${resultsRoot}`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  sourceSha,
  requiredModelVersion,
  conditions,
};

const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>V12.2 環境評価 | DECK COMPASS</title>
  <style>
    :root{font-family:Inter,"Noto Sans JP","Yu Gothic",sans-serif;color:#182019;background:#f4f5ef;line-height:1.55}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#eef1e7 0,#f8f8f4 28rem,#f4f5ef 100%)}a{color:inherit}.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:14px clamp(16px,4vw,52px);background:rgba(247,248,242,.94);backdrop-filter:blur(16px);border-bottom:1px solid #dfe3d7}.brand{text-decoration:none;font-weight:900;letter-spacing:.06em}.back{padding:8px 13px;border:1px solid #cfd5c8;border-radius:999px;text-decoration:none;background:#fff;font-weight:700;font-size:.9rem}.page{width:min(1500px,calc(100% - 28px));margin:0 auto;padding:40px 0 70px}.hero{display:grid;grid-template-columns:1.4fr .8fr;gap:24px;align-items:end;margin-bottom:24px}.eyebrow{font-size:.75rem;font-weight:900;letter-spacing:.14em;color:#5d6d57}.hero h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05;margin:.4rem 0 1rem}.hero p{max-width:760px;color:#566057;margin:0}.summary{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.metric{background:#fff;border:1px solid #dfe3d7;border-radius:16px;padding:14px}.metric span{display:block;color:#6f786f;font-size:.75rem;font-weight:700}.metric strong{display:block;font-size:1.15rem;margin-top:3px}.notice{background:#17251b;color:#f3f7ef;border-radius:18px;padding:16px 18px;margin:20px 0 24px}.notice strong{color:#d7f0c9}.panel{background:rgba(255,255,255,.93);border:1px solid #dde2d7;border-radius:22px;box-shadow:0 12px 35px rgba(29,42,28,.06);overflow:hidden}.controls{display:flex;flex-wrap:wrap;gap:12px;padding:16px;border-bottom:1px solid #e3e6de;background:#fafbf7}.condition-tabs,.position-tabs{display:flex;gap:7px;flex-wrap:wrap}.chip{appearance:none;border:1px solid #ccd4c6;background:#fff;border-radius:999px;padding:8px 12px;font-weight:800;cursor:pointer}.chip[aria-pressed="true"]{background:#1f3b28;color:#fff;border-color:#1f3b28}.search{flex:1 1 260px;min-width:220px;padding:10px 12px;border:1px solid #cbd3c6;border-radius:12px;font:inherit}.select{padding:10px 12px;border:1px solid #cbd3c6;border-radius:12px;background:#fff;font:inherit}.meta{display:flex;flex-wrap:wrap;gap:9px;padding:12px 16px;border-bottom:1px solid #e7e9e3;color:#626c62;font-size:.82rem}.meta b{color:#273228}.table-wrap{overflow:auto;max-height:72vh}.results{width:100%;border-collapse:separate;border-spacing:0;min-width:1260px}.results th{position:sticky;top:0;z-index:3;background:#f1f4ed;color:#536052;text-align:left;font-size:.72rem;letter-spacing:.04em;padding:10px;border-bottom:1px solid #dce1d8;white-space:nowrap}.results td{padding:10px;border-bottom:1px solid #eceee9;vertical-align:top;font-size:.86rem}.results tbody tr:hover{background:#fafcf8}.rank{font-size:1rem;font-weight:900}.name{font-weight:900;font-size:.93rem}.id{display:block;color:#899187;font-size:.68rem;word-break:break-all}.number{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.positive{color:#16703d;font-weight:900}.negative{color:#a13a32;font-weight:900}.status{display:inline-flex;border-radius:999px;background:#e9efe6;padding:4px 8px;font-size:.72rem;font-weight:800;white-space:nowrap}.deck{max-width:330px}.deck details{min-width:260px}.deck summary{cursor:pointer;font-weight:800;color:#41533e}.deck p{margin:.45rem 0 0;color:#5d675c}.empty{padding:48px;text-align:center;color:#687267}.footer{margin-top:18px;color:#7a8279;font-size:.78rem}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}@media(max-width:850px){.hero{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}.page{width:min(100% - 20px,1500px);padding-top:24px}.controls{align-items:stretch}.search{flex-basis:100%}}
  </style>
</head>
<body>
  <header class="top"><a class="brand" href="index.html">DECK COMPASS</a><a class="back" href="index.html">← 通常のデッキ推薦へ</a></header>
  <main class="page">
    <section class="hero">
      <div><span class="eyebrow">TEAM OPPORTUNITY VALUE / V12.2</span><h1>V12.2 環境評価</h1><p>候補キャラ入りの最善デッキと、そのキャラを禁止して同じコスト上限で再最適化した最善デッキを比較した結果です。枠ごとに「そのキャラを使えることがチーム勝率をどれだけ動かしたか」を確認できます。</p></div>
      <div class="summary"><div class="metric"><span>完了済み条件</span><strong id="condition-count"></strong></div><div class="metric"><span>モデル</span><strong>V12.2</strong></div><div class="metric"><span>表示中の候補</span><strong id="row-count"></strong></div><div class="metric"><span>結果スナップショット</span><strong class="mono" id="source-sha"></strong></div></div>
    </section>
    <aside class="notice"><strong>V12.2の完了済み結果のみ表示。</strong> 最新実行では次の「全属性・コスト100」のシャード計算まで進みましたが、公開用マージ中にキャンセルされたため、このページには確定保存された条件だけを載せています。</aside>
    <section class="panel">
      <div class="controls"><div class="condition-tabs" id="condition-tabs" aria-label="環境条件"></div><div class="position-tabs" id="position-tabs" aria-label="枠"></div><input class="search" id="search" type="search" placeholder="キャラ名・ID・スキル・デッキ内キャラで検索"><select class="select" id="status-filter"><option value="">評価状態: すべて</option></select></div>
      <div class="meta" id="meta"></div>
      <div class="table-wrap"><table class="results"><thead><tr><th>順位</th><th>キャラ</th><th>コスト</th><th>HP</th><th>Power</th><th>スキル</th><th>機会勝率差</th><th>安定補正後差</th><th>候補勝率</th><th>代替勝率</th><th>評価状態</th><th>比較デッキ</th></tr></thead><tbody id="tbody"></tbody></table><div class="empty" id="empty" hidden>条件に一致する結果がありません。</div></div>
    </section>
    <p class="footer">「安定補正後差」はV12.2の順位付けに使われる保守的な差分です。負の値も隠さず表示します。生成: <span id="generated-at"></span></p>
  </main>
  <script id="v12-data" type="application/json">${safeJson(payload)}</script>
  <script>
    const data = JSON.parse(document.getElementById("v12-data").textContent);
    let activeCondition = data.conditions[0]?.id || "";
    let activePosition = 1;
    const tabs = document.getElementById("condition-tabs");
    const positions = document.getElementById("position-tabs");
    const tbody = document.getElementById("tbody");
    const search = document.getElementById("search");
    const statusFilter = document.getElementById("status-filter");
    const empty = document.getElementById("empty");
    const meta = document.getElementById("meta");
    const rowCount = document.getElementById("row-count");
    document.getElementById("condition-count").textContent = data.conditions.length + " 条件";
    document.getElementById("source-sha").textContent = data.sourceSha ? data.sourceSha.slice(0, 8) : "保存済み";
    document.getElementById("generated-at").textContent = new Intl.DateTimeFormat("ja-JP", {dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Tokyo"}).format(new Date(data.generatedAt));

    function pct(value) { return value == null ? "—" : (value * 100).toFixed(1) + "%"; }
    function pt(value) { if (value == null) return "—"; const n = value * 100; return (n >= 0 ? "+" : "") + n.toFixed(2) + "pt"; }
    function n(value) { return value == null ? "—" : Number(value).toLocaleString("ja-JP"); }
    function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
    function currentCondition() { return data.conditions.find((entry) => entry.id === activeCondition) || data.conditions[0]; }

    for (const condition of data.conditions) {
      const button = text("button", condition.label, "chip");
      button.type = "button";
      button.dataset.id = condition.id;
      button.setAttribute("aria-pressed", String(condition.id === activeCondition));
      button.addEventListener("click", () => { activeCondition = condition.id; renderTabs(); refreshStatuses(); render(); });
      tabs.append(button);
    }
    for (let position = 1; position <= 5; position += 1) {
      const button = text("button", position + "枠", "chip");
      button.type = "button";
      button.dataset.position = String(position);
      button.setAttribute("aria-pressed", String(position === activePosition));
      button.addEventListener("click", () => { activePosition = position; renderTabs(); refreshStatuses(); render(); });
      positions.append(button);
    }

    function renderTabs() {
      for (const button of tabs.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.id === activeCondition));
      for (const button of positions.querySelectorAll("button")) button.setAttribute("aria-pressed", String(Number(button.dataset.position) === activePosition));
    }

    function refreshStatuses() {
      const condition = currentCondition();
      const statuses = [...new Set(condition.rows.filter((row) => row.position === activePosition).map((row) => row.evaluationStatus).filter(Boolean))].sort();
      const previous = statusFilter.value;
      statusFilter.replaceChildren(new Option("評価状態: すべて", ""));
      for (const status of statuses) statusFilter.add(new Option(status, status));
      if (statuses.includes(previous)) statusFilter.value = previous;
    }

    function appendNumberCell(rowNode, value, formatter, signed) {
      const formatted = formatter(value);
      let className = "number";
      if (signed && value != null) className += value >= 0 ? " positive" : " negative";
      rowNode.append(text("td", formatted, className));
    }

    function render() {
      const condition = currentCondition();
      if (!condition) return;
      const query = search.value.trim().toLocaleLowerCase("ja");
      const status = statusFilter.value;
      const rows = condition.rows.filter((row) => {
        if (row.position !== activePosition) return false;
        if (status && row.evaluationStatus !== status) return false;
        if (!query) return true;
        return [row.name,row.id,row.skillType,row.candidateDeck,row.baselineDeck,row.evaluationStatus].join(" ").toLocaleLowerCase("ja").includes(query);
      });
      tbody.replaceChildren();
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.append(text("td", String(row.rank), "rank"));
        const character = document.createElement("td");
        character.append(text("span", row.name, "name"), text("span", row.id, "id"));
        tr.append(character);
        appendNumberCell(tr, row.cost, n, false);
        appendNumberCell(tr, row.hp, n, false);
        appendNumberCell(tr, row.power, n, false);
        tr.append(text("td", (row.skillTurn == null ? "—" : row.skillTurn + "T") + " / " + (row.skillType || "—")));
        appendNumberCell(tr, row.opportunityWinGain, pt, true);
        appendNumberCell(tr, row.robustOpportunityWinGain, pt, true);
        appendNumberCell(tr, row.candidateExpectedWinRate, pct, false);
        appendNumberCell(tr, row.benchmarkExpectedWinRate, pct, false);
        const statusCell = document.createElement("td"); statusCell.append(text("span", row.evaluationStatus || "—", "status")); tr.append(statusCell);
        const deckCell = document.createElement("td"); deckCell.className = "deck";
        const details = document.createElement("details");
        details.append(text("summary", "候補 / 代替デッキを見る"));
        const candidate = text("p", "候補: " + (row.candidateDeck || "—"));
        const baseline = text("p", "代替: " + (row.baselineDeck || "—"));
        details.append(candidate, baseline); deckCell.append(details); tr.append(deckCell);
        tbody.append(tr);
      }
      rowCount.textContent = rows.length.toLocaleString("ja-JP") + " 体";
      empty.hidden = rows.length > 0;
      const updated = condition.updatedAt ? new Intl.DateTimeFormat("ja-JP", {dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Tokyo"}).format(new Date(condition.updatedAt)) : "不明";
      meta.replaceChildren(
        text("span", "条件: "), text("b", condition.label),
        text("span", "枠: "), text("b", activePosition + "枠"),
        text("span", "モデル: "), text("b", condition.modelVersion),
        text("span", "更新: "), text("b", updated),
        text("span", "チームシナリオ: "), text("b", condition.teamScenarioCount == null ? "—" : String(condition.teamScenarioCount))
      );
    }

    search.addEventListener("input", render);
    statusFilter.addEventListener("change", render);
    refreshStatuses();
    renderTabs();
    render();
  </script>
</body>
</html>`;

await writeFile(resolve(projectRoot, "v12.html"), html, "utf8");

const indexPath = resolve(projectRoot, "index.html");
let indexHtml = await readFile(indexPath, "utf8");
if (!indexHtml.includes('href="v12.html"')) {
  indexHtml = indexHtml.replace(
    '<div class="header-actions">',
    '<div class="header-actions">\n      <a class="auth-button" href="v12.html" style="text-decoration:none;display:inline-flex;align-items:center">V12.2結果</a>',
  );
  await writeFile(indexPath, indexHtml, "utf8");
}

console.log(`Built v12.html with ${conditions.length} completed V12.2 conditions.`);
