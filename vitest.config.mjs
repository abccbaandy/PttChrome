// Vitest（unit + integration）。刻意獨立於 vite.config.mjs、不 extends 它：
// app 的 `define` 會把 FIRESTORE_EMULATOR_HOST 等釘成 undefined（供 build 剪
// dead code），integration 測試卻依賴這些真實 env 連 emulator——混用會全滅。
// 測試下 process.env.* 直接讀 Node 真實環境變數，無需 define。
import fs from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import worktree from './scripts/worktree.js';
import { isBrowserTestSource } from './scripts/unit-browser-marker.mjs';

// 需要 DOM 的 unit 檔第一行寫 BROWSER_MARKER ⇒ 跑在真 Chromium（unit-browser project），
// 其餘跑 node（unit project）。以檔頭標記分流而不是檔名，是為了不讓上百個檔改名
// （docs 裡大量 `<file>#…` pointer 會全斷）。守護 tests/unit/unit_environment.test.js。
const UNIT_DIR = 'tests/unit';
// 遞迴：unit project 的 include 是 `tests/unit/**`，只看頂層的話子目錄的 DOM 測試會被丟到 node。
const browserFiles = fs
  .readdirSync(UNIT_DIR, { recursive: true })
  .map((f) => f.split('\\').join('/'))
  .filter((f) => /\.test\.jsx?$/.test(f))
  .filter((f) => isBrowserTestSource(fs.readFileSync(`${UNIT_DIR}/${f}`, 'utf8')))
  .map((f) => `${UNIT_DIR}/${f}`);

// 瀏覽器沒有 `process`：src 讀的 process.env.* 在 app 由 vite.config.mjs 的 define 釘值，
// 測試沿用 node 下的語意（＝未設定），只轉發測試自己會讀的開關。
const browserEnv = { UPDATE_GOLDEN: process.env.UPDATE_GOLDEN || '' };

// 整合測試 in-test poll deadline（tests/integration/pref_sync.test.js 由同一
// env 推導）；外層 per-test timeout 須大於它，留兩輪 sequential poll 的餘裕。
const pollDeadline =
  Number(process.env.INTEGRATION_TIMEOUT_MS) ||
  (process.env.CI ? 30000 : 10000);

// maxWorkers 是全域選項（不吃 project 層），testTimeout 只套 unit project。
const { maxWorkers, testTimeout } = worktree.unitLimits(worktree.isLinkedWorktree());
const unitTimeout = testTimeout ? { testTimeout } : {};

export default defineConfig({
  plugins: [react()],
  // Big5 轉碼表（tests/unit/helpers/load_big5_tables.js 用 `?inline` 讀）。
  assetsInclude: ['**/*.bin'],
  test: {
    globals: true,
    ...(maxWorkers ? { maxWorkers } : {}),
    projects: [
      {
        extends: true,
        test: {
          // 純邏輯／靜態掃描／解析，node 環境，離線。需要 DOM 的檔案在 unit-browser。
          // threads 比預設的 forks 起 worker 輕；不准在 unit 裡用 process.chdir（threads 不支援）。
          name: 'unit',
          environment: 'node',
          pool: 'threads',
          include: ['tests/unit/**/*.test.{js,jsx}'],
          exclude: browserFiles,
          setupFiles: ['tests/unit/setup.js'],
          // git worktree 裡限流（scripts/worktree.js#unitLimits）：不搶主 session 的 CPU。
          ...unitTimeout,
        },
      },
      {
        extends: true,
        define: { 'process.env': JSON.stringify(browserEnv) },
        test: {
          // DOM／渲染／React 週邊 UI，跑在真 Chromium（Vitest Browser Mode）。2026-10 從 jsdom
          // 換過來：同一批檔案 59s → 15s，而且 layout、scrollTop、IntersectionObserver、
          // 樣式正規化都是真的（評估見 docs/build-modernization.md）。
          // 測試檔裡不能用 fs／path／Buffer／require／__dirname；fixture 用 `?raw` import。
          // API server 預設 port 63315，被佔用會自動往下找，多 session 並行不衝突。
          name: 'unit-browser',
          include: browserFiles,
          setupFiles: ['tests/unit/setup.js'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // 失敗截圖對 unit 沒用，還會在 .vitest/ 堆檔。
            screenshotFailures: false,
            // 沿用 jsdom 時代的視窗大小（1024×768），讓既有的版面斷言語意不變。
            viewport: { width: 1024, height: 768 },
            instances: [{ browser: 'chromium' }],
          },
          ...unitTimeout,
        },
      },
      {
        extends: true,
        test: {
          // 雲端同步流程（真 modular SDK ↔ Docker 裡的 Firebase Emulator）。
          // node env（非 jsdom）：讓 Firestore SDK 走 node build 的 gRPC，
          // 避免瀏覽器 build 的 WebChannel/XHR 在無真瀏覽器下 flaky。
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.js'],
          setupFiles: ['tests/integration/setup.js'],
          testTimeout: pollDeadline * 2 + 10000,
          // 刻意不設 retry：重試會把 flaky 吞成綠。舊的 CI 冷啟動逾時根因（emulator 首次寫入
          // 的暖機成本落在第一條測試的 deadline 裡）已在 scripts/run-integration.mjs#warmUp 處理。
          // 守護 tests/unit/no_test_retry.test.js。
        },
      },
    ],
  },
});
