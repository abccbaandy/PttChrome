const { defineConfig, devices } = require('@playwright/test');

// E2E 測試：用真實 Chromium 驅動 pttchrome 連真實 PTT。
// dev server 由 webServer 自動啟動（已手動 npm start 時會 reuse）。
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
  // 三个 project 共用同一个 webServer（webpack dev server）：
  // - live   ：连真实 PTT 的 e2e（现有 spec），排除 offline/ 与 tools/。
  // - offline：离线重放（tests/e2e/offline/**），用 stub WebSocket + cassette，零网络。
  // - record ：一次性录制器（tools/record-cassette.spec.js），连真实 PTT(guest) 产出 cassette。
  // 见 docs/offline-replay-testing.md。
  projects: [
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['offline/**', 'tools/**'],
    },
    {
      name: 'offline',
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'offline/**/*.spec.js',
    },
    {
      name: 'record',
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'tools/record-cassette.spec.js',
    },
  ],
  webServer: {
    // 直接跑單一 node 進程（webpack bin 自動委派 webpack-cli），不經 npx/cross-env 多層 wrapper，
    // teardown 才殺得乾淨、不留孤兒。NODE_ENV 改走 Playwright 內建 env（會 merge 進 process.env）。
    command: 'node node_modules/webpack/bin/webpack.js serve',
    env: { NODE_ENV: 'development' },
    url: 'http://localhost:8080',
    timeout: 180000,
    // teardown 先送 SIGTERM 讓 dev server 自己收掉 socket，再強制收。
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    // 直接 npx playwright test（不走 yarn 前置 kill:dev）時仍能附到手動 dev server；
    // 走 yarn 腳本時前置已 kill:dev 清空 8080，等於每次全新，杜絕 stale bundle。
    reuseExistingServer: true,
  },
});
