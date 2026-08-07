// imgur 資產型別探測（無副檔名／gif 副檔名的連結專用）。
//
// 為什麼需要：imgur **忽略 URL 副檔名**，一律回「儲存的原始格式」——但這句話只在
// 原始檔是**圖片**時成立。現代 imgur 把上傳的動畫／影片存成 video/mp4，這類資產的
// 任何圖片副檔名都只回**單幀靜態縮圖**，而且 <img> 會 onload 成功 → FallbackImage
// 不會退回，動圖直接被靜音成一張圖（回報案例 https://imgur.com/lP0NHpE）。
//
// 實測（curl -I，數據見 docs/media-preview-addons.md）：
//   lP0NHpE.jpg / .gif → 200 image/jpeg 33469（靜態單幀）   .mp4 → 200 video/mp4 82794
//   auVUJzV.jpg（gif 原檔） → 200 image/gif 10850053（完整動畫）
//   456CKaj.mp4（靜態原檔） → 400 "Not an animated gif"
// ⇒ 「.mp4 是否 200」是可靠的動畫判準，「圖片回應的 content-type 是否 image/gif」
//   則能把 gif 原檔與影片原檔分開（gif 原檔直接載原圖即可，不必吃 imgur mp4 衍生
//   的長尾，見 docs 的 gif→mp4 決策）。
//
// i.imgur.com 回應帶 `Access-Control-Allow-Origin: *`，且 HEAD 屬 CORS simple
// method（不觸發 preflight）、content-type 屬 CORS-safelisted response header，
// 所以瀏覽器端讀得到。走 HEAD 而非 imgur API：不吃 API 額度、不需 client_id。

export const IMGUR_PROBE_TIMEOUT_MS = 3000;

// 純決策表（unit 直接測）：
//   image/gif        → "gif"     原檔就是 gif，載原圖即會動；**不得**改要 webp
//                                （imgur 的 webp 衍生對 gif 只回靜態單幀）
//   其他 image/*  + mp4 200 → "video"   影片型動圖，只有 .mp4 會動
//   其他 image/*  + mp4 400 → "static"  真靜態圖，可安心吃 webp 優化
//   非圖片／探測失敗 → "unknown" 維持現行 .jpg（保守，不比舊行為差）
export const classifyImgurAsset = ({ imageContentType, mp4Ok }) => {
  const ct = typeof imageContentType === "string" ? imageContentType.toLowerCase() : "";
  if (ct.indexOf("image/gif") === 0) return "gif";
  if (ct.indexOf("image/") !== 0) return "unknown";
  return mp4Ok ? "video" : "static";
};

const contentTypeOf = (res) => {
  try {
    return res && res.headers && res.headers.get ? res.headers.get("content-type") : null;
  } catch (e) {
    return null;
  }
};

// id → Promise<kind>。同一篇文章同一個 id 可能出現多次（內文連結＋推文），只探一輪。
const probeCache = new Map();

export const clearImgurProbeCache = () => probeCache.clear();

const runProbe = (id, opts) => {
  const fetchImpl =
    opts.fetchImpl ||
    (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) return Promise.resolve("unknown");

  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(
    () => ctrl && ctrl.abort(),
    opts.timeoutMs || IMGUR_PROBE_TIMEOUT_MS,
  );
  // 探測失敗一律吞掉回 null → 降級 "unknown"，絕不可讓預覽卡住或炸出 rejection。
  const head = (url) =>
    Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          method: "HEAD",
          mode: "cors",
          // imgur 對 Referer: *.ptt.cc 直接 403（見 ImagePreviewer 的 needsReferer）。
          referrerPolicy: "no-referrer",
          signal: ctrl ? ctrl.signal : undefined,
        }),
      )
      .catch(() => null);

  const base = `https://i.imgur.com/${id}`;
  // 兩發並行 → 延遲只有一個 RTT。
  return Promise.all([head(`${base}.jpg`), head(`${base}.mp4`)]).then(
    ([imgRes, mp4Res]) => {
      clearTimeout(timer);
      if (!imgRes) return "unknown";
      return classifyImgurAsset({
        imageContentType: contentTypeOf(imgRes),
        mp4Ok: !!(mp4Res && mp4Res.ok),
      });
    },
  );
};

export const probeImgurAsset = (id, opts = {}) => {
  let p = probeCache.get(id);
  if (p === undefined) {
    p = runProbe(id, opts).catch(() => "unknown");
    probeCache.set(id, p);
  }
  return p;
};
