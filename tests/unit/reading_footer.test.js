// @unit-env browser
// P65 好讀底列顯示「你讀到哪」：狀態列左半換成讀者位置、右半功能鍵照舊；認不出 ⇒ 原樣鏡像。
// 狀態列取自 upstream pttbbs 原始碼產的真畫面（ptt-src-screens），經真 TermBuf／AnsiParser。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { parseFunctionKeys } from "../../src/js/footer_keys";
import { textCellWidth } from "../../src/js/string_util";
import {
  footerLeftSpan,
  footerProgressCells,
  footerProgressTexts,
  scrollPercent,
} from "../../src/js/reading_footer";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import articleFx from "./fixtures/ptt_src_screens/article_help.json";

loadBig5Tables();

function bufAt(fx, name) {
  const idx = fx.frames.findIndex((f) => f.name === name);
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({ update() {}, updateCursorPos() {}, refreshCursorVisibility() {}, blinkOn: false });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (let i = 0; i <= idx; ++i) parser.feed(fx.frames[i].bytes);
  buf.notify();
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return buf;
}

// 格子 → 畫面文字（Big5 兩位元組併回一個字；同 getRowText 的讀法）。
function cellsText(buf, chars) {
  const saved = buf.lines[buf.rows - 1];
  buf.lines[buf.rows - 1] = chars;
  try {
    return buf.getRowText(buf.rows - 1, 0, chars.length);
  } finally {
    buf.lines[buf.rows - 1] = saved;
  }
}

const buf = bufAt(articleFx, "back");
const statusText = buf.getRowText(buf.rows - 1, 0, buf.cols);
const statusChars = buf.lines[buf.rows - 1];

describe("狀態列左半", () => {
  test("真 pmore 狀態列：認得左半，範圍到「行」為止、不含功能鍵", () => {
    expect(statusText).toMatch(/瀏覽 第 1\/1 頁 \(100%\)/);
    const span = footerLeftSpan(statusText, textCellWidth);
    expect(span).not.toBeNull();
    const keysStart = Math.min(...parseFunctionKeys(statusChars).map((k) => k.startCol));
    expect(span.end).toBeLessThanOrEqual(keysStart);
    expect(span.secondStart).toBeGreaterThan(0);
  });

  test.each([
    ["實況狀態列", "  實況中 01:23 [+2]  (X)留言(B)鈴聲 (q)離開"],
    ["沒有行號（此頁內容會依閱讀者不同）", "  瀏覽 第 1/2 頁 ( 50%)  ▲此頁內容會依閱讀者不同"],
    ["水平捲動的顯示範圍", "  瀏覽 第 1/2 頁 ( 50%)  顯示範圍: 2~81 欄位, 01~22 行"],
    ["列表 footer", " 文章列表  (^P)發表 (y)回應 (X)推文"],
    ["空白", ""],
  ])("%s ⇒ 不換（原樣鏡像）", (_, text) => {
    expect(footerLeftSpan(text, textCellWidth)).toBeNull();
  });
});

describe("讀者位置的字", () => {
  test("整篇接起來了：百分比＋共 N 列", () => {
    expect(footerProgressTexts({ first: 1, last: 10, total: 28, complete: true, percent: 36 })).toEqual({
      head: "  讀到 36% ",
      tail: " 第 1~10 列／共 28 列",
    });
  });
  test("還在接：不給百分比與總數，寫已載入", () => {
    expect(footerProgressTexts({ first: 5, last: 5, total: 40, complete: false, percent: null })).toEqual({
      head: "  讀到 ",
      tail: " 第 5 列／已載入 40 列",
    });
  });
  test("量不到 ⇒ null", () => {
    expect(footerProgressTexts(null)).toBeNull();
    expect(footerProgressTexts({ first: 0, last: 3, total: 3 })).toBeNull();
  });
  test("百分比＝視窗下緣讀到全文的幾成，扣掉文末標題卡", () => {
    expect(scrollPercent({ scrollTop: 0, clientHeight: 500, scrollHeight: 1000, trailing: 0 })).toBe(50);
    expect(scrollPercent({ scrollTop: 0, clientHeight: 500, scrollHeight: 400, trailing: 0 })).toBe(100);
    expect(scrollPercent({ scrollTop: 300, clientHeight: 500, scrollHeight: 900, trailing: 100 })).toBe(100);
    expect(scrollPercent({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 })).toBeNull();
  });
});

describe("換上去的格子", () => {
  const span = footerLeftSpan(statusText, textCellWidth);

  test("左半換成讀者位置、寬度不變；右半功能鍵一字不差、欄位不動", () => {
    const texts = footerProgressTexts({ first: 1, last: 10, total: 28, complete: true, percent: 36 });
    const out = footerProgressCells(statusChars, span, texts);
    expect(out).not.toBeNull();
    expect(out.length).toBe(statusChars.length);
    const text = cellsText(buf, out);
    expect(text.startsWith("  讀到 36%  第 1~10 列／共 28 列")).toBe(true);
    expect(text).not.toMatch(/瀏覽|目前顯示/);
    expect(textCellWidth(text)).toBe(textCellWidth(statusText));
    const before = parseFunctionKeys(statusChars).map((k) => [k.startCol, k.endCol, k.label]);
    const after = parseFunctionKeys(out).map((k) => [k.startCol, k.endCol, k.label]);
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });

  test("原本的格子不被改到（buf 是真畫面）", () => {
    const snapshot = buf.getRowText(buf.rows - 1, 0, buf.cols);
    footerProgressCells(statusChars, span, footerProgressTexts({ first: 1, last: 2, total: 3, complete: true, percent: 1 }));
    expect(buf.getRowText(buf.rows - 1, 0, buf.cols)).toBe(snapshot);
  });

  test("顏色沿用 PTT 的兩段（「瀏覽」段、「目前顯示」段）", () => {
    const texts = footerProgressTexts({ first: 1, last: 10, total: 28, complete: true, percent: 36 });
    const out = footerProgressCells(statusChars, span, texts);
    expect(out[2].getBg()).toBe(statusChars[2].getBg());
    expect(out[span.end - 1].getBg()).toBe(statusChars[span.secondStart + 1].getBg());
  });

  test("放不進原本左半的寬度 ⇒ null（原樣鏡像）", () => {
    const texts = { head: "  讀到 100% ", tail: " " + "長".repeat(40) };
    expect(footerProgressCells(statusChars, span, texts)).toBeNull();
  });
});
