const { test, expect } = require('./helpers/fixtures');
const { readScreen } = require('./helpers/ptt');

// 「連得上 + 登得進去」的煙霧測試。
//
// **刻意不自己 login()**：共用 session 的 fixture（helpers/fixtures.js）本來就會做一次
// 全新的 goto + login，這條斷言的就是那一次。自己再登一次只是讓整輪多一次登入 ——
// 而整輪登入次數正是 PTT DDoS/BOT 防護的觸發條件（見 tests/e2e/README.md）。
// 登入失敗時的診斷不會因此變差：訊息由同一個 login() 產生，只是改從 fixture 冒出來。
test('連線並登入到主選單', async ({ shared }) => {
  const { page, logs } = shared;
  logs.length = 0;
  try {
    const screen = await readScreen(page);
    // 主選單可辨識標記（不同站台/狀態文字略有差異，取常見者）
    expect(screen).toContain('主功能表');

    await page.screenshot({
      path: 'tests/e2e/__screenshots__/main-menu.png',
      fullPage: true,
    });
  } catch (err) {
    // 失敗時 dump console（easy_reading 等模組有大量 console.log，利於除錯）
    console.log('\n===== 瀏覽器 console 紀錄 =====');
    console.log(logs.join('\n'));
    console.log('==============================\n');
    throw err;
  }
});
