// 共用登入 session：worker-scoped fixture，整個 worker（workers:1 → 整包）只登入一次，
// 跨 spec 檔重用同一個已登入 page，避免 PTT「登入太頻繁」節流。
//
// 用法：
//   const { test, expect } = require('./helpers/fixtures');
//   test.describe.serial('...', () => {
//     test('case', async ({ shared }) => {
//       const { page, logs } = shared;
//       logs.length = 0;            // 清掉上個 case 的 console 紀錄
//       await resetSession(page);   // 回主選單 + prefs baseline
//       ...
//     });
//   });
//
// 注意：
// - prefs 一律用 helpers/ptt.js 的 applyPrefs（runtime），不可用 addInitScript（共用 page 不 reload）。
// - 此 page 非 Playwright 內建 fixture，失敗時不會自動截圖/錄影 → case 的 catch 內自行 page.screenshot。
// - 某 test 失敗後 Playwright 會重啟 worker → fixture 重建 = 自動重新登入一次。
// - 測登入流程本身的 case（connect-login、自動登入）不要用此 fixture，續用內建 page。
const base = require('@playwright/test');
const { login, attachConsole } = require('./ptt');

const test = base.test.extend({
  shared: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: 'http://localhost:8080' });
      const page = await context.newPage();
      const logs = attachConsole(page);
      await page.goto('/');
      console.log(await login(page));
      await use({ page, logs });
      await context.close();
    },
    // worker scope：跨 test/跨 spec 檔共用；登入含節流退避（30s×2 + 重連）可能很慢，給寬鬆 timeout。
    { scope: 'worker', timeout: 240000 },
  ],
});

module.exports = { test, expect: base.expect };
