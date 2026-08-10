// `/tenor` 解析路由的兩個純邏輯，也是它的安全邊界：
//   parseTenorTarget —— 決定「什麼 URL 可以被回源抓取」。破了就是開放 proxy
//     （任何人都能拿這個 Worker 當跳板打任意站，還掛在專案方的 Cloudflare 額度上）。
//   parseTenorMedia  —— 從 tenor 頁面的 og tag 取出真正的媒體位址。
//
// 為什麼 tenor 需要伺服端代解（不是偷懶）：tenor.com 的 HTML 頁**沒有 CORS header**，
// `/view/` 頁又是 x-frame-options: DENY，短連結 tenor.com/<code>.gif 在瀏覽器端
// 完全無法解析。詳見 docs/media-preview-addons.md 的 tenor 實測段。
import { describe, test, expect } from "vitest";
import { parseTenorTarget, parseTenorMedia } from "../src/index.js";

describe("parseTenorTarget 白名單", () => {
  test.each([
    ["https://tenor.com/bgOd4.gif", "短連結"],
    ["https://www.tenor.com/bgOd4.gif", "www 子網域"],
    ["https://tenor.com/view/faker-hug-smile-happy-shy-gif-16360306", "view 完整連結"],
  ])("放行 %s（%s）", (raw) => {
    expect(parseTenorTarget(raw)).toBeTruthy();
  });

  // 短碼**大小寫敏感**：tenor.com/bgOd4.gif 與 tenor.com/bgod4.gif 是兩張不同的圖
  // （16360306 / 16260362）。任何正規化都不可以動到 pathname 的大小寫。
  test("短碼大小寫原樣保留", () => {
    expect(parseTenorTarget("https://tenor.com/bgOd4.gif")).toBe(
      "https://tenor.com/bgOd4.gif",
    );
  });

  test("query / hash 一律丟棄（避免快取碎片與參數注入）", () => {
    expect(parseTenorTarget("https://tenor.com/bgOd4.gif?utm_source=x#frag")).toBe(
      "https://tenor.com/bgOd4.gif",
    );
  });

  test.each([
    ["https://media.tenor.com/TjWRuqajuC0AAAAd/faker-hug.gif", "直連媒體（app 端不會送來，且不該經由這裡）"],
    ["https://tenor.com.evil.com/x.gif", "後綴偽裝網域"],
    ["https://eviltenor.com/x.gif", "前綴偽裝網域"],
    ["https://evil.com/tenor.com/x.gif", "路徑偽裝"],
    ["http://tenor.com/bgOd4.gif", "非 https"],
    ["https://tenor.com/search?q=cat", "非 view/短連結路徑"],
    ["https://tenor.com/", "根路徑"],
    ["https://tenor.com/view/../../etc/passwd", "路徑穿越"],
    ["https://tenor.com/bgOd4.png", "非 .gif 短連結"],
    ["https://tenor.com/view/no-trailing-id", "view 但無數字 id"],
    ["not a url", "非 URL"],
    ["", "空字串"],
  ])("拒絕 %s（%s）", (raw) => {
    expect(parseTenorTarget(raw)).toBe(null);
  });

  test("undefined / null 不丟例外", () => {
    expect(parseTenorTarget(undefined)).toBe(null);
    expect(parseTenorTarget(null)).toBe(null);
  });
});

// 取自 tenor.com/view/faker-hug-smile-happy-shy-gif-16360306 的真實 markup。
// 注意 class="dynamic" 排在 property 之前 —— 屬性順序不固定，解析不能假設順序。
const REAL_HEAD = `
<meta class="dynamic" property="og:image" content="https://media1.tenor.com/m/TjWRuqajuC0AAAAd/faker-hug.gif">
<meta class="dynamic" property="og:image:type" content="image/gif">
<meta class="dynamic" property="og:image:width" content="640">
<meta class="dynamic" property="og:image:height" content="390">
<meta class="dynamic" property="og:video" content="https://media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4">
<meta class="dynamic" property="og:video:secure_url" content="https://media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4">
<meta class="dynamic" property="og:video:type" content="video/mp4">
<meta class="dynamic" property="og:video" content="https://media.tenor.com/TjWRuqajuC0AAAPs/faker-hug.webm">
<meta class="dynamic" property="og:video:type" content="video/webm">
<meta itemprop="contentUrl" content="https://media1.tenor.com/m/TjWRuqajuC0AAAAC/faker-hug.gif">
<link rel="canonical" href="https://tenor.com/view/faker-hug-smile-happy-shy-gif-16360306"/>
`;

describe("parseTenorMedia", () => {
  test("真實頁面：取到 mp4（不是 webm）、gif、尺寸與 id", () => {
    expect(parseTenorMedia(REAL_HEAD)).toEqual({
      id: "16360306",
      mp4: "https://media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4",
      webm: "https://media.tenor.com/TjWRuqajuC0AAAPs/faker-hug.webm",
      gif: "https://media1.tenor.com/m/TjWRuqajuC0AAAAd/faker-hug.gif",
      width: 640,
      height: 390,
    });
  });

  test("只有 og:image（無影片）→ 仍可用 gif", () => {
    const got = parseTenorMedia(
      '<meta property="og:image" content="https://media1.tenor.com/m/abc/x.gif">',
    );
    expect(got.gif).toBe("https://media1.tenor.com/m/abc/x.gif");
    expect(got.mp4).toBe(undefined);
  });

  test("單引號屬性也吃得到", () => {
    const got = parseTenorMedia(
      "<meta property='og:video' content='https://media.tenor.com/abc/x.mp4'>",
    );
    expect(got.mp4).toBe("https://media.tenor.com/abc/x.mp4");
  });

  // 頁面內容是上游控制的，不能讓它把任意第三方位址塞進我們回給前端的 JSON。
  test("非 tenor 網域的 og 值一律丟棄", () => {
    expect(
      parseTenorMedia(
        '<meta property="og:video" content="https://evil.com/x.mp4">' +
          '<meta property="og:image" content="https://evil.com/x.gif">',
      ),
    ).toBe(null);
  });

  test.each([
    ["", "空字串"],
    ["<html><body>no meta</body></html>", "沒有 og tag"],
    ['<meta property="og:title" content="x">', "只有無關 og tag"],
  ])("解析不到媒體回 null（%s）", (html) => {
    expect(parseTenorMedia(html)).toBe(null);
  });

  test("null / undefined 不丟例外", () => {
    expect(parseTenorMedia(undefined)).toBe(null);
  });
});
