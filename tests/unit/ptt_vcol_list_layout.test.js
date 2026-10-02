// @vitest-environment jsdom
// PTT「列表模式導入動態分欄架構（VCOL）」公告（PttCurrent，2026-10-01；PTT2 9/30、
// PTT1 10/4 上線）的相容性證明：**server 改用 VCOL 排版後，本專案的列表欄位解析
// 在 80 欄下照舊正確**，寬於 80 欄時欄位起點也不動。
//
// 做法：把 pttbbs 的 VCOL 排版逐行移植成下面的 vcolLayout／vcolRender（含
// 「…」截斷），用**現行** server 的欄位定義與 row builder 組出 Big5 位元組，
// 經 app 自己的 AnsiParser → TermBuf 落到格子裡，再跑本專案的解析器。
// 事實來源（3rd_script/pttbbs @ 36b5fd4d）：
//   mbbsd/vtuikit.c#vs_cols_layout_ex   欄寬分配（phase 1 依 pri 給 minw，phase 2 依權重補到 maxw）
//   mbbsd/vtuikit.c#vs_col_render       左對齊補白；超寬時 stream_col_offset(w-2) ＋ "…"
//   mbbsd/psb.c#psb_sync_cols           可用寬度 = t_columns - col_paddings(=1)
//   mbbsd/psb.c#psb_render_header_columns  欄位列整列 ANSI_REVERSE，右側接 col_header_right
//   mbbsd/bbs.c#bbs_coldefs / #readdoent       文章列表
//   mbbsd/board.c#brdlist_coldefs / #brdlist_renderer  看板列表
//   common/sys/string.c#stream_col_offset / #stream_width  Big5 寬度＝位元組數（ESC 序列不算）
// 3rd_script/ 不進 repo（.gitignore），所以欄位定義抄成常數；server 再改版時要對著
// 上列檔案重抄，並看這支測試是否仍綠。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
import {
  rowToText,
  parseListArticleNum,
  parseListAuthor,
  parseListTitleRaw,
  subjectOfListText,
  isListRowRead,
  isListShapedRow,
  isPinnedListRow,
  listColRegion,
  LIST_AUTHOR_COL_START,
  LIST_TITLE_COL_START,
} from "../../src/js/comment_parse";
import { classifyListScreen } from "../../src/js/list_session";
import {
  parseBoardListNum,
  parseBoardListName,
} from "../../src/js/board_list_parse";
import { listRowIdentity, subjectMatches } from "../../src/js/long_push_anchor";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

const ESC = "\x1b";
const RESET = ESC + "[m";
const TTLEN = 64; // include/pttstruct.h
const BTLEN = 41; // include/pttstruct.h

// VCOL {label, minw, maxw, pri}（include/vtuikit.h）
const BBS_COLDEFS = [
  { label: "", minw: 1, maxw: 1, pri: 100 },
  { label: "  編號", minw: 6, maxw: 6, pri: 20 },
  { label: "    ", minw: 4, maxw: 4, pri: 90 },
  { label: "日 期", minw: 6, maxw: 6, pri: 70 },
  { label: "作  者       ", minw: 13, maxw: 13, pri: 80 },
  { label: "文  章  標  題", minw: 16, maxw: TTLEN + 1, pri: 100 },
];
const BRDLIST_COLDEFS = [
  { label: "", minw: 1, maxw: 1, pri: 100 },
  { label: "  編號   ", minw: 9, maxw: 9, pri: 20 },
  { label: "看  板       ", minw: 13, maxw: 13, pri: 100 },
  { label: "類別   ", minw: 7, maxw: 7, pri: 75 },
  { label: "中   文   敘   述", minw: 34, maxw: BTLEN + 1, pri: 90 },
  { label: "人氣 ", minw: 3, maxw: 3, pri: 80 },
  { label: "板   主", minw: 12, maxw: 0, pri: 70 },
];
const COL_PADDINGS = 1; // bbs.c#readtitle、board.c 的 PSB_CTX 都是 1

