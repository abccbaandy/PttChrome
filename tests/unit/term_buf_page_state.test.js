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
});
