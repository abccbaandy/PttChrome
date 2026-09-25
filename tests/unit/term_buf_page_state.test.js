// `TermBuf.setPageState` 對 **menu.c#domenu 子選單**的分類。
//
// 為什麼要有這一份：`setPageState` **刻意沒有 reset 分支**
// （term_buf.js 那行被註解掉的 `pageState = 0`，理由見 docs/pttbbs-screen-protocol.md），
// 任一分支都不命中時就沿用上一幀。而它判 MENU 只有兩條路：
//   (a) row0 開頭是 `【主功能表】`/`【分類看板】`/`【精華文章】`
//   (b) `parseListRow(最後一列)` —— menu.c#show_status 的狀態列指紋
// `(X)yz 系統資訊區` 這類子選單的 row0 是 `【工具程式】`，**只剩 (b)**。2026-09 以前 (b)
// 的 regex 比對的是 pttbbs 史上不存在的格式（見 string_util.js 的長註解）⇒ 恆為 false
// ⇒ 子選單一律沿用上一幀，實測造成兩個使用者可見的 bug：
//   1. 「查看系統資訊」是 pressanykey（pageState 5），關框回子選單後**黏在 5**
//      ⇒ resolveMouseRegion 的 switch 走 default ⇒ 滑鼠瀏覽整個失效，
//        要走到判得出來的畫面才恢復。
//   2. 讀完一篇按 ← 回子選單（黏在 3）再開下一篇 ⇒ settled edge 是 `3→3`，
//      不在 nextEasyReadingState 的來源集 {1,2} ⇒ 好讀「有時」不啟用。
// 故本檔鎖的是**症狀**：「離開一個非選單畫面回到子選單時，pageState 必須回到 1」。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const COLS = 80;
const ROWS = 24;

// 顯示寬度（Big5 全形字佔兩欄）。
const width = (s) => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return w;
};
const padCols = (s, cols) => s + " ".repeat(Math.max(0, cols - width(s)));

const at = (row, col) => "\x1b[" + (row + 1) + ";" + (col + 1) + "H";
const CLEAR = "\x1b[2J\x1b[H";

// menu.c:302-322#show_status 的實際輸出（ANSI 已省略，setPageState 吃的是純文字）：
//   "%d/%d周%c%c %d:%02d" "%-14s"(today_is) " 線上" "%d" "人,我是" "%s" ",呼叫器" "%s"
//   "\t"(vbarf 靠右) "(h)" "說明"
// today_is 是站長可改的任意文字，`%-14s` 補的是**位元組**寬度；這裡沿用線上實測值
// " [ 射手時 ]   "（8 個 ASCII ＋ 3 個 Big5 字 = 14 bytes）。
const showStatusRow = (pager = "開啟", user = "someuser") =>
  padCols(
    "9/10周四 17:09 [ 射手時 ]    線上25809人,我是" + user + ",呼叫器" + pager,
    COLS - width("(h)說明")
  ) + "(h)說明";

