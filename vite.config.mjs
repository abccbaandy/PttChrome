import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// Build identity, surfaced in the About tab and the startup console line so a
// running page can be matched to a commit (stale-deploy debugging).
let GIT_COMMIT = 'unknown';
try {
  GIT_COMMIT = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {}
// Display in UTC+8 (台灣時間) — the user base is in Taiwan, so a +8 timestamp is
// what people expect to see in the About tab / startup console.
const BUILD_TIME = new Date(Date.now() + 8 * 3600 * 1000)
  .toISOString()
  .replace('T', ' ')
  .replace(/\..+$/, '') + ' (UTC+8)';

// index.html 的 %PTTCHROME_PAGE_TITLE% 佔位替換（取代舊 html-webpack-plugin EJS）。
const htmlVars = () => ({
  name: 'pttchrome:html-vars',
  transformIndexHtml(html) {
    return html.replace(
      /%PTTCHROME_PAGE_TITLE%/g,
      process.env.PTTCHROME_PAGE_TITLE || 'PttChrome'
    );
  },
});

export default defineConfig(({ command }) => {
  // dev server（vite serve）＝ developer mode；vite build ＝ production。
  const DEVELOPER_MODE = command === 'serve';
  return {
    // 部署在 GitHub Pages 子路徑，所有資源引用走相對路徑。
    base: './',
    plugins: [react(), htmlVars()],
    // .bin（Big5 轉碼表）與 .bmp 不在 Vite 內建 asset 清單，明確納入。
    assetsInclude: ['**/*.bin', '**/*.bmp'],
    define: {
      'process.env.PTTCHROME_PAGE_TITLE': JSON.stringify(process.env.PTTCHROME_PAGE_TITLE || 'PttChrome'),
      'process.env.DEFAULT_SITE': JSON.stringify(DEVELOPER_MODE ? 'wstelnet://localhost:8080/bbs' : 'wsstelnet://ws.ptt.cc/bbs'),
      // Default OFF: ignore ?site= in the URL (a page-author/link could otherwise
      // point the client at an arbitrary WebSocket host). Users who want a custom
      // proxy set it in Preferences instead (useProxy + proxyUrl, see pref_storage.js).
      // Set ALLOW_SITE_IN_QUERY=yes to re-enable the query override.
      'process.env.ALLOW_SITE_IN_QUERY': JSON.stringify(process.env.ALLOW_SITE_IN_QUERY === 'yes'),
      'process.env.DEVELOPER_MODE': JSON.stringify(DEVELOPER_MODE),
      // App Check debug token for local dev (pref_sync.js). Comes from the
      // developer's machine env, never from the repo — a registered debug
      // token bypasses reCAPTCHA, so committing it would defeat App Check.
      // Unset → undefined → pref_sync falls back to per-profile auto tokens.
      'process.env.APPCHECK_DEBUG_TOKEN': JSON.stringify(process.env.APPCHECK_DEBUG_TOKEN) || 'undefined',
      'process.env.GIT_COMMIT': JSON.stringify(GIT_COMMIT),
      'process.env.BUILD_TIME': JSON.stringify(BUILD_TIME),
      // Emulator hookup in pref_sync.js is test-only (set by the integration
      // runner); pin to undefined so the minifier drops it.
      'process.env.FIRESTORE_EMULATOR_HOST': 'undefined',
      'process.env.FIREBASE_AUTH_EMULATOR_HOST': 'undefined',
      'process.env.GCLOUD_PROJECT': 'undefined',
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      // 目標＝主流桌機瀏覽器現代版（見 CLAUDE.md 慣例）；不考慮手機/舊版/冷門瀏覽器。
      target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
      // 體積警告門檻（沿用舊 webpack performance 調校精神）：基線 entry ~709KB
      //（React+Mantine+app）、firebase lazy chunk ~567KB，皆屬預期；門檻設在
      // 基線之上以濾噪音，仍能抓真正異常肥大。
      chunkSizeWarningLimit: 800,
    },
    // firebase 是 runtime 才 dynamic import 的 lazy 依賴：先預打包，避免 dev
    // server 冷快取時 mid-session 才發現 → re-optimize → 強制 full reload
    //（會把跑到一半的 e2e 頁面重載炸掉）。
    optimizeDeps: {
      include: [
        'firebase/app',
        'firebase/auth',
        'firebase/firestore',
        'firebase/app-check',
      ],
    },
    server: {
      port: 8080,
      strictPort: true,
      watch: {
        // build 產物與測試報告非 source：一旦被監看，e2e 進行中跑 `yarn build`
        // 或 Playwright 寫報告會觸發 dev server 廣播 full reload，炸掉被測頁面。
        ignored: ['**/dist/**', '**/playwright-report/**', '**/test-results/**', '**/3rd_script/**'],
      },
      proxy: {
        // dev 內建 /bbs WebSocket proxy：改寫 Origin→term.ptt.cc 直連真 PTT
        //（ws.ptt.cc 的白名單不收 ws.ptt.cc 自己）。
        '/bbs': {
          target: 'https://ws.ptt.cc',
          secure: true,
          ws: true,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReqWs', (proxyReq) => {
              proxyReq.setHeader('origin', 'https://term.ptt.cc');
            });
          },
        },
      },
    },
  };
});
