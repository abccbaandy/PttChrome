// Regression guard: auto-link must extend into CJK path segments
// (https://zh.wikipedia.org/wiki/戈黛娃夫人) without absorbing Chinese prose
// that merely follows a URL. Two layers:
//   1) pure cjkUrlExtension decision table;
//   2) real TermBuf + AnsiParser fed Big5 bytes → fullurl / partOfURL flags
//      (the bug lived in term_buf.js's placeholder substitution + uriRegEx).
import { cjkUrlExtension } from "../../src/js/url_cjk";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { u2b } from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

describe("cjkUrlExtension (pure)", () => {
  test("wiki path: CJK right after '/' is accepted", () => {
    expect(cjkUrlExtension("/", "戈黛娃夫人")).toBe("戈黛娃夫人");
  });

  test("full-width punctuation terminates the extension", () => {
    expect(cjkUrlExtension("/", "戈黛娃夫人。超好看")).toBe("戈黛娃夫人");
    expect(cjkUrlExtension("/", "戈黛娃夫人，讚")).toBe("戈黛娃夫人");
    expect(cjkUrlExtension("/", "戈黛娃夫人」後略")).toBe("戈黛娃夫人");
  });

  test("prose after a letter/digit boundary is NOT absorbed", () => {
    // ...watch?v=xxx真的好看 → prev char is 'x', not '/' or '='
    expect(cjkUrlExtension("x", "真的好看")).toBe("");
    expect(cjkUrlExtension("9", "這篇讚")).toBe("");
  });

  test("query value: CJK right after '=' is accepted", () => {
    expect(cjkUrlExtension("=", "中文關鍵字")).toBe("中文關鍵字");
  });

  test("mixed CJK+ASCII title continues, ASCII space terminates", () => {
    expect(cjkUrlExtension("/", "戈黛娃夫人_(歌手) 推")).toBe(
      "戈黛娃夫人_(歌手)"
    );
  });

  test("no leading CJK → no extension (pure-ASCII tail untouched)", () => {
    expect(cjkUrlExtension("/", "abc")).toBe("");
    expect(cjkUrlExtension("/", " 戈黛娃")).toBe("");
  });

  test("trailing ASCII sentence punctuation is trimmed", () => {
    expect(cjkUrlExtension("/", "戈黛娃夫人.")).toBe("戈黛娃夫人");
  });
});

describe("TermBuf URI detection with CJK path (Big5)", () => {
  beforeAll(() => loadBig5Tables());
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function paintRow(text) {
    const buf = new TermBuf(80, 24);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      blinkOn: false,
    });
    buf.useMouseBrowsing = false;
    const parser = new AnsiParser(buf);
    parser.feed(u2b(text)); // Big5 bytes, one char per byte
    vi.advanceTimersByTime(300); // flush queueUpdate/notify
    return buf.lines[0];
  }

  test("wiki URL with Chinese title links to the full URL", () => {
    const line = paintRow("https://zh.wikipedia.org/wiki/戈黛娃夫人");
    expect(line[0].startOfURL).toBe(true);
    expect(line[0].fullurl).toBe(
      "https://zh.wikipedia.org/wiki/" + encodeURI("戈黛娃夫人")
    );
    // 5 CJK chars ×2 cols after the 30-char ASCII part → cols 30..39 in URL.
    expect(line[30].partOfURL).toBe(true);
    expect(line[39].partOfURL).toBe(true);
    expect(line[39].endOfURL).toBe(true);
    expect(line[40].partOfURL).toBeFalsy();
  });

  test("Chinese prose after the URL is cut at full-width punctuation", () => {
    const line = paintRow("https://zh.wikipedia.org/wiki/戈黛娃夫人，很讚");
    expect(line[0].fullurl).toBe(
      "https://zh.wikipedia.org/wiki/" + encodeURI("戈黛娃夫人")
    );
    expect(line[40].partOfURL).toBeFalsy();
  });

  test("prose butted against a non-slash boundary is not absorbed", () => {
    const line = paintRow("https://youtu.be/abc123真的好看");
    expect(line[0].fullurl).toBe("https://youtu.be/abc123");
    expect(line[23].partOfURL).toBeFalsy();
  });

  test("plain ASCII URL behaves exactly as before", () => {
    const line = paintRow("https://example.com/foo bar");
    expect(line[0].fullurl).toBe("https://example.com/foo");
    expect(line[23].partOfURL).toBeFalsy();
  });

  // 2026-09-10 回報：整條網址被半形括號包起來時，結尾的 `)` 被吃進連結
  //（下游的行內預覽／hover 預覽／右鍵複製文章連結全部跟著失配）。
  test("半形括號包起來的網址：結尾的 ) 不得進連結", () => {
    const url = "https://vt100.net/emu/ctrlseq_dec.html";
    const line = paintRow("(" + url + ")");
    expect(line[1].startOfURL).toBe(true);
    expect(line[1].fullurl).toBe(url);
    // URL 佔 col 1..url.length；結尾的 `)` 落在 col 1+url.length。
    expect(line[url.length].endOfURL).toBe(true);
    expect(line[url.length].ch).toBe("l");
    expect(line[1 + url.length].partOfURL).toBeFalsy();
    expect(line[1 + url.length].ch).toBe(")");
  });

  test("全形括號（Big5 placeholder）包起來也不影響邊界", () => {
    const url = "https://docs.frankentui.com/render/synchronized-output";
    const line = paintRow("（" + url + "）");
    // 全形括號佔兩格。
    expect(line[2].startOfURL).toBe(true);
    expect(line[2].fullurl).toBe(url);
    expect(line[1 + url.length].endOfURL).toBe(true);
  });

  test("path 裡成對的括號必須保留（反向鎖）", () => {
    const url = "https://en.wikipedia.org/wiki/Godiva_(singer)";
    const line = paintRow(url + " ok");
    expect(line[0].fullurl).toBe(url);
    expect(line[url.length - 1].endOfURL).toBe(true);
    expect(line[url.length - 1].ch).toBe(")");
  });

  test("句尾句號不得被吃進連結", () => {
    const line = paintRow("see https://example.com/a/b. next");
    expect(line[4].fullurl).toBe("https://example.com/a/b");
  });
});
