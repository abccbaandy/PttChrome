// @unit-env browser
// 手機精華區卡片（P88，js/essence_list.js、render/essence_card.js、docs/mobile.md「精華區卡片」）。
//
// 鎖的症狀：
//   1. 精華區項目列（upstream announce.c 新版 announce_renderer、舊版 a_showmenu 的版型）解成
//      編號／目錄或文章／標題／編選者／日期；不是項目列 ⇒ null（該列照舊畫格線）。
//   2. 畫面指紋：row 0【精華文章】＋欄位標題列＋底列 caption（一般瀏覽／板主），缺一 ⇒ 不是
//      （照舊格線）；複製佇列（標記項目）也不接（c 標記要看得到）。
//   3. 手機（enhance.menuCards === 'essence'）：項目列畫成卡片（data-menu-row ⇒ 點卡片送
//      「移游標＋⏎」）、欄位標題列收起、標題列改畫所在位置；主功能表模式不畫精華區卡片。
// real-input: tests/e2e/offline/mobile_essence_cards.offline.spec.js
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import {
  essenceCrumb,
  essenceHeaderRow,
  essenceCursorRowOk,
  isEssenceListFooter,
  parseEssenceRow,
} from "../../src/js/essence_list";
import { ESSENCE_CARD_PX, buildEssenceCard } from "../../src/render/essence_card";
import { menuCardTargetRow } from "../../src/js/mobile_layout";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import mainCss from "../../src/css/main.css?raw";
import essenceFx from "./fixtures/ptt_src_screens/essence.json";
import essenceLegacyFx from "./fixtures/ptt_src_screens_legacy/essence_01b5517.json";
import { ESSENCE_ROWS, ESSENCE_ROWS_OLD, ESSENCE_ITEM_ROWS } from "./fixtures/essence_rows";

beforeAll(() => loadBig5Tables());
afterEach(() => unmountAll());

function bufAt(fx, name) {
  const idx = fx.frames.findIndex((f) => f.name === name);
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    applyCursorHighlight() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (let i = 0; i <= idx; ++i) {
    parser.feed(fx.frames[i].bytes);
    buf.notify();
    clearTimeout(buf.timerUpdate);
  }
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return buf;
}

describe("upstream 產的畫面", () => {
  test.each([
    ["新版", essenceFx],
    ["舊版 01b5517", essenceLegacyFx],
  ])("%s：精華區認得出、文字跟 ESSENCE_ROWS 一致", (_n, fx) => {
    const buf = bufAt(fx, "menu");
    expect(buf.isEssenceListScreen()).toBe(true);
    expect(buf.isPromptPending()).toBe(false);
    const rows = Array.from({ length: buf.rows }, (_, y) => buf.getRowText(y, 0, buf.cols));
    expect(rows).toEqual(ESSENCE_ROWS);
  });

  test.each([
    ["文章列表", "list"],
    ["精華區開的文章", "article"],
  ])("同一卷的%s ⇒ 不是精華區列表", (_n, name) => {
    expect(bufAt(essenceFx, name).isEssenceListScreen()).toBe(false);
  });
});

describe("parseEssenceRow", () => {
  test("upstream 項目列", () => {
    expect(parseEssenceRow(ESSENCE_ROWS[3])).toEqual({
      num: 1,
      kind: "file",
      title: "[爆卦] 收進精華區的文章",
      editor: "judy",
      date: "09/27/26",
      cursor: true,
      hidden: false,
      bmOnly: false,
    });
  });

  test("舊版 a_showmenu（● 游標、欄距不同）＋目錄", () => {
    expect(parseEssenceRow(ESSENCE_ROWS_OLD[2])).toMatchObject({
      num: 1,
      kind: "dir",
      title: "[板規] 本板板規與公告",
      editor: "sysop",
      cursor: true,
    });
    expect(parseEssenceRow(ESSENCE_ROWS_OLD[3])).toMatchObject({ num: 2, kind: "file", cursor: false });
  });

  test("板主限定（X）／隱藏（)）／已標記（c）／沒有前綴", () => {
    expect(parseEssenceRow("     4X  ◆ 板主資料夾        sysop        [01/02/26]")).toMatchObject({ bmOnly: true, kind: "dir" });
    expect(parseEssenceRow("     5)  ◇ 藏起來的         sysop        [01/02/26]")).toMatchObject({ hidden: true });
    expect(parseEssenceRow("     6.c ◇ 標記的           sysop        [01/02/26]")).toMatchObject({ num: 6 });
    expect(parseEssenceRow("     7.  沒有前綴的標題      sysop        [01/02/26]")).toMatchObject({ kind: "other", title: "沒有前綴的標題" });
  });

  test.each([
    ["空白列", " ".repeat(80)],
    ["欄位標題列", ESSENCE_ROWS[2]],
    ["空精華區的提示", "  《精華區》尚在吸取天地間的日月精華中... :)"],
    ["日期不是 [MM/DD/YY]", "     1.  ◇ 標題               judy         09/27/26"],
    ["沒有編選者", "     1.  ◇ [01/02/26]"],
    ["不是字串", null],
  ])("%s → null", (_n, row) => {
    expect(parseEssenceRow(row)).toBeNull();
  });
});

