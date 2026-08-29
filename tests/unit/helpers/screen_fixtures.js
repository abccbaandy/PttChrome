// 核心畫面渲染鏈的共用素材（React 版 golden 產生器與純 JS 版等價測試共用同一份）。
//
// 為什麼要有這一份：`src/render/` 的純 JS 渲染鏈必須產生與舊 <Screen>/<Row>
// **逐字相同**的 DOM——`data-type="bbsline"`／`data-row`（選取複製反查）、
// `.wpadding`（term_view.fixedResize 直接掃 DOM 改寬度）、`data-pusher-col`
// （滑鼠防誤觸）等契約漏一個就有功能靜默壞掉，而那些消費端全在 unit 測不到的
// term_view / ContextMenu 裡。故改寫前先用舊版把 DOM 凍成 golden，改寫後比對。
//
// 這裡的 cell 是**真 Big5 位元組**（經 u2b 轉出），不是 ASCII 替身：DBCS 併字、
// 全形字強制寬度、雙色字（lead/tail 不同色）這三條路徑只有餵真位元組才走得到，
// 而它們正是 ColorSegmentBuilder 最容易寫錯的部分。
import { isDBCSLead, u2b } from "../../../src/js/string_util";
import { loadBig5Tables } from "./load_big5_tables";

// b2u/u2b 讀裸全域 `lib`（= jsdom 的 window.lib）。cell 工廠在 module 載入時就會
// 呼叫 u2b，故這裡就要備妥表。
loadBig5Tables();

// 終端機寬度。列一律補滿空白，與真實 PTT 畫面一致（尾端空白會併成單一 span，
// 不會讓 golden 檔膨脹太多）。
export const COLS = 80;

// term_ui.ColorState 的等價替身：equals 比 fg/bg/blink 三個欄位（不是參考），
// 這正是 WordSegmentBuilder 併色段的判準。
export function color(fg = 7, bg = 0, blink = false) {
  return {
    fg,
    bg,
    blink,
    equals(o) {
      return !!o && this.fg === o.fg && this.bg === o.bg && this.blink === o.blink;
    },
  };
}

const DEFAULT_COLOR = color(7, 0, false);

// TermChar 替身。渲染鏈只用到 ch / isLeadByte / getColor / isStartOfURL /
// isEndOfURL / getFullURL 六個成員。
//
// isLeadByte 由 term_buf.updateCharAttr() 在真實流程中標上（rowToText 靠它把兩個
// 位元組併回一個 Unicode 字），fixture 必須自己標——沒標的話整列文字是亂碼，
// annotateComment 一條都認不出來（推文列全部退化成一般內文）。
function cell(ch, colorState, url, lead) {
  return {
    ch,
    isLeadByte: !!lead,
    getColor: () => colorState,
    isStartOfURL: () => !!(url && url.start),
    isEndOfURL: () => !!(url && url.end),
    getFullURL: () => (url ? url.href : null),
  };
}

// Big5 位元組串 → cells，逐格標好 isLeadByte。
function bytesToCells(bytes, colorAt, urlAt) {
  const out = [];
  for (let i = 0; i < bytes.length; ++i) {
    const lead = isDBCSLead(bytes[i]) && i + 1 < bytes.length;
    out.push(cell(bytes[i], colorAt(i), urlAt ? urlAt(i) : null, lead));
    if (lead) {
      ++i;
      out.push(cell(bytes[i], colorAt(i), urlAt ? urlAt(i) : null, false));
    }
  }
  return out;
}

// 一段純文字 → cells。Unicode 先轉 Big5，全形字因此自然佔兩格，欄號與真實終端機
// 一致（annotateComment / parseListAuthor 的欄位校準都靠這個）。
export function seg(text, colorState = DEFAULT_COLOR) {
  return bytesToCells(u2b(text), () => colorState);
}

