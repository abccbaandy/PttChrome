// 「這張圖這次載入有沒有真的經過 imgur 快取代理」的判定與狀態分送。
//
// 判準主軸是**有沒有經過代理**，不是快不快 —— 所以 fail-open 302 退回直連、以及
// 瀏覽器本機快取命中（這次根本沒發網路請求）都必須是 "none"（無徽章）。
//
// store 的硬契約是**每次載入重算**：徽章講的是「這一次載入」，不是「這個 URL 曾經
// 怎樣」。舊版把結論以 URL 為鍵快取起來 + 單調遞增，等於一個 session 內只算一次
// （PTT client 進出文章不重整網頁 ⇒ 永遠不會重算），三條驗收流程全數失效。

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

  // deliveryType（Chrome 109+，跨源需 TAO）直接說出「這筆是從瀏覽器快取供應的」，
  // 比 transferSize 推論更無歧義 ⇒ 它是主判準，尺寸條件留作 fallback。
  test("deliveryType 為 cache → none，即使尺寸欄位看起來像真的下載過", () => {
    expect(
      classify({
        deliveryType: "cache",
        transferSize: 40000,
        encodedBodySize: 39700,
        serverTiming: [{ name: "pttproxy", description: String(NOW_SEC - 86400) }],
      }),
    ).toBe("none");
  });

  test("deliveryType 為空字串（走網路）→ 照常判定", () => {
    expect(classify({ deliveryType: "" })).toBe("proxy");
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
  const HREF_B = "https://imgur.com/def456";

  // store 路徑走真實時鐘（ingest 內部用 Date.now()），所以時間戳要跟著現在算。
  const liveStamp = (deltaSec = 0) =>
    String(Math.floor(Date.now() / 1000) + deltaSec);
  // 每筆計時項的 startTime 都不同：同一個 URL 連續載入兩次是**兩筆獨立的計時項**，
  // 去重鍵含 startTime 才不會把第二筆當成 buffered 重播丟掉。
  let startTime = 0;
  const live = (over = {}) =>
    entry({
      startTime: ++startTime,
      serverTiming: [{ name: "pttproxy", description: liveStamp() }],
      ...over,
    });
  // 代理端快取命中（舊時間戳）。
  const hit = (over = {}) =>
    live({
      serverTiming: [{ name: "pttproxy", description: liveStamp(-86400) }],
      ...over,
    });
  // 瀏覽器本機快取命中（disk cache：有計時項但沒真的下載）。
  const localCache = (over = {}) => live({ transferSize: 0, ...over });

  // 計時項可能晚於 <img> 的 onload 才送到觀察器 → 先掛載入事件，之後補派送。
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

  // --- 三條驗收流程（docs/handoff 定案的規格，每次載入都要重算）---------------

  test("案例1：代理回源 → 第二次吃本機快取 → 本機快取沒了改由代理端命中", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(live());
    expect(getProxyStatus(HREF)).toBe("proxy"); // ◇

    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(localCache());
    expect(getProxyStatus(HREF)).toBe("none"); // 無符號

    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(hit());
    expect(getProxyStatus(HREF)).toBe("cache"); // ◆
  });

  test("案例2：首次就代理端命中 → 第二次吃本機快取", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(hit());
    expect(getProxyStatus(HREF)).toBe("cache");

    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(localCache());
    expect(getProxyStatus(HREF)).toBe("none");
  });

  test("案例3：代理掛了退回直連 → 兩次都無符號", () => {
    const DIRECT = "https://i.imgur.com/abc123.jpg";
    reportProxyLoad(HREF, DIRECT);
    ingestEntryForTest(live({ name: DIRECT, transferSize: 0, encodedBodySize: 0, serverTiming: [] }));
    expect(getProxyStatus(HREF)).toBe("none");

    reportProxyLoad(HREF, DIRECT);
    expect(getProxyStatus(HREF)).toBe("none");
  });

  // memory cache 命中時瀏覽器**可能完全不產生計時項** ⇒ 靠「收到計時項才降級」會永遠
  // 停在舊值。所以 onload 當下先歸零，沒有計時項自然就是無符號。
  test("onload 之後始終沒有計時項（memory cache）→ 必須回到 none", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(hit());
    expect(getProxyStatus(HREF)).toBe("cache");

    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("none");
  });

  test("歸零時要通知訂閱者（徽章才會真的消失）", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(live());
    const cb = vi.fn();
    subscribeProxyStatus(cb);
    reportProxyLoad(HREF, URL_A);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getProxyStatus(HREF)).toBe("none");
  });

  // 取代舊的「單調遞增」守護——那條守的正是這次要拆掉的錯誤行為。
  test("後來的 none 必須蓋掉先前的 cache", () => {
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(hit());
    expect(getProxyStatus(HREF)).toBe("cache");

    reportProxyLoad(HREF, "https://i.imgur.com/abc123.jpg");
    expect(getProxyStatus(HREF)).toBe("none");
  });

  // 相簿一個 href 對應多張圖、多個 href 也可能指到同一個 URL：載入事件必須是列表，
  // 一個 href 只存得下一個 url 時前面那筆會被覆蓋掉、對應的計時項就找不到派送對象。
  test("同一 URL 兩次載入產生兩筆計時項 → 各自匹配，不互搶", () => {
    reportProxyLoad(HREF, URL_A);
    reportProxyLoad(HREF_B, URL_A);

    ingestEntryForTest(live()); // 先到的配先掛的
    expect(getProxyStatus(HREF)).toBe("proxy");
    expect(getProxyStatus(HREF_B)).toBe("none");

    ingestEntryForTest(hit());
    expect(getProxyStatus(HREF_B)).toBe("cache");
    expect(getProxyStatus(HREF)).toBe("proxy");
  });

  test("計時項早於 onload 抵達 → 只能被消費一次，下一次載入不得沿用", () => {
    ingestEntryForTest(hit());
    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("cache");

    reportProxyLoad(HREF, URL_A);
    expect(getProxyStatus(HREF)).toBe("none");
  });

  // buffered:true 會把觀察器建立前完成的載入重播一次；同一筆不可被當成第二次載入。
  test("同一筆計時項重複送達（buffered 重播）只算一次", () => {
    const replayed = live();
    reportProxyLoad(HREF, URL_A);
    ingestEntryForTest(replayed);
    expect(getProxyStatus(HREF)).toBe("proxy");

    reportProxyLoad(HREF_B, URL_A);
    ingestEntryForTest(replayed);
    expect(getProxyStatus(HREF_B)).toBe("none");
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
