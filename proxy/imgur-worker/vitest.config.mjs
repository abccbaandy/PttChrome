import { defineConfig } from "vitest/config";

// 必要：沒有這個檔，vitest 會往上找到**主專案**的 vitest.config.mjs，
// 套用它的 unit/integration project（include 指向 tests/unit、tests/integration）
// → 這裡的測試一個都掃不到，直接 "No test files found" 退出 1。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
