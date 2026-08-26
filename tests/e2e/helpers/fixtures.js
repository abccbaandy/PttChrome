// 共用登入 session：worker-scoped fixture，整個 worker（workers:1 → 整包）只登入一次，
// 跨 spec 檔重用同一個已登入 page。
//
// **這是整輪 live e2e 唯一的登入**，而且必須維持如此：登入次數就是 PTT DDoS/BOT
// 防護的觸發條件（2026-08-25 實錄：以前 easy-reading-list 一支就自己登入 9 次，整輪
// 十幾次，連跑兩輪帳號直接被鎖；2026-08-26 又因為連跑五輪對照被鎖一次，那時一輪還有
// 三次登入 —— 共用 session ＋ 自動登入 spec ＋ deep link spec）。任何新 spec 一律用
// 這個 fixture，不要自己 goto + login。規範與盤點見 tests/e2e/README.md，
// 回歸守護見 tests/unit/e2e_login_budget.test.js。
//
// ## 一輪一次登入是怎麼做到的（2026-08-26）
//
// 這一次的開機**就是產品自己的自動登入**（`autoLoginBoot` 注入 autoLogin prefs →
// 開站 → 完全不按鍵等主功能表），所以：
//
//   1. 「開站自動登入」不必再自己開一個 page —— enhance.spec.js 那條改成斷言
//      `shared.boot`（這一次開機留下的證據），零額外登入。
//   2. deep link 也不必自己開站 —— 改用 `location.hash`（hashchange）在**同一個已登入
//      的分頁**再貼一次連結，走的是 deep_link_entry.js 明列的第 2 條進入路徑
//      「同一個分頁再貼一次連結，不重載、不用重新登入」。
//
// 於是整輪流程就是：開機（＝唯一一次登入，順帶驗自動登入）→ deep link → 其餘 spec。
//
// 這樣換掉的覆蓋度（**刻意的**，兩者都另有 unit 守護）：
//   - 「重複登入」提示：以前靠「共用 session 還掛著時再開一條」製造，現在整輪只有
//     一條連線就製造不出來。auto_login 的 one-shot guard（_answeredDup/_answeredErr）
//     守在 tests/unit/auto_login_2fa.test.js 與 auto_login_logic.test.js。
//   - deep link 的「連結先到、人還沒登入」暫存排程：那是冷啟動才有的時序。
//     DeepLinkController 的 _hold/_pending 守在 tests/unit/deep_link_controller.test.js。
//
// 沒有 PTT_USER/PTT_PASS 時退回 guest + 手動 login()（自動登入本來就無從測起，
// 相關 spec 自己 test.skip）。
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
const base = require('@playwright/test');
const { login, autoLoginBoot, attachConsole } = require('./ptt');
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

      // boot ＝這一次開機留下的證據，供 enhance.spec.js 的「開站自動登入」斷言。
      // auto:false ＝沒有帳密、走 guest 手動登入，那條 spec 會自己 skip。
      let boot;
      if (process.env.PTT_USER && process.env.PTT_PASS) {
        const r = await autoLoginBoot(page);
        console.log(
          `AUTO LOGIN OK: ${r.waitedMs}ms retries=${r.retries} | ` +
            r.screen.split('\n')[0]
        );
        boot = Object.assign({ auto: true }, r);
      } else {
        await page.goto('/');
        const message = await login(page);
        console.log(message);
        boot = { auto: false, message };
      }

      await use({ page, logs, boot });
      await context.close();
    },
    // worker scope：跨 test/跨 spec 檔共用；登入含節流退避（30s×2 + 重連）可能很慢，給寬鬆 timeout。
    { scope: 'worker', timeout: 240000 },
  ],
});

module.exports = { test, expect: base.expect };
