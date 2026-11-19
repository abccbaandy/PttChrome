// `/og` 路由（P110 網頁連結預覽卡）：第一條收「任意網址」的回源路由。
//   parseOgTarget —— 安全邊界：什麼網址可以回源（每一跳轉址也過它）。
//   parseOgMeta   —— 從外部 HTML 取標題／網站名／縮圖，只回這幾個欄位、長度有上限。
//   handleOg      —— 轉址、內容型別、讀取上限、限流、快取標頭。
import { describe, test, expect, vi } from "vitest";
import {
  parseOgTarget,
  parseOgMeta,
  decodeEntities,
  pickCharset,
  handleOg,
  MAX_TITLE,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
} from "../src/og.js";
import worker from "../src/index.js";

describe("parseOgTarget 安全邊界", () => {
  test.each([
    ["https://www.ettoday.net/news/20261119/1234.htm", "https://www.ettoday.net/news/20261119/1234.htm"],
    ["http://example.com/a?id=3#frag", "http://example.com/a?id=3"],
    ["https://drive.google.com/file/d/abc/view?usp=sharing", "https://drive.google.com/file/d/abc/view?usp=sharing"],
  ])("放行 %s", (raw, want) => {
    expect(parseOgTarget(raw)).toBe(want);
  });

  test.each([
    ["ftp://example.com/x", "非 http(s)"],
    ["javascript:alert(1)", "javascript:"],
    ["https://user:pw@example.com/", "帶帳密"],
    ["https://example.com:8443/", "非預設埠"],
    ["https://127.0.0.1/", "IPv4"],
    ["https://127.1/", "IPv4 縮寫（URL 會正規化成 127.0.0.1）"],
    ["https://0x7f000001/", "十六進位 IP"],
    ["https://[::1]/", "IPv6"],
    ["https://localhost/", "localhost"],
    ["https://intranet/", "單一標籤"],
    ["https://printer.local/", ".local"],
    ["https://db.internal/", ".internal"],
    ["https://a.localhost/", ".localhost"],
    ["https://router.home.arpa/", ".home.arpa"],
    ["not a url", "解析不了"],
    ["", "空字串"],
    ["https://example.com/" + "a".repeat(3000), "太長"],
  ])("擋下 %s（%s）", (raw) => {
    expect(parseOgTarget(raw)).toBeNull();
  });

  test("非字串擋下", () => {
    expect(parseOgTarget(null)).toBeNull();
    expect(parseOgTarget(undefined)).toBeNull();
  });
});

describe("parseOgMeta", () => {
  const base = "https://www.example.com/news/1";

  test("og 標題、網站名、縮圖", () => {
    const html = `<html><head>
      <meta property="og:title" content="颱風假 &amp; 停班停課">
      <meta property="og:site_name" content='範例新聞'>
      <meta property="og:image" content="https://img.example.com/a.jpg">
      <title>別用這個</title></head><body></body></html>`;
    expect(parseOgMeta(html, base)).toEqual({
      title: "颱風假 & 停班停課",
      site: "範例新聞",
      image: "https://img.example.com/a.jpg",
      url: base,
    });
  });

  test("沒有 og 就用 twitter:，標題最後退回 <title>，網站名退回網域（去 www.）", () => {
    const html = `<head><meta name="twitter:image" content="/thumb.png"><title> 教學 &#x6587;  章 </title></head>`;
    expect(parseOgMeta(html, base)).toEqual({
      title: "教學 文 章",
      site: "example.com",
      image: "https://www.example.com/thumb.png",
      url: base,
    });
  });

  test("屬性順序顛倒、沒引號也認得", () => {
    const html = `<meta content="標題" property=og:title>`;
    expect(parseOgMeta(html, base).title).toBe("標題");
  });

  test("同一個 key 出現兩次取第一個", () => {
    const html = `<meta property="og:title" content="第一"><meta property="og:title" content="第二">`;
    expect(parseOgMeta(html, base).title).toBe("第一");
  });

  test("縮圖只收 https（http 圖在 https 頁面是 mixed content）、不收帶帳密、不收 javascript:", () => {
    for (const img of ["http://img.example.com/a.jpg", "https://u:p@img.example.com/a.jpg", "javascript:alert(1)"]) {
      const html = `<meta property="og:title" content="t"><meta property="og:image" content="${img}">`;
      expect(parseOgMeta(html, base).image).toBe("");
    }
  });

  test("沒有標題 ⇒ null（不放卡）", () => {
    expect(parseOgMeta(`<meta property="og:image" content="https://a.example/x.jpg">`, base)).toBeNull();
    expect(parseOgMeta("", base)).toBeNull();
  });

  test("標題截到上限、控制字元與連續空白收掉", () => {
    const long = "字".repeat(MAX_TITLE + 50);
    const r = parseOgMeta(`<meta property="og:title" content="${long}">`, base);
    expect(Array.from(r.title).length).toBe(MAX_TITLE);
    expect(r.title.endsWith("…")).toBe(true);
    const r2 = parseOgMeta(`<meta property="og:title" content="a\u0001\u0007  \n b">`, base);
    expect(r2.title).toBe("a b");
  });

  test("超過讀取上限之後的 meta 不看", () => {
    const html = " ".repeat(MAX_HTML_BYTES) + `<meta property="og:title" content="太後面">`;
    expect(parseOgMeta(html, base)).toBeNull();
  });
});

