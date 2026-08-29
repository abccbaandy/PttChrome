const { defineConfig, devices } = require('@playwright/test');

// 逆境 project 的 spec 清單（詳見下方 offline-slow 的註解）。
// 這兩個常數被 tests/unit/e2e_layout_settle.test.js 讀去做靜態守護，改名要一起改。
const ADVERSE_LAYOUT_SPECS = [
  'offline/mouse.offline.spec.js',
  'offline/pusher_highlight.offline.spec.js',
  'offline/blacklist_quick_add.offline.spec.js',
  'offline/comment_merge.offline.spec.js',
  'offline/enhance.offline.spec.js',
  'offline/quick_search.offline.spec.js',
];
// image_load_conditions 刻意**不在**逆境清單裡：它自己用 bootOffline 的 imageProfile
// 逐條指定情境（明確傳入的優先序高於 project 名），放進來只會原封不動再跑一次。
const ADVERSE_IMAGE_SPECS = [
  'offline/lazy_preview_blank.offline.spec.js',
  'offline/lazy_preview_enlarge_blank.offline.spec.js',
  'offline/easy-reading.offline.spec.js',
];

// offline project 的「瀏覽器層硬斷網」。第三層防線，上面兩層是
//   1. helpers/replay.js#installOfflineNetwork 的述詞 route（正常路徑全部本地回應）
//   2. helpers/offline_images.js#GONE_ORIGIN（轉址終點鑄在保留域，不沿用原址）
// 為什麼還需要第三層：2026-08-28 發現 offline e2e 每輪都真的去打自架的 imgur 快取
// Worker（access log 實錄 `GET /__offline-gone__/783.png`）。成因是 `route.fulfill`
// 吐出的 301 會被 Chromium 跟隨，而那一跳**不再經過 page.route** —— 從測試這一端
// 完全看不出來（handler 只被打到一次、served 也沒有它），卻是真的送上公網。
// 述詞 route 有多少種繞法無法窮舉，所以直接把瀏覽器的出口封死：指向一個必定連不上
// 的 proxy，localhost 照舊直連（dev server／stub WS 不受影響；被 route.fulfill 接住
// 的請求根本不走網路，也不受影響）。
const OFFLINE_NO_NETWORK = {
  server: 'http://127.0.0.1:1',
  bypass: 'localhost,127.0.0.1,::1',
};

// 逆境三桶共用的 use。與一般 offline 的唯一差別是**本機關掉錄影**：
// `video: 'retain-on-failure'` 是每條測試都在錄、只有失敗才留檔 ⇒ 一輪 189 條就是
// 189 份 screencast 通道與暫存檔 handle，是本機 Windows 撞 STATUS_DLL_INIT_FAILED
// （見 scripts/run-adverse-e2e.mjs 開頭）的養分之一。CI 是 Linux，沒有那個 session
// 資源上限，影片又是唯一能回看逆境現場的東西 ⇒ 只在本機關。
// screenshot/trace 不動：前者只在失敗時抓、後者沒 retry 就不錄，成本近乎零。
const ADVERSE_USE = {
  ...devices['Desktop Chrome'],
  proxy: OFFLINE_NO_NETWORK,
  video: process.env.CI ? 'retain-on-failure' : 'off',
};

