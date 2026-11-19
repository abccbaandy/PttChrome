// `/og` 路由：一般網頁的分享資訊（og:title／og:site_name／og:image），給文章裡的網頁連結預覽卡（P110）。
//
// 為什麼要伺服端代抓：網頁（term.ptt.cc／GitHub Pages）不能讀別的網站的 HTML（沒有 CORS），
// 而分享資訊只寫在對方頁面的 <meta> 裡。APK 版由原生直接抓，不經這裡。
//
// **這是第一條「任意網址」的回源路由**（tenor 只收 tenor.com 兩種路徑）。安全邊界：
//   1. parseOgTarget：只收 http／https、預設埠、沒有帳密，host 不能是 IP／localhost／內網名稱；
//      轉址由 handleOg 自己跟（最多 MAX_REDIRECTS 次），每一跳重新過 parseOgTarget。
//   2. 只回四個欄位（標題、網站名、https 縮圖網址、最後的網址），長度都有上限，**不轉送頁面內容**
//      ⇒ 不能被當成內容代理。
//   3. 讀上游有總時限（FETCH_TIMEOUT_MS）與讀取上限（MAX_HTML_BYTES）；每個 IP 每分鐘上限由
//      wrangler.jsonc 的 ratelimit binding（OG_LIMITER）給，沒有 binding 時不限。
// 守護 test/og.test.js。

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 6000;
// og tag 一定在 <head>；頁面本體可以很大，只讀前面這麼多（CPU 與記憶體都要有上界）。
export const MAX_HTML_BYTES = 300000;
const MAX_URL_LENGTH = 2048;
export const MAX_TITLE = 200;
export const MAX_SITE = 60;

const OG_UA = "ptt-link-preview/1.0 (+https://github.com/abccbaandy/PttChrome)";

// 內網／保留用的名稱尾碼。Cloudflare Workers 本來就連不到私有位址，這層是多一道保險，
// 也避免把 Worker 拿去試探別人的內部名稱。
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

const isIpLiteral = (host) =>
  host.startsWith("[") || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^0x/i.test(host) || /^\d+$/.test(host);

// 回傳可以回源的網址（丟掉 hash），或 null。query 保留：很多新聞網站的文章 id 在 query 裡。
export const parseOgTarget = (raw) => {
  if (!raw || typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIpLiteral(host)) return null;
  if (host === "localhost" || !host.includes(".")) return null;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  u.hash = "";
  return u.href;
};

// 逐個 tag 掃再取屬性（不寫雙 `[^>]+` 的一條正規式：多項式回溯，CodeQL js/polynomial-redos；
// 輸入是外部網頁，同 index.js 的 tenor 解析）。
const attr = (tag, name) => {
  const m =
    new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag) ||
    new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, "i").exec(tag) ||
    new RegExp(`\\s${name}\\s*=\\s*([^\\s"'>]+)`, "i").exec(tag);
  return m ? m[1] : null;
};

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
      return String.fromCodePoint(code);
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? all : v;
  });

