// 「這張圖這次載入有沒有真的經過 imgur 快取代理」的偵測與狀態分送。
//
// 為什麼要這樣做：`<img>` 的載入**無法從 JS 讀取回應標頭**，而 Worker 的 fail-open
// 是 302 導回 i.imgur.com（proxy/imgur-worker/src/index.js#redirectToOrigin）——所以
// 「代理服務的」與「額度用盡／Worker 掛掉被導回直連的」在瀏覽器端預設長得一模一樣。
// 唯一**不增加任何網路請求**的資訊來源是 PerformanceResourceTiming，代價是 Worker 必須
// 吐 `Timing-Allow-Origin: *`（否則跨網域欄位全歸零）與 `Server-Timing: pttproxy;desc=…`。
//
// 判準主軸是「有沒有經過代理」，不是「快不快」：
//   經過代理 + 代理端命中 → "cache"（強調徽章）
//   經過代理 + 代理端回源 → "proxy"（一般徽章）
//   沒經過代理           → "none"（無徽章，畫面與這功能不存在時逐字相同）

import { getImgurProxyConfig, normalizeImgurProxyBase } from "./imgur_proxy.js";

// Server-Timing 的 metric 名稱，與 Worker 的 passthroughHeaders 逐字對齊。
export const PROXY_SERVER_TIMING_NAME = "pttproxy";

// 時間戳距今超過這個秒數 ⇒ 判定為代理端快取命中。
//
// Workers Cache 命中時 Worker **不執行**，吐回的是建立快取當下的時間戳；MISS 則是剛剛
// 才蓋的新時間戳，差距趨近 0（單趟請求本身只有 1 s 級）。門檻純粹是時鐘偏差的容忍度：
// 使用者時鐘快超過這個秒數時，剛回源的 MISS 會被誤標成 HIT（純外觀問題）。
// NTP 同步的機器通常在 1 s 內，30 s 已經很寬；換來的是「剛存進快取的圖幾乎立刻就認得
// 出是命中」，不必等好幾分鐘。
export const PROXY_CACHE_AGE_THRESHOLD_SEC = 30;

