// live e2e 的前置健檢：只驗「連得到 PTT」，不做登入、不碰任何功能。
//
// 為什麼要獨立成一個 project：PTT 維護／爆量時，沒有這層的話整包 live e2e 會有 20 幾條
// 各自 timeout，錯誤訊息全是 `waitForScreen timeout 等不到 [請輸入代號...]` —— 看不出
// 是 PTT 掛了還是本專案 code 壞了，每個 session 都要重新研究一次。
// playwright.config.js 讓 live／record 依賴本 project：這裡紅掉，它們整個不跑，
// 只留下一則明確結論。
//
// 逃生門：E2E_SKIP_PREFLIGHT=1（例如刻意要看某條 case 在斷線狀態下的行為）。
const { test } = require('@playwright/test');
const {
  waitBbsConnected,
  waitForScreen,
  attachConsole,
  describeConnectFailure,
  readScreen,
} = require('./helpers/ptt');

test('preflight：PTT 連線可用', async ({ page }) => {
  test.skip(!!process.env.E2E_SKIP_PREFLIGHT, 'E2E_SKIP_PREFLIGHT=1，跳過連線健檢');

  const logs = attachConsole(page);
  try {
    await page.goto('/');

    // 第一層＋第二層：app boot 起來了嗎、WebSocket 連上了嗎。
    await waitBbsConnected(page, { timeout: 30000 });

    // 第三層：連上但 server 不吐畫面（PTT 維護模式常見 —— 接受連線後直接靜默或踢掉）。
    try {
      await waitForScreen(page, ['請輸入代號', '請輸入帳號', 'guest', '按任意鍵'], {
        timeout: 30000,
      });
    } catch (e) {
      throw new Error(
        describeConnectFailure({
          hasApp: true,
          connectState: await page.evaluate(() => window.__app.connectState),
          screen: await readScreen(page),
          timeout: 30000,
        })
      );
    }
  } catch (err) {
    console.log('\n===== 瀏覽器 console 紀錄 =====');
    console.log(logs.join('\n'));
    console.log('==============================\n');
    throw err;
  }
});