// E2E 測試：用真實 Chromium 驅動 pttchrome 連真實 PTT。
// dev server 由 webServer 自動啟動（已手動 yarn start 時會 reuse）。
module.exports = defineConfig({
  testDir: './tests/e2e',
  // 目前只負責清掉 DDoS/BOT 封鎖閂鎖，讓它只在同一輪內有效（見 tests/e2e/global-setup.js）。
  globalSetup: './tests/e2e/global-setup.js',
  // BBS 連線/登入較慢，timeout 放寬
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  // 各 project 共用同一个 webServer（Vite dev server）：
  // - preflight：连线健检（tests/e2e/preflight.setup.js），只验「连得到 PTT」。
  // - live   ：连真实 PTT 的 e2e（现有 spec），排除 offline/ 与 tools/。
  // - offline：离线重放（tests/e2e/offline/**），用 stub WebSocket + cassette，零网络。
  // - record ：一次性录制器（tools/record-cassette.spec.js），连真实 PTT(guest) 产出 cassette。
  // 见 docs/offline-replay-testing.md。
  //
  // live／record 依赖 preflight：PTT 维护／不可达时，整包不跑，只留一则明确结论，
  // 而不是 20 几条各自 waitForScreen timeout（看不出是 PTT 掛了还是本专案 code 坏了）。
  projects: [
    {
      name: 'preflight',
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'preflight.setup.js',
    },
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['preflight'],
      testIgnore: ['offline/**', 'tools/**', 'preflight.setup.js'],
    },
    {
      name: 'offline',
      use: { ...devices['Desktop Chrome'], proxy: OFFLINE_NO_NETWORK },
      testMatch: 'offline/**/*.spec.js',
    },
    {
      // offline-firefox：只跑「選取文字」那支。issue #22 的兩個症狀（選取自動複製、
      // 右鍵快速搜尋帶入選取）只在 Firefox 壞，Chromium 永遠綠 —— 沒有真 Firefox
      // 就沒有回歸守護。其餘 offline spec 仍只跑 chromium（不少 spec 依賴
      // grantPermissions 之類的 Chromium-only 行為）。
      // 本機首次需 `yarn playwright install firefox`。
      //
      // MOZ_DISABLE_CONTENT_SANDBOX：Windows 上 Firefox 的 content sandbox 有時
      // 起不來，症狀是**每一條都** `browserContext.newPage: Test timeout`，瀏覽器
      // log 只有 `RenderCompositorSWGL failed mapping default framebuffer` 與
      // `remoteTab is null`（＝content process 沒生出來），看起來像被測 code 大爆炸，
      // 其實連空白頁都開不了。實測（2026-08-15）headless/有頭、關 WebRender、關硬體
      // 加速、`security.sandbox.content.level=0`、關 fission/e10s 全都無效，只有這個
      // 環境變數能救。測試瀏覽器只載入本機 dev server 與 fixture，關掉 content
      // sandbox 沒有實際風險。
      name: 'offline-firefox',
      use: {
        ...devices['Desktop Firefox'],
        proxy: OFFLINE_NO_NETWORK,
        launchOptions: {
          env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' },
        },
      },
      testMatch: 'offline/selection.offline.spec.js',
    },
    // ---- 逆境 project（`yarn test:e2e:offline:adverse`，CI 另開一個平行 job）----
    // 同一批 offline spec，但圖片改成「壞掉／很慢／混合」。目的是把 CI 偶發紅變成
    // **必現紅**：本機 fixture 圖秒回，版面在測試量座標之前就穩了，所以「捲完立刻量
    // getBoundingClientRect」這類 bug 本機永遠測不出來（50fa35c 的現場）。
    // profile 由 project 名推導（helpers/offline_images.js#profileFromProjectName），
    // 不需要 cross-env。
    //
    // 兩層清單，分法的理由：
    //   Tier A（ADVERSE_LAYOUT_SPECS）＝版面／座標敏感，但與圖片**成敗**無關 ⇒ 三種
    //     逆境都跑，斷言語義完全不變。
    //   Tier B（ADVERSE_IMAGE_SPECS）＝主題就是圖片本身，「圖有高度」是它的前提 ⇒
    //     只跑 slow（最終 DOM 與 cache 相同，只是慢）。broken 下的行為由
    //     image_load_conditions.offline.spec.js 專門驗，那裡的斷言是為 broken 寫的。
    {
      name: 'offline-slow',
      use: ADVERSE_USE,
      timeout: 300000,
      testMatch: [...ADVERSE_LAYOUT_SPECS, ...ADVERSE_IMAGE_SPECS],
    },
    {
      name: 'offline-broken',
      use: ADVERSE_USE,
      timeout: 300000,
      testMatch: ADVERSE_LAYOUT_SPECS,
    },
    {
      name: 'offline-mixed',
      use: ADVERSE_USE,
      timeout: 300000,
      testMatch: ADVERSE_LAYOUT_SPECS,
    },
    {
      name: 'record',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['preflight'],
      testMatch: 'tools/record-cassette.spec.js',
    },
  ],
  webServer: {
    // 直接跑單一 node 進程（vite bin），不經 npx/yarn 多層 wrapper，
    // teardown 才殺得乾淨、不留孤兒。vite serve 即 development mode，無需 NODE_ENV。
    command: 'node node_modules/vite/bin/vite.js',
    url: 'http://localhost:8080',
    timeout: 180000,
    // teardown 先送 SIGTERM 讓 dev server 自己收掉 socket，再強制收。
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    // 直接 npx playwright test（不走 yarn 前置 kill:dev）時仍能附到手動 dev server；
    // 走 yarn 腳本時前置已 kill:dev 清空 8080，等於每次全新，杜絕 stale bundle。
    reuseExistingServer: true,
  },
});
