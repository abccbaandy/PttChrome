// 畫面健全性（不跑版／不亂碼）—— offline 逐卷版。
//
// 同一個檢查器（helpers/screen_sanity.js）也是 live 核心 e2e 的主斷言；這裡先在所有
// 錄好的素材上跑一遍，有兩個用途：
//   1. 每一卷素材都是「某個時間點的真 PTT 畫面」，新錄進來的版面／協定只要渲染出錯，
//      不必連線就會在這裡紅（live 只能跑一輪，offline 才能反覆修到綠）。
//   2. 守住檢查器本身有牙齒：故意把 DOM 弄壞，三種檢查都要報出來（否則 live 那條就是
//      恆綠的擺設）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassettes,
  findCassette,
  loadCassette,
  bootOffline,
  replayCassette,
  replayListCassette,
} = require('../helpers/replay');
const { screenSanity, describeSanity, expectScreenSane: expectSane } = require('../helpers/screen_sanity');

const articles = findCassettes('article');
const list = findCassette('list');
const nav = loadCassette('cchat-list-nav');

test.describe('畫面健全性（離線逐卷）', () => {
  test('看板列表（原生）', async ({ page }) => {
    test.skip(!list, '尚無 list cassette');
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await replayCassette(page, list, { easyReading: false });
    expectSane(await screenSanity(page), list.__file);
  });

  // 列表好讀（預設開）：檢查的是捲動視窗（_listWindowLines），不是原生 24 列。
  test('看板列表（列表好讀捲動視窗）', async ({ page }) => {
    test.skip(!nav, '尚無 cchat-list-nav cassette');
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true });
    await page.waitForFunction(
      () =>
        window.__app.listSession.state === 'active' &&
        window.__app.buf.listRenderMode === 'buffer' &&
        window.__app.commandQueue.idle &&
        (window.__app.buf.listLines || []).length > 40
    );
    const r = await screenSanity(page);
    expect(r.listWindow, describeSanity(r, 'list window')).toBe(true);
    expect(r.checked).toBeGreaterThan(40);
    expectSane(r, 'list window');
  });

  for (const article of articles) {
    test(`文章原生 [${article.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: false });
      await replayCassette(page, article, { easyReading: false });
      expectSane(await screenSanity(page), `${article.__file} native`);
    });

    test(`文章好讀 [${article.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        // 合併同作者推文會把多列併成一塊，DOM 不再是逐列對應 buf；那條路徑另由
        // comment_merge.offline.spec.js 守。
        mergeSameAuthorComments: false,
      });
      await replayCassette(page, article, { easyReading: true });
      const r = await screenSanity(page);
      expect(r.er, describeSanity(r, article.__file)).toBe(true);
      expectSane(r, `${article.__file} easy-reading`);
    });
  }

  // 檢查器的牙齒：三種破壞各自要被抓到（突變驗證寫成常駐測試）。
  test('檢查器會抓到：漏字／格線位移／水平溢出', async ({ page }) => {
    test.skip(!list, '尚無 list cassette');
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await replayCassette(page, list, { easyReading: false });
    expectSane(await screenSanity(page), 'baseline');

    // 1) 格線：某一列的字距被撐開（＝字型 fallback／全形寬度沒對齊的效果）。
    await page.evaluate(() => {
      const el = document.querySelector('#mainContainer [data-type="bbsline"][data-row="3"]');
      el.style.letterSpacing = '1px';
    });
    const grid = await screenSanity(page);
    expect(grid.gridMisaligned.map((g) => g.row)).toContain(3);

    // 2) 漏字：DOM 少一個字。
    await page.evaluate(() => {
      const el = document.querySelector('#mainContainer [data-type="bbsline"][data-row="4"]');
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n && !n.data.trim()) n = walker.nextNode();
      n.data = n.data.replace(/\S/, '');
    });
    const text = await screenSanity(page);
    expect(text.textMismatch.map((m) => m.row)).toContain(4);

    // 3) 水平溢出。
    await page.evaluate(() => {
      const el = document.querySelector('#mainContainer [data-type="bbsline"][data-row="5"]');
      el.style.display = 'inline-block';
      el.style.width = '5000px';
    });
    const overflow = await screenSanity(page);
    expect(overflow.horizontalOverflow).toBeGreaterThan(0);

    // 4) 亂碼：buf 裡塞一對查不到 Unicode 的 Big5（0x81 0x30：trail 不在合法區間）。
    await page.evaluate(() => {
      const line = window.__app.buf.lines[6];
      line[40].ch = '\x81';
      line[40].isLeadByte = true;
      line[41].ch = '\x30';
    });
    const garbled = await screenSanity(page);
    expect(garbled.decodeFail.map((d) => d.row)).toContain(6);
  });
});
