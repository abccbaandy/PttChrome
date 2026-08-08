// imgur 快取代理的 URL 改寫層守護。
//
// 這層唯一的風險是「把不該送的東西送進代理」：
//   - 影片（mp4/webm）→ Worker 白名單擋掉會回 **404**（不是 fail-open 的 302），
//     等於自製一個載入失敗；且 Cloudflare 服務條款排除影片檔。
//   - 異常 id／未知副檔名 → 同樣撞上 Worker 的 404。
// 另一個風險是「代理掛掉沒得退」：候選清單第一順位是代理，後面必須留 i.imgur.com
// 原址，Worker 掛掉或額度用盡（Error 1027）時由 FallbackImage 自動退回。
//
// 對應實作 src/js/imgur_proxy.js，白名單與 proxy/imgur-worker/src/index.js:23 的
// RE_ASSET 逐字對齊。

import {
  DEFAULT_IMGUR_PROXY_BASE,
  imgurCandidates,
  normalizeImgurProxyBase,
  proxiedImgurUrl,
  getImgurProxyConfig,
  resetImgurProxyConfig,
  setImgurProxyConfig,
} from "../../src/js/imgur_proxy.js";

const ON = { enabled: true, base: DEFAULT_IMGUR_PROXY_BASE };
const OFF = { enabled: false, base: DEFAULT_IMGUR_PROXY_BASE };

describe("proxiedImgurUrl", () => {
  test("代理關閉時原樣回 i.imgur.com", () => {
    expect(proxiedImgurUrl("abc123", "jpg", OFF)).toBe(
      "https://i.imgur.com/abc123.jpg",
    );
    expect(proxiedImgurUrl("abc123", "jpg", null)).toBe(
      "https://i.imgur.com/abc123.jpg",
    );
  });

  test("白名單內的副檔名改寫成代理位址", () => {
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp"]) {
      expect(proxiedImgurUrl("aBc1230", ext, ON)).toBe(
        `${DEFAULT_IMGUR_PROXY_BASE}/aBc1230.${ext}`,
      );
    }
  });

  test("副檔名大小寫不影響判斷，輸出一律小寫", () => {
    expect(proxiedImgurUrl("abc123", "JPG", ON)).toBe(
      `${DEFAULT_IMGUR_PROXY_BASE}/abc123.jpg`,
    );
  });

  // 這是本檔最重要的一條：影片走代理 = 404 = 動圖被靜音／影片載不出來。
  test("影片副檔名一律不代理", () => {
    for (const ext of ["mp4", "webm", "ogg", "gifv"]) {
      expect(proxiedImgurUrl("abc123", ext, ON)).toBe(
        `https://i.imgur.com/abc123.${ext}`,
      );
    }
  });

  test("未知／空副檔名不代理", () => {
    expect(proxiedImgurUrl("abc123", "bmp", ON)).toBe(
      "https://i.imgur.com/abc123.bmp",
    );
    expect(proxiedImgurUrl("abc123", "", ON)).toBe("https://i.imgur.com/abc123.");
    expect(proxiedImgurUrl("abc123", undefined, ON)).toBe(
      "https://i.imgur.com/abc123.",
    );
  });

  test("id 不符 base62 1~12 碼（含路徑穿越）不代理", () => {
    expect(proxiedImgurUrl("abcdefghijklm", "jpg", ON)).toBe(
      "https://i.imgur.com/abcdefghijklm.jpg",
    );
    expect(proxiedImgurUrl("../evil", "jpg", ON)).toBe(
      "https://i.imgur.com/../evil.jpg",
    );
    expect(proxiedImgurUrl("", "jpg", ON)).toBe("https://i.imgur.com/.jpg");
  });

  test("使用者自訂 base：裸 host 補 https、尾端斜線去掉", () => {
    expect(
      proxiedImgurUrl("abc123", "jpg", { enabled: true, base: "my.example.dev/" }),
    ).toBe("https://my.example.dev/abc123.jpg");
    expect(
      proxiedImgurUrl("abc123", "jpg", {
        enabled: true,
        base: "http://localhost:8787",
      }),
    ).toBe("http://localhost:8787/abc123.jpg");
  });

  test("base 留空時退回專案方預設位址", () => {
    expect(proxiedImgurUrl("abc123", "jpg", { enabled: true, base: "  " })).toBe(
      `${DEFAULT_IMGUR_PROXY_BASE}/abc123.jpg`,
    );
  });
});

describe("normalizeImgurProxyBase", () => {
  test("空字串／undefined 回預設", () => {
    expect(normalizeImgurProxyBase("")).toBe(DEFAULT_IMGUR_PROXY_BASE);
    expect(normalizeImgurProxyBase(undefined)).toBe(DEFAULT_IMGUR_PROXY_BASE);
  });

  test("補 scheme、trim、去尾端斜線", () => {
    expect(normalizeImgurProxyBase("  my.example.dev//  ")).toBe(
      "https://my.example.dev",
    );
    expect(normalizeImgurProxyBase("https://my.example.dev")).toBe(
      "https://my.example.dev",
    );
  });
});

describe("imgurCandidates", () => {
  test("代理開啟：第一順位代理，其後保留原址 fallback", () => {
    expect(imgurCandidates("abc123", ["webp", "jpg"], ON)).toEqual([
      `${DEFAULT_IMGUR_PROXY_BASE}/abc123.webp`,
      "https://i.imgur.com/abc123.webp",
      "https://i.imgur.com/abc123.jpg",
    ]);
  });

  test("代理關閉：與整合前完全相同的候選清單（不多出重複項）", () => {
    expect(imgurCandidates("abc123", ["webp", "jpg"], OFF)).toEqual([
      "https://i.imgur.com/abc123.webp",
      "https://i.imgur.com/abc123.jpg",
    ]);
  });

  test("不可代理的副檔名不會產生重複候選", () => {
    expect(imgurCandidates("abc123", ["bmp"], ON)).toEqual([
      "https://i.imgur.com/abc123.bmp",
    ]);
  });
});

describe("模組級 config", () => {
  afterEach(() => resetImgurProxyConfig());

  test("預設是關閉（fail-safe，真值由 onPrefChange 注入）", () => {
    expect(getImgurProxyConfig()).toEqual({
      enabled: false,
      base: DEFAULT_IMGUR_PROXY_BASE,
    });
  });

  test("setImgurProxyConfig 是部分更新，兩個 pref 各自進來也不會蓋掉對方", () => {
    setImgurProxyConfig({ enabled: true });
    setImgurProxyConfig({ base: "https://my.example.dev" });
    expect(getImgurProxyConfig()).toEqual({
      enabled: true,
      base: "https://my.example.dev",
    });
  });
});
