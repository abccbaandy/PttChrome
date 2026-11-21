// @ts-check
// 網頁連結預覽卡（P110）的純邏輯層：哪些連結要卡、Worker 網址、回應驗證、並行上限（無 DOM）。
//
// 一般網頁（新聞、部落格、雲端硬碟…）的分享資訊只寫在對方頁面的 <meta>，網頁讀不到別站 HTML
// （沒有 CORS）⇒ 由圖片代理 Worker 的 `/og` 代抓（proxy/imgur-worker/src/og.js，安全邊界在那邊）。
// 這裡是前端那一半：
//   - linkCardEligible：只對 http(s)、不是 PTT 自己、不是 IP／內網的連結要卡（Worker 也會擋，兩層都要在）。
//   - linkCardResolveUrl：開關＝圖片代理總開關（useImgurProxy）∧ 預覽卡開關（linkPreviewCard）。
//     同 tenor 的理由：使用者關掉代理代表不想把瀏覽紀錄送過去，卡片也跟著不抓。
//   - linkCardDescriptor：Worker 回的 JSON 一律當外部資料驗：標題必須是非空字串（截長）、
//     縮圖只收 https、點下去開的永遠是文章裡那條原始連結（不是 Worker 回的 url）。
//   - createLimiter：同時最多 N 個請求（一篇文章幾十個連結時不要一次全打出去）。
// 守護 tests/unit/link_card.test.js。

import { normalizeImgurProxyBase } from "./image_proxy.js";

export const LINK_CARD_MAX_TITLE = 200;
export const LINK_CARD_MAX_SITE = 60;
const MAX_URL_LENGTH = 2048;
export const LINK_CARD_CONCURRENCY = 2;

// PTT 自己的網址（文章連結點了在終端機裡開）不放卡。
const PTT_HOSTS = /(?:^|\.)ptt\.cc$/;
// 跟 Worker（proxy/imgur-worker/src/og.js 的 BLOCKED_SUFFIXES）同一份，兩邊都改。
const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

/** @param {string} href */
export function linkCardEligible(href) {
  if (!href || typeof href !== "string" || href.length > MAX_URL_LENGTH) return false;
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (PTT_HOSTS.test(host)) return false;
  return true;
}

/**
 * Worker `/og` 的網址；開關沒開或連結不合格回 null。
 * @param {string} href
 * @param {{ enabled?: boolean, base?: string } | null | undefined} proxyConfig 圖片代理設定（image_proxy.getImageProxyConfig）
 * @param {boolean} cardEnabled pref linkPreviewCard
 */
export function linkCardResolveUrl(href, proxyConfig, cardEnabled) {
  if (!cardEnabled || !proxyConfig || !proxyConfig.enabled) return null;
  if (!linkCardEligible(href)) return null;
  return `${normalizeImgurProxyBase(proxyConfig.base)}/og?url=${encodeURIComponent(href)}`;
}

/**
 * 這條連結的卡片從哪裡抓：APK 認得 'fetchOg' 且是 https ⇒ 原生直接抓（網址不經我們的 Worker，
 * 所以不看圖片代理開關）；否則照舊走 Worker（要代理總開關）；都不行 ⇒ null（不放卡）。
 * http 連結在 APK 也走 Worker：App 不准明文連線（network_security_config）。
 * @param {string} href
 * @param {{ enabled?: boolean, base?: string } | null | undefined} proxyConfig
 * @param {boolean} cardEnabled pref linkPreviewCard
 * @param {boolean} nativeOk android_bridge.androidCanFetchOg()
 * @returns {{ kind: "native" } | { kind: "worker", url: string } | null}
 */
export function linkCardSource(href, proxyConfig, cardEnabled, nativeOk) {
  if (!cardEnabled || !linkCardEligible(href)) return null;
  if (nativeOk && /^https:/i.test(href)) return { kind: "native" };
  const url = linkCardResolveUrl(href, proxyConfig, cardEnabled);
  return url ? { kind: "worker", url } : null;
}

/** @param {unknown} s @param {number} max */
function cleanText(s, max) {
  if (typeof s !== "string") return "";
  // oxlint-disable-next-line no-control-regex -- 刻意比對控制字元
  const one = s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // bidi 控制字元（LRM／RLM、嵌入／覆寫、隔離）：外部標題可以拿它把顯示順序反過來。
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(one);
  return cps.length > max ? cps.slice(0, max - 1).join("") + "…" : one;
}

/** @param {unknown} s */
function httpsUrl(s) {
  if (typeof s !== "string" || !s || s.length > MAX_URL_LENGTH) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch (e) {
    return "";
  }
}

/**
 * Worker 回應 → 卡片描述；沒有標題（含 `{none:true}`、錯誤物件）回 null（不放卡）。
 * @param {any} json
 * @param {string} href 文章裡的原始連結（點卡片開的就是它）
 * @returns {{ type: "card", href: string, title: string, site: string, image: string } | null}
 */
export function linkCardDescriptor(json, href) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  // 點卡片開的是 href ⇒ 呼叫端傳錯（javascript: 之類）也不能出卡。
  if (!linkCardEligible(href)) return null;
  const title = cleanText(json.title, LINK_CARD_MAX_TITLE);
  if (!title) return null;
  let site = cleanText(json.site, LINK_CARD_MAX_SITE);
  if (!site) {
    try {
      site = new URL(href).hostname.replace(/^www\./, "");
    } catch (e) {
      site = "";
    }
  }
  return { type: "card", href, title, site, image: httpsUrl(json.image) };
}

// ---- 開關（pref linkPreviewCard，預設開；pttchrome.jsx 的 pref 套用處設定）----
let cardEnabled = true;
/** @param {boolean} on */
export function setLinkPreviewCard(on) {
  cardEnabled = !!on;
}
export function linkPreviewCardOn() {
  return cardEnabled;
}

// ---- 還有沒有人要這張卡（排隊中的請求作廢用）----
// 佔位盒掛載（捲到附近）時 +1、卸載／拆掉時 -1（render/inline_preview_slot.js）。請求排到開始時
// 已經沒人要（捲過去了、整列被拆掉）⇒ 不打 Worker，以 STALE 失敗收掉；requestPreview 看到 STALE
// 會把快取那一格拿掉，下次捲回來重新排隊。不然一篇幾十個連結快速捲過，排隊的請求會一個個照打。
/** @type {Map<string, number>} */
const wanted = new Map();
/** @param {string} href @param {number} delta */
export function markLinkCardWanted(href, delta) {
  const n = (wanted.get(href) || 0) + delta;
  if (n > 0) wanted.set(href, n);
  else wanted.delete(href);
}
/** @param {string} href */
export function linkCardWanted(href) {
  return (wanted.get(href) || 0) > 0;
}
export const LINK_CARD_STALE = "link-card: stale";
/** @param {unknown} e */
export function isLinkCardStale(e) {
  return !!(e && typeof e === "object" && /** @type {any} */ (e).message === LINK_CARD_STALE);
}

/**
 * 同時最多 n 個在跑；其餘排隊，照呼叫順序開始。
 * @param {number} n
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(n) {
  // 0、負數、NaN 當成 1（0 會永遠不開始，NaN 會完全不限流）。
  const cap = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  let running = 0;
  /** @type {Array<() => void>} */
  const queue = [];
  const next = () => {
    if (running >= cap || !queue.length) return;
    running++;
    const start = /** @type {() => void} */ (queue.shift());
    start();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        let p;
        try {
          p = Promise.resolve(task());
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(resolve, reject).finally(() => {
          running--;
          next();
        });
      });
      next();
    });
}