// 控制字元換成空白、連續空白收成一個、截到上限（以 code point 算，不切壞代理對）。
const clean = (s, max) => {
  if (!s) return "";
  // oxlint-disable-next-line no-control-regex -- 刻意比對控制字元
  const one = decodeEntities(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const cps = Array.from(one);
  return cps.length > max ? cps.slice(0, max - 1).join("") + "…" : one;
};

// 縮圖網址：相對路徑以頁面網址解析；只收 https（http 圖在 https 頁面是 mixed content）。
const cleanImage = (raw, baseUrl) => {
  if (!raw) return "";
  let u;
  try {
    u = new URL(decodeEntities(raw.trim()), baseUrl);
  } catch (e) {
    return "";
  }
  if (u.protocol !== "https:" || u.username || u.password) return "";
  return u.href.length > MAX_URL_LENGTH ? "" : u.href;
};

/**
 * 從 HTML 取分享資訊。og 優先，沒有就用 twitter:，標題最後退回 <title>。
 * 沒有標題 ⇒ null（這頁不放卡）。
 */
export const parseOgMeta = (html, baseUrl) => {
  if (!html || typeof html !== "string") return null;
  const head = html.slice(0, MAX_HTML_BYTES);
  const found = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    const content = attr(tag, "content");
    if (!key || content == null) continue;
    if (found[key] === undefined) found[key] = content;
  }
  let title = clean(found["og:title"] || found["twitter:title"] || "", MAX_TITLE);
  if (!title) {
    const m = /<title\b[^>]*>([^<]{1,2000})<\/title>/i.exec(head);
    title = m ? clean(m[1], MAX_TITLE) : "";
  }
  if (!title) return null;
  let host = "";
  try {
    host = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch (e) {
    host = "";
  }
  const site = clean(found["og:site_name"] || "", MAX_SITE) || host;
  const image = cleanImage(
    found["og:image:secure_url"] || found["og:image"] || found["og:image:url"] || found["twitter:image"] || found["twitter:image:src"] || "",
    baseUrl,
  );
  return { title, site, image, url: baseUrl };
};

// Content-Type／<meta charset> 的編碼；Workers 的 TextDecoder 不認得的一律退回 utf-8。
export const pickCharset = (contentType, headBytesAsLatin1) => {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1].toLowerCase();
  const fromMeta = /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(headBytesAsLatin1 || "");
  return fromMeta ? fromMeta[1].toLowerCase() : "utf-8";
};

const decodeHtml = (bytes, contentType) => {
  const latin1 = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = pickCharset(contentType, latin1);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (e) {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

// 讀到上限就停（cancel 剩下的串流），不把整頁讀進記憶體。
export const readLimited = async (response, limit) => {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= limit) reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
};

const OK_CACHE = "public, max-age=86400";
// 「這頁沒有分享資訊」不是錯誤，也快取（短一點：網站可能之後補上），避免同一篇文章每次重開都回源。
const NONE_CACHE = "public, max-age=21600";

const ogJson = (body, status, cacheControl) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
    },
  });

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ OG_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }} [env]
 * @param {typeof fetch} [fetchImpl] 測試注入
 */
export const handleOg = async (request, url, env, fetchImpl = fetch) => {
  let target = parseOgTarget(url.searchParams.get("url"));
  if (!target) return ogJson({ error: "bad url" }, 400, "no-store");

  if (env && env.OG_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") || "unknown";
    try {
      const { success } = await env.OG_LIMITER.limit({ key });
      if (!success) return ogJson({ error: "rate limited" }, 429, "no-store");
    } catch (e) {
      // 限流服務自己出錯 ⇒ 放行（最差等於沒有限流）。
    }
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let upstream;
  try {
    for (let hop = 0; ; hop++) {
      upstream = await fetchImpl(target, {
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "zh-TW,zh;q=0.9,en;q=0.5",
          "user-agent": OG_UA,
        },
        redirect: "manual",
        signal,
      });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const loc = upstream.headers.get("location");
      if (!loc || hop >= MAX_REDIRECTS) return ogJson({ error: "redirect" }, 404, "no-store");
      let next;
      try {
        next = new URL(loc, target).href;
      } catch (e) {
        next = null;
      }
      target = next && parseOgTarget(next);
      if (!target) return ogJson({ error: "bad redirect" }, 404, "no-store");
    }
  } catch (e) {
    return ogJson({ error: "upstream" }, 502, "no-store");
  }
  if (!upstream.ok) return ogJson({ error: "upstream" }, 404, "no-store");
  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("text/html") && !ct.startsWith("application/xhtml+xml")) {
    upstream.body && upstream.body.cancel().catch(() => {});
    return ogJson({ none: true }, 200, NONE_CACHE);
  }
  let bytes;
  try {
    bytes = await readLimited(upstream, MAX_HTML_BYTES);
  } catch (e) {
    return ogJson({ error: "upstream" }, 502, "no-store");
  }
  const meta = parseOgMeta(decodeHtml(bytes, ct), target);
  if (!meta) return ogJson({ none: true }, 200, NONE_CACHE);
  return ogJson(meta, 200, OK_CACHE);
};
