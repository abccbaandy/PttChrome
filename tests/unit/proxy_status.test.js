// 「這張圖這次載入有沒有真的經過 imgur 快取代理」的判定與狀態分送。
//
// 判準主軸是**有沒有經過代理**，不是快不快 —— 所以 fail-open 302 退回直連、以及
// 瀏覽器本機快取命中（這次根本沒發網路請求）都必須是 "none"（無徽章）。

import {
  PROXY_CACHE_AGE_THRESHOLD_SEC,
  classifyProxyDelivery,
  getProxyStatus,
  ingestEntryForTest,
  reportProxyLoad,
  resetProxyStatusForTest,
  subscribeProxyStatus,
} from "../../src/js/proxy_status";
import {
  resetImgurProxyConfig,
  setImgurProxyConfig,
} from "../../src/js/imgur_proxy";

const BASE = "https://worker.example.dev";
const URL_A = `${BASE}/abc123.jpg`;
const NOW_SEC = 1770000000;
const NOW_MS = NOW_SEC * 1000;

// 一筆「代理真的服務了這張圖」的資源計時：TAO 通過 ⇒ 尺寸欄位有值、serverTiming 讀得到。
const entry = (over = {}) => ({
  name: URL_A,
  initiatorType: "img",
  transferSize: 40000,
  encodedBodySize: 39700,
  serverTiming: [{ name: "pttproxy", description: String(NOW_SEC) }],
  ...over,
});

const classify = (over) =>
  classifyProxyDelivery({ entry: entry(over), proxyBase: BASE, nowMs: NOW_MS });

describe("classifyProxyDelivery", () => {
  test("代理剛回源（新時間戳）→ proxy", () => {
    expect(classify()).toBe("proxy");
  });

  test("代理端快取命中（舊時間戳）→ cache", () => {
    const old = NOW_SEC - PROXY_CACHE_AGE_THRESHOLD_SEC - 1;
    expect(
      classify({ serverTiming: [{ name: "pttproxy", description: String(old) }] }),
    ).toBe("cache");
  });

  test("時間戳恰在門檻上 → 仍算 proxy（門檻是嚴格大於）", () => {
    const edge = NOW_SEC - PROXY_CACHE_AGE_THRESHOLD_SEC;
    expect(
      classify({ serverTiming: [{ name: "pttproxy", description: String(edge) }] }),
    ).toBe("proxy");
  });

  test("時鐘偏差讓時間戳落在未來 → 不會誤判成 cache", () => {
    const future = NOW_SEC + 600;
    expect(
      classify({ serverTiming: [{ name: "pttproxy", description: String(future) }] }),
    ).toBe("proxy");
  });

  test("非代理主機（直連 i.imgur.com 候選）→ none", () => {
    expect(classify({ name: "https://i.imgur.com/abc123.jpg" })).toBe("none");
  });

  test("代理主機字首相同但不是同一個 host → none", () => {
    expect(classify({ name: `${BASE}.evil.com/abc123.jpg` })).toBe("none");
  });

  // fail-open 302 導到 i.imgur.com（該主機沒有 TAO）⇒ 整筆計時的 TAO 檢查失敗，
  // 尺寸欄位全歸零、serverTiming 空。這正是「額度用盡／Worker 掛掉」的長相。
  test("fail-open 302 退回直連（TAO 檢查失敗，欄位全空）→ none", () => {
    expect(
      classify({ transferSize: 0, encodedBodySize: 0, serverTiming: [] }),
    ).toBe("none");
  });

  test("Worker 加標頭前就存在的舊快取條目（讀不到 pttproxy）→ none", () => {
    expect(classify({ serverTiming: [{ name: "cfCache", description: "hit" }] })).toBe(
      "none",
    );
  });

  // 這條就是「本機快取那一支必須早於時間戳那一支」的回歸守護：本機快取重播的是
  // 舊回應、帶著舊的 pttproxy 時間戳，順序寫反就會被誤判成邊緣快取命中。
  test("瀏覽器本機快取命中 → none，即使帶著會被判成 cache 的舊時間戳", () => {
    const old = NOW_SEC - 86400;
    expect(
      classify({
        transferSize: 0,
        encodedBodySize: 39700,
        serverTiming: [{ name: "pttproxy", description: String(old) }],
      }),
    ).toBe("none");
  });

  test("description 不是數字 → none（不當成命中）", () => {
    expect(
      classify({ serverTiming: [{ name: "pttproxy", description: "hit" }] }),
    ).toBe("none");
  });

  test("代理關閉（proxyBase 為 null）→ none", () => {
    expect(
      classifyProxyDelivery({ entry: entry(), proxyBase: null, nowMs: NOW_MS }),
    ).toBe("none");
  });
});