// ---- vtuikit.c#vs_cols_layout_ex（VCOL_EXPAND_WEIGHTED，PSB 的預設 0）----
function vcolLayout(cols, totalWidth) {
  const n = cols.length;
  const ws = new Array(n).fill(0);
  const minW = cols.map((c) => (c.minw > 0 ? c.minw : 0));
  const maxW = cols.map((c, i) =>
    c.maxw <= 0 || c.maxw < minW[i] ? totalWidth : c.maxw
  );
  // stable bubble sort by pri desc
  const order = cols.map((_, i) => i);
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < n - 1 - i; j++)
      if (cols[order[j]].pri < cols[order[j + 1]].pri) {
        const t = order[j];
        order[j] = order[j + 1];
        order[j + 1] = t;
      }
  let rem = totalWidth;
  for (const i of order) {
    if (rem >= minW[i]) {
      ws[i] = minW[i];
      rem -= minW[i];
    } else ws[i] = 0;
  }
  while (rem > 0) {
    let totalWeight = 0;
    for (let i = 0; i < n; i++)
      if ((ws[i] > 0 || (minW[i] === 0 && rem > 0)) && ws[i] < maxW[i])
        totalWeight += cols[i].pri > 0 ? cols[i].pri : 1;
    if (totalWeight <= 0) break;
    let added = 0;
    for (let i = 0; i < n && rem > 0; i++) {
      if (ws[i] < maxW[i] && (ws[i] > 0 || minW[i] === 0)) {
        const weight = cols[i].pri > 0 ? cols[i].pri : 1;
        let share = Math.trunc((rem * weight) / totalWeight);
        share = Math.min(share, maxW[i] - ws[i]);
        if (share > 0) {
          ws[i] += share;
          rem -= share;
          added += share;
        }
      }
    }
    if (added === 0) {
      for (const i of order) {
        if (rem <= 0) break;
        if (ws[i] < maxW[i] && (ws[i] > 0 || minW[i] === 0)) {
          ws[i]++;
          rem--;
          added++;
        }
      }
      if (added === 0) break;
    }
  }
  return ws;
}

// ---- 位元組層（Big5）：string.c#skip_control_sequence / stream_width / stream_col_offset ----
const code = (s, i) => s.charCodeAt(i);
function skipControl(s, i) {
  let p = i + 1;
  if (p >= s.length) return p;
  if (s[p] !== "[") return p + 1;
  p++;
  while (p < s.length && code(s, p) - 0x20 >= 0 && code(s, p) - 0x20 < 0x20) p++;
  if (p < s.length && code(s, p) >= 0x40 && code(s, p) <= 0x7e) p++;
  return p;
}
function streamWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === ESC) i = skipControl(s, i);
    else {
      w++;
      i++;
    }
  }
  return w;
}
const isLead = (c) => c >= 0x81 && c <= 0xfe;
const isTrail = (c) => (c >= 0x40 && c <= 0x7e) || (c >= 0xa1 && c <= 0xfe);
function streamColOffset(count, s) {
  let cols = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      i = skipControl(s, i);
      continue;
    }
    const c = code(s, i);
    if (c >= 0x20 && c < 0x7f) {
      if (cols + 1 > count) break;
      cols++;
      i++;
      continue;
    }
    if (isLead(c) && i + 1 < s.length && isTrail(code(s, i + 1))) {
      if (cols + 2 > count) break;
      cols += 2;
      i += 2;
      continue;
    }
    if (cols + 1 > count) break;
    cols++;
    i++;
  }
  return { bytes: i, cols };
}