// 一段被標成超連結的文字（TermChar 的 URL 旗標由 term_url_flag.js 在真實流程中
// 標上，這裡直接給結果）。href 預設就是文字本身。
export function link(text, href = text, colorState = DEFAULT_COLOR) {
  const bytes = u2b(text);
  return bytesToCells(
    bytes,
    () => colorState,
    (i) => ({ href, start: i === 0, end: i === bytes.length - 1 }),
  );
}

// 原始位元組（跳過 u2b）：用來造 b2u 轉不出來的組合，走 ColorSegmentBuilder 的
// 「Conversion error」分支（輸出 '?'）。第一格標成 lead byte。
export function raw(codes, colorState = DEFAULT_COLOR) {
  const out = [];
  for (let i = 0; i < codes.length; ++i) {
    out.push(cell(String.fromCharCode(codes[i]), colorState, null, i % 2 === 0));
  }
  return out;
}

// 雙色全形字：lead 與 tail 兩個位元組不同色 → TwoColorWord 路徑。
export function twoColor(text, leadColor, tailColor) {
  return bytesToCells(u2b(text), (i) => (i % 2 === 0 ? leadColor : tailColor));
}

// 併接多段 → 補滿 COLS 欄的一列。
export function row(...parts) {
  const cells = [].concat(...parts);
  while (cells.length < COLS) cells.push(cell(" ", DEFAULT_COLOR, null, false));
  return cells.slice(0, COLS);
}

// 列表列的欄位校準與 parseListAuthor 一致：作者從 col 17 起 12 欄，標題從 col 29。
const LIST_PREFIX = " 350024 + 2 6/14 "; // 17 欄
export function listRow(author, title, colorState = DEFAULT_COLOR) {
  return row(
    seg(LIST_PREFIX, colorState),
    seg((author + "            ").slice(0, 12), colorState),
    seg(title, colorState),
  );
}

// ---------------------------------------------------------------------------
// 場景
// ---------------------------------------------------------------------------
// 每個場景 = 一組交給 renderer 的完整 props。名稱同時是 golden 檔名。
// enhance 的欄位與 term_view._renderScreenLines 組出來的那份同形。

const ENHANCE_BASE = {
  blacklist: new Set(),
  titleBlacklist: [],
  showFloorNumbers: false,
  mergeSameAuthorComments: false,
  captionAiEnabled: false,
  highlightAuthor: false,
  articleAuthor: null,
  selectedPusher: null,
  autoFixUrl: false,
  bareDomainLink: false,
  urlAiEnabled: false,
  fixAiEnabled: false,
  enableXMention: false,
  pageState: 3,
  easyReading: false,
  onAidClick: null,
  dropHidden: false,
  inListContext: false,
  articleId: "fixture-1",
};

function enhance(extra) {
  return Object.assign({}, ENHANCE_BASE, extra);
}

const PROPS_BASE = {
  forceWidth: 20,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
};

function scenario(name, lines, enhanceExtra, propsExtra) {
  return Object.assign({ name, lines, enhance: enhance(enhanceExtra) }, PROPS_BASE, propsExtra || {});
}

// --- 文章：原生 24 列（活 buffer，無 stableRows）---------------------------
const ARTICLE_NATIVE_LINES = [
  row(seg("作者  wowbenny (阿班) 看板  Test")),
  row(seg("標題  [問題] 這是一篇測試文章")),
  row(seg("時間  Sat Jun 14 12:00:00 2026")),
  row(seg("")),
  row(seg("內文第一行，含一條網址："), link("https://i.imgur.com/abc.jpg")),
  row(seg("這一行有全形字：測試中文寬度對齊")),
  row(twoColor("雙色", color(1, 0), color(4, 0)), seg(" 兩個位元組不同色")),
  // symbolTable 判定 1/2 的字（Big5 全形、Unicode 卻是窄字）→ ForceWidthWord 的
  // .wpadding，term_view.fixedResize 直接掃 DOM 改它的 width，是硬契約。
  row(seg("符號 ° ± × ÷ Α Ω 對齊")),
  // b2u 轉不出來的位元組對 → Conversion error 分支（兩個 '?'）。
  row(seg("壞碼："), raw([0xfe, 0x7f]), seg(" 之後照常")),
  row(seg("推 gooduser: 推文一則", color(2, 0)), seg("            06/14 12:01")),
  row(seg("推 baduser: 這則會被黑名單", color(2, 0)), seg("      06/14 12:02")),
  row(seg("→ wowbenny: 原PO自己回", color(3, 0)), seg("        06/14 12:03")),
];

