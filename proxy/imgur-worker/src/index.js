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

// ---------------------------------------------------------------------------
// `/tenor` 解析路由
//
// 為什麼要伺服端代解：tenor 的分享連結（tenor.com/<code>.gif）是 **HTML 頁**不是圖檔，
// 301 導到 /view/<slug>-<id>；而 tenor.com 的頁面**沒有 CORS header**、/view/ 又是
// x-frame-options: DENY ⇒ 瀏覽器端既 fetch 不到也 iframe 不了，前端無論如何解不開。
// 真正的媒體位址只寫在頁面 og tag 裡（media.tenor.com 的 mp4／media1 的 gif），
// 那兩個主機才帶 CORS 且不擋 referer。完整實測見 docs/media-preview-addons.md。
//
// 本路由**只回位址（JSON），不代理影片位元組**：Cloudflare 服務條款排除影片檔，
// 與上面 RE_ASSET 擋 mp4 是同一條界線，不可跨。
// ---------------------------------------------------------------------------

// 可回源抓取的 tenor 路徑。**這是安全邊界**：只有分享短連結與 view 頁兩種形式，
// 別的路徑（/search、/users/… 等）一律不放行，避免 Worker 變成任意站台的跳板。
const RE_TENOR_PATH = /^\/(?:view\/[\w-]+-\d+|[A-Za-z0-9]{1,16}\.gif)$/;
const TENOR_HOSTS = new Set(["tenor.com", "www.tenor.com"]);

// 只掃 head 該有的長度：og tag 一定在 <head>，而頁面本體可以很大（CPU 額度與
// 最壞情況的掃描成本都要有上界）。
const MAX_HTML_SCAN = 300000;

// 回傳正規化後的絕對 URL，或 null。
// **pathname 的大小寫絕不可動**：tenor 短碼大小寫敏感，tenor.com/bgOd4.gif 與
// tenor.com/bgod4.gif 是兩張不同的圖（16360306 / 16260362）。
export const parseTenorTarget = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!TENOR_HOSTS.has(u.hostname)) return null;
  if (!RE_TENOR_PATH.test(u.pathname)) return null;
  // query/hash 丟棄：對解析結果沒有影響，留著只會製造快取碎片。
  return `https://${u.hostname}${u.pathname}`;
};

// og 值只接受 tenor 自家媒體主機。頁面內容是上游控制的，不做這層過濾等於讓
// 上游（或任何能影響該頁的人）把任意第三方位址塞進我們回給前端的 JSON。
const isTenorMediaUrl = (v) => {
  if (!v) return false;
  try {
    const h = new URL(v).hostname;
    return h === "tenor.com" || h.endsWith(".tenor.com");
  } catch (e) {
    return false;
  }
};

// 逐個 <meta> tag 掃描、再從單一 tag 取屬性。
// **刻意不寫 `<meta[^>]+property="og:video"[^>]+content="([^"]+)"`**：雙 `[^>]+`
// 是多項式回溯（CodeQL js/polynomial-redos），而輸入是外部網頁。同理見
// src/js/imgur_proxy.js 的 stripTrailingSlashes 註解。
const attr = (tag, name) => {
  const m =
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag) ||
    new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return m ? m[1] : null;
};

