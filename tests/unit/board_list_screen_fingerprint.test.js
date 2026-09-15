// 「這一幀是不是看板列表」的指紋（`buf.isBoardListScreen`）。
//
// 為什麼需要它：pageState 1 底下有兩種完全不同的畫面，而它們的 Home/End 在 PTT 端
// **語意相反** ——
//   看板列表 mbbsd/board.c:1830,1768 → `num = 0` / `num = brdnum - 1`（第一個／
//                                       最後一個看板，＝使用者預期的跳頁）
//   主功能表 mbbsd/menu.c:508,517    → `++i` / `--i`（下一項／上一項，與
//                                       KEY_PGUP/KEY_PGDN 同一組）
// ⇒ 邊緣點擊翻頁（mouseEdgePaging）只能給前者，判準就是這支。
//
// 指紋出處 board.c:1279 的標題 `【看板列表】`，與 board_list_parse
// .classifyBoardListScreen 的第一條判斷**同一個事實、同一種取字方式**
// （`buf.getRowText(r, 0, buf.cols)`）。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { resolveMouseRegion, ACT_HOME, ACT_NONE } from "../../src/js/mouse_regions";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

function makeBuf() {
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return buf;
}

// Big5 的 `【看板列表】`（畫面上是 server 送來的位元組，不是 UTF-8）。
const BIG5_TITLE = "\xa1\x69\xac\xdd\xaa\x4f\xa6\x43\xaa\xed\xa1\x6a";

function drawTitle(buf, bytes) {
  new AnsiParser(buf).feed("\x1b[H\x1b[2J\x1b[1;1H" + bytes);
  // getRowText 依賴 isLeadByte，而那是 updateCharAttr 在重畫路上設的
  // （docs/mouse.md：「getRowText 只有在重畫之後才有意義」）。
  buf.notify();
  buf.view.update = () => {};
}

describe("isBoardListScreen", () => {
  test("看板列表的標題列 ⇒ true", () => {
    const buf = makeBuf();
    drawTitle(buf, BIG5_TITLE + "  \xbd\x73\xb8\xb9"); // 【看板列表】 編號
    buf.pageState = 1;
    expect(buf.isBoardListScreen()).toBe(true);
  });

  test("主功能表（標題不是【看板列表】）⇒ false", () => {
    const buf = makeBuf();
    drawTitle(buf, "\xa1\x69\xa5\x5c\xaf\xe0\xaa\xed\xa1\x6a"); // 【功能表】
    buf.pageState = 1;
    expect(buf.isBoardListScreen()).toBe(false);
  });

  test("其餘 pageState 一格都不掃（連文章列表也回 false）", () => {
    const buf = makeBuf();
    drawTitle(buf, BIG5_TITLE);
    for (const ps of [0, 2, 3, 4, 5, 6]) {
      buf.pageState = ps;
      expect(buf.isBoardListScreen()).toBe(false);
    }
  });
});

// 指紋 → 決策的接線：同一格在兩種畫面上給出不同的答案。
describe("pageState 1 的邊緣區只在看板列表成立", () => {
  const at = (boardList) =>
    resolveMouseRegion({
      pageState: 1,
      row: 0,
      col: 40,
      rows: 24,
      cols: 80,
      edgePaging: true,
      boardList,
    });

  test("看板列表的頂列＝Home；主功能表什麼都不是", () => {
    expect(at(true).action).toBe(ACT_HOME);
    expect(at(false).action).toBe(ACT_NONE);
    expect(at(false).hintBand).toBe(null);
  });
});
