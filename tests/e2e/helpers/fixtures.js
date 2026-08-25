// 共用登入 session：worker-scoped fixture，整個 worker（workers:1 → 整包）只登入一次，
// 跨 spec 檔重用同一個已登入 page。
//
// **這是整輪 live e2e 唯一呼叫 login() 的地方**，而且必須維持如此：登入次數就是 PTT
// DDoS/BOT 防護的觸發條件（2026-08-25 實錄：以前 easy-reading-list 一支就自己登入 9 次，
// 整輪十幾次，連跑兩輪帳號直接被鎖，之後每一條都卡在登入閘門）。任何新 spec 一律用
// 這個 fixture，不要自己 goto + login。規範與盤點見 tests/e2e/README.md，
// 回歸守護見 tests/unit/e2e_login_budget.test.js。
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
// - 唯二不用此 fixture 的 case：enhance 的「自動登入」與 deep-link —— 被測行為本身就是
//   「開站自動登入」，不可能共用已登入的 page。connect-login 反而**要**用（它斷言的就是
//   這個 fixture 那一次登入的結果）。名單鎖死在 tests/unit/e2e_login_budget.test.js。
const base = require('@playwright/test');
const { login, attachConsole } = require('./ptt');
const { assertNotBotBlocked } = require('./bot_block');

const test = base.test.extend({
  shared: [
    async ({ browser }, use) => {
      // 這一輪稍早已判定被封鎖 ⇒ 連 context 都不要開（開站即自動 connect，見
      // CLAUDE.md「dev build 開站即 connect()」）。Playwright 在 test 失敗後會重啟
      // worker、fixture 因此重建，沒有這道閂鎖就會一路重登到封鎖延長。
      assertNotBotBlocked();
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
