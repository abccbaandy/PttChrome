// 離線文章（原「存到本機」，P64，docs/saved-articles.md）的整合守門（真瀏覽器、離線）。
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

test.describe('離線文章', () => {
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
    expect(await page.evaluate(() => document.title)).toContain('離線文章');
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

  // 指令面板（F4）：好讀文章裡有「存成離線文章」；存了之後清單（IndexedDB，非同步）補進面板，
  // 點一下在同一頁疊唯讀頁（不開新分頁）；Esc（焦點在唯讀頁裡）關掉；「前往線上版本」用後面的連線開那篇。
  test('指令面板：存成離線文章 → 列出 → 點一下開唯讀頁；Esc 關、前往線上版本走 deep link', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    const palette = page.locator('[data-command-palette]');
    const input = page.locator('input[name="commandPaletteQuery"]');
    await page.keyboard.press('F4');
    await expect(input).toBeFocused();
    await input.fill('離線文章');
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
    await expect(item).toContainText('離線文章');
    let popups = 0;
    page.context().on('page', () => popups++);
    await item.click();
    const overlay = page.locator('[data-saved-reader]');
    await expect(overlay).toBeVisible();
    const frame = page.frameLocator('[data-saved-reader] iframe');
    const firstRow = frame.locator('#mainContainer [data-type="bbsline"]').first();
    await expect(firstRow).toContainText('作者');
    // 焦點進唯讀頁（真點擊）再按 Esc：唯讀頁吞掉按鍵，靠 postMessage 請外面關掉。
    await firstRow.click();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);

    // 再開一次，按「前往線上版本」⇒ 唯讀頁收起、用這條連線開那篇（deep link，AID 跳文）。
    await page.keyboard.press('F4');
    await expect(input).toBeFocused();
    await palette.locator(`[data-palette-item="saved:${KEY}"]`).click();
    await expect(overlay).toBeVisible();
    const requested = page.evaluate(
      () =>
        new Promise((resolve) => {
          const dl = window.__app.deepLinkController;
          const orig = dl.request.bind(dl);
          dl.request = (t, o) => {
            resolve({ board: t.board, aid: t.aid });
            return orig(t, o);
          };
        })
    );
    await page.locator('[data-key="__savedReaderOnline"]').click();
    expect(await requested).toEqual({ board: 'Stock', aid: '1g8znzQ3' });
    await expect(overlay).toHaveCount(0);
    expect(popups).toBe(0);
  });

  // 回歸：APK 的 WebView 開不了新分頁（window.open 被原生轉交外部瀏覽器、本站網址又被 App Link
  // 解析回 App ⇒ 點了沒反應）。唯讀頁一律在同一頁疊全螢幕 iframe：不開新分頁、活連線不動，關掉／系統返回回原畫面。
  test('APK：點存檔 ⇒ 同一頁開唯讀頁（不開新分頁），關閉與返回都回原畫面', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    await page.evaluate(() => window.__app.savedArticles.saveCurrent());
    // 只開 bridge 的宣告（同 mobile_toolbar spec）：isAndroidApp() 在點擊當下現讀。
    await page.evaluate(() => {
      window.__PTT_ANDROID__ = Object.freeze({ version: 'e2e', site: '' });
      window.PttAndroid = { postMessage() {}, addEventListener() {} };
    });
    let popups = 0;
    page.context().on('page', () => popups++);

    const input = page.locator('input[name="commandPaletteQuery"]');
    const palette = page.locator('[data-command-palette]');
    const overlay = page.locator('[data-saved-reader]');
    const openFromPalette = async () => {
      await page.keyboard.press('F4');
      await expect(input).toBeFocused();
      const item = palette.locator(`[data-palette-item="saved:${KEY}"]`);
      await expect(item).toBeVisible();
      await item.click();
      await expect(overlay).toBeVisible();
    };

    await openFromPalette();
    await expect(overlay).toHaveAttribute('data-saved-reader', KEY);
    const frame = page.frameLocator('[data-saved-reader] iframe');
    await expect(frame.locator('#mainContainer [data-type="bbsline"]').first()).toContainText('作者');
    const inner = page.frames().find((fr) => /[?&]saved=/.test(fr.url()));
    expect(inner).toBeTruthy();
    expect(await inner.evaluate(() => window.__app.view.conn)).toBeUndefined();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);
    // 後面的活連線原封不動。
    expect(await page.evaluate(() => window.__app.isConnected())).toBe(true);

    await page.locator('[data-key="__savedReaderClose"]').click();
    await expect(overlay).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);

    // 系統返回（真 popstate）＝關掉唯讀頁，不送 ←。
    await openFromPalette();
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
    await page.evaluate(() => {
      window.__sent = [];
      window.__stubWSSent = (x) => window.__sent.push(x);
    });
    await page.goBack();
    await expect(overlay).toHaveCount(0);
    expect(await page.evaluate(() => (window.__sent || []).join(''))).not.toContain('\x1b[D');
    expect(popups).toBe(0);
  });

  // 設定 → 設定備份「本機收藏」：匯出的檔案（真下載）刪光後再匯入，同一篇回來。
  test('匯出本機收藏 → 刪掉 → 匯入檔案 ⇒ 同一篇回來', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);
    await page.evaluate(() => window.__app.savedArticles.saveCurrent());
    await page.keyboard.press('F4');
    await page.locator('input[name="commandPaletteQuery"]').fill('設定');
    await page.locator('[data-palette-item="action:settings"]').click();
    await page.getByRole('tab', { name: '設定備份' }).click();
    const download = page.waitForEvent('download');
    await page.locator('[data-saved-export]').click();
    const file = await (await download).path();
    await expect(page.locator('[data-saved-backup-result]')).toHaveText('已匯出 1 篇。');

    await page.evaluate((key) => window.__app.savedArticles.remove(key), KEY);
    expect(await page.evaluate(() => window.__app.savedArticles.list())).toEqual([]);
    await page.locator('input[name="savedImportFile"]').setInputFiles(file);
    await expect(page.locator('[data-saved-backup-result]')).toHaveText('已匯入：新增 1 篇、更新 0 篇。');
    const list = await page.evaluate(() => window.__app.savedArticles.list());
    expect(list.map((m) => m.key)).toEqual([KEY]);
  });

  test('找不到的存檔 ⇒ 錯誤提示、不連線', async ({ page }) => {
    await bootOffline(page, ptt);
    await watchSockets(page);
    await page.goto('/?saved=' + encodeURIComponent('test/1aaaaaaa'));
    await expect(page.locator('body')).toContainText('找不到這篇離線文章');
    expect(await page.evaluate(() => window.__wsOpened)).toBe(0);
    // 對照組：一般開站真的會被數到（不然上面的 0 什麼都沒證明）。
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.__wsOpened)).toBeGreaterThan(0);
  });
});
