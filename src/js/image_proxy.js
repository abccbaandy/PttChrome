// 圖片走「專案方 Cloudflare Worker 快取代理」的 URL 改寫層（imgur／twimg／catbox，
// 外加 tenor 分享連結解析共用同一個 Worker）。Worker 本體見 proxy/imgur-worker/，
// 量測見 docs/imgur-latency-research.md。
//
// 為什麼（各站瓶頸不同，文案不可一概而論）：
//   - imgur：Fastly 把台灣導到美西 BUR，20 次取樣有 4～5 次 stall 9～24 s。代理後
//     stall 0/20，但 **median 幾乎沒變**——賣點是「不再卡住」，不是「更快」。
//   - twimg：對台灣的 body 吞吐只有 24–70 KB/s，`:orig`（2.38 MB）直連 24–40 s；
//     經代理（prod，快取命中）穩定 1.4 s。
//   - catbox：單一 nginx origin、無 CDN；經代理 0.61 s vs 直連 0.86 s，HIT 後不再
//     依賴那台 origin。

export const DEFAULT_IMGUR_PROXY_BASE =
  "https://ptt-imgur-cache.ptt-relay-8xquy.workers.dev";

// 可逐站開關的站台清單（單一來源：設定頁、設定搜尋、App.onPrefChange 都從這裡生）。
// 總開關是 pref `useImgurProxy`（key 名沿用 imgur 單站時代：本 repo 沒有 pref 遷移
// 機制，沿用舊 key 才能讓「以前為了隱私關掉代理的人」連新站台也維持關閉）。
export const IMAGE_PROXY_SITES = [
  { id: "imgur", prefKey: "imageProxyImgur", labelKey: "options_imageProxySite_imgur" },
  { id: "twimg", prefKey: "imageProxyTwimg", labelKey: "options_imageProxySite_twimg" },
  { id: "catbox", prefKey: "imageProxyCatbox", labelKey: "options_imageProxySite_catbox" },
  { id: "tenor", prefKey: "imageProxyTenor", labelKey: "options_imageProxySite_tenor" },
];

// 總開關開 ∧ 該站沒被關。`sites` 缺項視為開（各站 pref 預設 true）。
export const siteProxyEnabled = (config, id) =>
  !!(config && config.enabled) && !(config.sites && config.sites[id] === false);

// 去尾端斜線刻意用字元掃描而非 `/\/+$/`：後者對「一長串斜線 + 尾端非斜線」是 O(n²)
// 回溯（CodeQL js/polynomial-redos，實測 60000 個斜線要 1.9 s），而這裡的輸入正是
// 使用者自己在設定頁填的位址。回歸守護 tests/unit/image_proxy.test.js。
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

// 候選清單去重：代理沒開／不可代理時第一個候選就等於原址，不去重的話
// FallbackImage 會對同一個死 URL 重試兩輪。
const uniq = (list) => {
  const out = [];
  for (const u of list) if (out.indexOf(u) === -1) out.push(u);
  return out;
};

// ---- imgur ---------------------------------------------------------------
// 白名單完全對齊 Worker 的 RE_ASSET（proxy/imgur-worker/src/index.js）：
//   ^\/([A-Za-z0-9]{1,12})\.(jpg|jpeg|png|gif|webp)$
// 對不上就回原址——**影片、未知副檔名、異常 id 全被這一條擋掉**，呼叫端不必各自判斷。
// 特別是影片：Cloudflare 服務條款排除影片檔，Worker 端白名單擋掉會回 **404**（不是
// fail-open 的 302），送過去等於自製一個載入失敗。
const RE_IMGUR_ID = /^[A-Za-z0-9]{1,12}$/;
const IMGUR_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

const imgurOrigin = (id, ext) => `https://i.imgur.com/${id}.${ext}`;

export const proxiedImgurUrl = (id, ext, config) => {
  const e = (ext || "").toLowerCase();
  const direct = imgurOrigin(id, e);
  if (!siteProxyEnabled(config, "imgur")) return direct;
  if (!RE_IMGUR_ID.test(id) || !IMGUR_EXT.has(e)) return direct;
  return `${normalizeImgurProxyBase(config.base)}/${id}.${e}`;
};

// 代理位置優先、原址墊底的候選清單（FallbackImage 會逐候選退回）。
export const imgurCandidates = (id, exts, config) =>
  uniq([
    proxiedImgurUrl(id, exts[0], config),
    ...exts.map((ext) => imgurOrigin(id, (ext || "").toLowerCase())),
  ]);

// ---- twimg ---------------------------------------------------------------
// 對齊 Worker 的 RE_TWIMG_ASSET：/twimg/<size>/<id>.<jpg|png|webp>。
// 代理只取 `orig`（app 本來的第一候選），其餘直連候選原樣墊在後面。
const RE_TWIMG_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TWIMG_EXT = new Set(["jpg", "png", "webp"]);

// 現行直連候選（:orig → .png:orig → :large → 無尺寸），順序即整合前的 srcset。
export const twimgDirectCandidates = (id, ext) => {
  const base = `https://pbs.twimg.com/media/${id}`;
  return [`${base}.${ext}:orig`, `${base}.png:orig`, `${base}.${ext}:large`, `${base}.${ext}`];
};

export const twimgCandidates = (id, ext, config) => {
  const e = (ext || "").toLowerCase();
  const direct = twimgDirectCandidates(id, e);
  if (!siteProxyEnabled(config, "twimg") || !RE_TWIMG_ID.test(id) || !TWIMG_EXT.has(e)) {
    return direct;
  }
  return uniq([`${normalizeImgurProxyBase(config.base)}/twimg/orig/${id}.${e}`, ...direct]);
};

// ---- catbox --------------------------------------------------------------
// 對齊 Worker 的 RE_CATBOX_ASSET：/catbox/<name>.<jpg|jpeg|png|gif|webp>（影片不收）。
const RE_CATBOX_NAME = /^[A-Za-z0-9]{1,16}$/;
const CATBOX_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

// 副檔名**不做大小寫正規化**：catbox 是檔案伺服器，`.PNG` 與 `.png` 不保證是同一個
// 檔；Worker 白名單只收小寫（避免快取碎片），大寫的就原樣直連。
export const catboxCandidates = (name, ext, config) => {
  const direct = `https://files.catbox.moe/${name}.${ext}`;
  if (!siteProxyEnabled(config, "catbox") || !RE_CATBOX_NAME.test(name) || !CATBOX_EXT.has(ext)) {
    return [direct];
  }
  return [`${normalizeImgurProxyBase(config.base)}/catbox/${name}.${ext}`, direct];
};

// ---- 模組級 config ---------------------------------------------------------
// **預設 enabled:false 是 fail-safe**：真值由 App.onPrefChange 在啟動時（main.jsx →
// onValuesPrefChange 逐 key）注入，任何沒接上 pref 的路徑（含 unit 測試）一律維持
// 直連行為，不會因為 DEFAULT_PREFS 是 true 就在測試裡冒出代理位址。
const initialConfig = () => ({ enabled: false, base: DEFAULT_IMGUR_PROXY_BASE, sites: {} });
let config = initialConfig();

// 部分更新；`sites` 逐站合併（各站 pref 各自進來，不可互相蓋掉）。
export const setImageProxyConfig = (patch) => {
  config = {
    ...config,
    ...patch,
    sites: { ...config.sites, ...(patch && patch.sites) },
  };
};

export const getImageProxyConfig = () => config;

// 測試用：把模組狀態還原成初始值。
export const resetImageProxyConfig = () => {
  config = initialConfig();
};
