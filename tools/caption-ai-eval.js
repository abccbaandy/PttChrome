// 評估頁本體（dev-only，見 caption-ai-eval.html 檔頭）。
//
// 語料重建刻意走 **app 自己的真實路徑**：cassette bytes → AnsiParser → TermBuf →
// getRowText → resolvePageOverlap 累積（鏡像 term_view.js#accumulatePageLines）。
// 不手抄文章文字，量到的才是「這功能在真實輸入上的表現」。
import { TermBuf } from "../src/js/term_buf";
import { AnsiParser } from "../src/js/ansi_parser";
import { findPageOverlap, resolvePageOverlap } from "../src/js/comment_parse";
import { parseStatusRow } from "../src/js/string_util";
import { buildCaptionSpans, spanNeedsAi } from "../src/js/caption_ai_logic";
import {
  captionAiAvailability,
  ensureCaptionAiReady,
  classifySpan,
} from "../src/js/caption_ai";
import cases from "./caption-ai-cases.json";
import b2uTableUrl from "../src/conv/b2u_table.bin?url";
import u2bTableUrl from "../src/conv/u2b_table.bin?url";

const cassetteModules = import.meta.glob("../tests/e2e/cassettes/*.json");

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  $("status").textContent += msg + "\n";
};

async function loadBig5Tables() {
  const [b2u, u2b] = await Promise.all(
    [b2uTableUrl, u2bTableUrl].map((u) =>
      fetch(u).then((r) => r.arrayBuffer()),
    ),
  );
  window.lib = window.lib || {};
  window.lib.b2uArray = new Uint8Array(b2u);
  window.lib.u2bArray = new Uint8Array(u2b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 逐 step 餵進真實 parser/buf，取每頁 24 列文字。isLeadByte 在 buf 的 update
// pass 才標記（notify 30ms + settle 50ms），所以每頁餵完要讓事件回圈跑一下，
// 否則 getRowText 會吐出未轉碼的 Big5 位元組。
async function pageScreensOf(cassette) {
  const buf = new TermBuf(cassette.cols, cassette.rows);
  buf.setView({ update() {}, updateCursorPos() {}, blinkOn: false });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  const screens = [];
  for (const step of cassette.steps) {
    const bin = atob(step.recv);
    parser.feed(bin);
    await sleep(120);
    const rows = [];
    for (let r = 0; r < cassette.rows; ++r)
      rows.push(buf.getRowText(r, 0, cassette.cols));
    screens.push(rows);
  }
  return screens;
}

// 鏡像 term_view.js#accumulatePageLines（狀態列行號為主、findPageOverlap 為輔）。
function accumulate(pageScreens) {
  let acc = [];
  let accEndRow = null;
  for (let p = 0; p < pageScreens.length; ++p) {
    const screen = pageScreens[p];
    const status = parseStatusRow(screen[screen.length - 1]);
    const newRows = screen.slice(0, -1);
    if (p === 0) {
      acc = newRows.slice();
      accEndRow = status ? status.rowIndexEnd : null;
      continue;
    }
    const accTail = acc.slice(-newRows.length);
    const kContent = findPageOverlap(accTail, newRows);
    const begin = resolvePageOverlap({
      accEndRow,
      statusStart: status ? status.rowIndexStart : null,
      kContent,
      maxK: Math.min(accTail.length, newRows.length),
      accTail,
      newTexts: newRows,
    });
    acc = acc.concat(newRows.slice(begin));
    if (status) accEndRow = status.rowIndexEnd;
  }
  return acc;
}

// 攤平成待評估項：{ caseName, span, golden }
async function buildItems() {
  const items = [];
  for (const c of cases.cassettes) {
    const key = Object.keys(cassetteModules).find((k) => k.endsWith("/" + c.file));
    if (!key) {
      log("找不到 cassette：" + c.file);
      continue;
    }
    const mod = await cassetteModules[key]();
    const cassette = mod.default || mod;
    const rowTexts = accumulate(await pageScreensOf(cassette));
    for (const span of buildCaptionSpans(rowTexts, c.direction)) {
      const golden = c.golden[span.imageUrl];
      if (golden === undefined) {
        log("cassette " + c.file + " 有未標註的圖：" + span.imageUrl);
        continue;
      }
      items.push({ caseName: c.file, span, golden });
    }
  }
  for (const s of cases.synthetic) {
    for (const span of buildCaptionSpans(s.rows, s.direction)) {
      const golden = s.golden[span.imageRow];
      if (golden === undefined) continue;
      items.push({ caseName: s.name, span, golden });
    }
  }
  return items;
}

function cell(v, cls) {
  return '<td class="' + (cls || "") + '">' + v + "</td>";
}

function renderRows(rows) {
  $("result").innerHTML =
    "<table><tr><th>案例</th><th>圖</th><th class='num'>候選段</th>" +
    "<th class='num'>正解</th><th class='num'>規則</th><th class='num'>取滿</th>" +
    "<th class='num'>AI</th><th>命中</th><th class='num'>ms</th><th>模型原始回覆</th></tr>" +
    rows.join("") +
    "</table>";
}

async function run() {
  $("runBtn").disabled = true;
  $("result").innerHTML = "";
  $("summary").textContent = "重建語料中…";
  const items = await buildItems();
  const evaluated = items.filter((it) => spanNeedsAi(it.span));
  const skipped = items.length - evaluated.length;
  const rows = [];
  let ruleHit = 0;
  let maxHit = 0;
  let aiHit = 0;
  let totalMs = 0;
  for (let i = 0; i < evaluated.length; ++i) {
    const { caseName, span, golden } = evaluated[i];
    $("summary").textContent =
      "推論中… " + (i + 1) + " / " + evaluated.length + "（每塊數秒）";
    const r = await classifySpan(span);
    const n = span.paragraphs.length;
    if (span.ruleKeep === golden) ruleHit++;
    if (n === golden) maxHit++;
    const hit = r.keep === golden;
    if (hit) aiHit++;
    totalMs += r.ms;
    rows.push(
      "<tr>" +
        cell(caseName) +
        cell('<span class="dim">' + span.imageUrl.slice(-28) + "</span>") +
        cell(n, "num") +
        cell(golden, "num") +
        cell(span.ruleKeep, "num") +
        cell(n, "num") +
        cell(r.keep, "num") +
        cell(hit ? "✔" : "✘", hit ? "hit" : "miss") +
        cell(r.ms, "num") +
        cell(
          '<span class="dim">' +
            String(r.error || r.raw || "").slice(0, 60) +
            (r.fallback ? "（fallback→規則）" : "") +
            "</span>",
        ) +
        "</tr>",
    );
    renderRows(rows);
  }
  const pct = (n) =>
    evaluated.length ? Math.round((n / evaluated.length) * 100) + "%" : "—";
  $("summary").innerHTML =
    "可評估 " + evaluated.length + " 塊（另有 " + skipped +
    " 塊候選段只有 1 個或未封閉，規則已無可改空間 → 不推論）｜" +
    "<strong>AI " + pct(aiHit) + "</strong>（" + aiHit + "/" + evaluated.length + "）｜" +
    "規則 baseline " + pct(ruleHit) + "｜永遠取滿 baseline " + pct(maxHit) + "｜" +
    "平均 " + (evaluated.length ? Math.round(totalMs / evaluated.length) : 0) + " ms/塊";
  $("runBtn").disabled = false;
}

const SMOKE = [
  {
    q: "只回答一個數字。以下句子有幾個人在說話？「哎呀？」「啊！有蚊子！！」",
    expect: /2|two|２/,
  },
  {
    q: '只回答 yes 或 no。「為了點蚊香而延長時間。」這句話是在描述打蚊子的情境嗎？',
    expect: /yes/i,
  },
  {
    q: '只回答 yes 或 no。「大家覺得這種題材還想看更多嗎？」這句話是漫畫裡角色的對白嗎？',
    expect: /no/i,
  },
];

async function smoke() {
  $("smokeBtn").disabled = true;
  $("smoke").innerHTML = "";
  const lm = window.LanguageModel;
  if (!lm) {
    $("smoke").textContent = "此瀏覽器沒有 LanguageModel。";
    $("smokeBtn").disabled = false;
    return;
  }
  const rows = [];
  for (const s of SMOKE) {
    let out = "";
    try {
      const session = await lm.create();
      out = await session.prompt(s.q);
      session.destroy();
    } catch (e) {
      out = "ERROR " + ((e && e.message) || e);
    }
    const ok = s.expect.test(out);
    rows.push(
      "<tr>" +
        cell(s.q) +
        cell('<span class="dim">' + String(out).slice(0, 120) + "</span>") +
        cell(ok ? "✔" : "✘", ok ? "hit" : "miss") +
        "</tr>",
    );
    $("smoke").innerHTML =
      "<table><tr><th>題目</th><th>回覆</th><th>合理</th></tr>" +
      rows.join("") +
      "</table>";
  }
  $("smokeBtn").disabled = false;
}

async function refreshAvailability() {
  const a = await captionAiAvailability();
  $("availability").textContent =
    a +
    {
      unsupported: "（此瀏覽器沒有 Prompt API）",
      unavailable: "（裝置不符需求：22GB 可用空間 / 16GB RAM 或 >4GB VRAM）",
      downloadable: "（可下載，按「啟用／下載模型」開始，數 GB）",
      downloading: "（下載中）",
      available: "（可用）",
    }[a];
  return a;
}

$("enableBtn").onclick = async () => {
  $("enableBtn").disabled = true;
  log("ensureCaptionAiReady…（首次會下載模型，數 GB）");
  const a = await ensureCaptionAiReady((loaded) =>
    log("下載進度 " + Math.round(loaded * 100) + "%"),
  );
  log("結果：" + a);
  await refreshAvailability();
  $("enableBtn").disabled = false;
};
$("smokeBtn").onclick = smoke;
$("runBtn").onclick = () => run().catch((e) => log("ERROR " + e.message));

// 供自動化健檢用（不需要模型：確認語料重建、golden 對得上、候選段切得對）。
window.__captionEval = { buildItems, run, smoke, refreshAvailability };

loadBig5Tables().then(refreshAvailability);
