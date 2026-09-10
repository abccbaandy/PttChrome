// 回歸守護：URL 結尾的句子標點／不成對括號不得被當成連結的一部分
// （2026-09-10 回報，現場兩行見 src/js/url_trim.js 檔頭）。
//
// 反向鎖同樣重要：`(` `)` 在 path 裡合法（維基百科 `戈黛娃夫人_(歌手)`，另有
// tests/unit/url_cjk.test.js 從 TermBuf 那一端鎖住），所以「成對就保留」這條
// 不能退化成「一律砍掉結尾括號」。
import { trimUrlTail, trimUrlTailLength } from "../../src/js/url_trim";

describe("trimUrlTail — 不成對括號", () => {
  test("回報現場：整條網址被半形括號包起來", () => {
    expect(trimUrlTail("https://vt100.net/emu/ctrlseq_dec.html)")).toBe(
      "https://vt100.net/emu/ctrlseq_dec.html"
    );
    expect(
      trimUrlTail("https://docs.frankentui.com/render/synchronized-output)")
    ).toBe("https://docs.frankentui.com/render/synchronized-output");
  });

  test("成對括號是 path 的一部分 ⇒ 原樣保留", () => {
    const u = "https://zh.wikipedia.org/wiki/%E6%AD%8C_(%E6%89%8B)";
    expect(trimUrlTail(u)).toBe(u);
    expect(trimUrlTailLength(u)).toBe(0);
  });

  test("巢狀成對保留，多出來的那一層才砍", () => {
    expect(trimUrlTail("https://a.com/x((y))")).toBe("https://a.com/x((y))");
    expect(trimUrlTail("https://a.com/x((y)))")).toBe("https://a.com/x((y))");
  });

  test("方括號與大括號同規則", () => {
    expect(trimUrlTail("https://a.com/x]")).toBe("https://a.com/x");
    expect(trimUrlTail("https://a.com/x[1]")).toBe("https://a.com/x[1]");
    expect(trimUrlTail("https://a.com/x}")).toBe("https://a.com/x");
  });
});

describe("trimUrlTail — 句尾標點", () => {
  test("句號／逗號／分號／冒號／驚嘆號／問號", () => {
    expect(trimUrlTail("https://a.com/b.")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b,")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b;")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b:")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b!")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b?")).toBe("https://a.com/b");
  });

  test("只砍結尾，中段的標點一律保留", () => {
    expect(trimUrlTail("https://a.com/a,b")).toBe("https://a.com/a,b");
    expect(trimUrlTail("https://a.com/a.b.c")).toBe("https://a.com/a.b.c");
    expect(trimUrlTail("https://a.com/?q=1&r=2")).toBe("https://a.com/?q=1&r=2");
  });

  test("標點與括號混在一起時反覆套用到收斂", () => {
    expect(trimUrlTail("https://a.com/b).")).toBe("https://a.com/b");
    expect(trimUrlTail("https://a.com/b.)")).toBe("https://a.com/b");
  });

  test("引號刻意不砍（path 裡比句尾常見）", () => {
    expect(trimUrlTail("https://a.com/b'")).toBe("https://a.com/b'");
  });
});

describe("trimUrlTail — 下界與退化輸入", () => {
  test("絕不砍進 scheme", () => {
    expect(trimUrlTail("https://)")).toBe("https://)");
    expect(trimUrlTail("https://.")).toBe("https://.");
    expect(trimUrlTail("https://a)")).toBe("https://a");
  });

  test("無 scheme 的候選至少保留一個字元", () => {
    expect(trimUrlTail("example.com/b)")).toBe("example.com/b");
    expect(trimUrlTail(")")).toBe(")");
    expect(trimUrlTail(".")).toBe(".");
  });

  test("pid:// 與一般結尾是 no-op", () => {
    expect(trimUrlTailLength("pid://12345678")).toBe(0);
    expect(trimUrlTailLength("https://a.com/b")).toBe(0);
    expect(trimUrlTailLength("")).toBe(0);
    expect(trimUrlTailLength(null)).toBe(0);
  });
});
