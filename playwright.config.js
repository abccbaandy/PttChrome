const { defineConfig, devices } = require('@playwright/test');

// E2E 測試：用真實 Chromium 驅動 pttchrome 連真實 PTT。
// dev server 由 webServer 自動啟動（已手動 yarn start 時會 reuse）。
module.exports = defineConfig({
  testDir: './tests/e2e',
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
  // 四个 project 共用同一个 webServer（Vite dev server）：
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
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'offline/**/*.spec.js',
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
