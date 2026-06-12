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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx cross-env NODE_ENV=development webpack serve',
    url: 'http://localhost:8080',
    timeout: 180000,
    reuseExistingServer: true,
  },
});
