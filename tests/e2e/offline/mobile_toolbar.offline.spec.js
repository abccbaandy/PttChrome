// 手機底部工具列（docs/mobile.md「底部工具列」）：tap 不叫鍵盤、按鈕依畫面顯示、
// 按鍵面板送鍵、黏滯 Ctrl、終端機排在工具列／面板上方。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬：hasTouch + isMobile ⇒
// pointer: coarse、hover: none），`offline` project 以 testIgnore 排除。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette, waitScreenSettled } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const articles = findCassettes('article');

const inputMode = (page) => page.evaluate(() => document.getElementById('t').getAttribute('inputmode'));
const focusedIsT = (page) => page.evaluate(() => document.activeElement === document.getElementById('t'));
const scrollTop = (page) => page.evaluate(() => window.__app.view.mainDisplay.scrollTop);
const byKey = (page, k) => page.locator(`[data-key="${k}"]`);

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 文章列表一整幀（指紋同 article_search.offline.spec.js）。
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

// 終端機最後一列的下緣（CSS px）。
const lastRowBottom = (page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('#mainContainer [data-type="bbsline"]');
    const r = rows[rows.length - 1].getBoundingClientRect();
    return r.bottom;
  });

test.describe('手機底部工具列（離線重放）', () => {
  test('裝置偵測：模擬手機 ⇒ mobile 模式、#t inputmode=none、工具列常駐、面板收起', async ({ page }) => {
    await bootOffline(page, ptt);
    expect(await page.evaluate(() => window.__app.mobile)).toBe(true);
    expect(await inputMode(page)).toBe('none');
    await expect(byKey(page, '__keys')).toBeVisible();
    await expect(byKey(page, '__more')).toBeVisible();
    await expect(byKey(page, 'PageDown')).toHaveCount(0);
  });

  test('文章列表：出現搜尋，沒有推；點搜尋直接開彈窗（不經子選單），四種都能切', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await drawArticleList(page);
    await expect(byKey(page, '__search')).toBeVisible();
    await expect(byKey(page, 'X')).toHaveCount(0);
    await byKey(page, '__search').tap();
    await expect(page.locator('input[name="searchKeyword"]')).toBeVisible();
    const kinds = page.locator('[data-search-modal] .mantine-SegmentedControl-label');
    await expect(kinds).toHaveCount(4);
    // 彈窗開著時工具列收起（同其他 modal）
    await expect(byKey(page, '__keys')).toHaveCount(0);
  });

  test('按鍵面板：送鍵、終端機底列不被工具列／面板蓋住；Ctrl＋p 送 ^P', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await drawArticleList(page);

    const bar = await waitRectStable(page, '.mobileToolbarBar');
    expect(await lastRowBottom(page)).toBeLessThanOrEqual(bar.top + 0.5);

    await byKey(page, '__keys').tap();
    const panel = await waitRectStable(page, '#mobileKeypad');
    // 面板展開 ⇒ 終端機排到面板上方（PTT 的輸入列在底列，不可被蓋住）
    await expect.poll(() => lastRowBottom(page)).toBeLessThanOrEqual(panel.top + 0.5);

    await collectSent(page);
    await byKey(page, 'Escape').tap();
    await expect.poll(() => sentText(page)).toBe('\x1b');

    await collectSent(page);
    await byKey(page, '__ctrl').tap();
    await expect(byKey(page, '__ctrl')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('p');
    await expect.poll(() => sentText(page)).toBe('\x10');
    await expect(byKey(page, '__ctrl')).toHaveAttribute('aria-pressed', 'false');
    expect(await focusedIsT(page)).toBe(true);
  });

  test('更多：選取模式、設定、登出二段確認', async ({ page }) => {
    await bootOffline(page, ptt);
    await byKey(page, '__more').tap();
    await byKey(page, '__select').tap();
    expect(await page.evaluate(() => window.__app.mobileSelectMode)).toBe(true);
    await byKey(page, '__more').tap();
    await byKey(page, '__logout').tap();
    await expect(byKey(page, '__logoutYes')).toBeVisible();
    await byKey(page, '__logoutNo').tap();
    await byKey(page, '__settings').tap();
    await expect(page.locator('.mantine-Modal-content').first()).toBeVisible();
  });

  test.describe('文章好讀', () => {
    test.skip(!articles.length, '尚無 article cassette');

    test('文章裡出現推、沒有搜尋；tap 不叫鍵盤；PgDn 捲動好讀、不搶 #t 焦點；鍵盤鈕切 inputmode', async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, articles[0], { easyReading: true });
      await expect
        .poll(() => page.evaluate(() => window.__app.view.mainDisplay.scrollHeight > window.__app.view.mainDisplay.clientHeight + 50))
        .toBe(true);
      await expect(byKey(page, 'X')).toBeVisible();
      await expect(byKey(page, '__search')).toHaveCount(0);

      // tap 畫面：inputmode 維持 none（tap 不會叫出軟鍵盤）
      const box = await page.locator('#mainContainer').boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + 40);
      expect(await inputMode(page)).toBe('none');

      await byKey(page, '__keys').tap();
      await page.evaluate(() => window.__app.setInputAreaFocus());
      const before = await scrollTop(page);
      await byKey(page, 'PageDown').tap();
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(before);
      expect(await focusedIsT(page)).toBe(true);

      await byKey(page, '__keyboard').tap();
      expect(await inputMode(page)).toBe('text');
      expect(await focusedIsT(page)).toBe(true);
      await byKey(page, '__keyboard').tap();
      expect(await inputMode(page)).toBe('none');
    });
  });
});
