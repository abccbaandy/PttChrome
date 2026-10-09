// @unit-env browser
// 手機主功能表大按鈕（docs/mobile.md「Phase 5」）：
//   - enhance.menuCards 時選單項列畫成按鈕（render/menu_card.js），ANSI 圖／標題／狀態列
//     照舊是格線列，選單項之後的空白列收起來；DOM 契約（bbsrow/srow、bbsline/data-row）保留；
//   - 桌機（沒有 menuCards）一列都不換；
//   - CSS 高度／字級與常數一致；
//   - 點按鈕由 DOM 目標取列（data-menu-row），送「移游標＋Enter」；點 art 什麼都不送；
//   - `.main` 撐到可視高（mobileMenuLayout）。
// real-input: tests/e2e/offline/mobile_main_menu.offline.spec.js
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import {
  MENU_CARD_PX,
  buildMenuCard,
  menuCardParts,
} from "../../src/render/menu_card";
import {
  MOBILE_ROW_FONT_PX,
  menuCardTargetRow,
  mobileMenuLayout,
} from "../../src/js/mobile_layout";
import { App } from "../../src/js/pttchrome";
import mainCss from "../../src/css/main.css?raw";
import {
  MAIN_MENU_ROWS,
  MAIN_MENU_ITEM_ROWS,
  MAIN_MENU_CURSOR_ROW,
  SUBMENU_ROWS,
  SUBMENU_ITEM_ROWS,
} from "./fixtures/main_menu_rows";

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const NORMAL = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return !!o && o.fg === this.fg && o.bg === this.bg && o.blink === this.blink;
  },
};

const line = (str) =>
  str.split("").map((c) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => NORMAL,
  }));

// 錄製畫面 row 0–22 ＋ 4 列空白 ＋ 狀態列（內容用佔位，不含帳號）＝ 28 列。
const STATUS = " 主選單   某節日   10/9 週五 13:31 | someone | 線上1人      (h)說明  ";
const ROWS = [...MAIN_MENU_ROWS, ...Array(4).fill(" ".repeat(80)), STATUS];
const LINES = ROWS.map(line);

function render(menuCards) {
  return mountScreen({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: { pageState: 1, menuCards },
  });
}

const rowNode = (s, r) => s.container.querySelector(`[type="bbsrow"][srow="${r}"]`);

describe("render：menuCards", () => {
  test("選單項列是按鈕，其餘不是", () => {
    const s = render(true);
    const cards = Array.from(s.container.querySelectorAll(".menuCard")).map((n) =>
      Number(n.getAttribute("data-menu-row")),
    );
    expect(cards).toEqual(MAIN_MENU_ITEM_ROWS);
    for (let r = 0; r <= 12; ++r) expect(rowNode(s, r).classList.contains("menuCard")).toBe(false);
  });

  test("按鈕內容：(X) 與描述；游標記號不進按鈕", () => {
    const s = render(true);
    const card = rowNode(s, MAIN_MENU_CURSOR_ROW);
    expect(card.querySelector(".menuCardKey").textContent).toBe("(F)");
    expect(card.querySelector(".menuCardDesc").textContent).toBe(
      "avorite     【 我 的 最愛 】",
    );
    expect(card.textContent).not.toContain(">");
  });

  test("DOM 契約：bbsrow/srow ＋ bbsline/data-row", () => {
    const s = render(true);
    for (const r of MAIN_MENU_ITEM_ROWS) {
      const body = rowNode(s, r).querySelector('[data-type="bbsline"]');
      expect(body.getAttribute("data-row")).toBe(String(r));
    }
  });

  test("選單項之後的空白列收起來，狀態列照舊", () => {
    const s = render(true);
    for (let r = 23; r <= 26; ++r)
      expect(rowNode(s, r).classList.contains("menuBlankRow")).toBe(true);
    expect(rowNode(s, 27).classList.contains("menuBlankRow")).toBe(false);
    expect(rowNode(s, 27).textContent).toContain("(h)說明");
  });

  test("游標底色下在按鈕本體", () => {
    const s = render(true);
    s.controller.setCursorHighlight({ row: 16, cls: "b4", col: 8 });
    expect(rowNode(s, 16).querySelector(".menuCardBody").classList.contains("b4")).toBe(
      true,
    );
  });

  test("子選單（個人設定區）一樣：選單項是按鈕，數字快捷鍵也算", () => {
    const s = mountScreen({
      lines: SUBMENU_ROWS.map(line),
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: { pageState: 1, menuCards: true },
    });
    const cards = Array.from(s.container.querySelectorAll(".menuCard"));
    expect(cards.map((n) => Number(n.getAttribute("data-menu-row")))).toEqual(
      SUBMENU_ITEM_ROWS,
    );
    expect(cards[6].querySelector(".menuCardKey").textContent).toBe("(2)");
    expect(rowNode(s, 23).textContent).toContain("回到上層");
  });

  test("桌機（沒有 menuCards）一列都不換", () => {
    const s = render(undefined);
    expect(s.container.querySelector(".menuCard")).toBe(null);
    expect(s.container.querySelector(".menuBlankRow")).toBe(null);
  });
});

