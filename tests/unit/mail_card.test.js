// @unit-env browser
// 手機信件列表卡片（P31，js/mail_list.js、render/mail_card.js、docs/mobile.md「信件列表卡片」）。
//
// 鎖的症狀：
//   1. 信件列（upstream mail.c#maildoent 的版型，新舊欄寬都吃）解成 編號／未讀／日期／寄件人／標題；
//      不是信件列 ⇒ null（該列照舊畫格線）。
//   2. 畫面指紋：底列「信件列表／鴻雁往返」＋欄位標題列，缺一 ⇒ 不是信件列表（照舊格線）。
//   3. 手機（enhance.menuCards === 'mail'）：信件列畫成卡片（帶 data-menu-row ⇒ 點卡片送
//      「移游標＋⏎」，同主功能表大按鈕）、欄位標題列收起；主功能表模式（true）不畫信件卡片。
// real-input: tests/e2e/offline/mobile_mail_cards.offline.spec.js
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { isMailListRows, mailHeaderRow, parseMailRow } from "../../src/js/mail_list";
import { MAIL_CARD_PX, buildMailCard } from "../../src/render/mail_card";
import { menuCardTargetRow } from "../../src/js/mobile_layout";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import mainCss from "../../src/css/main.css?raw";
import mailListFx from "./fixtures/ptt_src_screens/mail_list.json";
import { MAIL_LIST_ROWS, MAIL_HEADER_ROW, MAIL_ITEM_ROWS } from "./fixtures/mail_list_rows";
import { MAIN_MENU_ROWS } from "./fixtures/main_menu_rows";

beforeAll(() => loadBig5Tables());
afterEach(() => unmountAll());

