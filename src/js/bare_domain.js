// 裸網域自動連結的**純函式層**（無 DOM / 無網路 → unit test 直跑 node env）。
//
// 為什麼需要這層：PTT 文章常直接寫「介紹台灣獨立遊戲的 indiegametw.com」，但
//   - TermBuf.uriRegEx（term_buf.js）硬性要求 scheme → 看不見它；
//   - detectFixableUrls（url_fix.js）刻意跳過「無空白、無路徑」的候選，因為那個
//     形狀同時也是「文中提及」（※ 發信站: 批踢踢實業坊(ptt.cc)）。
// 本模組專責這塊灰色地帶：規則層**預設連**，再用三道 mention 守則排除提及型。
//
// 分層契約：
//   規則層（預設開）－ 裸網域可連，守則排除系統行/括號包覆/系統網域。
//   AI 層（opt-in，url_ai.js）－ 只能**撤掉**規則已允許的連結（單向收縮），
//   永不新增。故 AI 關閉／不支援／逾時 ⇒ 結果恆等於純規則結果。
//
// WHY 走 TermChar[] 而非 rowToText 字串：Big5 DBCS 的 trail byte 落在 0x40-0x7E，
// 涵蓋 A-Za-z，字串掃描會在中文裡湊出假 label（「中」的 trail byte 是 'a' →
// 假的 "a.com"）。做法比照 src/js/mention_parse.js：isLeadByte → 跳 2 格，只比對
// 單位元組 ASCII，回傳的 col 即真實 TermChar index，LinkSegmentBuilder 的
// readChar(ch, i) 直接可比對。
import { TLDS } from "./url_fix";

const TLD_SET = new Set(TLDS);

// PTT 系統網域：只會以「文中提及」的身分出現（發信站、文章網址），不連。
const SYSTEM_HOSTS = new Set([
  "ptt.cc",
  "ptt2.cc",
  "www.ptt.cc",
  "www.ptt2.cc"
]);

// PTT server 產生的系統行（見 docs/pttbbs-screen-protocol.md）：整列不做偵測。
// 這些列裡的網域一律是機器寫的引用，不是作者要讀者去點的連結。
const SYSTEM_LINE_RE = /^\s*(?:※\s*(?:發信站|文章網址|編輯|轉錄|引述)|◆\s*From:)/;

// Big5 全形括號：（ = a1 5d，） = a1 5e。UTF-8 charset 下 cell.ch 直接是該字元。
const FW_LEAD = "\xa1";
const FW_OPEN_TRAIL = "\x5d";
const FW_CLOSE_TRAIL = "\x5e";

function isLabelChar(c) {
  return (
    (c >= "A" && c <= "Z") ||
    (c >= "a" && c <= "z") ||
    (c >= "0" && c <= "9") ||
    c === "-"
  );
}

function isDigit(c) {
  return c >= "0" && c <= "9";
}

const chAt = (chars, i) => (i >= 0 && i < chars.length && chars[i] ? chars[i].ch : null);

// 括號包覆判定。半形直接比 cell.ch；全形在 Big5 下是 DBCS pair（前一格是 trail
// byte，再前一格是 lead byte），在 UTF-8 下 cell.ch 就是「（」。
function isOpenParenBefore(chars, i) {
  const c = chAt(chars, i);
  if (c === "(" || c === "（") return true;
  const lead = chars[i - 1];
  return c === FW_OPEN_TRAIL && !!lead && !!lead.isLeadByte && lead.ch === FW_LEAD;
}

function isCloseParenAt(chars, i) {
  const cell = chars[i];
  if (!cell) return false;
  if (cell.ch === ")" || cell.ch === "）") return true;
  // 全形右括號的起點是 lead byte，其 trail 在下一格。
  return (
    !!cell.isLeadByte &&
    cell.ch === FW_LEAD &&
    chAt(chars, i + 1) === FW_CLOSE_TRAIL
  );
}

function inTermUrl(cell) {
  return !!(
    cell &&
    typeof cell.isPartOfURL === "function" &&
    cell.isPartOfURL()
  );
}

