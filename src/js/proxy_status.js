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
  // deliveryType（Chrome 109+，跨網域同樣需要 TAO）直接回報 "cache"，最無歧義，
  // 故為主判準；讀不到時退回 transferSize 為 0 但有 body 的傳統推論（跨網域沒有
  // TAO 時兩者皆為 0，會落到下面那條的 "none"）。
  if (entry.deliveryType === "cache") return "none";
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
// 觀察器：把圖片載入計時派送給「這一次載入」
// ---------------------------------------------------------------------------
//
// 徽章講的是**這一次載入**，每次載入都要重算 ⇒ 模型是「載入事件」，不是「URL →
// 結論」的快取。（舊版兩者混用：URL 查得到舊結論就直接沿用，加上狀態單調遞增，
// 等於一個 URL 一個 session 只分類一次；而 PTT client 進出文章不重整網頁，使用者
// 看到的就是「有符號的一直有、沒符號的一直沒有」。）
//
//   reportProxyLoad(href, url)  ← <img> onload：**立刻把該 href 歸零**，
//                                 之後有匹配的計時項才升成 proxy / cache
//   ingest(entry)               ← PerformanceObserver：找對應的載入事件派送
//
// 「先歸零」是核心取捨：`<img>` 命中 memory cache 時瀏覽器**可能完全不產生計時項**
// （disk cache 會產生、transferSize 為 0；memory cache 通常不會）。若改成「收到
// 計時項才降級」，沒有計時項時就會停在上一次的舊值。歸零在先 ⇒「沒有計時項」自然
// 落在規格要的無徽章，memory cache 到底有沒有計時項變成不影響正確性的實作細節。

// 載入事件／早到計時項的存活上限：超過就作廢，避免很久以後的計時項誤配到早就結束
// 的載入。計時項與 onload 之間只隔解碼，正常是毫秒級；留 30 s 是給超大圖在慢機器上
// 解碼的餘裕（配對本來就以 URL 為鍵、先到先配，放寬一點不會亂配）。
const MATCH_TTL_MS = 30000;
// 各佇列的硬上限（長 session 逛很多文章不可無限長大）。
const MAX_EVENTS = 256;
// href → status 也要有界；超過就汰換最久沒更新的（那時早已捲出視野）。
const MAX_HREF_STATUS = 512;

// href → "proxy" | "cache"，UI 訂閱的就是這張表（"none" 不存，即為預設值）
const hrefStatus = new Map();
// <img> 已經 onload、還在等匹配計時項的載入事件：{href, url, at}。
// **必須是列表**：相簿一個 href 對應多張圖，同一個 URL 也可能同時被多個 href 載入，
// 舊版 Map<href,url> 一個 href 只存得下一筆，先掛的會被覆蓋掉。
const pendingLoads = [];
// 計時項比 onload 早到時的短期暫存：{url, status, at}。**一次性消費**，
// 被某次 reportProxyLoad 取走後即失效，不能再餵給下一次載入。
const earlyEntries = [];
// 已消化過的計時項（`name|startTime`）。buffered:true 的重播與同 URL 多次載入
// 靠 startTime 區分：前者鍵相同要擋掉，後者鍵不同必須各算一次。
const seenEntries = new Set();
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

// FIFO + TTL 汰除（list 依 at 遞增，直接從頭砍）。
const dropStale = (list, now) => {
  while (
    list.length &&
    (list.length > MAX_EVENTS || now - list[0].at > MATCH_TTL_MS)
  ) {
    list.shift();
  }
};

// 直接覆蓋，不做任何單調遞增：「符號會消失」正是規格要的行為（第二次看同一張圖
// 是從瀏覽器自己的快取讀出來的）。回傳有沒有真的變動，決定要不要通知訂閱者。
const setHrefStatus = (href, status) => {
  const cur = hrefStatus.get(href);
  if (status === "none") {
    if (cur === undefined) return false;
    hrefStatus.delete(href);
    return true;
  }
  if (cur === status) return false;
  hrefStatus.delete(href); // 重新插入 ⇒ 移到尾端，讓下面汰換的是最久沒更新的
  hrefStatus.set(href, status);
  while (hrefStatus.size > MAX_HREF_STATUS) {
    hrefStatus.delete(hrefStatus.keys().next().value);
  }
  return true;
};

// 同一筆計時項只能算一次。startTime 讀不到（測試假物件／不合規環境）時放行，
// 寧可重複計算也不要把「同 URL 的第二次載入」誤當重播丟掉。
const isDuplicateEntry = (entry) => {
  if (typeof entry.startTime !== "number") return false;
  const key = entry.name + "|" + entry.startTime;
  if (seenEntries.has(key)) return true;
  seenEntries.add(key);
  // 只用大小設界（不設 TTL）：多留一點只是多擋幾筆重播，比誤放行安全。
  while (seenEntries.size > MAX_EVENTS) {
    seenEntries.delete(seenEntries.values().next().value);
  }
  return false;
};

const ingest = (entry) => {
  // 只認圖片載入。imgur_probe.js 的 HEAD 探測也會打到代理（同一個 .jpg URL），
  // 那是 initiatorType "fetch"，拿它的計時去判圖片會張冠李戴。
  if (!entry || entry.initiatorType !== "img") return;
  const now = Date.now();
  if (isDuplicateEntry(entry)) return;
  const status = classifyProxyDelivery({ entry, proxyBase: proxyBase() });

  dropStale(pendingLoads, now);
  const i = pendingLoads.findIndex((p) => p.url === entry.name);
  if (i >= 0) {
    // **"none" 也要消費掉這筆載入事件**：留著它會被之後某筆不相干的計時項配走。
    const [load] = pendingLoads.splice(i, 1);
    if (setHrefStatus(load.href, status)) notify();
    return;
  }
  // 沒有對應的載入事件 ⇒ 計時項比 onload 早到，暫存等它來取。
  // "none" 不存：狀態預設就是 none，存了只是讓早到清單被本機快取重載灌爆。
  if (status === "none") return;
  earlyEntries.push({ url: entry.name, status, at: now });
  dropStale(earlyEntries, now);
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

// 預覽 <img> 載入成功時呼叫：href ＝ 原文那個連結，loadedUrl ＝ 實際成功的候選。
// **先歸零再等升級**（理由見本節開頭）；計時項可能早到也可能晚到，兩邊都要接。
export const reportProxyLoad = (href, loadedUrl) => {
  if (!href || !loadedUrl) return;
  ensureObserver();
  const now = Date.now();
  let changed = setHrefStatus(href, "none");

  dropStale(earlyEntries, now);
  const i = earlyEntries.findIndex((e) => e.url === loadedUrl);
  if (i >= 0) {
    const [early] = earlyEntries.splice(i, 1); // 一次性消費
    if (setHrefStatus(href, early.status)) changed = true;
  } else {
    dropStale(pendingLoads, now);
    pendingLoads.push({ href, url: loadedUrl, at: now });
  }
  if (changed) notify();
};

export const getProxyStatus = (href) => hrefStatus.get(href) || "none";

export const subscribeProxyStatus = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// 測試用：把模組狀態還原成初始值。
export const resetProxyStatusForTest = () => {
  hrefStatus.clear();
  pendingLoads.length = 0;
  earlyEntries.length = 0;
  seenEntries.clear();
  listeners.clear();
  if (observer) observer.disconnect();
  observer = null;
  observerFailed = false;
};

// 測試用：直接餵一筆假的 resource entry，不必真的跑 PerformanceObserver。
export const ingestEntryForTest = (entry) => ingest(entry);
