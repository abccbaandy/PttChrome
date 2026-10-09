// @unit-env browser
// 選單（主功能表與子選單）的滑鼠區域接線（term_buf.setPageState →
// _resolveMouseRegionAt → mouse_regions）：畫面文字畫進真的 TermBuf，上半的 ANSI 圖／
// 心情點播不可點、不上底色，選單項照舊可點。
// 回歸：滑鼠移到 art 上會高亮成可點項目（主功能表與子選單皆然）。子選單的 pageState 1
// 來自 setPageState 的 parseListRow 分支，這裡一併確認從 pressanykey 回來接得上。
// 判定依據見 src/js/menu_items.js（mbbsd/menu.c#menu_renderer、#show_status_bar）。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
import { ACT_ENTER, ACT_NONE } from "../../src/js/mouse_regions";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import {
  MAIN_MENU_ROWS,
  MAIN_MENU_ITEM_ROWS,
  MAIN_MENU_STATUS,
  SUBMENU_ROWS,
  SUBMENU_ITEM_ROWS,
} from "./fixtures/main_menu_rows";

loadBig5Tables();

const MAIN_MENU_SCREEN = [...MAIN_MENU_ROWS, MAIN_MENU_STATUS];

// stalePageState：畫之前的 pageState（setPageState 沒有 reset 分支，判不出就沿用）。
function draw(rows, stalePageState) {
  const buf = new TermBuf(80, rows.length);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  buf.pageState = stalePageState;
  let bytes = "\x1b[H\x1b[2J";
  rows.forEach((text, r) => {
    // 標題列整列 80 格反白（redraw_title 用空白補滿），term_buf.setPageState 的
    // isUnicolor 閘門看的就是它。
    bytes +=
      "\x1b[" + (r + 1) + ";1H" +
      (r === 0 ? "\x1b[7m" + u2b(text) + "\x1b[m" : u2b(text.trimEnd()));
  });
  new AnsiParser(buf).feed(bytes);
  // getRowText 依賴 isLeadByte（重畫路上才設），setPageState 也在 notify 裡跑。
  buf.notify();
  buf.view.update = () => {};
  return buf;
}

describe.each([
  ["主功能表", MAIN_MENU_SCREEN, MAIN_MENU_ITEM_ROWS],
  ["子選單（個人設定區）", SUBMENU_ROWS, SUBMENU_ITEM_ROWS],
])("%s", (_name, rows, itemRows) => {
  test("從 pressanykey（pageState 5）回來 ⇒ pageState 1、認得是選單、不是看板列表", () => {
    const buf = draw(rows, 5);
    expect(buf.pageState).toBe(1);
    expect(buf.isMenuScreen()).toBe(true);
    expect(buf.isBoardListScreen()).toBe(false);
  });

  test("ANSI 圖／心情點播／分隔線：不可點、不上底色", () => {
    const buf = draw(rows, 1);
    for (let row = 1; row <= 12; ++row) {
      const r = buf._resolveMouseRegionAt(40, row);
      expect([row, r.action, r.highlightRow]).toEqual([row, ACT_NONE, -1]);
    }
  });

  test("選單項：可點＋上底色", () => {
    const buf = draw(rows, 1);
    for (const row of itemRows) {
      const r = buf._resolveMouseRegionAt(30, row);
      expect([row, r.action, r.highlightRow]).toEqual([row, ACT_ENTER, row]);
    }
  });
});