const serverTimingStamp = (entry) => {
  const list = entry && entry.serverTiming;
  if (!list || !list.length) return null;
  for (let i = 0; i < list.length; ++i) {
    if (list[i] && list[i].name === PROXY_SERVER_TIMING_NAME) {
      const n = parseInt(list[i].description, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
};

// 純決策表（unit 直接測）。**分支順序就是規格**，不可調換：本機快取那一條必須早於
// 時間戳那一條，否則本機快取重播的舊時間戳會被誤判成邊緣命中。
export const classifyProxyDelivery = ({ entry, proxyBase, nowMs }) => {
  if (!entry || typeof entry.name !== "string") return "none";
  if (!proxyBase || entry.name.indexOf(proxyBase + "/") !== 0) return "none";

  // 本機快取命中：這次載入根本沒發出網路請求 ⇒ 沒經過代理 ⇒ 無徽章。
  // （transferSize 為 0 但有 body ＝ 從記憶體／硬碟快取來的標準判準。跨網域要有 TAO
  //  才讀得到這兩個值，沒有 TAO 時兩者皆為 0，會落到下面那條的 "none"。）
  if (entry.transferSize === 0 && entry.encodedBodySize > 0) return "none";

  const stamp = serverTimingStamp(entry);
  // 讀不到時間戳 ⇒ 沒經過代理。涵蓋兩種情況：
  //   (a) fail-open 302 導到 i.imgur.com（該主機沒有 TAO）⇒ 整筆計時的 TAO 檢查失敗
  //   (b) Worker 加這兩個標頭之前就已建立的快取條目（cross_version_cache 會讓它們
  //       繼續吐舊標頭，在 LRU 汰換前讀不到）
  // 兩者都保守判為 none：寧可不顯示，也不要標錯。
  if (stamp === null) return "none";

  const ageSec = (typeof nowMs === "number" ? nowMs : Date.now()) / 1000 - stamp;
  return ageSec > PROXY_CACHE_AGE_THRESHOLD_SEC ? "cache" : "proxy";
};

// ---------------------------------------------------------------------------
// 觀察器：把代理主機底下的圖片載入計時收成 url → status
// ---------------------------------------------------------------------------

const RANK = { none: 0, proxy: 1, cache: 2 };

// url → "proxy" | "cache"（"none" 不存，省得無限長大）
const urlStatus = new Map();
// href → status，UI 訂閱的就是這張表
const hrefStatus = new Map();
// href → url：<img> 已經 onload 但計時項還沒送到觀察器時的待補清單
const pending = new Map();
const listeners = new Set();

let observer = null;
let observerFailed = false;

const proxyBase = () => {
  const config = getImgurProxyConfig();
  if (!config || !config.enabled) return null;
  return normalizeImgurProxyBase(config.base);
};

const notify = () => {
  for (const cb of listeners) cb();
};

// 單調遞增：相簿一個 href 對應多張圖，只要有任何一張確認經過代理就保留徽章，
// 不因為其中一張退回直連（或之後從本機快取重載）而閃掉。
const upgrade = (map, key, status) => {
  const cur = map.get(key);
  if (cur !== undefined && RANK[cur] >= RANK[status]) return false;
  map.set(key, status);
  return true;
};

const ingest = (entry) => {
  // 只認圖片載入。imgur_probe.js 的 HEAD 探測也會打到代理（同一個 .jpg URL），
  // 那是 initiatorType "fetch"，拿它的計時去判圖片會張冠李戴。
  if (entry.initiatorType !== "img") return;
  const base = proxyBase();
  if (!base) return;
  const status = classifyProxyDelivery({ entry, proxyBase: base });
  if (status === "none") return;
  urlStatus.set(entry.name, status);
  let changed = false;
  for (const [href, url] of pending) {
    if (url !== entry.name) continue;
    pending.delete(href);
    if (upgrade(hrefStatus, href, status)) changed = true;
  }
  if (changed) notify();
};

const ensureObserver = () => {
  if (observer || observerFailed) return;
  if (typeof PerformanceObserver !== "function") {
    observerFailed = true;
    return;
  }
  try {
    observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (let i = 0; i < entries.length; ++i) ingest(entries[i]);
    });
    // **不可改用 performance.getEntriesByName()**：預設資源計時 buffer 只有 250 筆，
    // 實錄長文有 287 個圖片連結（docs/media-preview-addons.md），會被丟棄。
    // buffered:true 讓觀察器建立前就完成的載入也收得到。
    observer.observe({ type: "resource", buffered: true });
  } catch (e) {
    observerFailed = true;
    observer = null;
  }
};

// FallbackImage 載入成功時呼叫：href ＝ 原文那個連結，loadedUrl ＝ 實際成功的候選。
// 計時項可能晚於 onload 才送達觀察器，所以查不到就先掛進 pending 等補派送。
export const reportProxyLoad = (href, loadedUrl) => {
  if (!href || !loadedUrl) return;
  ensureObserver();
  const known = urlStatus.get(loadedUrl);
  if (known !== undefined) {
    if (upgrade(hrefStatus, href, known)) notify();
    return;
  }
  pending.set(href, loadedUrl);
};

export const getProxyStatus = (href) => hrefStatus.get(href) || "none";

export const subscribeProxyStatus = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// 測試用：把模組狀態還原成初始值。
export const resetProxyStatusForTest = () => {
  urlStatus.clear();
  hrefStatus.clear();
  pending.clear();
  listeners.clear();
  if (observer) observer.disconnect();
  observer = null;
  observerFailed = false;
};

// 測試用：直接餵一筆假的 resource entry，不必真的跑 PerformanceObserver。
export const ingestEntryForTest = (entry) => ingest(entry);
