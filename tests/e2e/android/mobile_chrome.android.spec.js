// 真 Android Chrome（模擬器）上的手機版外殼：bottom sheet＋系統返回、好讀文章換行版面、App Bar。
// 桌機 offline-mobile（Pixel 7 模擬）已經守同一組行為（mobile_sheet／mobile_reflow／mobile_app_bar），
// 這裡守它們摸不到的那層（docs/mobile.md Phase 3／6／8／9 原本只標「真機 guess」）：
//   1. 系統返回是 OS 的 KEYCODE_BACK（不是 page.goBack()），而且 sheet 開著時焦點在 Mantine
//      Drawer 的 focus trap 裡 —— 要確認真的變成 popstate、被 dismissTopSheet 接住，不送 ←；
//   2. 換行版面在真 Chrome 的 viewport 下（網址列、系統列、真 DPR、真字型）不橫向溢出、
//      長列真的折行，且終端機不被 App Bar／底部導覽蓋住、收起列真的收起。
// 觸控與按鍵一律走 OS 的 input injection（screen.js）。
const { test, expect, envError } = require('./fixtures');
const {
  article,
  openScreen,
  recordTouches,
  recordBackGuard,
  backGuardDiag,
  waitOnSentinel,
  tap,
  keyevent,
  collectSent,
  sentText,
} = require('./screen');

const MORE_SHEET = '[data-sheet="more"]';

// 左鍵關掉：真 tap 落在終端機上時不可以自己送鍵（左側退出帶、邊緣翻頁）。
const PREFS = { mouseLeftClick: false };

// 好讀需要一屏＝cassette 的列數（24）。Pixel 6 原生 49 列 ⇒ 縮螢幕高（同 list_card_blacklist）。
const SHORT_SCREEN = 'wm size 1080x1400';

const layout = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const main = document.querySelector('.main');
    const r = main.getBoundingClientRect();
    const chh = app.view.chh;
    const rows = Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]'));
    const lines = document.querySelectorAll('#mainContainer [data-type="bbsline"]');
    const bar = document.getElementById('mobileAppBar');
    const tb = document.querySelector('.mobileToolbarBar');
    return {
      reflow: app.view.reflow,
      cls: main.classList.contains('mobileReflow'),
      chh,
      rows: app.buf.rows,
      mainTop: r.top,
      mainLeft: r.left,
      mainWidth: r.width,
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      wrapped: rows.filter(
        (el) => !el.querySelector('.inlinePreviewSlot, img, video, iframe') && el.getBoundingClientRect().height > chh * 1.5
      ).length,
      firstLineTop: lines.length ? lines[0].getBoundingClientRect().top : null,
      barBottom: bar ? bar.getBoundingClientRect().bottom : null,
      toolbarTop: tb ? tb.getBoundingClientRect().top : null,
      title: app.view._articleTitle,
      // 好讀的 80 欄狀態列是 #easyReadingLastRow；檔頭分隔線收成 0 高（檔頭改卡片）。
      footerShown: (() => {
        const f = document.getElementById('easyReadingLastRow');
        return !!f && getComputedStyle(f).display !== 'none';
      })(),
      ruleH: (() => {
        const rule = document.querySelector('#mainContainer .articleMetaRule');
        return rule ? rule.getBoundingClientRect().height : null;
      })(),
    };
  });

test.describe('Android Chrome：bottom sheet、換行版面、App Bar（真觸控／真按鍵）', () => {
  test.skip(!article, '尚無 article cassette');

  test('更多 sheet：真 tap 打開；系統返回鍵只收 sheet，不送 ←、留在站內、sentinel 補回', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page, PREFS);
    await recordTouches(page);

    // 這一下真觸控也是第一層 sentinel 疊上去的時機（mobile_input 已實測 Chrome 113 不會跳過）。
    await tap(page, device, '[data-key="__more"]');
    await expect(page.locator(MORE_SHEET)).toBeVisible();
    await waitOnSentinel(page);
    // 開 sheet 之後才開始記：只看返回鍵這一下造成的事。
    await recordBackGuard(page);
    await collectSent(page);
    const url = page.url();

    await keyevent(device, 'KEYCODE_BACK');
    await expect(page.locator(MORE_SHEET), await backGuardDiag(page)).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);
    // 補回 sentinel 是非同步的（guard 走 history.forward()）；等它回來再判「沒送鍵」才不會判早了。
    await waitOnSentinel(page, { timeout: 10000 });
    expect(await sentText(page)).toBe('');
    const diag = JSON.parse(await backGuardDiag(page));
    expect(diag.navs, '收 sheet 不可以交給送鍵出口').toEqual([]);
    expect(diag.hints, '收 sheet 不可以出逃生提示').toEqual([]);
    expect(page.url()).toBe(url);
  });

  test('好讀文章換行版面：不橫向溢出、長列折行；終端機在兩條 bar 之間、狀態列收起', async ({ page, android }) => {
    test.setTimeout(180000);
    const { device } = android;
    await device.shell(SHORT_SCREEN);
    try {
      await openScreen(page, { ...PREFS, enableEasyReading: true });
      const rows = await page.evaluate(() => window.__app.buf.rows);
      if (rows !== ((article && article.rows) || 24)) {
        throw envError(`手機版面 rows=${rows}，對不上 cassette（wm size 沒把螢幕縮夠矮？）`);
      }
      await expect.poll(() => page.evaluate(() => window.__app.view.reflow), { timeout: 20000 }).toBe(true);
      // 換行後版面還會因字型、預覽佔位盒落地再動：連兩次量到一樣才判。
      let g = await layout(page);
      await expect
        .poll(async () => {
          const prev = g;
          g = await layout(page);
          return JSON.stringify(prev) === JSON.stringify(g);
        }, { timeout: 15000 })
        .toBe(true);

      expect(g.cls).toBe(true);
      expect(g.chh).toBeLessThanOrEqual(16);
      expect(Math.abs(g.mainWidth - g.innerWidth)).toBeLessThanOrEqual(1);
      expect(g.mainLeft).toBeGreaterThanOrEqual(-0.5);
      expect(g.mainScrollWidth).toBeLessThanOrEqual(g.mainClientWidth + 1);
      expect(g.docScrollWidth).toBeLessThanOrEqual(g.innerWidth);
      expect(g.wrapped).toBeGreaterThan(0);

      // App Bar（Phase 6）：標題＝文章標題；終端機與第一列都在它下面、底部導覽上面。
      expect(g.title).toBeTruthy();
      await expect(page.locator('#mobileAppBar [data-key="__title"]')).toHaveText(g.title);
      expect(g.barBottom).not.toBeNull();
      expect(g.mainTop).toBeGreaterThanOrEqual(g.barBottom - 0.5);
      expect(g.firstLineTop).toBeGreaterThanOrEqual(g.barBottom - 0.5);
      expect(g.toolbarTop).not.toBeNull();
      // 收起標頭列（Phase 8）：80 欄狀態列不顯示、檔頭分隔線收成 0 高。
      expect(g.footerShown).toBe(false);
      expect(g.ruleH).toBe(0);
    } finally {
      await device.shell('wm size reset');
    }
  });
});
