// @ts-check
// P107 離線文章連圖片一起存（只做 APK）第一步：從一篇存檔的連結裡挑出「要抓回來存」的圖。純函式。
// 整體切法見 docs/saved-articles.md「還沒做 1.」；抓圖由 APK 原生端做（不受 CORS 限制），這裡只決定抓哪些。
//
// 只挑「網址本身就看得出是靜態圖」的：
//   - 路徑以靜態圖副檔名結尾（jpg／jpeg／png／webp／bmp／avif／jfif）；GIF 不存（動圖動輒十幾 MB，縮了就不會動）。
//   - pbs.twimg.com/media 帶 `format=jpg|png|webp`（推特圖常見寫法，路徑沒副檔名）。
//   - imgur 單張（imgur.com／i.imgur.com／m.imgur.com）**明寫**靜態圖副檔名的，改寫成 i.imgur.com 直連；
//     沒寫副檔名的要先探測是不是影片（ImagePreviewer 的 imgur resolver 會多發請求），這裡不挑 ⇒ 照舊只存連結。
//   - 相簿、tenor、影片、YouTube 這類都不挑。
// 網址一律要 https：APK 的 network_security_config 不准明文。已知圖床（i.imgur、pbs.twimg）的 http 改寫成 https，
// 其他 http 圖不挑（照舊只存連結）。
// 唯讀頁的行內預覽以文章裡的原連結（href）為鍵，所以 pickSavedImages 同時給「href → 要抓的網址」。

import { RE_IMGUR_ALBUM, RE_IMGUR_SINGLE, RE_TWIMG } from './image_url_detect';

/** 一篇最多抓幾張（長文 179 張圖的那種只存前面這些，其餘照舊只存連結）。 */
export const SAVED_IMAGE_LIMIT = 50;

const STATIC_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'jfif']);
const HTTPS_UPGRADE_HOSTS = new Set(['i.imgur.com', 'pbs.twimg.com']);

/** @param {string} pathname */
function pathExt(pathname) {
  const m = /\.([a-z0-9]+)$/i.exec(pathname);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 一個連結要抓的網址；不挑回 null。
 * @param {string} href
 * @returns {string | null}
 */
export function savedImageUrl(href) {
  if (typeof href !== 'string' || !href) return null;
  /** @type {URL} */
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();

  // imgur：相簿不挑；單張要明寫靜態圖副檔名，改寫成 i.imgur.com 直連。
  if (/(^|\.)imgur\.com$/.test(host)) {
    if (RE_IMGUR_ALBUM.test(href)) return null;
    const m = RE_IMGUR_SINGLE.exec(href);
    if (!m || !m[2] || !STATIC_EXT.has(m[2].toLowerCase())) return null;
    if (pathExt(u.pathname) !== m[2].toLowerCase()) return null;
    return `https://i.imgur.com/${m[1]}.${m[2].toLowerCase()}`;
  }

  if (u.protocol === 'http:') {
    if (!HTTPS_UPGRADE_HOSTS.has(host)) return null;
    u.protocol = 'https:';
  }

  // 推特圖：路徑沒副檔名，格式寫在 query。
  if (host === 'pbs.twimg.com') {
    const m = RE_TWIMG.exec(u.href);
    if (!m) return null;
    const ext = (m[2] || m[3] || '').toLowerCase();
    return STATIC_EXT.has(ext) ? u.href : null;
  }

  return STATIC_EXT.has(pathExt(u.pathname)) ? u.href : null;
}

/**
 * 從一篇的連結（照出現順序，可重複）挑出要抓的圖。
 *   - urls：要抓的網址，去重、最多 limit 張（照第一次出現的順序）。
 *   - byHref：每個挑中的原連結 → 它的 url（兩個寫法不同的連結指到同一張圖時共用一個 url；
 *     超過 limit 之後才出現的新圖不在裡面）。
 * @param {ReadonlyArray<string>} hrefs
 * @param {number} [limit]
 * @returns {{ urls: string[], byHref: Map<string, string> }}
 */
export function pickSavedImages(hrefs, limit = SAVED_IMAGE_LIMIT) {
  /** @type {string[]} */
  const urls = [];
  /** @type {Map<string, string>} */
  const byHref = new Map();
  for (const href of hrefs || []) {
    if (byHref.has(href)) continue;
    const url = savedImageUrl(href);
    if (!url) continue;
    if (!urls.includes(url)) {
      if (urls.length >= limit) continue;
      urls.push(url);
    }
    byHref.set(href, url);
  }
  return { urls, byHref };
}