describe("decodeEntities／pickCharset", () => {
  test("數字實體超出範圍或代理區原樣保留", () => {
    expect(decodeEntities("&#0;&#xD800;&#x110000;&bogus;")).toBe("&#0;&#xD800;&#x110000;&bogus;");
    expect(decodeEntities("&lt;b&gt;&#39;&quot;")).toBe(`<b>'"`);
  });
  test("編碼：header 優先，其次 meta charset，預設 utf-8", () => {
    expect(pickCharset("text/html; charset=Big5", '<meta charset="utf-8">')).toBe("big5");
    expect(pickCharset("text/html", '<meta charset="big5">')).toBe("big5");
    expect(pickCharset("text/html", "<html>")).toBe("utf-8");
  });
});

const htmlResponse = (html, { status = 200, type = "text/html; charset=utf-8", headers = {} } = {}) =>
  new Response(html, { status, headers: { "content-type": type, ...headers } });
const req = (target, headers = {}) =>
  new Request(`https://w.example/og?url=${encodeURIComponent(target)}`, { headers });
const call = (target, fetchImpl, env) => handleOg(req(target), new URL(req(target).url), env, fetchImpl);

describe("handleOg", () => {
  test("成功：回四個欄位，快取一天、CORS 放行，回源不跟轉址（manual）且帶誠實 UA", async () => {
    const f = vi.fn(async () => htmlResponse(`<meta property="og:title" content="T">`));
    const res = await call("https://example.com/a", f);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "T", site: "example.com", image: "", url: "https://example.com/a" });
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const [, init] = f.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(init.headers["user-agent"]).toMatch(/ptt-link-preview/);
  });

  test("壞網址 400 不回源", async () => {
    const f = vi.fn();
    const res = await call("https://127.0.0.1/", f);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(f).not.toHaveBeenCalled();
  });

  test("轉址每一跳重新檢查：轉到內網就停", async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://localhost/admin" } }));
    const res = await call("https://example.com/r", f);
    expect(res.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("相對轉址照頁面網址解析，最後的網址回在 url", async () => {
    const f = vi.fn(async (u) =>
      u === "https://example.com/r"
        ? new Response(null, { status: 301, headers: { location: "/final" } })
        : htmlResponse(`<title>終點</title>`),
    );
    const res = await call("https://example.com/r", f);
    expect((await res.json()).url).toBe("https://example.com/final");
  });

  test(`轉址超過 ${MAX_REDIRECTS} 次就停`, async () => {
    let n = 0;
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: `/r${++n}` } }));
    const res = await call("https://example.com/r0", f);
    expect(res.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  test("不是 HTML ⇒ none（快取 6 小時），沒有標題也是 none", async () => {
    let res = await call("https://example.com/a.pdf", async () => htmlResponse("%PDF", { type: "application/pdf" }));
    expect(await res.json()).toEqual({ none: true });
    expect(res.headers.get("cache-control")).toBe("public, max-age=21600");
    res = await call("https://example.com/b", async () => htmlResponse("<html></html>"));
    expect(await res.json()).toEqual({ none: true });
  });

  test("上游錯誤或連線失敗不快取", async () => {
    let res = await call("https://example.com/a", async () => htmlResponse("x", { status: 500 }));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    res = await call("https://example.com/a", async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("只讀前 MAX_HTML_BYTES：很大的頁面不整份讀完", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`<meta property="og:title" content="T">` + " ".repeat(64 * 1024));
    const body = new ReadableStream({
      pull(c) {
        pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
    const res = await call("https://example.com/big", async () => new Response(body, { headers: { "content-type": "text/html" } }));
    expect((await res.json()).title).toBe("T");
    expect(pulled).toBeLessThan(MAX_HTML_BYTES + 2 * chunk.byteLength);
  });

  test("Big5 頁面照 charset 解碼", async () => {
    const big5 = new Uint8Array([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]);
    const res = await call("https://example.com/big5", async () => new Response(big5, { headers: { "content-type": "text/html; charset=big5" } }));
    expect((await res.json()).title).toBe("中文");
  });

  test("限流：超過就 429 不回源；限流服務出錯照放行", async () => {
    const f = vi.fn(async () => htmlResponse(`<title>T</title>`));
    const deny = { OG_LIMITER: { limit: vi.fn(async () => ({ success: false })) } };
    const res = await handleOg(req("https://example.com/a", { "cf-connecting-ip": "1.2.3.4" }), new URL(req("https://example.com/a").url), deny, f);
    expect(res.status).toBe(429);
    expect(deny.OG_LIMITER.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
    expect(f).not.toHaveBeenCalled();
    const broken = { OG_LIMITER: { limit: async () => { throw new Error("x"); } } };
    expect((await call("https://example.com/a", f, broken)).status).toBe(200);
  });
});

describe("Worker 路由", () => {
  test("/og 只收 GET", async () => {
    const res = await worker.fetch(new Request("https://w.example/og?url=https%3A%2F%2Fexample.com%2F", { method: "HEAD" }), {});
    expect(res.status).toBe(405);
  });
  test("/og 壞網址走到 handleOg（400）", async () => {
    const res = await worker.fetch(new Request("https://w.example/og?url=http%3A%2F%2Flocalhost%2F"), {});
    expect(res.status).toBe(400);
  });
});