// labels 全部合法（非空、頭尾非連字號），且最後一個是白名單 TLD。
function validHostLabels(labels) {
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (!l) return false;
    if (l.charAt(0) === "-" || l.charAt(l.length - 1) === "-") return false;
  }
  return TLD_SET.has(labels[labels.length - 1].toLowerCase());
}

// 這個候選是否屬「AI 值得複核的灰色地帶」。強訊號（→ gray false，規則直接放行、
// 省一次約 1 秒的裝置端推論）：www. 前綴，或三段以上子網域——這兩種寫法幾乎只在
// 「真的要給人連過去」時才出現。其餘（indiegametw.com 這種兩段裸網域，形狀與
// ptt.cc 型提及完全相同）留給 AI 複核。
function isGray(labels) {
  if (labels.length >= 3) return false;
  return labels[0].toLowerCase() !== "www";
}

// detectBareDomains(chars, rowText) -> [{ startCol, endCol, host, href, gray }]
// endCol 為 exclusive（第一個不屬於候選的欄），與 comment_parse.js 的
// [authorIdStart, authorIdEnd) 及 mention_parse.js 慣例一致。
export function detectBareDomains(chars, rowText) {
  if (!chars || !chars.length) return [];
  if (rowText && SYSTEM_LINE_RE.test(rowText)) return [];

  const out = [];
  const n = chars.length;
  let i = 0;
  while (i < n) {
    const cell = chars[i];
    if (!cell) {
      i++;
      continue;
    }
    // DBCS（Big5 全形）字：占 i 與 i+1 兩欄，整組跳過——它的 trail byte 可能長得
    // 像 label 字元，絕不可併進 host。
    if (cell.isLeadByte) {
      i += 2;
      continue;
    }
    if (!isLabelChar(cell.ch) && cell.ch !== ".") {
      i++;
      continue;
    }
    // 收一段連續的「label 字元或點」。run 的邊界即候選的最大範圍。
    const runStart = i;
    let j = i;
    let inUrl = false;
    while (j < n) {
      const c = chars[j];
      if (!c || c.isLeadByte) break;
      if (!isLabelChar(c.ch) && c.ch !== ".") break;
      if (inTermUrl(c)) inUrl = true;
      j++;
    }
    i = j; // 下一輪從 run 之後接著掃（run 內不可能再有第二個候選）

    // 已被 uriRegEx 標記成 URL 的一部分 → 真偵測器已經處理，不重複連。
    if (inUrl) continue;

    // 尾端的點是句號，不屬於 host（「去 example.com.」）。
    let end = j;
    while (end > runStart && chAt(chars, end - 1) === ".") --end;
    if (end <= runStart) continue;

    let run = "";
    for (let k = runStart; k < end; ++k) run += chars[k].ch;
    const labels = run.split(".");
    if (!validHostLabels(labels)) continue;

    // email 的 local part / 網域部分都不連。
    if (chAt(chars, runStart - 1) === "@") continue;
    if (chAt(chars, end) === "@") continue;
    // 後面緊接 '/' 的深連結歸 url_fix.js（它會補 scheme 並另起一行），不重複。
    if (chAt(chars, end) === "/") continue;

    // 可選 port：':' 後面必須緊接數字。
    let hostEnd = end;
    if (chAt(chars, hostEnd) === ":" && isDigit(chAt(chars, hostEnd + 1) || "")) {
      let p = hostEnd + 1;
      while (p < n && isDigit(chAt(chars, p) || "")) ++p;
      hostEnd = p;
    }

    let host = "";
    for (let k = runStart; k < hostEnd; ++k) host += chars[k].ch;
    host = host.toLowerCase();
    if (SYSTEM_HOSTS.has(host)) continue;
    // 括號包覆＝文中提及（批踢踢實業坊(ptt.cc)），不是要讀者點的連結。
    if (
      isOpenParenBefore(chars, runStart - 1) &&
      isCloseParenAt(chars, hostEnd)
    ) {
      continue;
    }

    out.push({
      startCol: runStart,
      endCol: hostEnd,
      host,
      href: "https://" + host,
      gray: isGray(labels)
    });
  }
  return out;
}