export const parseTenorMedia = (html) => {
  if (!html || typeof html !== "string") return null;
  const head = html.slice(0, MAX_HTML_SCAN);
  const out = {};
  const videos = [];

  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const prop = (attr(tag, "property") || "").toLowerCase();
    const content = attr(tag, "content");
    if (!prop || !content) continue;
    switch (prop) {
      case "og:video":
      case "og:video:secure_url":
        videos.push(content);
        break;
      case "og:image":
        if (!out.gif && isTenorMediaUrl(content)) out.gif = content;
        break;
      case "og:image:width":
      case "og:video:width":
        if (!out.width) out.width = parseInt(content, 10) || undefined;
        break;
      case "og:image:height":
      case "og:video:height":
        if (!out.height) out.height = parseInt(content, 10) || undefined;
        break;
      default:
        break;
    }
  }

  // og:video 會出現兩次（mp4 與 webm），順序不保證 ⇒ 依副檔名分流而非取第一個。
  for (const v of videos) {
    if (!isTenorMediaUrl(v)) continue;
    if (!out.mp4 && /\.mp4(?:$|[?#])/i.test(v)) out.mp4 = v;
    else if (!out.webm && /\.webm(?:$|[?#])/i.test(v)) out.webm = v;
  }

  if (!out.mp4 && !out.gif) return null;

  const canonical = /<link\b[^>]*>/gi;
  let m;
  while ((m = canonical.exec(head)) !== null) {
    if ((attr(m[0], "rel") || "").toLowerCase() !== "canonical") continue;
    const id = /-(\d+)$/.exec(attr(m[0], "href") || "");
    if (id) out.id = id[1];
    break;
  }
  return out;
};

const jsonResponse = (body, { status, cacheable }) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 上游可能改編碼／換位址，故不用 immutable；但映射本身夠穩定，一天足夠。
      // 錯誤一律 no-store：把 4xx/5xx 快取起來等於自我封鎖（同 imgur 分支的理由）。
      "cache-control": cacheable ? "public, max-age=86400" : "no-store",
      "access-control-allow-origin": "*",
    },
  });

const handleTenor = async (request, url) => {
  const target = parseTenorTarget(url.searchParams.get("url"));
  if (!target) {
    return jsonResponse({ error: "bad url" }, { status: 400, cacheable: false });
  }

  let upstream;
  try {
    // 不帶 referer（同 imgur 分支）。tenor 短連結一定會 301 到 /view/，必須 follow。
    upstream = await fetch(target, {
      headers: { accept: "text/html,*/*" },
      redirect: "follow",
    });
  } catch (e) {
    return jsonResponse({ error: "upstream" }, { status: 502, cacheable: false });
  }
  if (!upstream.ok) {
    return jsonResponse({ error: "upstream" }, { status: 404, cacheable: false });
  }
  if ((upstream.headers.get("content-type") || "").indexOf("text/html") !== 0) {
    return jsonResponse({ error: "not html" }, { status: 404, cacheable: false });
  }

  const media = parseTenorMedia(await upstream.text());
  if (!media) {
    return jsonResponse({ error: "no media" }, { status: 404, cacheable: false });
  }
  return jsonResponse(media, { status: 200, cacheable: true });
};

// 上游資產以 hash 定址、內容永不變 ⇒ 可安心長 TTL。
// 但**錯誤回應絕不可快取**：imgur 對 Cloudflare 出口 IP 會限流（公用 proxy wsrv.nl
// 實測被回 429），把 429／5xx 快取一年等於自我封鎖。
export const passthroughHeaders = (upstream, { cacheable, nowMs }) => {
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
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  // 外部驗證快取是否生效用：兩次請求拿到**相同**時間戳 = 快取命中（命中時 Worker
  // 根本不執行，所以這個值不會更新）。沒有它就只能靠猜，見 README 的驗證段。
  h.set("x-imgur-proxy-fetched-at", new Date(now).toISOString());

  // ---- 前端「連結旁的代理狀態徽章」用（src/js/proxy_status.js）----
  // <img> 載入拿不到回應標頭，唯一不增加請求的資訊來源是 PerformanceResourceTiming，
  // 而它的跨網域欄位要有 TAO 才揭露。**沒有這一行，前端就分不出「代理服務的」與
  // 「fail-open 302 導回 i.imgur.com 的」**（後者的 TAO 檢查會失敗 ⇒ 欄位全歸零，
  // 正好成為「沒經過代理」的判準）。
  h.set("timing-allow-origin", "*");
  // 同 x-imgur-proxy-fetched-at 的原理（Workers Cache 命中時本 Worker 不執行 ⇒ 吐的是
  // 建立快取當下的舊時間戳），但走 Server-Timing 就能被 PerformanceResourceTiming
  // .serverTiming 讀到，**不必再對圖片發一次 fetch()**（也就不需要放進
  // access-control-expose-headers）。前端比對「時間戳距今多久」分辨 HIT／MISS。
  // desc 用 epoch 秒（純數字是合法的 token，不必加引號）。
  h.set("server-timing", `pttproxy;desc=${Math.floor(now / 1000)}`);
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

    if (url.pathname === "/tenor") {
      return handleTenor(request, url);
    }

    const m = RE_ASSET.exec(url.pathname);
    if (!m) {
      return new Response(
        "not found\nusage: /<imgur-id>.<jpg|jpeg|png|gif|webp>\n" +
          "       /tenor?url=<tenor 分享連結>\n",
        {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
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
