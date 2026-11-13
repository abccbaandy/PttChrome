// 守護正式版 <meta> CSP（scripts/csp.mjs、docs/security.md）：
//   1. 行內 <script> 由建置時算 hash 放行，meta 排在任何 script／link 之前（meta 只管之後的內容）。
//   2. index.html 不准有行內事件屬性（onclick= 之類）或 javascript: 網址：hash 救不了，上線就被擋。
//   3. Firebase SDK 會動態載入的 script 網址都在 script-src 裡（SDK 換網域時這裡先紅，
//      不然要等使用者登入雲端同步才發現登不進去）。
//   4. 程式真的會連的地方 connect-src／frame-src／img-src 都放行（PTT、APK 本機 proxy、上傳、oEmbed、內嵌）。
//   5. vite.config.mjs 真的掛了這個 plugin，且只在 build。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  cspDirectives,
  cspMetaPlugin,
  injectCspMeta,
  inlineScriptHashes,
  serializeCsp,
} from '../../scripts/csp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SELF = 'https://abccbaandy.github.io';

// 夠用的 CSP source 比對（CSP3 §6.7.2 的子集）：'self'、*、scheme-source、host-source（含路徑前綴）。
function allows(sources, url, self = SELF) {
  const u = new URL(url);
  const selfUrl = new URL(self);
  return sources.some((src) => {
    if (src === "'self'") {
      const sameHost = u.host === selfUrl.host;
      // CSP3：'self' 也涵蓋同 host 的 wss:（https 頁面）
      return sameHost && (u.protocol === selfUrl.protocol || (selfUrl.protocol === 'https:' && u.protocol === 'wss:'));
    }
    if (src === '*') return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol);
    if (/^[a-z][a-z0-9+.-]*:$/.test(src)) return u.protocol === src;
    if (src.startsWith("'")) return false;
    const s = new URL(src);
    if (s.protocol !== u.protocol || s.host !== u.host) return false;
    if (s.pathname === '/' && !src.endsWith('/')) return true; // 只寫到 host
    return s.pathname.endsWith('/') ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
  });
}

describe('CSP meta 注入', () => {
  const html = read('index.html');

  test('index.html 的行內 script 都被 hash 放行（逐字算）', () => {
    const bodies = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    expect(bodies.length).toBeGreaterThan(0);
    const expected = bodies.map((b) => 'sha256-' + createHash('sha256').update(b, 'utf8').digest('base64'));
    expect(inlineScriptHashes(html)).toEqual(expected);
    const out = injectCspMeta(html);
    for (const h of expected) expect(out).toContain(`'${h}'`);
  });

  test('有 src 的 script 不算行內、不產 hash', () => {
    expect(inlineScriptHashes('<script type="module" crossorigin src="./a.js"></script>')).toEqual([]);
  });

  test('meta 排在 <head> 裡任何 script／link／style 之前', () => {
    const out = injectCspMeta(html);
    const meta = out.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(out.indexOf('<head>'));
    for (const tag of ['<script', '<link', '<style']) {
      const at = out.indexOf(tag);
      if (at >= 0) expect(meta).toBeLessThan(at);
    }
  });

  test('policy 寫在 content 屬性裡不會被雙引號截斷', () => {
    const policy = serializeCsp(cspDirectives(['sha256-abc']));
    expect(policy).not.toContain('"');
    expect(policy).toContain("script-src 'self' 'sha256-abc'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(policy).toContain("object-src 'none'");
  });

  test('index.html 沒有行內事件屬性或 javascript: 網址（hash 放行不了）', () => {
    const tags = html.replace(/<!--[\s\S]*?-->/g, '').match(/<[a-z][^>]*>/gi) || [];
    const bad = tags.filter((t) => /\son[a-z]+\s*=/i.test(t) || /javascript:/i.test(t));
    expect(bad).toEqual([]);
  });

  test('vite.config.mjs 掛了 cspMetaPlugin，且只在 build 生效', () => {
    expect(read('vite.config.mjs')).toMatch(/plugins:\s*\[[^\]]*cspMetaPlugin\(\)/);
    const plugin = cspMetaPlugin();
    expect(plugin.apply).toBe('build');
    expect(plugin.transformIndexHtml.order).toBe('post');
  });
});

describe('CSP 涵蓋程式會用到的來源', () => {
  const d = cspDirectives();

  test('Firebase SDK 動態載入的 script 都在 script-src', () => {
    const files = [
      ...fs
        .readdirSync(path.join(ROOT, 'node_modules/@firebase/auth/dist/esm'), { recursive: true })
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join('node_modules/@firebase/auth/dist/esm', f)),
      'node_modules/@firebase/app-check/dist/esm/index.esm.js',
    ];
    const urls = new Set();
    for (const f of files) for (const m of read(f).matchAll(/https:\/\/[a-zA-Z0-9./_-]+\.js\b/g)) urls.add(m[0]);
    expect([...urls]).toEqual(expect.arrayContaining(['https://apis.google.com/js/api.js']));
    expect([...urls].filter((u) => !allows(d['script-src'], u))).toEqual([]);
    // enterprise.js 接著載的 release 檔
    expect(allows(d['script-src'], 'https://www.gstatic.com/recaptcha/releases/abc/recaptcha__zh_tw.js')).toBe(true);
    expect(allows(d['script-src'], 'https://evil.example/x.js')).toBe(false);
    expect(allows(d['script-src'], 'https://www.google.com/x.js')).toBe(false);
  });

  test('連線：PTT、APK 本機 proxy、自填 relay、上傳、oEmbed、Firebase', () => {
    for (const url of [
      'wss://ws.ptt.cc/bbs',
      'ws://127.0.0.1:43210/bbs/token',
      'wss://ptt-relay.example.workers.dev/ssh',
      'https://api-v1-t2-upload.urusai.cc/v1/upload',
      'https://api.imgur.com/oembed.json',
      'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen',
      `${SELF}/PttChrome/assets/b2u_table.bin`,
    ]) {
      expect(allows(d['connect-src'], url), url).toBe(true);
    }
  });

  test('圖片／影片任何網站都放行；內嵌 iframe 只要 https', () => {
    expect(allows(d['img-src'], 'http://i.meee.com.tw/a.jpg')).toBe(true);
    expect(d['img-src']).toEqual(expect.arrayContaining(['data:', 'blob:']));
    expect(allows(d['media-src'], 'https://i.imgur.com/a.mp4')).toBe(true);
    expect(allows(d['frame-src'], 'https://www.youtube.com/embed/x')).toBe(true);
    expect(allows(d['frame-src'], 'https://pttchrome.firebaseapp.com/__/auth/iframe')).toBe(true);
  });
});