// 點卡片前的游標檢查（pttchrome.jsx 的 menu-card 分支）：游標列要是帶游標記號的項目列。
describe("essenceCursorRowOk", () => {
  test("新版 > 與舊版 ● 都算", () => {
    expect(essenceCursorRowOk(ESSENCE_ROWS[3])).toBe(true);
    expect(essenceCursorRowOk(ESSENCE_ROWS_OLD[2])).toBe(true);
  });
  test.each([
    ["沒有游標記號的項目列", ESSENCE_ROWS_OLD[3]],
    ["按鍵說明列", ESSENCE_ROWS[1]],
    ["欄位標題列", ESSENCE_ROWS[2]],
    ["空白列", " ".repeat(80)],
    ["底列", ESSENCE_ROWS[ESSENCE_ROWS.length - 1]],
    ["不是字串", undefined],
  ])("%s → 不送", (_n, row) => {
    expect(essenceCursorRowOk(row)).toBe(false);
  });
});

describe("畫面指紋", () => {
  test("新舊兩代都認得", () => {
    expect(essenceHeaderRow(ESSENCE_ROWS)).toBe(2);
    expect(essenceHeaderRow(ESSENCE_ROWS_OLD)).toBe(1);
    expect(isEssenceListFooter(" 精華管理  (n)新增文章")).toBe(true);
    expect(isEssenceListFooter(" 【板  主】  (n)新增文章 (g)新增目錄")).toBe(true);
  });

  test("複製佇列（標記項目）不接：c 標記要看得到", () => {
    expect(isEssenceListFooter(" 標記項目  (p)貼上")).toBe(false);
    expect(isEssenceListFooter(" 【已標記(複製) 3 項】  (c)標記/複製")).toBe(false);
  });

  test("所在位置：中間是這一層的名稱，跟板名一樣就不重複", () => {
    expect(essenceCrumb(ESSENCE_ROWS[0])).toEqual({ board: "Gossip", title: "" });
    expect(essenceCrumb("【精華文章】   [板規] 本板板規與公告   看板《Gossip》")).toEqual({
      board: "Gossip",
      title: "[板規] 本板板規與公告",
    });
  });
});

// 假 TermChar：一格一字（解析與畫卡片只看文字）。同 mail_card.test.js。
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
const render = (rows, menuCards) =>
  mountScreen({
    lines: rows.map(line),
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: { pageState: 1, menuCards },
  });

describe("手機卡片 DOM", () => {
  test("項目列 → 卡片（data-menu-row＝列號），目錄有 ›", () => {
    const card = buildEssenceCard({ chars: line(ESSENCE_ROWS_OLD[2]), row: 2 });
    expect(card).not.toBeNull();
    const n = card.node;
    expect(n.getAttribute("data-menu-row")).toBe("2");
    expect(menuCardTargetRow(n.querySelector(".essenceCardTitle"))).toBe(2);
    expect(n.classList.contains("essenceCardDir")).toBe(true);
    expect(n.querySelector(".essenceCardChevron")).not.toBeNull();
    expect(n.querySelector(".essenceCardMeta").textContent).toContain("sysop");
    expect(n.querySelector('[data-type="bbsline"]').getAttribute("data-row")).toBe("2");
  });

  test("不是項目列 → null（照舊格線）", () => {
    expect(buildEssenceCard({ chars: line(ESSENCE_ROWS[2]), row: 2 })).toBeNull();
  });

  test("CSS 卡片高度＝ESSENCE_CARD_PX", () => {
    const m = /span\.menuCard\.essenceCard\s*\{([^}]*)\}/.exec(mainCss);
    expect(m && m[1]).toContain(`height: ${ESSENCE_CARD_PX}px;`);
  });

  test("Screen：menuCards='essence' ⇒ 項目畫卡片、標題列畫所在位置、欄位標題列收起；true（主功能表）⇒ 不畫", () => {
    const s = render(ESSENCE_ROWS, "essence");
    const cards = s.container.querySelectorAll(".essenceCard");
    expect(Array.from(cards).map((c) => Number(c.getAttribute("data-menu-row")))).toEqual(ESSENCE_ITEM_ROWS);
    expect(s.container.querySelector(".essenceCrumb").textContent).toBe("Gossip 精華區");
    expect(s.container.querySelector('[srow="2"]').classList.contains("mobileCollapsedRow")).toBe(true);
    unmountAll();
    const menu = render(ESSENCE_ROWS, true);
    expect(menu.container.querySelectorAll(".essenceCard").length).toBe(0);
  });
});