describe("proxy status store", () => {
  beforeEach(() => {
    resetProxyStatusForTest();
    setImgurProxyConfig({ enabled: true, base: BASE });
  });
  afterEach(() => {
    resetProxyStatusForTest();
    resetImgurProxyConfig();
  });

  const HREF = "https://imgur.com/abc123";

  // store 路徑走真實時鐘（ingest 內部用 Date.now()），所以時間戳要跟著現在算。
  const liveStamp = (deltaSec = 0) =>
    String(Math.floor(Date.now() / 1000) + deltaSec);
  const live = (over = {}) =>
    entry({ serverTiming: [{ name: "pttproxy", description: liveStamp() }], ...over });

  // 計時項可能晚於 <img> 的 onload 才送到觀察器 → 先掛 pending，之後補派送。
  test("先 onload 後才收到計時項 → 補派送並通知訂閱者", () => {
    const cb = vi.fn();
    subscribeProxyStatus(cb);
    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("none");

    ingestEntryForTest(live());
    expect(getProxyStatus(HREF)).toBe("proxy");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test("先收到計時項後才 onload → 直接命中", () => {
    ingestEntryForTest(live());
    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("proxy");
  });

  // 相簿一個 href 對應多張圖；捲走再捲回也會重新 onload（且多半吃本機快取＝none）。
  // 狀態必須單調遞增，否則徽章會閃掉。
  test("狀態單調遞增：cache 不會被後來的 proxy／none 蓋掉", () => {
    const URL_B = `${BASE}/def456.jpg`;
    ingestEntryForTest(
      live({
        name: URL_B,
        serverTiming: [{ name: "pttproxy", description: liveStamp(-86400) }],
      }),
    );
    reportProxyLoad(HREF, URL_B);
    expect(getProxyStatus(HREF)).toBe("cache");

    ingestEntryForTest(live());
    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("cache");

    reportProxyLoad(HREF, "https://i.imgur.com/abc123.jpg");
    expect(getProxyStatus(HREF)).toBe("cache");
  });

  // imgur_probe.js 的 HEAD 探測會打到同一個 .jpg URL，那是 initiatorType "fetch"。
  test("非 img 的計時項（探測用的 fetch）被忽略", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(live({ initiatorType: "fetch" }));
    expect(getProxyStatus(HREF)).toBe("none");
  });

  test("退回直連候選 → 維持 none", () => {
    reportProxyLoad(HREF, "https://i.imgur.com/abc123.jpg");
    ingestEntryForTest(live({ name: "https://i.imgur.com/abc123.jpg" }));
    expect(getProxyStatus(HREF)).toBe("none");
  });

  test("unsubscribe 之後不再收到通知", () => {
    const cb = vi.fn();
    const off = subscribeProxyStatus(cb);
    off();
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(live());
    expect(cb).not.toHaveBeenCalled();
  });

  test("代理關閉時不記任何狀態", () => {
    setImgurProxyConfig({ enabled: false });
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(live());
    expect(getProxyStatus(HREF)).toBe("none");
  });

  // PerformanceObserver 不存在（jsdom）或 observe 直接丟例外時，整個功能要靜默關閉，
  // 絕不可讓預覽路徑跟著炸掉。
  test("PerformanceObserver 建立失敗 → no-op，不丟例外", () => {
    const orig = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = function () {
      throw new Error("nope");
    };
    try {
      expect(() => reportProxyLoad(HREF, URL_A)).not.toThrow();
      expect(getProxyStatus(HREF)).toBe("none");
    } finally {
      if (orig === undefined) delete globalThis.PerformanceObserver;
      else globalThis.PerformanceObserver = orig;
    }
  });
});