// ---- vtuikit.c#vs_col_render（輸入是 Big5 位元組字串）----
const ELLIPSIS_B5 = () => u2b("…");
function vcolRender(w, s) {
  if (w <= 0) return "";
  let out = "";
  const sw = streamWidth(s);
  if (sw <= w) {
    out += s + " ".repeat(w - sw);
  } else if (w >= 2) {
    const { bytes, cols } = streamColOffset(w - 2, s);
    out += s.slice(0, bytes) + ELLIPSIS_B5();
    if (w > cols + 2) out += " ".repeat(w - (cols + 2));
  } else {
    const { bytes } = streamColOffset(1, s);
    out += bytes > 0 ? s.slice(0, bytes) : " ";
  }
  if (s.indexOf(ESC) >= 0) out += RESET;
  return out;
}

// psb.c#render_columns：data 是 Unicode 字串（含 ANSI），逐欄轉 Big5 後排版。
function renderColumns(coldefs, ws, data) {
  return coldefs.map((_, i) => vcolRender(ws[i], u2b(data[i] || ""))).join("");
}

// psb.c#psb_render_header_columns
function renderHeader(coldefs, ws, termCols, rightStr) {
  const rightW = rightStr ? streamWidth(u2b(rightStr)) : 0;
  const hdr = ws.slice();
  const last = hdr.length - 1;
  if (rightW > 0 && hdr[last] > rightW) hdr[last] -= rightW;
  let out = ESC + "[7m";
  let x = 0;
  for (let i = 0; i < coldefs.length; i++) {
    const cell = vcolRender(hdr[i], u2b(coldefs[i].label));
    out += cell;
    x += streamWidth(cell);
  }
  let rem = termCols - x;
  if (rightW > 0 && rem >= rightW) {
    out += " ".repeat(rem - rightW) + u2b(rightStr);
  } else out += " ".repeat(Math.max(0, rem));
  return out + RESET;
}

// ---- bbs.c#readdoent 的 render_columns 引數（非 SAFE_DELETE 屍體列）----
function readdoentData({
  num,
  pinned = false,
  type = " ",
  recom = "0m  ",
  date = " 9/30",
  owner,
  online = false,
  mark = "□",
  title,
}) {
  const colNum = pinned
    ? " " + ESC + "[1;33m" + "  ★ " + RESET
    : String(num).padStart(6, " ");
  const colRecom = " " + type + ESC + "[0;1;3" + recom + RESET;
  const colDate = date.slice(0, 5).padEnd(6, " ");
  const colAuthor =
    (online ? ESC + "[1m" : "") +
    owner.slice(0, 12).padEnd(13, " ") +
    (online ? RESET : "");
  const colTitle = mark + " " + title;
  return ["", colNum, colRecom, colDate, colAuthor, colTitle];
}

// 舊版（fixed printf）同一列的**可見文字**——comment_parse.js 欄位表那一版：
//   %7d ＋ " " ＋ type ＋ 推文數(2) ＋ %-6.5s ＋ %-13.12s ＋ mark ＋ " " ＋ title
function classicArticleText({ num, type = " ", recomText = "  ", date = " 9/30", owner, mark = "□", title }) {
  return (
    String(num).padStart(7, " ") +
    " " +
    type +
    recomText +
    date.slice(0, 5).padEnd(6, " ") +
    owner.slice(0, 12).padEnd(13, " ") +
    mark +
    " " +
    title
  );
}

// ---- board.c#brdlist_renderer（一般看板列）----
function brdlistData({ head, name, unread = false, cls = "綜合", desc, nuser = "HOT", bm = "" }) {
  const unreadStr = unread
    ? ESC + "[1;31m" + "ˇ" + RESET
    : ESC + "[37m" + "  " + RESET;
  const colNum = String(head).padStart(6, " ") + " " + unreadStr;
  const colName = ESC + "[1;36m" + name.padEnd(13, " ") + RESET;
  const colClass = cls + " ".repeat(Math.max(0, 4 - cls.length * 2)) + " " + ESC + "[0;37m" + "◎" + RESET;
  return ["", colNum, colName, colClass, desc, nuser, bm];
}

function makeBuf(cols, rows = 24) {
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return buf;
}

