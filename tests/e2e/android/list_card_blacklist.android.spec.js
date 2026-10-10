// 真 Android Chrome（模擬器）上長按文章列表卡片 → 黑名單快速新增。
// 卡片整張是同一組點選目標：長按落在卡片的哪一段（序號・日期／作者／標題）都要同時給
// 「加入黑名單 '作者'」與「加入標題黑名單」（context_menu_items.listBlacklistTargets）。
// 桌機 offline 那支（mobile_list_cards）只能手捏 contextmenu；這裡走 OS 層真長按，
// 守「真手指按下去，contextmenu 的 target 真的落在卡片裡」這一段。
const { test, expect, webviewOrigin } = require('./fixtures');
const { openListCards, recordTouches, checkLanding } = require('./screen');
const { toDevicePoint } = require('./android_env');
const { loadCassette } = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');
const CONTEXT_SHEET = '[data-sheet="context"]';

// Pixel 6 原生 2400 高 ⇒ 手機版面 49 列。縮到 1400（≈533 CSS px）扣掉系統列、Chrome 網址列、
// App Bar、底部導覽後列數低於下限 ⇒ 夾在 24，對上 cassette。
const SHORT_SCREEN = 'wm size 1080x1400';

// 視口內（卡片捲動容器可見範圍、底部導覽之上）第一張有作者的卡片裡，指定段落的中心。
const segmentPoint = (page, cls) =>
  page.evaluate((cls) => {
    const v = document.querySelector('#mainContainer .listBodyView');
    const vr = v.getBoundingClientRect();
    const bar = document.querySelector('.mobileToolbarBar');
    const bottom = Math.min(vr.bottom, bar ? bar.getBoundingClientRect().top : innerHeight) - 4;
    for (const card of v.querySelectorAll('.listCard[data-list-author][data-list-title]')) {
      const el = card.querySelector('.' + cls);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top < vr.top + 4 || r.bottom > bottom || !r.width) continue;
      return {
        x: r.left + Math.min(r.width / 2, 24),
        y: r.top + r.height / 2,
        dpr: devicePixelRatio,
        author: card.getAttribute('data-list-author'),
      };
    }
    return null;
  }, cls);

test.describe('Android Chrome：長按列表卡片 → 黑名單（真觸控）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('長按卡片的序號・日期／作者／標題 ⇒ 都同時出現作者與標題黑名單選項', async ({ page, android }) => {
    test.setTimeout(180000);
    const { device } = android;
    await device.shell(SHORT_SCREEN);
    try {
      await openListCards(page, nav);
      const [addAuthor, addTitle] = await page.evaluate(() => [
        window.__i18n('cmenu_addAuthorBlacklist'),
        window.__i18n('cmenu_addTitleBlacklist'),
      ]);
      await recordTouches(page);
      const sheet = page.locator(CONTEXT_SHEET);
      const items = sheet.locator('[data-cmenu]');

      let presses = 0;
      for (const cls of ['listCardInfo', 'listCardAuthor', 'listCardTitleText']) {
        const pt = await segmentPoint(page, cls);
        expect(pt, `視口內找不到 .${cls}`).not.toBeNull();
        const origin = await webviewOrigin(device);
        const p = toDevicePoint(origin, pt.dpr, pt);
        // 真長按：OS 層按住 1.2s（Android 長按門檻 500ms）。
        await device.shell(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} 1200`);
        await checkLanding(page, pt, origin, ++presses);

        await expect(sheet, `長按 .${cls} 沒開選單`).toBeVisible();
        const authorItem = items.filter({ hasText: addAuthor });
        await expect(authorItem, `長按 .${cls}：缺作者黑名單`).toBeVisible();
        await expect(authorItem).toContainText(pt.author);
        await expect(items.filter({ hasText: addTitle }), `長按 .${cls}：缺標題黑名單`).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
      }
    } finally {
      await device.shell('wm size reset');
    }
  });
});
