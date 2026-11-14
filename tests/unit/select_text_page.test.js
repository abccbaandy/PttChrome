// 手機「選取文字」頁（P81，src/js/select_text_page.js）：畫面這一份 lines → 頁面文字列。
// 鎖的行為：
//   1. 全形字（Big5 雙位元組、UTF-8 線路的 WIDE_TRAIL）轉成文字不多不少，列尾補滿的空白去掉。
//   2. 畫面上被藏起來的列（黑名單、推文篩選收起）頁面也不放；篩選展開的列照放。
//   3. 長按的列號對到正確那一行（被藏的列退到前一行）。
//   4. 只在手機＋開關開著＋畫面是好讀累積頁／唯讀頁時出現；一個 byte 都不送。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import {
  SelectTextPage,
  pageTextLines,
  lineIndexForRow,
  annotationHidesRow,
  rowForLine,
} from "../../src/js/select_text_page";
import { setUnicodeCells } from "../../src/js/unicode_cells";
import { createUtf8Inbound } from "../../src/js/wire_charset";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => {
  loadBig5Tables();
});

afterEach(() => {
  setUnicodeCells(false);
  for (const k of Object.keys(prefOverride)) delete prefOverride[k];
});

function makeTerm({ utf8 } = {}) {
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
    charset: "big5",
  });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  const inbound = createUtf8Inbound();
  const feed = (text) => {
    if (utf8) parser.feed(inbound.decode(String.fromCharCode(...new TextEncoder().encode(text))));
    else parser.feed(text);
    buf.notify();
  };
  return { buf, feed };
}

describe("pageTextLines：畫面列 → 文字", () => {
  test("Big5 全形字一字不多不少、列尾空白去掉", () => {
    const { buf, feed } = makeTerm();
    // 「推文」的 Big5：B1C0 A4E5
    feed("\xb1\xc0\xa4\xe5 abc   \r\n\r\n  x");
    const lines = pageTextLines(3, (r) => buf.getRowText(r, 0, buf.cols));
    expect(lines).toEqual([
      { row: 0, text: "推文 abc" },
      { row: 1, text: "" },
      { row: 2, text: "  x" },
    ]);
  });

  test("UTF-8 線路 Big5 收不下的全形字（WIDE_TRAIL）只出現一次", () => {
    setUnicodeCells(true);
    const { buf, feed } = makeTerm({ utf8: true });
    feed("한국A 推");
    const [l] = pageTextLines(1, (r) => buf.getRowText(r, 0, buf.cols));
    expect(l.text).toBe("한국A 推");
  });

  test("被藏的列不放、列號保留畫面列號", () => {
    const text = ["a", "b", "c", "d"];
    const ann = [null, { hidden: true }, { hidden: true, filterShown: true }, null];
    const lines = pageTextLines(4, (r) => text[r], (r) => annotationHidesRow(ann[r]));
    expect(lines).toEqual([
      { row: 0, text: "a" },
      { row: 2, text: "c" },
      { row: 3, text: "d" },
    ]);
  });
});

describe("lineIndexForRow：長按的列 → 頁面那一行", () => {
  const lines = [{ row: 0 }, { row: 2 }, { row: 3 }, { row: 7 }];
  test("對到同一列", () => {
    expect(lineIndexForRow(lines, 3)).toBe(2);
    expect(lineIndexForRow(lines, 7)).toBe(3);
  });
  test("被藏的列退到前一行；超過最後一列給最後一行", () => {
    expect(lineIndexForRow(lines, 1)).toBe(0);
    expect(lineIndexForRow(lines, 5)).toBe(2);
    expect(lineIndexForRow(lines, 99)).toBe(3);
  });
  test("沒有列號＝從頭（-1 不捲）", () => {
    expect(lineIndexForRow(lines, null)).toBe(-1);
    expect(lineIndexForRow([], 3)).toBe(-1);
  });
});

describe("rowForLine：共用 data-row 的合併塊 → 真正那一列", () => {
  // 同作者推文合併塊：三則推文的內容行都標第一則的 data-row（10）。
  const rows = {
    10: "推 alice: 第一則內容                                     11/14 10:00",
    11: "推 alice: 第二則 講別的                                  11/14 10:01",
    12: "推 alice: 第三則　結尾                               11/14 10:02",
  };
  const rowText = (r) => rows[r] || "";
  test("按第三則 ⇒ 第 12 列（不是第一則）", () => {
    expect(rowForLine(10, 3, "第三則　結尾", rowText)).toBe(12);
    expect(rowForLine(10, 3, "第二則 講別的", rowText)).toBe(11);
  });
  test("只有一行、空白行、找不到 ⇒ 原列", () => {
    expect(rowForLine(10, 1, "第三則", rowText)).toBe(10);
    expect(rowForLine(10, 3, "  ", rowText)).toBe(10);
    expect(rowForLine(10, 3, "不存在的字", rowText)).toBe(10);
  });
});

function fakeCore({ mobile = true, rendered = "page" } = {}) {
  const pageLines = [["推文"], ["內容"], ["藏起來"], ["結尾"]];
  const sent = [];
  const buf = {
    cols: 80,
    pageLines,
    lines: [["24 列鏡像"]],
    getRowText(r, c0, c1, lines) {
      return (lines || this.lines)[r][0] + "   ";
    },
  };
  const view = {
    buf,
    _staticRows: null,
    componentScreen: { _annotations: [null, null, { hidden: true }, null] },
    _send: (b) => sent.push(b),
    _convSend: (t) => sent.push(t),
  };
  if (rendered === "page") view._renderedLines = pageLines;
  else if (rendered === "native") view._renderedLines = buf.lines;
  else if (rendered === "saved") view._renderedLines = view._staticRows = [["存檔"]];
  return { mobile, view, buf, sent };
}

describe("SelectTextPage 控制器", () => {
  test("好讀累積頁：開到長按的列、藏起來的列不放、一個 byte 都不送", () => {
    const core = fakeCore();
    const page = new SelectTextPage(core);
    const seen = [];
    page.onChange((s) => seen.push(s));
    expect(page.available()).toBe(true);
    expect(page.open(3)).toBe(true);
    expect(page.state.open).toBe(true);
    expect(page.state.lines.map((l) => l.text)).toEqual(["推文", "內容", "結尾"]);
    expect(page.state.focusIndex).toBe(2);
    page.close();
    expect(page.state.open).toBe(false);
    expect(seen.map((s) => s.open)).toEqual([false, true, false]);
    expect(core.sent).toEqual([]);
  });

  test("存到本機的唯讀頁也能開", () => {
    const page = new SelectTextPage(fakeCore({ rendered: "saved" }));
    expect(page.open(null)).toBe(true);
    expect(page.state.lines).toEqual([{ row: 0, text: "存檔" }]);
  });

  test("認不出就不出現：原生 24 列鏡像、桌機、開關關著", () => {
    expect(new SelectTextPage(fakeCore({ rendered: "native" })).available()).toBe(false);
    expect(new SelectTextPage(fakeCore({ mobile: false })).available()).toBe(false);
    prefOverride.mobileSelectTextPage = false;
    const page = new SelectTextPage(fakeCore());
    expect(page.available()).toBe(false);
    expect(page.open(0)).toBe(false);
    expect(page.state.open).toBe(false);
  });

  test("開關預設開、不送鍵所以不在安全模式清單", () => {
    expect(DEFAULT_PREFS.mobileSelectTextPage).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("mobileSelectTextPage");
  });
});
