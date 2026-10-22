// 好讀文章的狀態列 footer（#easyReadingLastRow）的位置。
//
// `.main` 高是 chh*rows+10（term_view.setTermFontSize；那 10px 是 easy_reading._scrollBy 下界
// 的前提，不能拿掉），而桌機的字級只保證 chh*rows 放得進視窗。footer 舊做法貼在 `.main`
// 最下緣 ⇒ 視窗高剛好是列高整數倍附近時（1280×720 就是：30×24＝720），`.main` 下緣在視窗外
// 10px，狀態列被切掉三分之一，推文列又壓在它上面。footer 改成疊在格線最後一列（＝原生
// 狀態列的位置），下面那 10px 由 footer 自己的陰影蓋住。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

const article = findCassette('article');

const measure = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const main = document.querySelector('.main').getBoundingClientRect();
    const footer = document.getElementById('easyReadingLastRow');
    const f = footer.getBoundingClientRect();
    const bar = document.getElementById('commentBar');
    const b = bar ? bar.getBoundingClientRect() : null;
    return {
      innerHeight: window.innerHeight,
      chh: app.view.chh,
      rows: app.buf.rows,
      mainTop: main.top,
      footerDisplay: getComputedStyle(footer).display,
      footerTop: f.top,
      footerBottom: f.bottom,
      barBottom: b ? b.bottom : null,
    };
  });

test.describe('好讀狀態列 footer', () => {
  test.skip(!article, '尚無 article cassette');

  for (const height of [720, 730, 760]) {
    test(`視窗高 ${height}：footer 在格線最後一列、整列在視窗內、推文列在它上面`, async ({ page }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width: 1280, height });
      await bootOffline(page, ptt, { commentBar: true });
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, article, { easyReading: true });
      await waitPreviewsSettled(page);
      await expect.poll(() => page.evaluate(() => !!document.getElementById('commentBar'))).toBe(true);

      const m = await measure(page);
      expect(m.footerDisplay).toBe('block');
      const lastRowTop = m.mainTop + m.chh * (m.rows - 1);
      expect(Math.abs(m.footerTop - lastRowTop)).toBeLessThanOrEqual(1);
      expect(m.footerBottom).toBeLessThanOrEqual(m.innerHeight + 0.5);
      expect(m.barBottom).toBeLessThanOrEqual(m.footerTop + 0.5);
    });
  }
});