// 逐列定位寫入（PTT 的 move(y,0) ＋ 內容），最後把游標停在 (cursorRow, 0)
// 並畫上 psb_default_cursor 的 ">"（outs(STR_CURSOR "\b")）。
function paint(buf, rowsBytes, cursorRow) {
  const parser = new AnsiParser(buf);
  let s = ESC + "[H" + ESC + "[2J";
  rowsBytes.forEach((bytes, y) => {
    if (bytes == null) return;
    s += ESC + "[" + (y + 1) + ";1H" + bytes;
  });
  if (cursorRow != null)
    s += ESC + "[" + (cursorRow + 1) + ";1H>" + "\b";
  parser.feed(s);
  buf.updateCharAttr();
  return buf;
}

const textOf = (buf, y) => buf.getRowText(y, 0, buf.cols);
// 某段文字在列上的**格子**起點（全形 = 2 格）
function cellIndexOf(buf, y, needle) {
  const t = textOf(buf, y);
  const k = t.indexOf(needle);
  if (k < 0) return -1;
  let cells = 0;
  for (let i = 0; i < k; i++) cells += t.charCodeAt(i) > 0x7f ? 2 : 1;
  return cells;
}

// 必須是 server 存得下的標題（fileheader_t.title 是 TTLEN+1，含 NUL ⇒ ≤ 64 bytes），
// 但又寬過 80 欄的標題欄（49 格扣掉 mark＋空白 3 格 ⇒ > 46 格）。
const LONG_TITLE = "[問卦] 有沒有動態分欄上線後標題太長會被截斷加上省略號的八卦";

const ARTICLES = [
  { num: 352960, type: "+", recom: "2m 4", recomText: " 4", owner: "someone", title: "[心得] 測試一般標題" },
  { num: 352961, type: " ", recom: "3m35", recomText: "35", owner: "a0930307148", mark: "R:", title: "[閒聊] 烙印勇士384" },
  { num: 352962, type: "m", recom: "1m爆", recomText: "爆", owner: "LongUserId12", online: true, mark: "轉", title: "[新聞] 轉錄測試" },
  { num: 352963, type: "~", recom: "0m  ", recomText: "  ", owner: "abc", title: LONG_TITLE },
];

function articleListScreen(termCols) {
  const ws = vcolLayout(BBS_COLDEFS, termCols - COL_PADDINGS);
  const rows = new Array(24).fill(null);
  rows[0] = u2b(ESC + "[1;44;33m" + "【板主:someone】".padEnd(30, " ") + "看板《Gossiping》".padEnd(termCols - 30 - 12, " ") + RESET);
  rows[1] = u2b("[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [i]看板資訊/設定 [h]說明");
  rows[2] = renderHeader(BBS_COLDEFS, ws, termCols, "人氣:1234 ");
  ARTICLES.forEach((a, k) => {
    rows[3 + k] = renderColumns(BBS_COLDEFS, ws, readdoentData(a));
  });
  rows[3 + ARTICLES.length] = renderColumns(
    BBS_COLDEFS,
    ws,
    readdoentData({ pinned: true, recom: "0m  ", date: " 1/01", owner: "SYSOP", mark: "□", title: "[公告] 置底公告" })
  );
  rows[23] = u2b(ESC + "[34;46m" + " 文章選讀 " + ESC + "[31;47m" + " (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 " + RESET);
  return { buf: paint(makeBuf(termCols), rows, 3), ws };
}