test("menuCardParts：不是選單項回 null", () => {
  expect(menuCardParts(LINES[3])).toBe(null);
  expect(menuCardParts(LINES[22])).toEqual({ key: "G", desc: "oodbye         離開，再見…" });
});

test("CSS 高度／字級與常數一致", () => {
  const card = mainCss.match(/span\.menuCard \{([^}]*)\}/)[1];
  expect(card).toContain(`height: ${MENU_CARD_PX}px;`);
  const body = mainCss.match(/\.menuCard \.menuCardBody \{([^}]*)\}/)[1];
  expect(body).toContain(`font-size: ${MOBILE_ROW_FONT_PX}px;`);
});

test("menuCardTargetRow：按鈕內任何子元素都取得到列，按鈕外 -1", () => {
  const card = buildMenuCard({ chars: LINES[15], row: 15 }).node;
  document.body.appendChild(card);
  expect(menuCardTargetRow(card.querySelector(".menuCardKey"))).toBe(15);
  expect(menuCardTargetRow(card)).toBe(15);
  expect(menuCardTargetRow(document.body)).toBe(-1);
  expect(menuCardTargetRow(null)).toBe(-1);
  card.remove();
});

describe("mobileMenuLayout", () => {
  test("可視高比格線高 ⇒ 撐滿、貼頂", () => {
    expect(
      mobileMenuLayout({ innerHeight: 780, bottomInset: 48, chh: 10, rows: 45 }),
    ).toEqual({ height: 732, marginTop: 0 });
  });

  test("可視高不夠 ⇒ 退回格線規則", () => {
    expect(
      mobileMenuLayout({ innerHeight: 300, bottomInset: 0, chh: 10, rows: 45 }),
    ).toEqual({ height: 460, marginTop: 0 });
  });
});

// App.mouse_click 的 menuCards 分支。
function makeApp({ cur_y = MAIN_MENU_CURSOR_ROW, leftClick = true } = {}) {
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.CmdHandler = { getAttribute: () => "0", setAttribute: () => {} };
  app.buf = {
    useMouseBrowsing: true,
    listRenderMode: "native",
    pageState: 1,
    cols: 80,
    rows: 28,
    cur_y,
    onMouse_move: vi.fn(),
    dismissTarget: vi.fn(() => null),
    mouseAction: "none",
    mouseActionRow: -1,
  };
  app.view = { _send: vi.fn(), menuCards: true, flashListHint: vi.fn() };
  app.conn = { isConnected: true };
  app.mouseButtons = {
    onMouseDown: vi.fn(),
    onMouseUp: vi.fn(),
    syncFromButtons: vi.fn(),
  };
  app.aidNavigation = { active: false };
  app.setDblclickTimer = vi.fn();
  // 格子座標刻意給錯的列：分支若偷用 clientToPos 會送錯。
  app.clientToPos = vi.fn(() => ({ col: 40, row: 3 }));
  app.mouseGates = vi.fn(() => ({
    leftClick,
    misclickGuard: true,
    serverReport: false,
    wheel: true,
  }));
  app.activeListSession = vi.fn(() => null);
  app.onMouse_click = vi.fn();
  app.onDisableLiveHelperModalState = vi.fn();
  app.setInputAreaFocus = vi.fn();
  app.checkClass = vi.fn(() => false);
  app._onUploadLayer = vi.fn(() => false);
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: true,
    toString: () => "",
  });
  return app;
}

const click = (target) => ({
  button: 0,
  clientX: 100,
  clientY: 100,
  target,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

describe("App.mouse_click：手機主選單按鈕", () => {
  test("點 (M) 按鈕 ⇒ 從游標列往下移兩列＋Enter（不經 clientToPos）", () => {
    const app = makeApp();
    const card = buildMenuCard({ chars: LINES[16], row: 16 }).node;
    document.body.appendChild(card);
    app.mouse_click(click(card.querySelector(".menuCardDesc")));
    expect(app.view._send).toHaveBeenCalledWith("\x1b[B\x1b[B\r");
    expect(app.onMouse_click).not.toHaveBeenCalled();
    card.remove();
  });

  test("點游標所在那顆 ⇒ 只送 Enter", () => {
    const app = makeApp();
    const card = buildMenuCard({ chars: LINES[14], row: 14 }).node;
    document.body.appendChild(card);
    app.mouse_click(click(card));
    expect(app.view._send).toHaveBeenCalledWith("\r");
    card.remove();
  });

  test("點按鈕以外（縮小的 ANSI 圖）⇒ 什麼都不送，也不落到格子座標那條", () => {
    const app = makeApp();
    const art = document.createElement("span");
    document.body.appendChild(art);
    app.mouse_click(click(art));
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.onMouse_click).not.toHaveBeenCalled();
    art.remove();
  });
});
