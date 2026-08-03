// Vitest（unit + integration）。刻意獨立於 vite.config.mjs、不 extends 它：
// app 的 `define` 會把 FIRESTORE_EMULATOR_HOST 等釘成 undefined（供 build 剪
// dead code），integration 測試卻依賴這些真實 env 連 emulator——混用會全滅。
// 測試下 process.env.* 直接讀 Node 真實環境變數，無需 define。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 整合測試 in-test poll deadline（tests/integration/pref_sync.test.js 由同一
// env 推導）；外層 per-test timeout 須大於它，留兩輪 sequential poll 的餘裕。
const pollDeadline =
  Number(process.env.INTEGRATION_TIMEOUT_MS) ||
  (process.env.CI ? 30000 : 10000);

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          // 純邏輯 + Row/Screen 渲染（jsdom + @testing-library/react），離線。
          name: 'unit',
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.{js,jsx}'],
          setupFiles: ['tests/unit/setup.js'],
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
          // CI 已知 flaky（emulator 冷啟動）：自動重試，對應舊 jest.retryTimes(2)。
          retry: process.env.CI ? 2 : 0,
        },
      },
    ],
  },
});
