// 看板分頁在手機（src/js/board_tabs.js、docs/board-tabs.md）：App Bar 右邊、只列別的板（標題就是
// 現在這個板），tap 切板送原生 s。素材是逐幀餵的文章列表（同 board_tabs.offline.spec.js，各自一份）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');

const U2B_SRC = `(str) => {
  let out = '';
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) { out += ch; continue; }
    out += String.fromCharCode(window.lib.u2bArray[2 * c]) +
      String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
  }
  return out;
}`;

async function drawList(page, board) {
  await page.evaluate(
    ({ src, board }) => {
      const u2b = new Function('return ' + src)();
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[2J';
      d += '\x1b[1;1H' + REV + u2b(('【板主:test】' + '看板《' + board + '》').padEnd(80)) + OFF;
      d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
      d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
      [1233, 1234, 1235].forEach((n, i) => {
        d += '\x1b[' + (4 + i) + ';1H' + u2b(String(n).padStart(7) + '    ' + ' 9/01 ' + 'someone'.padEnd(13) + '□[閒聊] 測試 ' + n);
      });
      d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
      d += '\x1b[4;1H';
      window.__app.onData(d);
    },
    { src: U2B_SRC, board }
  );
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

const tabs = (page) => page.locator('#boardTabs');

async function boot(page, prefs) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'pttchrome.boardTabs.v1',
        JSON.stringify([
          { name: 'Stock', at: 1 },
          { name: 'Gossiping', at: 2 },
        ])
      );
    } catch (e) {}
  });
  await bootOffline(page, ptt, { boardTabs: true });
  // 自己畫的列表驗的是原生路徑；列表好讀一 engage 就會自己往線路送機器鍵。
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs || {}));
  await drawList(page, 'Test');
}

test('手機：分頁在 App Bar 右邊、只列別的板；tap ⇒ 送原生 s', async ({ page }) => {
  await boot(page);
  await expect(page.locator('body')).toHaveClass(/mobile-layout/);
  await expect(tabs(page).locator('[data-board-tab]')).toHaveText(['Stock', 'Gossiping']);
  const bar = await page.locator('.mobileAppBar').first().boundingBox();
  const box = await tabs(page).boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(bar.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height + 1);
  await startCapture(page);
  await tabs(page).locator('[data-board-tab="Stock"]').tap();
  await expect.poll(() => peekCapture(page)).toContain('s');
  expect(await takeCapture(page)).toBe('s\f');
});
