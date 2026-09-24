// 圖片快取代理（imgur／twimg／catbox）的 URL 改寫層守護。
//
// 這層唯一的風險是「把不該送的東西送進代理」：
//   - 影片（mp4/webm）→ Worker 白名單擋掉會回 **404**（不是 fail-open 的 302），
//     等於自製一個載入失敗；且 Cloudflare 服務條款排除影片檔。
//   - 異常 id／未知副檔名 → 同樣撞上 Worker 的 404。
// 另一個風險是「代理掛掉沒得退」：候選清單第一順位是代理，後面必須留 i.imgur.com
// 原址，Worker 掛掉或額度用盡（Error 1027）時由 FallbackImage 自動退回。
//
// 對應實作 src/js/image_proxy.js，白名單與 proxy/imgur-worker/src/index.js:23 的
// RE_ASSET 逐字對齊。

import {
  DEFAULT_IMGUR_PROXY_BASE,
  IMAGE_PROXY_SITES,
  siteProxyEnabled,
  twimgCandidates,
  twimgDirectCandidates,
  catboxCandidates,
  imgurCandidates,
  normalizeImgurProxyBase,
  proxiedImgurUrl,
  getImageProxyConfig,
  resetImageProxyConfig,
  setImageProxyConfig,
} from "../../src/js/image_proxy.js";
import { DEFAULT_PREFS } from "../../src/js/pref_storage.js";

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

  // ReDoS 回歸（CodeQL js/polynomial-redos）：舊寫法 `.replace(/\/+$/, "")` 對
  // 「一長串斜線 + 尾端非斜線」是 O(n²)——每個起點都貪婪吃完斜線，再逐格回溯找 $。
  // 輸入是使用者自己在設定頁填的位址，所以走的是同一條 code path。
  // 實測 60000 個斜線：regex 1894 ms、字元掃描 0 ms。
  test("長斜線串 + 尾端非斜線不會退化成多項式回溯", () => {
    const evil = "https://my.example.dev/" + "/".repeat(60000) + "a";
    const t0 = performance.now();
    expect(normalizeImgurProxyBase(evil)).toBe(evil);
    expect(performance.now() - t0).toBeLessThan(200);
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
  afterEach(() => resetImageProxyConfig());

  test("預設是關閉（fail-safe，真值由 onPrefChange 注入）", () => {
    expect(getImageProxyConfig()).toEqual({
      enabled: false,
      base: DEFAULT_IMGUR_PROXY_BASE,
      sites: {},
    });
  });

  test("setImageProxyConfig 是部分更新，各 pref 各自進來也不會蓋掉對方", () => {
    setImageProxyConfig({ enabled: true });
    setImageProxyConfig({ base: "https://my.example.dev" });
    setImageProxyConfig({ sites: { twimg: false } });
    setImageProxyConfig({ sites: { catbox: true } });
    expect(getImageProxyConfig()).toEqual({
      enabled: true,
      base: "https://my.example.dev",
      sites: { twimg: false, catbox: true },
    });
  });
});

describe("siteProxyEnabled（總開關 × 各站開關）", () => {
  test.each([
    [{ enabled: true }, true, "sites 缺項視為開（各站 pref 預設 true）"],
    [{ enabled: true, sites: { imgur: true } }, true, "站開"],
    [{ enabled: true, sites: { imgur: false } }, false, "站關"],
    [{ enabled: false, sites: { imgur: true } }, false, "總開關關閉一律關"],
    [null, false, "沒有 config"],
  ])("%j → %s（%s）", (config, expected) => {
    expect(siteProxyEnabled(config, "imgur")).toBe(expected);
  });

  test("關掉某站只影響該站", () => {
    const config = { enabled: true, base: DEFAULT_IMGUR_PROXY_BASE, sites: { imgur: false } };
    expect(proxiedImgurUrl("abc123", "jpg", config)).toBe("https://i.imgur.com/abc123.jpg");
    expect(twimgCandidates("HSWhvjqbMAIr5Ux", "jpg", config)[0]).toBe(
      `${DEFAULT_IMGUR_PROXY_BASE}/twimg/orig/HSWhvjqbMAIr5Ux.jpg`,
    );
  });

  test("站台清單的 prefKey 都有預設值 true（預設全開）", () => {
    for (const site of IMAGE_PROXY_SITES) {
      expect([site.id, DEFAULT_PREFS[site.prefKey]]).toEqual([site.id, true]);
    }
    // 總開關沿用舊 key（沒有 pref 遷移機制，理由見 pref_storage.js）。
    expect(DEFAULT_PREFS.useImgurProxy).toBe(true);
  });
});

