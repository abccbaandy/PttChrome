// 看板分頁（src/js/board_tabs.js、docs/board-tabs.md）的端到端行為：真瀏覽器、真 CommandQueue，
// 「server 回什麼」逐幀餵進 App.onData。unit（board_tabs.test.js）釘死認法與分頁清單；這裡守：
//   - 分頁真的疊在終端機第 1 列（按鍵提示列）上，不蓋標題列與表頭；
//   - 點別的板，線上真的送出原生 `s`（接著等 prompt 才送板名，同首頁儀表板的看板卡片）；
//   - 真右鍵關掉分頁，一個 byte 都不送、不開瀏覽器選單；pref 關不出現。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { rightClickElement } = require('../helpers/real_input');
const { waitRectStable } = require('../helpers/layout');

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
  await page.setViewportSize({ width: 1280, height: 800 });
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

test.describe('看板分頁', () => {
  test('疊在終端機第 1 列；點別的板 ⇒ 送原生 s；右鍵關掉不送鍵', async ({ page }) => {
    await boot(page);
    await expect(tabs(page)).toBeVisible();
    await expect(tabs(page).locator('[data-board-tab]')).toHaveText(['Stock', 'Gossiping', 'Test']);
    await expect(tabs(page).locator('[data-board-tab="Test"]')).toHaveAttribute('aria-selected', 'true');

    // 位置：第 1 列（標題列下面、表頭上面）。
    const row0 = await waitRectStable(page, '#mainContainer > [type="bbsrow"]:nth-child(1)');
    const row2 = await waitRectStable(page, '#mainContainer > [type="bbsrow"]:nth-child(3)');
    const bar = await waitRectStable(page, '#boardTabs');
    expect(bar.top).toBeGreaterThanOrEqual(row0.top + row0.height - 1);
    expect(bar.top + bar.height).toBeLessThanOrEqual(row2.top + 1);

    await startCapture(page);
    await rightClickElement(page, '#boardTabs [data-board-tab="Gossiping"]');
    await expect(tabs(page).locator('[data-board-tab]')).toHaveText(['Stock', 'Test']);
    // 現在這個板點了不送；點 Stock ⇒ s（＋保證整幀重繪的 \f），板名要等 prompt 才送。
    await tabs(page).locator('[data-board-tab="Test"]').click();
    await tabs(page).locator('[data-board-tab="Stock"]').click();
    await expect.poll(() => peekCapture(page)).toContain('s');
    expect(await takeCapture(page)).toBe('s\f');
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    await boot(page, { enableBoardTabs: false });
    await drawList(page, 'Test');
    await expect(page.locator('#mainContainer')).toContainText('Test');
    await expect(tabs(page)).toHaveCount(0);
  });
});
