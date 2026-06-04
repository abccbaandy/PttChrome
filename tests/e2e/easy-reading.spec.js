const { test, expect } = require('@playwright/test');
const { readScreen, login, sendKey, typeLine, attachConsole } = require('./helpers/ptt');

// 驗證好讀模式按 End：暫時切回原生、跳到文章最底、不卡住，且原生搜尋可用；
// 按左鍵離開後，進下一篇自動恢復好讀模式。
// 對應 src/js/easy_reading.js 的 switchToNativeAtBottom。
test('好讀模式 End 切回原生跳到底', async ({ page }) => {
  const logs = attachConsole(page);
  const dumpLogs = (tag) => {
    console.log(`\n===== console (${tag}) =====\n${logs.slice(-40).join('\n')}\n====================\n`);
  };

  // app 內部狀態（main.js 在 DEVELOPER_MODE 下 window.__app = app）
  const appState = () => page.evaluate(() => {
    const a = window.__app;
    const lr = document.getElementById('easyReadingLastRow');
    const mc = document.getElementById('mainContainer');
    return {
      useEasyReadingMode: a.view.useEasyReadingMode,
      pageState: a.buf.pageState,
      lastRowDisplay: lr ? getComputedStyle(lr).display : 'no-el',
      mcChildren: mc ? mc.childNodes.length : -1,
    };
  });
  const waitPageState = async (want, ms = 12000) => {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      if ((await page.evaluate(() => window.__app.buf.pageState)) === want) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };

  try {
    // app 載入前開啟好讀模式（預設 false，存在 localStorage）
    await page.addInitScript(() => {
      try {
        const KEY = 'pttchrome.pref.v1';
        const cur = JSON.parse(window.localStorage.getItem(KEY) || '{}');
        const values = Object.assign({}, cur.values, { enableEasyReading: true });
        window.localStorage.setItem(KEY, JSON.stringify({ values }));
      } catch (e) {}
    });

    await page.goto('/');
    console.log(await login(page));

    // 主選單 -> s 搜尋看板 -> C_Chat
    await sendKey(page, 's');
    await page.waitForTimeout(500);
    await typeLine(page, 'C_Chat');
    await page.waitForTimeout(1500);
    for (let i = 0; i < 6; i++) {
      const s = await readScreen(page);
      if (s.includes('看板') && (s.includes('標題') || s.includes('人氣'))) break;
      if (s.includes('加入') || s.includes('訂閱') || s.includes('我的最愛')) await typeLine(page, 'y');
      else await sendKey(page, 'Space');
      await page.waitForTimeout(800);
    }

    // 到最新一篇並開啟，等好讀模式自動翻頁
    await sendKey(page, 'End');
    await page.waitForTimeout(1000);
    await sendKey(page, 'Enter');
    await page.waitForTimeout(4000);

    const before = await appState();
    console.log('STATE BEFORE END:', JSON.stringify(before));
    expect(before.useEasyReadingMode).toBe(true); // 確認好讀模式真的啟動

    // 關鍵動作：按 End
    logs.length = 0;
    await sendKey(page, 'End');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/er-after-end.png', fullPage: true });

    const after = await appState();
    const afterScreen = await readScreen(page);
    console.log('STATE AFTER END:', JSON.stringify(after));
    dumpLogs('after End');

    // 切回原生：單頁原生 DOM（非好讀累積），好讀自訂列隱藏，畫面在文章最底
    expect(after.useEasyReadingMode).toBe(false);
    expect(after.mcChildren).toBeLessThanOrEqual(24);
    expect(after.lastRowDisplay).toBe('none');
    expect(afterScreen).toContain('說明'); // 原生狀態列
    expect(afterScreen).toContain('100%'); // 在最底

    // 原生搜尋可用：'/' 跳出搜尋提示（好讀模式會攔截 '/'）
    await sendKey(page, 'Slash');
    await page.waitForTimeout(1200);
    const searchScreen = await readScreen(page);
    console.log('SEARCH SCREEN:', searchScreen.split('\n')[0]);
    expect(searchScreen).toMatch(/搜尋|搜索|請輸入|關鍵/);
    await typeLine(page, ''); // 空 Enter 取消搜尋（避免用 Escape，pmore 會當逃逸序列）
    await page.waitForTimeout(1000);

    // 左鍵離開文章 → 回看板列表
    await sendKey(page, 'ArrowLeft');
    expect(await waitPageState(2)).toBe(true);

    // 進下一篇 → 好讀模式自動恢復
    await sendKey(page, 'Enter');
    await waitPageState(3);
    await page.waitForTimeout(2500);
    const reentry = await appState();
    console.log('STATE RE-ENTRY:', JSON.stringify(reentry));
    expect(reentry.useEasyReadingMode).toBe(true);
  } catch (err) {
    dumpLogs('error');
    await page.screenshot({ path: 'tests/e2e/__screenshots__/er-error.png', fullPage: true });
    throw err;
  }
});