// 子選單畫面：row0 是 showtitle() 的反白標題列（setPageState 要求
// isUnicolor(0,0,29) 與 isUnicolor(0,cols-20,cols-10)，故整列都要上底色），
// 底列是 show_status。標題不是三個白名單之一 —— 這正是重點。
const subMenuScreen = () =>
  CLEAR +
  at(0, 0) +
  "\x1b[30;47m" +
  padCols("【工具程式】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
  "\x1b[m" +
  at(12, 20) +
  "> (T)Hot Topics   【熱門話題與看板】" +
  at(13, 22) +
  "(U)sers         【使用者相關統計】" +
  at(17, 22) +
  "(L)Updates      《本站系統程式更新紀錄》" +
  at(18, 22) +
  "(X)info         《查看系統資訊》" +
  at(ROWS - 1, 0) +
  "\x1b[34;46m" +
  showStatusRow() +
  "\x1b[m" +
  at(12, 20);

// 【主功能表】：走 row0 白名單那條，任何時候都判得出來（對照組）。
const mainMenuScreen = () =>
  CLEAR +
  at(0, 0) +
  "\x1b[30;47m" +
  padCols("【主功能表】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
  "\x1b[m" +
  at(18, 20) +
  "> (X)yz          【 系統資訊區 】" +
  at(ROWS - 1, 0) +
  "\x1b[34;46m" +
  showStatusRow() +
  "\x1b[m" +
  at(18, 20);

// 「查看系統資訊」：vtuikit.h 的 VMSG_PAUSE " 請按任意鍵繼續 "，整列以 ▄ 填滿置中。
const pressAnyKeyScreen = () =>
  CLEAR +
  at(0, 0) +
  "\x1b[30;47m" +
  padCols("【系統資訊】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
  "\x1b[m" +
  at(2, 0) +
  "您現在位於 批踢踢實業坊" +
  at(ROWS - 1, 0) +
  // 實測整列剛好 80 欄：▄×16 (32) ＋ " 請按任意鍵繼續 " (16) ＋ ▄×16 (32)。
  "▄".repeat(16) + " 請按任意鍵繼續 " + "▄".repeat(16);

// pmore 文章（《本站系統程式更新紀錄》就是這一種）：底列 = parseStatusRow 指紋。
const articleScreen = () =>
  CLEAR +
  at(0, 0) +
  "PTT 系統程式更新記錄    (使用者版)" +
  at(ROWS - 1, 0) +
  padCols(
    "  瀏覽 第 1 頁 (  2%)  目前顯示: 第 01~22 行",
    COLS - width("(h)說明 (←/q)離開")
  ) +
  "(h)說明 (←/q)離開" +
  at(ROWS - 1, COLS - 1);

describe("TermBuf.setPageState — menu.c 子選單", () => {
  beforeAll(() => loadBig5Tables());
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeBuf() {
    const buf = new TermBuf(COLS, ROWS);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      charset: "big5",
      blinkOn: false,
    });
    buf.useMouseBrowsing = false;
    const parser = new AnsiParser(buf);
    return {
      buf,
      // 一幀 server 畫面：餵 Big5 位元組後把 queueUpdate 的 30ms debounce 跑完，
      // 走的是真的 notify() → updateCharAttr() → setPageState()。
      paint(screen) {
        parser.feed(u2b(screen));
        vi.advanceTimersByTime(300);
      },
    };
  }

  test("主功能表 → 1（對照組：走 row0 白名單）", () => {
    const t = makeBuf();
    t.paint(mainMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  test("系統資訊區子選單（row0 是【工具程式】）→ 1", () => {
    const t = makeBuf();
    t.paint(subMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // 使用者回報 #2：進「查看系統資訊」再退出，滑鼠瀏覽 100% 失效。
  test("pressanykey(5) 關框回到子選單 ⇒ 必須回到 1，不可黏在 5", () => {
    const t = makeBuf();
    t.paint(subMenuScreen());
    t.paint(pressAnyKeyScreen());
    expect(t.buf.pageState).toBe(5);

    t.paint(subMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // 使用者回報 #1：好讀「有時」沒啟用 —— 子選單黏在 3 時，下一篇的 settled edge
  // 會是 3→3，不在 nextEasyReadingState 的來源集 {1,2} 裡。
  test("文章(3) 按 ← 回到子選單 ⇒ 必須回到 1，不可黏在 3", () => {
    const t = makeBuf();
    t.paint(subMenuScreen());
    t.paint(articleScreen());
    expect(t.buf.pageState).toBe(3);

    t.paint(subMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // ─── PTT 2026-09-20 改版後的同一批畫面 ───────────────────────────────────
  //
  // CONFIRMED（讀碼 @ pttbbs origin/piaip.newui 7e35b24e，menu.c#show_status）：
  //   *[0;34;46m %s *[1;33;45m%-14s *[30;47m %d/%d 週%s %d:%02d | <ID>[ | 線上N人]
  //   vbarlr 靠右：子選單 "(←)回到上層 (h)說明 "、主選單 "(h)說明 "
  // 子選單在 stream_width(lbuf)+22 > t_columns-1 時把「 | 線上N人」整段截掉
  // （80 欄幾乎必然）⇒ 下面的子選單 fixture 照 source 不含線上人數。
  // ⇒ 舊的 parseListRow 錨點（`周`、`人,我是`、`,呼叫器`、線上人數）新版都不可靠。
  //
  // 上面那一批舊格式的測試一條都不准刪：PTT1/PTT2 上線時間不同，兩種格式並存。
  const newStatusRow = (label, { tail = "(h)說明 ", online = " | 線上25809人" } = {}) =>
    padCols(
      " " + label + " [ 秋分 ]       9/25 週四 10:06 | someuser" + online,
      COLS - width(tail)
    ) + tail;

  const newSubMenuScreen = () =>
    CLEAR +
    at(0, 0) +
    "\x1b[30;47m" +
    padCols("【工具程式】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
    "\x1b[m" +
    at(12, 20) +
    "> (T)Hot Topics   【熱門話題與看板】" +
    at(18, 22) +
    "(X)info         《查看系統資訊》" +
    at(ROWS - 1, 0) +
    "\x1b[34;46m" +
    newStatusRow("工具程式", { tail: "(←)回到上層 (h)說明 ", online: "" }) +
    "\x1b[m" +
    at(12, 20);

  test("新版底列的子選單（row0 是【工具程式】）→ 1", () => {
    const t = makeBuf();
    t.paint(newSubMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // 這一條才是真正的症狀鎖：新版底列下，子選單仍必須能從非選單畫面回到 1。
  // parseListRow 失效時它會黏在 5（滑鼠瀏覽整個失效）。
  test("新版底列：pressanykey(5) 關框回子選單 ⇒ 必須回到 1", () => {
    const t = makeBuf();
    t.paint(newSubMenuScreen());
    t.paint(pressAnyKeyScreen());
    expect(t.buf.pageState).toBe(5);

    t.paint(newSubMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // 新舊兩種底列在同一個 session 裡交替出現（PTT1 與 PTT2 上線差兩週、
  // 使用者可能換站）也要都判得出來。
  test("新舊底列交替出現都判得出 MENU", () => {
    const t = makeBuf();
    t.paint(subMenuScreen());
    expect(t.buf.pageState).toBe(1);
    t.paint(articleScreen());
    expect(t.buf.pageState).toBe(3);
    t.paint(newSubMenuScreen());
    expect(t.buf.pageState).toBe(1);
    t.paint(articleScreen());
    expect(t.buf.pageState).toBe(3);
    t.paint(subMenuScreen());
    expect(t.buf.pageState).toBe(1);
  });

  // 去括號的 row0（公告的兩段式形狀）。三段式標題公告保證不變，但 screen_titles
  // 兩種都吃 —— 這條確認那個容錯真的接到 setPageState 上。
  test("去括號 row0（ 主功能表 ）仍判得出 MENU", () => {
    const t = makeBuf();
    t.paint(
      CLEAR +
        at(0, 0) +
        "\x1b[30;47m" +
        padCols(" 主功能表 " + " ".repeat(21) + "批踢踢實業坊", COLS) +
        "\x1b[m" +
        at(18, 20) +
        "> (X)yz          【系統資訊區】" +
        at(ROWS - 1, 0) +
        "\x1b[34;46m" +
        // 底列刻意用「認不出來」的內容，逼判定只能走 row0 那條。
        padCols(" 主功能表 ", COLS) +
        "\x1b[m" +
        at(18, 20)
    );
    expect(t.buf.pageState).toBe(1);
  });

  // ─── 編輯器（vedit）底列 → pageState 6 ────────────────────────────────────
  // 舊版 CONFIRMED @ edit.c:470-479：
  //   vs_footer(" 編輯文章 ", " (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開\t%s│%c%c%c%c%3d:%3d")
  // 新版 CONFIRMED（讀碼 @ piaip.newui，edit.c#edit_msg）：caption「 編輯文章 」與
  //   右側 `%s│%c%c%c%c%3d:%3d` 格式不變，中段改成 " (^X)存檔 (^C)色碼 …"（塞得下才印）
  //   ＋靠右 "(Esc-h)… (^Z)…"，整段右對齊到 t_columns-2。
  // 以前比對的是整段中段提示 ⇒ 新版一上線 pageState 6 就失效，編輯器內的圖片上傳
  // （image_upload.js 的 pageState 6 → send）會走錯路徑。
  const editorScreen = (mid) =>
    CLEAR +
    at(0, 0) +
    "作者: someuser  看板: Test" +
    at(2, 0) +
    "內文第一行" +
    at(ROWS - 1, 0) +
    "\x1b[34;46m 編輯文章 \x1b[30;47m" +
    padCols(mid, COLS - width(" 編輯文章 ") - width("插入│aipr  3:  5")) +
    "插入│aipr  3:  5" +
    "\x1b[m" +
    at(2, 4);

  test("舊版編輯器底列 → 6", () => {
    const t = makeBuf();
    t.paint(editorScreen(" (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開"));
    expect(t.buf.pageState).toBe(6);
  });

  test("新版編輯器底列（動態指令列中段）→ 6", () => {
    const t = makeBuf();
    t.paint(editorScreen(" (^X)存檔 (^C)色碼 (^V)彩色 (Esc-h)按鍵 (^Z)說明"));
    expect(t.buf.pageState).toBe(6);
  });

  test("底列以「 編輯文章 」開頭但沒有右側狀態框 ⇒ 不是 6", () => {
    const t = makeBuf();
    t.paint(subMenuScreen());
    t.paint(
      CLEAR + at(0, 0) + "隨便一段內文" + at(ROWS - 1, 0) + " 編輯文章 的心得分享" + at(0, 0)
    );
    expect(t.buf.pageState).not.toBe(6);
  });
});
