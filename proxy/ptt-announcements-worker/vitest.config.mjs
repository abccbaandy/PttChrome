import { defineConfig } from "vitest/config";

// 必要：沒有這個檔，vitest 會往上找到主專案的 vitest.config.mjs（理由同 proxy/imgur-worker）。
// core.js 的純邏輯與 sync 流程在主專案 tests/unit/ptt_announcements.test.js；這裡只測 Worker 殼。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
