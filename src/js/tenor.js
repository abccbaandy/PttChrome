// tenor 分享連結 → 媒體位址的解析層（純模組：無 DOM、無網路）。
//
// 為什麼非得繞 Worker：tenor.com/<code>.gif 是 HTML 頁不是圖檔，301 導到
// /view/<slug>-<id>，而
//   1. tenor.com 的頁面**沒有 CORS header** → 前端 fetch 讀不到 HTML；
//   2. /view/ 頁是 x-frame-options: DENY → 也不能用 iframe 迂迴；
//   3. Tenor API v1 已下線，v2 要 Google API key。
// ⇒ 瀏覽器端無論如何解不開，只能由專案方的 Cloudflare Worker 抓頁面、解 og tag
// 後回 JSON（proxy/imgur-worker/src/index.js 的 /tenor 路由）。實測數據見
// docs/media-preview-addons.md 的 tenor 段。
//
// 開關沿用 imgur 快取代理（useImgurProxy，預設開）：同一個 Worker、同一個營運者，
// 使用者關掉代表不想把瀏覽紀錄送過去 ⇒ tenor 一併停用（連結維持原樣、不預覽，
// 仍優於現況的「破圖」）。
import { normalizeImgurProxyBase } from "./imgur_proxy.js";
import { RE_TENOR } from "./image_url_detect.js";

export const tenorResolveUrl = (pageUrl, config) => {
  if (!config || !config.enabled) return null;
  // 二次確認來源網域：呼叫端已用 RE_TENOR 過濾，這裡是不讓任何路徑把非 tenor 的
  // URL 送進 Worker 的 ?url=（Worker 端也有白名單，兩層都要在）。
  if (!pageUrl || !RE_TENOR.test(pageUrl)) return null;
  // **不得對 pageUrl 做大小寫正規化**：tenor 短碼大小寫敏感，bgOd4.gif 與
  // bgod4.gif 是兩張不同的圖。
  return `${normalizeImgurProxyBase(config.base)}/tenor?url=${encodeURIComponent(
    pageUrl,
  )}`;
};

// Worker 回的 JSON → ImagePreviewer 的 media descriptor。
// mp4 優先：tenor 原生就是 mp4（頁面 og:video），實測同一則 960 KB vs gif 4.17 MB，
// 且 media.tenor.com 帶 Access-Control-Allow-Origin: * 又不擋 referer。
// `gif: true` 讓 InlineVideo 改用 GIF 語意播放（自動循環靜音、無控制列）。
export const tenorMediaDescriptor = (json) => {
  if (!json) return null;
  if (json.mp4) return { type: "video", src: json.mp4, gif: true };
  if (json.gif) return { type: "image", src: json.gif };
  return null;
};