// --- 文章：好讀累積長頁（快照列，stableRows）-------------------------------
const ARTICLE_EASY_LINES = [
  row(seg("作者  wowbenny (阿班) 看板  Test")),
  row(seg("標題  [問題] 好讀模式測試")),
  row(seg("")),
  row(seg("轉錄自 "), seg("#1abcDEFG"), seg(" 這篇")),
  row(seg("裸網域：example.com 與 @someone 提及")),
  row(seg("修復候選：https: //i.imgur.com/xyz.png")),
  row(seg("Steamgifts giveaway 代碼")),
  row(seg("AbC12")),
  row(seg("推 gooduser: 第一則", color(2, 0)), seg("              06/14 12:01")),
  row(seg("推 gooduser: 同一人第二則", color(2, 0)), seg("        06/14 12:02")),
  row(seg("推 baduser: 黑名單這則", color(2, 0)), seg("          06/14 12:03")),
  row(seg("噓 other: 換人了", color(1, 0)), seg("                06/14 12:04")),
];

// --- 功能鍵提示列 -----------------------------------------------------------
// 依 pttbbs 原始碼逐字抄（不是從畫面反推）：
//   mbbsd/bbs.c:663      看板文章列表的提示列（row 1）
//   mbbsd/vtuikit.c:722  vs_footer()，一律畫在最後一列
// 兩列都含全形字，所以 golden 同時也是「解析走格子空間而非文字 index」的證明。
const FNKEY_TOP =
  "[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]搬移至 [i]看板資訊/設定 [h]說明";
const FNKEY_FOOTER =
  " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 (/?a)找標題/作者 (b)進板畫面";

// --- 列表 -------------------------------------------------------------------
const LIST_LINES = [
  listRow("gooduser", "R: [情報] 普通文章"),
  listRow("adman", "□ [閒聊] 這是廣告貼文"),
  row(seg(" 350024 + 2 6/14 -             (本文已被刪除) [adman]")),
  listRow("gooduser", "□ [心得] 另一篇"),
];

// 列表好讀 ＋ 平滑捲動（次列位移）：3 列 header + 20 列 body + footer(23) +
// overscan(24)。overscan 列刻意放在 footer **之後**（term_view.buildListWindowLines
// 的註解說明了為什麼：footer 的 data-row 必須維持 23）。render 端會把 body 與
// overscan 收進 .listBodyView 視口，header/footer 留在 #mainContainer 直系子層。
const LIST_SCROLL_LINES = (() => {
  const out = [
    row(seg("看板《Test》")),
    row(seg("  編號     日 期  作 者        文  章  標  題")),
    row(seg("")),
  ];
  for (let i = 0; i < 20; ++i) out.push(listRow("gooduser", "□ [心得] 第 " + i + " 篇"));
  out.push(row(seg(FNKEY_FOOTER)));
  out.push(listRow("gooduser", "□ [心得] 露出一小條的下一列"));
  return out;
})();

// --- 圖文合併（好讀「圖左字右」）-------------------------------------------
const CAPTION_LINES = [
  row(seg("作者  wowbenny (阿班) 看板  Test")),
  row(link("https://i.imgur.com/p1.jpg")),
  row(seg("這是第一張圖的說明文字")),
  row(seg("")),
  row(link("https://i.imgur.com/p2.jpg")),
  row(seg("這是第二張圖的說明文字")),
  row(seg("")),
  row(seg("推 someone: 好看", color(2, 0)), seg("                06/14 12:01")),
];

