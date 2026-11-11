// 存到本機（P64，docs/saved-articles.md）的整合守門（真瀏覽器、離線）。
//
// 守 unit 摸不到的接線：
//   1. 好讀讀完一篇（stock-huang，有文末網址列）→ savedArticles.saveCurrent() 存進真 IndexedDB；
//   2. 另開 `?saved=<key>` 唯讀頁：不連線（沒有任何 WebSocket）、畫出來的就是那一篇
//      （逐列文字＝存之前的累積頁、推文樓層照好讀標註）；
//   3. 找不到的 key ⇒ 一行錯誤提示、一樣不連線。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const KEY = 'stock/1g8znzQ3';

// 畫面上每一列的文字（[data-type=bbsline]，含分塊裡的列）。
const renderedTexts = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    return (app.view._staticRows || app.buf.pageLines).map((_, r, acc) =>
      app.buf.getRowText(r, 0, app.buf.cols, acc).replace(/\s+$/, '')
    );
  });

// 唯讀頁開機前記下有沒有人開 BBS 的 WebSocket（bootOffline 的 stub 也算：唯讀頁根本不該連）。
// dev server 的 HMR 也是 WebSocket（vite client），不算。
async function watchSockets(page) {
  await page.addInitScript(() => {
    window.__wsOpened = 0;
    const Orig = window.WebSocket;
    window.WebSocket = function (...args) {
      const protocols = String(args[1] || '');
      if (protocols.indexOf('vite') < 0) window.__wsOpened++;
      return new Orig(...args);
    };
    window.WebSocket.prototype = Orig.prototype;
  });
}

test.describe('存到本機', () => {
  test('好讀文章存起來 → 唯讀頁不連線、畫出同一篇', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    expect(await page.evaluate(() => window.__app.savedArticles.canSave())).toBe(true);
    const before = await renderedTexts(page);
    const res = await page.evaluate(() => window.__app.savedArticles.saveCurrent());
    expect(res).toEqual({ ok: true, replaced: false });
    // 同一篇再存＝覆蓋。
    expect(await page.evaluate(() => window.__app.savedArticles.saveCurrent())).toEqual({
      ok: true,
      replaced: true,
    });
    const list = await page.evaluate(() => window.__app.savedArticles.list());
    expect(list.map((m) => m.key)).toEqual([KEY]);

    await watchSockets(page);
    await page.goto('/?saved=' + encodeURIComponent(KEY));
    await expect
      .poll(() => page.evaluate(() => !!(window.__app && window.__app.view._staticRows)))
      .toBe(true);
    expect(await renderedTexts(page)).toEqual(before);
    // 畫的是好讀累積頁的版本：列數＝存檔列數，第一列是檔頭。
    await expect(page.locator('#mainContainer [data-type="bbsline"]').first()).toContainText('作者');
    expect(await page.evaluate(() => document.title)).toContain('本機收藏');
    expect(await page.evaluate(() => window.__wsOpened)).toBe(0);
    expect(await page.evaluate(() => window.__app.view.conn)).toBeUndefined();

    // 鍵盤只拿來捲動（staticReaderKey）：End 到底、Home 回頂。
    const scroll = () =>
      page.evaluate(() => {
        const d = window.__app.view.mainDisplay;
        return { top: d.scrollTop, max: d.scrollHeight - d.clientHeight };
      });
    expect((await scroll()).max).toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect.poll(async () => { const s = await scroll(); return s.top >= s.max - 1; }).toBe(true);
    await page.keyboard.press('Home');
    await expect.poll(async () => (await scroll()).top).toBe(0);
  });

  // 指令面板（F4）：好讀文章裡有「存到本機」；存了之後清單（IndexedDB，非同步）補進面板，
  // 點一下在新分頁開唯讀頁。
  test('指令面板：存到本機 → 列出存檔 → 點一下開唯讀頁', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    const palette = page.locator('[data-command-palette]');
    const input = page.locator('input[name="commandPaletteQuery"]');
    await page.keyboard.press('F4');
    await expect(input).toBeFocused();
    await input.fill('存到本機');
    await expect(palette.locator('[data-palette-item]').first()).toHaveAttribute(
      'data-palette-item',
      'action:saveArticle'
    );
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.__app.savedArticles.list().then((l) => l.map((m) => m.key))))
      .toEqual([KEY]);

    await page.keyboard.press('F4');
    await expect(input).toBeFocused();
    const item = palette.locator(`[data-palette-item="saved:${KEY}"]`);
    await expect(item).toBeVisible();
    await expect(item).toContainText('本機收藏');
    const popup = page.context().waitForEvent('page');
    await item.click();
    const reader = await popup;
    await expect(reader).toHaveURL(new RegExp('[?&]saved=' + encodeURIComponent(KEY)));
    await expect
      .poll(() => reader.evaluate(() => !!(window.__app && window.__app.view._staticRows)))
      .toBe(true);
  });

  test('找不到的存檔 ⇒ 錯誤提示、不連線', async ({ page }) => {
    await bootOffline(page, ptt);
    await watchSockets(page);
    await page.goto('/?saved=' + encodeURIComponent('test/1aaaaaaa'));
    await expect(page.locator('body')).toContainText('找不到這篇本機存檔');
    expect(await page.evaluate(() => window.__wsOpened)).toBe(0);
    // 對照組：一般開站真的會被數到（不然上面的 0 什麼都沒證明）。
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.__wsOpened)).toBeGreaterThan(0);
  });
});