// 白名單對齊 proxy/imgur-worker/src/index.js 的 RE_TWIMG_ASSET。
describe("twimgCandidates", () => {
  const ID = "HSWhvjqbMAIr5Ux";
  const direct = [
    `https://pbs.twimg.com/media/${ID}.jpg:orig`,
    `https://pbs.twimg.com/media/${ID}.png:orig`,
    `https://pbs.twimg.com/media/${ID}.jpg:large`,
    `https://pbs.twimg.com/media/${ID}.jpg`,
  ];

  test("代理關閉：與整合前逐字相同的四候選", () => {
    expect(twimgDirectCandidates(ID, "jpg")).toEqual(direct);
    expect(twimgCandidates(ID, "jpg", OFF)).toEqual(direct);
  });

  test("代理開啟：代理的 orig 第一，直連四候選原樣墊後", () => {
    expect(twimgCandidates(ID, "jpg", ON)).toEqual([
      `${DEFAULT_IMGUR_PROXY_BASE}/twimg/orig/${ID}.jpg`,
      ...direct,
    ]);
  });

  test("png 原圖：代理位址用 png，直連候選去重", () => {
    const out = twimgCandidates(ID, "png", ON);
    expect(out[0]).toBe(`${DEFAULT_IMGUR_PROXY_BASE}/twimg/orig/${ID}.png`);
    expect(new Set(out).size).toBe(out.length);
  });

  test.each([
    ["gif", "twimg 沒有 gif format"],
    ["jpeg", "Worker 白名單只收 jpg"],
  ])("%s 不代理（%s）", (ext) => {
    expect(twimgCandidates(ID, ext, ON)).toEqual(twimgDirectCandidates(ID, ext));
  });

  test("異常 id 不代理", () => {
    expect(twimgCandidates("../x", "jpg", ON)[0]).toBe("https://pbs.twimg.com/media/../x.jpg:orig");
    expect(twimgCandidates("a".repeat(33), "jpg", ON)[0]).toMatch(/^https:\/\/pbs\.twimg\.com\//);
  });
});

// 白名單對齊 proxy/imgur-worker/src/index.js 的 RE_CATBOX_ASSET。
describe("catboxCandidates", () => {
  test("代理開啟：[代理, 原址]", () => {
    expect(catboxCandidates("rdpjcp", "png", ON)).toEqual([
      `${DEFAULT_IMGUR_PROXY_BASE}/catbox/rdpjcp.png`,
      "https://files.catbox.moe/rdpjcp.png",
    ]);
  });

  test("代理關閉：只有原址", () => {
    expect(catboxCandidates("rdpjcp", "png", OFF)).toEqual(["https://files.catbox.moe/rdpjcp.png"]);
  });

  // Cloudflare ToS 排除影片；Worker 對影片回 404（不是 fail-open 302）。
  test.each([["mp4"], ["webm"], ["PNG"]])("%s 不代理", (ext) => {
    expect(catboxCandidates("rdpjcp", ext, ON)).toEqual([`https://files.catbox.moe/rdpjcp.${ext}`]);
  });

  test("自訂 base 同樣套用正規化", () => {
    expect(catboxCandidates("rdpjcp", "gif", { enabled: true, base: "my.example.dev/" })[0]).toBe(
      "https://my.example.dev/catbox/rdpjcp.gif",
    );
  });
});
