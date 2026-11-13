// 正式版 index.html 的 Content-Security-Policy（架構 review A4 步驟 b，docs/security.md）。
//
// 只在 `vite build` 注入（apply: 'build'）：Vite dev server 會在頁面塞行內 preamble（React refresh），
// dev 加 CSP 只會擋自己。CI 的 offline e2e 跑打包版（E2E_SERVER=bundle）⇒ 驗得到這份 policy。
// GitHub Pages 不能設 HTTP header ⇒ 只能用 <meta>（沒有 report-uri／frame-ancestors）。
//
// 主要收益在 script-src：程式只從本站載入，加上兩組 Google 的 script（雲端同步的 Google 登入
// gapi、App Check 的 reCAPTCHA Enterprise）。其餘刻意放寬，理由：
//   - connect-src：使用者能自填 proxy／relay 網址、圖片預覽打各家 oEmbed API、APK 連 127.0.0.1
//     的本機 proxy ⇒ 只能限協定。ws: 留給自架在 http 的人（https 頁面本來就被 mixed content 擋）。
//   - img-src／media-src：PTT 文章裡的圖可以是任何網站。
//   - frame-src：圖片預覽內嵌 YouTube 等 iframe、Firebase 登入的 auth handler iframe。
//   - style-src 'unsafe-inline'：Mantine 與 index.html 的 style 屬性。
// 行內 <script> 不用 'unsafe-inline'，改成建置時算 sha256 放行（加了新的行內 script 自動跟上）。
// 行內事件屬性（onclick= 之類）hash 救不了，守護 tests/unit/csp.test.js 直接禁止。
import { createHash } from 'node:crypto';

// 程式動態載入的外部 script（守護：tests/unit/csp.test.js 掃 Firebase SDK 的 script 網址）。
export const EXTERNAL_SCRIPT_SOURCES = [
  'https://apis.google.com', // Firebase Auth signInWithPopup 的 gapi（js/api.js 再載 /_/scs/…）
  'https://www.google.com/recaptcha/', // App Check：reCAPTCHA Enterprise enterprise.js
  'https://www.gstatic.com/recaptcha/', // enterprise.js 接著載的 releases/<ver>/recaptcha__*.js
];

export function cspDirectives(inlineScriptHashes = []) {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...inlineScriptHashes.map((h) => `'${h}'`), ...EXTERNAL_SCRIPT_SOURCES],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ['*', 'data:', 'blob:'],
    'media-src': ['*', 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https:', 'wss:', 'ws:'],
    'frame-src': ['https:'],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
}

export function serializeCsp(directives) {
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

// <script> 不帶 src 的內文（含空白，hash 要逐字對上瀏覽器看到的內容）。
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    out.push('sha256-' + createHash('sha256').update(m[1], 'utf8').digest('base64'));
  }
  return out;
}

// meta CSP 只管它**之後**的內容 ⇒ 放在 <head> 一開頭，排在任何 script／link 之前。
export function injectCspMeta(html) {
  const policy = serializeCsp(cspDirectives(inlineScriptHashes(html)));
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (!/<head>/i.test(html)) throw new Error('csp: index.html 找不到 <head>');
  return html.replace(/<head>/i, (h) => `${h}\n    ${meta}`);
}

export const cspMetaPlugin = () => ({
  name: 'pttchrome:csp-meta',
  apply: 'build',
  // order: 'post'：Vite 自己插進來的 <script>／<link> 都已就位，hash 才算得到全部行內 script。
  transformIndexHtml: { order: 'post', handler: injectCspMeta },
});
