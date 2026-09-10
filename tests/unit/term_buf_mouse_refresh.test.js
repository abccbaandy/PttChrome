// 「server 重畫之後，滑鼠沒有物理移動」時 `buf.mouseAction` 必須仍然有效。
//
// 壞掉的行為：`notify()` 的每個 changed 幀都呼叫 `clearHighlight()`，它把
// `mouseAction` 清成 ACT_NONE、`mouseActionRow` 清成 -1；而重算原本**只由真實
// mousemove 觸發**（`resetMousePos()` 只有三個 pref handler 會呼叫，不在 notify
// 路徑上）⇒ 使用者點掉「請按任意鍵繼續」之後、指標停在原地不動時，
// `App.onMouse_click` 讀到的 action 是 none，整個落到 `default: //do nothing`。
// pttchrome.jsx 的 onMouse_click 開頭那段「先取值再交給好讀」註解就是為它寫的
// workaround，本檔把根因鎖住。
//
// 關鍵不變量（第二個 test）：重算**不可以碰 `nowHighlight`**。它的 setter 在
// row >= 0 時會轉呼叫 `view.applyCursorHighlight('mouse')` ＝宣告滑鼠取得底色
// 優先權；每個重畫幀都宣告一次的話，`_highlightMover` 會永遠是 'mouse'，鍵盤
// 再也搶不回光棒 —— 正是 fddf274 修掉的那個 bug
// （守護 tests/unit/cursor_highlight_arbitration.test.js）。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
import { ACT_ENTER, ACT_NONE } from "../../src/js/mouse_regions";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const COLS = 80;
const ROWS = 24;

const width = (s) => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return w;
};
const padCols = (s, cols) => s + " ".repeat(Math.max(0, cols - width(s)));
const at = (row, col) => "\x1b[" + (row + 1) + ";" + (col + 1) + "H";
const CLEAR = "\x1b[2J\x1b[H";

// 用【主功能表】當素材：它走 setPageState 的 row0 白名單那條，與本檔要測的東西
// 正交（子選單的分類另由 term_buf_page_state.test.js 守）。
const menuScreen = (cursorRow) =>
  CLEAR +
  at(0, 0) +
  "\x1b[30;47m" +
  padCols("【主功能表】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
  "\x1b[m" +
  at(13, 22) +
  "(A)nnounce     【 精華公佈欄 】" +
  at(18, 22) +
  "(U)ser         【 個人設定區 】" +
  at(19, 22) +
  "(X)yz          【 系統資訊區 】" +
  at(cursorRow, 20) +
  ">" +
  at(ROWS - 1, 0) +
  "\x1b[34;46m" +
  padCols(
    "9/10周四 17:09 [ 射手時 ]    線上25809人,我是someuser,呼叫器開啟",
    COLS - width("(h)說明")
  ) +
  "(h)說明" +
  "\x1b[m" +
  at(cursorRow, 20);

const pressAnyKeyScreen = () =>
  CLEAR +
  at(0, 0) +
  "\x1b[30;47m" +
  padCols("【系統資訊】" + " ".repeat(23) + "批踢踢實業坊", COLS) +
  "\x1b[m" +
  at(ROWS - 1, 0) +
  "▄".repeat(16) + " 請按任意鍵繼續 " + "▄".repeat(16);

describe("重畫後 mouseAction 重算（滑鼠沒動也要有效）", () => {
  beforeAll(() => loadBig5Tables());
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeBuf() {
    const highlightSources = [];
    const buf = new TermBuf(COLS, ROWS);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      applyCursorHighlight(source) {
        highlightSources.push(source);
      },
      setExitAffordance() {},
      charset: "big5",
      blinkOn: false,
      mouseLeftClick: true,
      mouseMisclickGuard: false,
    });
    buf.useMouseBrowsing = true;
    const parser = new AnsiParser(buf);
    return {
      buf,
      highlightSources,
      paint(screen) {
        parser.feed(u2b(screen));
        vi.advanceTimersByTime(300);
      },
    };
  }

  test("選單上 hover 過的可點列，重畫一幀後 mouseAction 仍是 enter", () => {
    const t = makeBuf();
    t.paint(menuScreen(18));
    t.buf.onMouse_move(30, 19);
    expect(t.buf.mouseAction).toBe(ACT_ENTER);
    expect(t.buf.mouseActionRow).toBe(19);

    // server 重畫（例如關掉「請按任意鍵繼續」後選單整幅重畫）。滑鼠完全沒動。
    t.paint(menuScreen(19));
    expect(t.buf.mouseAction).toBe(ACT_ENTER);
    expect(t.buf.mouseActionRow).toBe(19);
  });

  test("重畫的重算不可宣告滑鼠底色優先權（不得以 'mouse' 呼叫 applyCursorHighlight）", () => {
    const t = makeBuf();
    t.paint(menuScreen(18));
    t.buf.onMouse_move(30, 19);

    t.highlightSources.length = 0;
    t.paint(menuScreen(19));
    expect(t.highlightSources).not.toContain("mouse");
  });

  test("pressanykey 畫面重畫後不得無中生有（維持 none）", () => {
    const t = makeBuf();
    t.paint(menuScreen(18));
    t.buf.onMouse_move(30, 19);
    expect(t.buf.mouseAction).toBe(ACT_ENTER);

    t.paint(pressAnyKeyScreen());
    expect(t.buf.mouseAction).toBe(ACT_NONE);
  });

  test("列表好讀（listRenderMode buffer）不參與：座標系不同，交給 view.onListMouseMove", () => {
    const t = makeBuf();
    t.paint(menuScreen(18));
    t.buf.onMouse_move(30, 19);
    expect(t.buf.mouseAction).toBe(ACT_ENTER);

    t.buf.listRenderMode = "buffer";
    t.paint(menuScreen(19));
    expect(t.buf.mouseAction).toBe(ACT_NONE);
  });
});