function upstreamMailBuf() {
  const buf = new TermBuf(mailListFx.cols, mailListFx.rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    applyCursorHighlight() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (const f of mailListFx.frames) {
    parser.feed(f.bytes);
    buf.notify();
    clearTimeout(buf.timerUpdate);
  }
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return buf;
}

describe("parseMailRow／isMailListRows", () => {
  test("upstream 產的信件列表：指紋成立，三封信都解得出來", () => {
    const buf = upstreamMailBuf();
    const texts = Array.from({ length: buf.rows }, (_, y) => buf.getRowText(y, 0, buf.cols));
    expect(texts.map((t) => t.replace(/\s+$/, ""))).toEqual(MAIL_LIST_ROWS.map((t) => t.replace(/\s+$/, "")));
    expect(buf.isMailListScreen()).toBe(true);
    expect(buf.isMenuScreen()).toBe(false);
    expect(mailHeaderRow(texts)).toBe(MAIL_HEADER_ROW);
    expect(MAIL_ITEM_ROWS.map((y) => parseMailRow(texts[y]))).toEqual([
      { num: 1, mark: "+", unread: true, date: "10/01", author: "alice", kind: "normal", title: "第一封信", cursor: false },
      { num: 2, mark: "+", unread: true, date: "10/02", author: "bob", kind: "reply", title: "第一封信", cursor: false },
      { num: 3, mark: "+", unread: true, date: "10/03", author: "carol", kind: "normal", title: "站方通知", cursor: true },
    ]);
  });

  test("單獨畫出來（沒有經過主功能表那一幀）也認得出，setPageState 一樣定成 1", () => {
    const buf = new TermBuf(mailListFx.cols, mailListFx.rows);
    buf.setView({ update() {}, updateCursorPos() {}, refreshCursorVisibility() {}, applyCursorHighlight() {}, blinkOn: false });
    buf.useMouseBrowsing = false;
    const parser = new AnsiParser(buf);
    for (const f of mailListFx.frames) parser.feed(f.bytes);
    buf.notify(); // 只 notify 一次：沒有經過主功能表那一幀，pageState 不是沿用來的
    clearTimeout(buf.timerUpdate);
    if (buf._settleTimer) clearTimeout(buf._settleTimer);
    expect(buf.isMailListScreen()).toBe(true);
    expect(buf.pageState).toBe(1);
  });

  test("各種狀態與欄寬：已讀、標記、已回、轉寄、個位數月份、舊版欄寬、● 游標", () => {
    expect(parseMailRow("     7   9/27 dave           ◇ 已讀的信")).toMatchObject({ num: 7, unread: false, date: "9/27", title: "已讀的信" });
    expect(parseMailRow("    12 m 10/05 erin           ◇ 標記已讀")).toMatchObject({ mark: "m", unread: false });
    expect(parseMailRow("    13 M 10/05 erin           ◇ 標記未讀")).toMatchObject({ mark: "M", unread: true });
    expect(parseMailRow("    14 r 10/06 frank          R: 回過了")).toMatchObject({ kind: "reply", unread: false });
    expect(parseMailRow("    15 + 10/07 grace          轉 轉寄的信")).toMatchObject({ kind: "forward", title: "轉寄的信" });
    expect(parseMailRow("●  100 + 10/08 heidi  ◇ 舊版欄寬")).toMatchObject({ num: 100, cursor: true, author: "heidi" });
  });

  test("不是信件列 ⇒ null（該列照舊格線）", () => {
    expect(parseMailRow(MAIL_LIST_ROWS[0])).toBe(null);
    expect(parseMailRow(MAIL_LIST_ROWS[1])).toBe(null);
    expect(parseMailRow(MAIL_LIST_ROWS[MAIL_HEADER_ROW])).toBe(null);
    expect(parseMailRow(" ".repeat(80))).toBe(null);
    // 文章列表列（□ 不是信件的標題標記）
    expect(parseMailRow("  1234 +  3 10/01 alice        □ [問卦] 標題")).toBe(null);
    expect(parseMailRow(null)).toBe(null);
  });

  test("主功能表不是信件列表", () => {
    expect(isMailListRows(MAIN_MENU_ROWS)).toBe(false);
    expect(isMailListRows(MAIL_LIST_ROWS)).toBe(true);
  });
});

// 假 TermChar：一格一字（解析與畫卡片只看文字）。
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
const LINES = MAIL_LIST_ROWS.map(line);
const render = (menuCards) =>
  mountScreen({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: { pageState: 1, menuCards },
  });
const rowNode = (s, r) => s.container.querySelector(`[type="bbsrow"][srow="${r}"]`);

describe("render：menuCards === 'mail'", () => {
  test("信件列是卡片（data-menu-row＝buf 列號）；欄位標題列、標題列、狀態列收起；按鍵說明列照舊", () => {
    const s = render("mail");
    for (const r of MAIL_ITEM_ROWS) {
      const n = rowNode(s, r);
      expect(n.classList.contains("mailCard")).toBe(true);
      expect(n.getAttribute("data-menu-row")).toBe(String(r));
      expect(n.querySelector('[data-type="bbsline"]').getAttribute("data-row")).toBe(String(r));
    }
    expect(rowNode(s, 4).querySelector(".mailCardTag").textContent).toBe("R:");
    expect(rowNode(s, 5).querySelector(".mailCardSubject").textContent).toBe("站方通知");
    expect(rowNode(s, 5).querySelector(".mailCardMeta").textContent).toBe("carol · 10/03");
    expect(rowNode(s, 3).classList.contains("mailCardUnread")).toBe(true);
    for (const r of [0, MAIL_HEADER_ROW, MAIL_LIST_ROWS.length - 1])
      expect(rowNode(s, r).classList.contains("mobileCollapsedRow")).toBe(true);
    expect(rowNode(s, 1).classList.contains("mobileCollapsedRow")).toBe(false);
    expect(rowNode(s, 1).classList.contains("mailCard")).toBe(false);
    expect(rowNode(s, 10).classList.contains("menuBlankRow")).toBe(true);
  });

  test("點卡片內任何子元素都取得到列（App.mouse_click 送移游標＋⏎ 用）", () => {
    const card = buildMailCard({ chars: LINES[4], row: 4 }).node;
    document.body.appendChild(card);
    expect(menuCardTargetRow(card.querySelector(".mailCardSubject"))).toBe(4);
    card.remove();
  });

  test("主功能表模式（true）與桌機（undefined）不畫信件卡片", () => {
    expect(render(true).container.querySelector(".mailCard")).toBe(null);
    expect(render(undefined).container.querySelector(".mailCard")).toBe(null);
  });

  test("CSS 高度與常數一致", () => {
    const card = mainCss.match(/span\.menuCard\.mailCard \{([^}]*)\}/)[1];
    expect(card).toContain(`height: ${MAIL_CARD_PX}px;`);
  });
});
