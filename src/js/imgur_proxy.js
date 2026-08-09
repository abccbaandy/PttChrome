// imgur 圖片走「專案方 Cloudflare Worker 快取代理」的 URL 改寫層。
//
// 為什麼：imgur 的 Fastly 把台灣流量導到美西 BUR POP，同一張圖 20 次取樣有 4～5 次
// stall 9～24 s。代理實測 max 15.7 s → 1.04 s、avg 3.18 → 0.97 s、stall 0/20，
// 但 **median 幾乎沒變**（0.963 → 0.994 s）——賣點是「不再卡住」，不是「更快」，
// 文案（設定 UI／README）不得宣稱加速。量測見 docs/imgur-latency-research.md，
// Worker 本體見 proxy/imgur-worker/。

export const DEFAULT_IMGUR_PROXY_BASE =
  "https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev";

// 白名單完全對齊 Worker 的 RE_ASSET（proxy/imgur-worker/src/index.js:23）：
//   ^\/([A-Za-z0-9]{1,12})\.(jpg|jpeg|png|gif|webp)$
// 對不上就回原址——**影片、未知副檔名、異常 id 全被這一條擋掉**，呼叫端不必各自判斷。
// 特別是影片：Cloudflare 服務條款排除影片檔，Worker 端白名單擋掉會回 **404**（不是
// fail-open 的 302），送過去等於自製一個載入失敗。
const RE_PROXYABLE_ID = /^[A-Za-z0-9]{1,12}$/;
const PROXYABLE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

const originUrl = (id, ext) => `https://i.imgur.com/${id}.${ext}`;

// 去尾端斜線刻意用字元掃描而非 `/\/+$/`：後者對「一長串斜線 + 尾端非斜線」是 O(n²)
// 回溯（CodeQL js/polynomial-redos，實測 60000 個斜線要 1.9 s），而這裡的輸入正是
// 使用者自己在設定頁填的位址。回歸守護 tests/unit/imgur_proxy.test.js。
const stripTrailingSlashes = (s) => {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
};

// 使用者填的位址容錯：允許裸 host（your-worker.workers.dev）與尾端斜線。
// 比照 util.js#proxySiteFromPrefs——UI 層零驗證，容錯全部下放到這個純函式。
export const normalizeImgurProxyBase = (raw) => {
  const s = stripTrailingSlashes((raw || "").trim());
  if (!s) return DEFAULT_IMGUR_PROXY_BASE;
  return /:\/\//.test(s) ? s : "https://" + s;
};

export const proxiedImgurUrl = (id, ext, config) => {
  const e = (ext || "").toLowerCase();
  const direct = originUrl(id, e);
  if (!config || !config.enabled) return direct;
  if (!RE_PROXYABLE_ID.test(id) || !PROXYABLE_EXT.has(e)) return direct;
  return `${normalizeImgurProxyBase(config.base)}/${id}.${e}`;
};

// 代理位置優先、原址墊底的候選清單（FallbackImage 會逐候選退回）。代理沒開／不可代理
// 時第一個候選就等於原址，故要去重，否則 FallbackImage 會對同一個死 URL 重試兩輪。
export const imgurCandidates = (id, exts, config) => {
  const out = [];
  const push = (u) => {
    if (out.indexOf(u) === -1) out.push(u);
  };
  push(proxiedImgurUrl(id, exts[0], config));
  for (const ext of exts) push(originUrl(id, (ext || "").toLowerCase()));
  return out;
};

// 模組級 config。**預設 enabled:false 是 fail-safe**：真值由 App.onPrefChange 在啟動時
// （main.jsx → onValuesPrefChange 逐 key）注入，任何沒接上 pref 的路徑（含 unit 測試）
// 一律維持現行直連行為，不會因為 DEFAULT_PREFS 改成 true 就在測試裡冒出代理位址。
let config = { enabled: false, base: DEFAULT_IMGUR_PROXY_BASE };

export const setImgurProxyConfig = (patch) => {
  config = { ...config, ...patch };
};

export const getImgurProxyConfig = () => config;

// 測試用：把模組狀態還原成初始值。
export const resetImgurProxyConfig = () => {
  config = { enabled: false, base: DEFAULT_IMGUR_PROXY_BASE };
};
