// 好讀文章底部常駐推文列（src/js/comment_bar.js、docs/long-push.md「底部常駐推文列」）：
// 好讀讀文章 ⇒ 終端機最下面疊一條「推／噓／→＋文字」輸入列。只有真瀏覽器驗得出來：
// 列真的與終端機同寬、捲到底時最後一列不被它蓋住（累積頁尾端多留的空白）、在列裡打字
// 一個 byte 都不送給 PTT（焦點真的在列上、終端機不搶回）、Enter 真的接上長推文的探路。
// 送出之後的分段／冷卻／錯誤處理整條沿用長推文，守在 long_push.offline.spec.js。
// 素材 stock-huang（49 則推文的長文）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitRectStable, waitScrollStable } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const VIEWPORT = { width: 1280, height: 800 };

const bar = (page) => page.locator('#commentBar');
const input = (page) => page.locator('#commentBar [name="commentBarText"]');

async function boot(page, prefs, opts = {}) {
  await page.setViewportSize(VIEWPORT);
  await bootOffline(page, ptt, { commentBar: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: opts.easyReading !== false });
  await waitPreviewsSettled(page);
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

test.describe('底部常駐推文列', () => {
  test('好讀文章 ⇒ 列出現、與終端機同寬；捲到底最後一列在列的上方', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await expect(bar(page)).toBeVisible();
    const term = await waitRectStable(page, '#BBSWindow > .main');
    const box = await waitRectStable(page, '#commentBar');
    expect(Math.abs(box.left - term.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - term.width)).toBeLessThanOrEqual(1);
    expect(box.top + box.height).toBeLessThanOrEqual(term.top + term.height + 1);

    await page.evaluate(() => {
      const el = window.__app.view.mainDisplay;
      el.scrollTop = el.scrollHeight;
    });
    await waitScrollStable(page, '#BBSWindow > .main');
    await waitPreviewsSettled(page);
    const last = await page.evaluate(() => {
      const rows = document.querySelectorAll('#mainContainer [type="bbsrow"][srow]');
      return Math.max(...Array.from(rows, (r) => Number(r.getAttribute('srow'))));
    });
    const lastBox = await waitRectStable(page, `#mainContainer [type="bbsrow"][srow="${last}"]`);
    const barBox = await waitRectStable(page, '#commentBar');
    expect(lastBox.top + lastBox.height).toBeLessThanOrEqual(barBox.top + 1);
  });

  test('在列裡打字不送鍵；Enter ⇒ 接上長推文探路，列清空', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await expect(bar(page)).toBeVisible();
    await input(page).click();
    await expect(input(page)).toBeFocused();
    await startCapture(page);
    // 英文字母在終端機上都是 PTT 的指令鍵：漏一個就是真的在 PTT 上做了事。
    await page.keyboard.type('qabc ');
    await page.keyboard.insertText('測試');
    await expect(input(page)).toHaveValue('qabc 測試');
    // Enter 本身就是柵欄：打字時若同步送了 byte，一定排在探路的 X 前面而被抓到。
    await page.keyboard.press('Enter');
    await expect.poll(() => peekCapture(page)).toContain('X');
    const sent = await takeCapture(page);
    expect(sent.slice(0, sent.indexOf('X'))).not.toMatch(/[qabc]/);
    await expect(page.getByText(await page.evaluate(() => window.__i18n('longPushProgress_preflight')))).toBeVisible();
    // 列在送出期間（functionMode）收起；回來時輸入框是空的。
    expect(await page.evaluate(() => window.__app.longPush.active)).toBe(true);
  });

  test('Esc ⇒ 離開列，焦點回終端機', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await input(page).click();
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('原生 pmore（好讀關）⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableEasyReading: false }, { easyReading: false });
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
    await expect(bar(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableCommentBar: false });
    expect(await page.evaluate(() => window.__app.buf.pageLines.length)).toBeGreaterThan(0);
    await expect(bar(page)).toHaveCount(0);
  });
});
