// OSC 8 payload 解析與 href 白名單（src/js/osc_hyperlink.js）。
// server 端送法見該檔檔頭；整條接線（parser → term_buf → URL 旗標）在
// ansi_parser_osc8.test.js。
import { parseOsc8, oscHyperlinkHref } from "../../src/js/osc_hyperlink";

describe("parseOsc8", () => {
  test("pfterm 的開啟形狀 `8;;<url>`", () => {
    expect(parseOsc8("8;;https://term.ptt.cc")).toEqual({
      uri: "https://term.ptt.cc",
    });
  });

  test("pfterm 的關閉形狀 `8;;`", () => {
    expect(parseOsc8("8;;")).toEqual({ uri: "" });
  });

  test("params 非空（`id=xx`）時 URI 仍取第二個分號之後", () => {
    expect(parseOsc8("8;id=1;https://a.b/c")).toEqual({ uri: "https://a.b/c" });
  });

  test("URI 自己含分號不可被切斷", () => {
    expect(parseOsc8("8;;https://a.b/?x=1;y=2")).toEqual({
      uri: "https://a.b/?x=1;y=2",
    });
  });

  test("不是 OSC 8 的 OSC（視窗標題等）回 null", () => {
    expect(parseOsc8("0;PTT")).toBeNull();
    expect(parseOsc8("80;;x")).toBeNull();
    expect(parseOsc8("")).toBeNull();
  });

  test("缺第二個分號＝格式錯，當作關閉", () => {
    expect(parseOsc8("8;https://a.b")).toEqual({ uri: "" });
  });
});

describe("oscHyperlinkHref", () => {
  test("http / https 放行（大小寫不拘）", () => {
    expect(oscHyperlinkHref("https://www.ptt.cc/bbs/")).toBe(
      "https://www.ptt.cc/bbs/",
    );
    expect(oscHyperlinkHref("HTTP://example.com")).toBe("HTTP://example.com");
  });

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "vbscript:x",
    "//example.com",
    "https://",
    "telnet://ptt.cc",
  ])("非 http/https 一律不給連結：%s", (raw) => {
    expect(oscHyperlinkHref(raw)).toBe("");
  });

  test("含控制字元的 URI 不收", () => {
    expect(oscHyperlinkHref("https://a.b/\x07x")).toBe("");
    expect(oscHyperlinkHref("https://a.b/\x7fx")).toBe("");
  });

  test("已經百分比編碼的部分不可再編一次", () => {
    expect(oscHyperlinkHref("https://a.b/%E4%B8%AD?q=%20")).toBe(
      "https://a.b/%E4%B8%AD?q=%20",
    );
  });

  test("非 ASCII 位元組經 Big5 解碼後只編碼中文段", () => {
    const decode = (s) => (s === "https://a.b/\xa4\xa4" ? "https://a.b/中" : s);
    expect(oscHyperlinkHref("https://a.b/\xa4\xa4", decode)).toBe(
      "https://a.b/%E4%B8%AD",
    );
  });

  test("有非 ASCII 位元組但沒給解碼器 ⇒ 不給連結（不猜編碼）", () => {
    expect(oscHyperlinkHref("https://a.b/\xa4\xa4")).toBe("");
  });

  test("空值", () => {
    expect(oscHyperlinkHref("")).toBe("");
    expect(oscHyperlinkHref(undefined)).toBe("");
  });
});