// 原生列表 ＋ 功能鍵按鈕：row 1 的提示列與最後一列的 vs_footer 各自變成一排
// <a class="fnKey">。刻意做成 24 列，讓 functionKeyRows(2, 24) = [1, 23] 對得上。
const LIST_FNKEY_LINES = (() => {
  const out = [row(seg("看板《Test》")), row(seg(FNKEY_TOP))];
  for (let i = 0; i < LIST_LINES.length; ++i) out.push(LIST_LINES[i]);
  while (out.length < 23) out.push(row(seg("")));
  out.push(row(seg(FNKEY_FOOTER)));
  return out;
})();

// 文章 ＋ 底部 footer 的功能鍵（pageState 3 ⇒ functionKeyRows(3, 24) = [23]）。
const ARTICLE_FNKEY_LINES = (() => {
  const out = ARTICLE_NATIVE_LINES.slice();
  while (out.length < 23) out.push(row(seg("")));
  out.push(row(seg(FNKEY_FOOTER)));
  return out;
})();

// 點下去要送什麼由 App.onFunctionKey 決定；golden 只鎖 DOM，故給一個穩定的空函式
// （引用穩定是 annotationsKey.refs 的前提，見 screen_annotate_cache.js）。
const NOOP_FNKEY = () => {};

export const SCENARIOS = [
  // 原生文章：hover 預覽開、黑名單留白（dropHidden=false）、樓層不顯示。
  scenario(
    "article_native",
    ARTICLE_NATIVE_LINES,
    {
      blacklist: new Set(["baduser"]),
      pageState: 3,
      easyReading: false,
      dropHidden: false,
      highlightAuthor: true,
      articleAuthor: "wowbenny",
    },
    { enableLinkHoverPreview: true },
  ),

  // 好讀累積長頁：全部增強打開（樓層／推文合併／mention／AID／裸網域／URL 修復），
  // 黑名單整列移除，自動開圖 inline，stableRows 讓增量快取生效。
  scenario(
    "article_easy_reading",
    ARTICLE_EASY_LINES,
    {
      blacklist: new Set(["baduser"]),
      showFloorNumbers: true,
      mergeSameAuthorComments: true,
      pageState: 3,
      easyReading: true,
      dropHidden: true,
      stableRows: true,
      autoFixUrl: true,
      bareDomainLink: true,
      enableXMention: true,
      highlightAuthor: true,
      articleAuthor: "wowbenny",
      onAidClick: () => {},
    },
    { enableLinkInlinePreview: true },
  ),

  // 同上但推文合併關閉 —— 逐則列的 DOM 與合併塊差很多，兩種都要鎖。
  scenario(
    "article_easy_no_merge",
    ARTICLE_EASY_LINES,
    {
      showFloorNumbers: true,
      mergeSameAuthorComments: false,
      pageState: 3,
      easyReading: true,
      dropHidden: true,
      stableRows: true,
      autoFixUrl: true,
      bareDomainLink: true,
      enableXMention: true,
    },
    { enableLinkInlinePreview: true },
  ),

  // 推文者高亮（整列 tint）：pusherHighlight 走 <Row> 的 className。
  scenario("article_pusher_highlight", ARTICLE_NATIVE_LINES, {
    pageState: 3,
    easyReading: false,
    selectedPusher: "gooduser",
  }),

  // 原生列表：黑名單 → 通知列（noticeSegments 旁路，繞過 LinkSegmentBuilder），
  // 刪除文原樣顯示。
  scenario("list_native", LIST_LINES, {
    blacklist: new Set(["adman"]),
    pageState: 2,
    easyReading: false,
  }),

  // 原生列表 + 標題關鍵字黑名單（通知列顯示命中的關鍵字而非作者）。
  scenario("list_native_title_blacklist", LIST_LINES, {
    titleBlacklist: ["廣告"],
    pageState: 2,
    easyReading: false,
  }),

  // 列表好讀視窗：deleted / blacklist 一律隱藏（hidden，不是通知列）。
  scenario("list_easy_reading", LIST_LINES, {
    blacklist: new Set(["adman"]),
    pageState: 2,
    listEasyReading: true,
    easyReading: true,
  }),

  // 列表好讀 ＋ 次列位移：body 區住進 .listBodyView（overflow:hidden，高度＝
  // 20 列），offsetPx 就是它的 scrollTop。這一份 golden 鎖的是「多包了一層之後
  // 列節點本身完全沒變」——data-row、class、內容都不動，只是換了父節點。
  scenario("list_easy_reading_scrolled", LIST_SCROLL_LINES, {
    pageState: 2,
    listEasyReading: true,
    easyReading: true,
    listScroll: {
      bodyStart: 3,
      bodyRows: 20,
      viewportPx: 400,
      offsetPx: 7,
      overscan: true,
    },
  }),

  // 原生列表 ＋ 功能鍵按鈕（row 1 的提示列 ＋ row 23 的 vs_footer）。
  // `(=[]<>)` 與 `(/?a)` 這兩組多鍵組**必須維持純文字**，golden 逐字鎖住。
  scenario("list_native_fnkeys", LIST_FNKEY_LINES, {
    pageState: 2,
    easyReading: false,
    functionKeyRows: [1, 23],
    onFunctionKey: NOOP_FNKEY,
  }),

  // 文章 ＋ 底部 footer 的功能鍵（pageState 3 只有最後一列，見 pmore.c）。
  scenario("article_footer_fnkeys", ARTICLE_FNKEY_LINES, {
    pageState: 3,
    easyReading: false,
    functionKeyRows: [23],
    onFunctionKey: NOOP_FNKEY,
  }),

  // 圖文合併（mergeCaption 由 controller 內部 state 驅動，見下方 INTERACTIONS）。
  scenario(
    "article_caption_merge",
    CAPTION_LINES,
    {
      pageState: 3,
      easyReading: true,
      dropHidden: true,
      stableRows: true,
    },
    { enableLinkInlinePreview: true },
  ),
];

