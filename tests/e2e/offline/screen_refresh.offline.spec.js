// 畫面重新整理（docs/screen-refresh.md）：桌機 F5 在文章列表改送 s<本板>⏎、不重新載入網頁；
// 冷卻期間只提示。真鍵盤（page.keyboard）送 F5：瀏覽器的預設動作是不是真的被擋下，只有
// 真按鍵驗得出來（手捏 KeyboardEvent 不會觸發瀏覽器的重新載入）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 文章列表一整幀（指紋同 mobile_toolbar.offline.spec.js）。
async function drawArticleList(page) {
  await page.evaluate(() => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    const REV = '\x1b[7m';
    const OFF = '\x1b[0m';
    let d = '\x1b[2J';
    d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
    d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
    d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
    for (let i = 0; i < 3; i++)
      d += '\x1b[' + (4 + i) + ';1H' + u2b(String(1233 + i).padStart(7) + '     9/01 testuser     □[閒聊] 測試' + i);
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  });
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

test.describe('重新整理（F5）', () => {
  test('文章列表：F5 送 s（不重新載入網頁）；冷卻內再按只有提示', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false, refreshMinIntervalSec: 60 });
    await drawArticleList(page);
    await page.evaluate(() => {
      window.__notReloaded = true;
      window.__f5Prevented = null;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F5') window.__f5Prevented = e.defaultPrevented;
      });
      window.__app.setInputAreaFocus();
    });
    await collectSent(page);
    await page.keyboard.press('F5');
    await expect.poll(() => sentText(page)).toContain('s');
    // 瀏覽器的重新載入被擋下（真瀏覽器裡就是「不重載網頁」的那一道）。
    expect(await page.evaluate(() => window.__f5Prevented)).toBe(true);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    // 第二步（板名）只在 CompleteBoard prompt 出現後才送 ⇒ 這時候還沒有。
    expect(await sentText(page)).not.toContain('Test\r');
    // 收尾（不管成功失敗）解除在途旗標後才測冷卻：直接 flush 佇列模擬「這輪結束」。
    await page.evaluate(() => window.__app.commandQueue.flush());
    await collectSent(page);
    await page.keyboard.press('F5');
    await expect(page.locator('.ListHint')).toContainText('秒再重新整理');
    expect(await sentText(page)).toBe('');
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
  });

  test('關掉 refreshKeyIntercept ⇒ F5 交還瀏覽器（不 preventDefault、不送 byte）', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false, refreshKeyIntercept: false });
    await drawArticleList(page);
    // headless Chromium 不執行 F5 這類瀏覽器快捷鍵（不會真的重載），所以驗的是「交還」
    // 本身：app 沒有 preventDefault、也沒送任何 byte。listener 掛在 app 之後（同在
    // window、bubble），讀得到 app 處理完的 defaultPrevented。
    await page.evaluate(() => {
      window.__f5Prevented = null;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F5') window.__f5Prevented = e.defaultPrevented;
      });
      window.__app.setInputAreaFocus();
    });
    await collectSent(page);
    await page.keyboard.press('F5');
    await expect.poll(() => page.evaluate(() => window.__f5Prevented)).toBe(false);
    expect(await sentText(page)).toBe('');
  });
});
