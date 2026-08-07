// i.imgur.com 快取代理（Cloudflare Worker）。
//
// 為什麼需要：imgur 的 CDN 是 Fastly，但它把台灣流量導到**美國西岸 BUR（Burbank）**
// POP（其他 Fastly 客戶如 pypi/fastly.com 都導到 NRT 東京）。跨太平洋鏈路在有負載時
// 大量丟包 → 同一張 391 KB 圖 20 次取樣中 5 次落在 10～23.6 s（其餘 0.99 s）。
// 換 webp 縮小檔案救不了這種 stall（stall 發生在 TLS handshake 與 body 傳輸中途）。
// 完整量測數據見 docs/imgur-latency-research.md。
//
// 本 Worker 在 Cloudflare TPE（台北，RTT 35 ms）落地，快取命中時圖片完全不出國。
//
// 快取機制用的是 **Workers Cache**（wrangler.jsonc 的 `cache.enabled`），不是舊的
// `caches.default` Cache API——後者在 *.workers.dev 上是 no-op（zone-level cache），
// 新機制在 workers.dev／自訂網域／service binding 都生效，且 free plan 可用。
// 快取命中時 Cloudflare **不會執行本 Worker**，所以不吃 CPU 額度。

// imgur id 是 5 或 7 碼 base62，尺寸變體會多一個字元後綴（如 `<id>l`、`<id>h`）。
// 放寬到 1～12 碼即可，重點是**只允許 base62**，杜絕路徑穿越與任意 host 轉發。
//
// **副檔名白名單刻意不含 mp4／webm**：
//   1. Cloudflare 服務條款允許 Workers 服務圖片／音訊等非 HTML 內容，但**排除影片檔**。
//   2. imgur 的 mp4 衍生本來就有嚴重長尾（見 ImagePreviewer.jsx 的 gif→mp4 決策）。
// 影片一律 fail-open 導回 i.imgur.com 原址，維持現行行為。
const RE_ASSET = /^\/([A-Za-z0-9]{1,12})\.(jpg|jpeg|png|gif|webp)$/;

const IMMUTABLE = "public, max-age=31536000, immutable";

// 上游資產以 hash 定址、內容永不變 ⇒ 可安心長 TTL。
// 但**錯誤回應絕不可快取**：imgur 對 Cloudflare 出口 IP 會限流（公用 proxy wsrv.nl
// 實測被回 429），把 429／5xx 快取一年等於自我封鎖。
const passthroughHeaders = (upstream, { cacheable }) => {
  const h = new Headers();
  const copy = ["content-type", "content-length", "etag", "last-modified", "accept-ranges"];
  for (const k of copy) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("cache-control", cacheable ? IMMUTABLE : "no-store");
  // 前端 imgur_probe.js 走 HEAD 讀 content-type 判資產型別，必須放行 CORS。
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  h.set("access-control-expose-headers", "content-type, content-length");
  h.set("x-imgur-proxy", "1");
  // 外部驗證快取是否生效用：兩次請求拿到**相同**時間戳 = 快取命中（命中時 Worker
  // 根本不執行，所以這個值不會更新）。沒有它就只能靠猜，見 README 的驗證段。
  h.set("x-imgur-proxy-fetched-at", new Date().toISOString());
  return h;
};

const redirectToOrigin = (id, ext) =>
  // fail-open：代理出任何狀況都退回直連 imgur，體感等於現況，不會比不裝代理更差。
  Response.redirect(`https://i.imgur.com/${id}.${ext}`, 302);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    const m = RE_ASSET.exec(url.pathname);
    if (!m) {
      return new Response("not found\nusage: /<imgur-id>.<jpg|jpeg|png|gif|webp>\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const [, id, ext] = m;

    let upstream;
    try {
      upstream = await fetch(`https://i.imgur.com/${id}.${ext}`, {
        method: request.method,
        // imgur 對 Referer: *.ptt.cc 直接 403（見 ImagePreviewer 的 needsReferer）。
        // Worker 回源時完全不帶 referer，順帶把前端那組 referer workaround 也解掉。
        headers: { accept: request.headers.get("accept") || "image/*,*/*" },
        redirect: "follow",
      });
    } catch (e) {
      return redirectToOrigin(id, ext);
    }

    // 上游掛掉／限流／資產不存在 → 一律導回原址，讓瀏覽器自己去要（含 imgur 的
    // removed.png 302 也會由瀏覽器原樣處理）。
    if (!upstream.ok) {
      return redirectToOrigin(id, ext);
    }

    // imgur 對非圖片路徑會回 HTML 錯誤頁；只放行真的是圖片的回應。
    const ct = (upstream.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("image/") !== 0) {
      return redirectToOrigin(id, ext);
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: 200,
      headers: passthroughHeaders(upstream, { cacheable: true }),
    });
  },
};

// 給單元測試用（路徑解析是唯一有分支的純邏輯）。
export { RE_ASSET };