describe("PTT VCOL 動態分欄（公告 2026-10-01）：80 欄下列表欄位位置不變", () => {
  test("素材自檢：長標題確實存得進 PTT、且在 80 欄會被截斷", () => {
    expect(u2b(LONG_TITLE).length).toBeLessThanOrEqual(TTLEN);
    expect(u2b("□ " + LONG_TITLE).length).toBeGreaterThan(49);
  });

  test("欄寬分配：80 欄時每一欄恰為舊固定寬度", () => {
    // 文章列表：游標 1、編號 6、標記/推文 4、日期 6、作者 13、標題吃剩下的 49。
    expect(vcolLayout(BBS_COLDEFS, 80 - COL_PADDINGS)).toEqual([1, 6, 4, 6, 13, 49]);
    // 看板列表：minw 總和恰為 79 ⇒ 全部取 minw，沒有任何欄位延展。
    expect(vcolLayout(BRDLIST_COLDEFS, 80 - COL_PADDINGS)).toEqual([1, 9, 13, 7, 34, 3, 12]);
  });

  test("寬於 80 欄：只有尾端欄位延展，作者／標題／板名起點不動", () => {
    for (const cols of [81, 100, 120, 200]) {
      expect(vcolLayout(BBS_COLDEFS, cols - COL_PADDINGS).slice(0, 5)).toEqual([1, 6, 4, 6, 13]);
      expect(vcolLayout(BRDLIST_COLDEFS, cols - COL_PADDINGS).slice(0, 4)).toEqual([1, 9, 13, 7]);
    }
  });

  // 只有使用者在 fixed-term-size 手設 <80 欄才會遇到；記下邊界供 docs 引用。
  test("窄於 80 欄：看板列表 79 欄即省略編號欄；文章列表要 <47 欄才省略", () => {
    expect(vcolLayout(BRDLIST_COLDEFS, 79 - COL_PADDINGS)[1]).toBe(0);
    expect(vcolLayout(BBS_COLDEFS, 47 - COL_PADDINGS).slice(0, 5)).toEqual([1, 6, 4, 6, 13]);
    expect(vcolLayout(BBS_COLDEFS, 46 - COL_PADDINGS)[1]).toBe(0);
  });

  test("文章列表一般列：VCOL 輸出與舊版 fixed printf 逐字相同", () => {
    const { buf } = articleListScreen(80);
    ARTICLES.slice(0, 3).forEach((a, k) => {
      const y = 3 + k;
      const expected = classicArticleText(a);
      // 游標列 col 0 是 '>'，其餘列是空白；舊版的 %7d 前導空白同樣被 '>' 蓋掉。
      const got = textOf(buf, y).replace(/\s+$/, "");
      expect(got.slice(1)).toBe(expected.slice(1));
    });
  });

  test("文章列表：編號／作者／標題／已讀判定／列形判定全部照舊", () => {
    const { buf } = articleListScreen(80);
    ARTICLES.forEach((a, k) => {
      const y = 3 + k;
      const t = textOf(buf, y);
      expect(parseListArticleNum(t)).toBe(a.num);
      expect(parseListAuthor(t)).toBe(a.owner.toLowerCase());
      expect(isListShapedRow(t)).toBe(true);
      expect(isListRowRead(buf.lines[y])).toBe(a.type === " " || a.type === "m");
      // 作者第一個字落在 cell 17、mark 落在 cell 30（滑鼠區域表的切點）
      expect(cellIndexOf(buf, y, a.owner)).toBe(LIST_AUTHOR_COL_START);
      expect(cellIndexOf(buf, y, a.mark || "□")).toBe(LIST_TITLE_COL_START);
      expect(listColRegion(LIST_AUTHOR_COL_START)).toBe("author");
      expect(listColRegion(LIST_TITLE_COL_START)).toBe("title");
    });
    expect(parseListTitleRaw(textOf(buf, 3))).toBe("□ [心得] 測試一般標題");
    expect(subjectOfListText(textOf(buf, 4))).toBe("[閒聊] 烙印勇士384");
  });

  test("置底列（★）：仍落在 cell 4–5，判為置底、作者照讀", () => {
    const { buf } = articleListScreen(80);
    const y = 3 + ARTICLES.length;
    const t = textOf(buf, y);
    expect(cellIndexOf(buf, y, "★")).toBe(4);
    expect(parseListArticleNum(t)).toBe(null);
    expect(isPinnedListRow(t)).toBe(true);
    expect(parseListAuthor(t)).toBe("sysop");
    expect(isListRowRead(buf.lines[y])).toBe(true);
  });

  test("長標題：在字元邊界截斷並以「…」結尾，不破字、不越過 79 欄；錨點比對容忍「…」", () => {
    const { buf } = articleListScreen(80);
    const y = 3 + 3;
    const t = textOf(buf, y);
    const title = parseListTitleRaw(t);
    expect(title.endsWith("…")).toBe(true);
    // 沒有被切半的 Big5（b2u 對孤立 lead byte 會吐出替代字元或亂碼）
    expect(title).not.toMatch(/[�]/);
    expect(LONG_TITLE.startsWith(title.slice(2, -1))).toBe(true);
    // 標題欄 49 格：cells 30..78，col 79 留白
    expect(buf.lines[y][79].ch).toBe(" ");
    // 長推文／返回導航的身分比對：列表上是截斷版，文章標頭是完整版
    const id = listRowIdentity(t);
    expect(id.author).toBe("abc");
    expect(subjectMatches(id.subject, LONG_TITLE)).toBe(true);
  });

  test("整幀仍被認成文章列表：表頭反白整列、含「編號」，classifyListScreen = clean-list", () => {
    const { buf } = articleListScreen(80);
    expect(textOf(buf, 2)).toContain("編號");
    expect(textOf(buf, 2)).toContain("人氣:1234");
    expect(buf.isUnicolor(2, 0, buf.cols - 10)).toBe(true);
    const rowTexts = [];
    for (let y = 0; y < 24; y++) rowTexts.push(textOf(buf, y));
    expect(
      classifyListScreen({
        rowTexts,
        curX: 0,
        curY: 3,
        rows: 24,
        row0Reversed: buf.isUnicolor(0, 0, 29),
        row2Reversed: buf.isUnicolor(2, 0, buf.cols - 10),
      })
    ).toEqual({ kind: "clean-list", boardName: "Gossiping" });
  });

  test("寬終端（120 欄）：解析結果與 80 欄相同，長標題可完整顯示", () => {
    const { buf, ws } = articleListScreen(120);
    expect(ws[5]).toBe(TTLEN + 1);
    ARTICLES.forEach((a, k) => {
      const t = textOf(buf, 3 + k);
      expect(parseListArticleNum(t)).toBe(a.num);
      expect(parseListAuthor(t)).toBe(a.owner.toLowerCase());
    });
    expect(subjectOfListText(textOf(buf, 6))).toBe(LONG_TITLE);
  });

  test("看板列表：編號欄結束於 cell 7、板名起於 cell 10，與舊版 %7d%c%s 相同", () => {
    const ws = vcolLayout(BRDLIST_COLDEFS, 80 - COL_PADDINGS);
    const rows = new Array(24).fill(null);
    const boards = [
      { head: 1, name: "Gossiping", desc: "綜合 ◎【八卦】" },
      { head: 12, name: "C_Chat", unread: true, desc: "閒談 ◎【希洽】C(西洽)洽 動漫與遊戲綜合討論版有點長的敘述" },
      { head: 345, name: "Stock-Talk", desc: "學術 ◎股票" },
    ];
    boards.forEach((b, k) => {
      rows[3 + k] = renderColumns(BRDLIST_COLDEFS, ws, brdlistData(b));
    });
    const buf = paint(makeBuf(80), rows, 3);
    boards.forEach((b, k) => {
      const y = 3 + k;
      const t = textOf(buf, y);
      expect(parseBoardListNum(t)).toBe(b.head);
      expect(parseBoardListName(t)).toBe(b.name);
      expect(cellIndexOf(buf, y, b.name)).toBe(10);
      // 數字的最後一位在 cell 6（舊 %7d 欄 [0,7)）
      expect(buf.lines[y][6].ch).toBe(String(b.head).slice(-1));
    });
  });
});