// 需要「先設互動狀態再取 DOM」的場景：key = 場景名，值 = 要套用的動作。
// React 版經 imperative handle / 模擬點擊，純 JS 版經 controller 的 setter；
// 兩邊的**產物**必須相同，故動作在這裡宣告、由各自的測試檔翻譯。
export const INTERACTIONS = {
  // 游標底色：整列（col 0，絕大多數情形）。
  article_native: { cursorHighlight: { row: 7, cls: "b2", col: 0 } },
  // 游標底色：部分欄（防誤觸模式，底色包在 wrapper span 裡）。
  list_native: { cursorHighlight: { row: 0, cls: "b2", col: 17 } },
  // 圖文合併開成「上圖下文」。
  article_caption_merge: { mergeCaption: "imageFirst" },
};

// golden 比對前的正規化：
//  1. `.inlinePreviewSlot` 內部剪掉 —— 那是 ImagePreviewer（兩版共用的 React 葉子
//     島）的實作細節，不是渲染鏈的契約；只鎖佔位盒外殼。
//  2. 屬性順序：React 與手寫 DOM 的 setAttribute 順序不保證一致，且順序對任何
//     消費端都沒有意義，故逐元素排序後重建。
export function normalizeHtml(container) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll(".inlinePreviewSlot").forEach((slot) => {
    slot.textContent = "";
  });
  const sortAttrs = (el) => {
    const attrs = Array.from(el.attributes)
      .map((a) => [a.name, a.value])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    attrs.forEach(([n]) => el.removeAttribute(n));
    attrs.forEach(([n, v]) => el.setAttribute(n, v));
    Array.from(el.children).forEach(sortAttrs);
  };
  Array.from(clone.children).forEach(sortAttrs);
  // 每個頂層列一行，golden 檔的 diff 才讀得懂。
  return Array.from(clone.children)
    .map((n) => n.outerHTML)
    .join("\n");
}
