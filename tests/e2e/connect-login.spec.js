const { test, expect } = require('@playwright/test');
const { readScreen, login, attachConsole } = require('./helpers/ptt');

test('連線並登入到主選單', async ({ page }) => {
  // 本檔是唯一沒有自訂 timeout 的 live spec，過去吃 playwright.config.js 的 60s 全域值：
  // waitBbsConnected(≤25s) + 等首畫面 + 登入互動迴圈(≤40s) 相加就已經逼近 60s，PTT 端
  // 驗證慢一點（畫面停在「正在檢查帳號與密碼...」）必紅。其餘 live spec 一律 120s 起跳。
  test.setTimeout(180000);

  const logs = attachConsole(page);

  try {
    await page.goto('/');

    const result = await login(page);
    console.log(result);

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
