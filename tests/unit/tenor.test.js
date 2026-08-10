// tenor 連結的辨識與解析端點組裝（純邏輯）。
//
// 背景：tenor.com/<code>.gif 是 **HTML 頁**不是圖檔，泛用的「任意 .gif 直連」
// resolver 會誤判成圖片 → 送進 <img> 必定失敗。真正的媒體位址只能由 Worker 代解
// （tenor 頁面無 CORS、/view/ 頁 x-frame-options: DENY）。見 docs/media-preview-addons.md。
import { describe, test, expect } from "vitest";
import { RE_TENOR } from "../../src/js/image_url_detect.js";
import {
  tenorResolveUrl,
  tenorMediaDescriptor,
} from "../../src/js/tenor.js";
import { DEFAULT_IMGUR_PROXY_BASE } from "../../src/js/imgur_proxy.js";

describe("RE_TENOR", () => {
  test.each([
    ["https://tenor.com/bgOd4.gif", "分享短連結（使用者實際會貼的形式）"],
    ["http://tenor.com/bgOd4.gif", "http"],
    ["https://www.tenor.com/bgOd4.gif", "www"],
    ["https://tenor.com/bgOd4.gif?utm_source=x", "帶 query"],
    ["https://tenor.com/view/faker-hug-smile-happy-shy-gif-16360306", "view 完整連結"],
  ])("匹配 %s（%s）", (url) => {
    expect(RE_TENOR.test(url)).toBe(true);
  });

  test.each([
    ["https://media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4", "直連 mp4 交給泛用影片 resolver"],
    ["https://media1.tenor.com/m/TjWRuqajuC0AAAAd/faker-hug.gif", "直連 gif 交給泛用圖片 resolver"],
    ["https://tenor.com.evil.com/x.gif", "後綴偽裝網域"],
    ["https://evil.com/tenor.com/x.gif", "路徑偽裝"],
    ["https://tenor.com/search?q=cat", "非媒體頁"],
    ["https://imgur.com/abc.gif", "別的圖床"],
  ])("不匹配 %s（%s）", (url) => {
    expect(RE_TENOR.test(url)).toBe(false);
  });

  // tenor 短碼**大小寫敏感**：bgOd4.gif 是 16360306、bgod4.gif 是 16260362，
  // 兩張完全不同的圖。任何環節都不可以把它轉小寫。
  test("regex 的 i 旗標不影響原字串大小寫", () => {
    const url = "https://tenor.com/bgOd4.gif";
    expect(RE_TENOR.test(url)).toBe(true);
    expect(url).toContain("bgOd4");
  });
});

describe("tenorResolveUrl", () => {
  const on = { enabled: true, base: DEFAULT_IMGUR_PROXY_BASE };

  test("組出 Worker 解析端點，原始 URL 經過 encode", () => {
    expect(tenorResolveUrl("https://tenor.com/bgOd4.gif", on)).toBe(
      `${DEFAULT_IMGUR_PROXY_BASE}/tenor?url=https%3A%2F%2Ftenor.com%2FbgOd4.gif`,
    );
  });

  test("使用者自訂 base（裸 host／尾端斜線）沿用 imgur_proxy 的正規化", () => {
    expect(
      tenorResolveUrl("https://tenor.com/bgOd4.gif", {
        enabled: true,
        base: "my-worker.workers.dev///",
      }),
    ).toBe(
      "https://my-worker.workers.dev/tenor?url=https%3A%2F%2Ftenor.com%2FbgOd4.gif",
    );
  });

  // 代理關掉 = 使用者不想把瀏覽紀錄送給專案方 Worker ⇒ tenor 也一併停用。
  test.each([
    [{ enabled: false, base: DEFAULT_IMGUR_PROXY_BASE }, "代理關閉"],
    [null, "無設定"],
  ])("回 null（%#：%s）", (config) => {
    expect(tenorResolveUrl("https://tenor.com/bgOd4.gif", config)).toBe(null);
  });

  test("非 tenor 連結一律回 null（別讓 Worker 變成任意站台跳板）", () => {
    expect(tenorResolveUrl("https://evil.com/x.gif", on)).toBe(null);
    expect(tenorResolveUrl("", on)).toBe(null);
  });
});

describe("tenorMediaDescriptor", () => {
  test("有 mp4 → GIF 語意的 video descriptor（960 KB vs gif 4.2 MB）", () => {
    expect(
      tenorMediaDescriptor({
        mp4: "https://media.tenor.com/a/x.mp4",
        gif: "https://media1.tenor.com/m/a/x.gif",
      }),
    ).toEqual({ type: "video", src: "https://media.tenor.com/a/x.mp4", gif: true });
  });

  test("只有 gif → image descriptor", () => {
    expect(tenorMediaDescriptor({ gif: "https://media1.tenor.com/m/a/x.gif" })).toEqual({
      type: "image",
      src: "https://media1.tenor.com/m/a/x.gif",
    });
  });

  test.each([[{}], [{ error: "no media" }], [null], [undefined]])(
    "缺媒體欄位回 null（%#）",
    (json) => {
      expect(tenorMediaDescriptor(json)).toBe(null);
    },
  );
});
