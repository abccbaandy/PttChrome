// 手機設定頁「一般」的段落小標＋跳轉列（P94，js/pref_groups.js）。只在 `offline-mobile`
// project 跑（Pixel 7 模擬）。
//
// 合約：跳轉列六顆鈕比手機螢幕寬（本來就設計成橫滑），但只有跳轉列自己橫滑，不可以把
// 整個「一般」分區撐寬（fieldset 的 min-width 預設是 min-content，一旦生效說明文字就會
// 跑出右欄、右半邊被切掉）。換語系（英文鈕更長）或改跳轉列樣式時由這條把關，
// 只有完整頁面（app 的全域樣式＋手機版面）量得準。
// 小標順序、點鈕捲到哪、亮哪顆在 tests/unit/pref_groups.test.jsx。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw, waitScreenSettled } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openGeneral(page) {
  await bootOffline(page, ptt);
  await feedRaw(page, '\x1b[2J\x1b[H  PREF GROUPS TEST  ');
  await waitScreenSettled(page);
  await page
    .locator('#mainContainer [data-type="bbsline"]')
    .first()
    .click({ button: 'right', position: { x: 40, y: 2 } });
  const menu = page.locator('[data-sheet="context"]').first();
  await expect(menu).toBeVisible();
  await menu.getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
  await expect(page.locator('.PrefModal')).toBeVisible();
  await waitRectStable(page, '.PrefModal');
  await page.locator('[data-pref-category="general"]').click();
  await expect(page.locator('.PrefModal__GroupNav')).toBeVisible();
}

test('「一般」分區不被跳轉列撐寬，說明文字不跑出右欄', async ({ page }) => {
  await openGeneral(page);
  const m = await page.evaluate(() => {
    const box = document.querySelector('.PrefModal__Grid__Col--right');
    const fs = document.querySelector('[data-pref-anchor="section:options_general"]');
    const nav = document.querySelector('.PrefModal__GroupNav');
    return {
      overflow: box.scrollWidth - box.clientWidth,
      fsRight: fs.getBoundingClientRect().right,
      boxRight: box.getBoundingClientRect().right,
      navScrolls: nav.scrollWidth > nav.clientWidth,
    };
  });
  // 前提：跳轉列真的比螢幕寬（不然這條測不到東西）。
  expect(m.navScrolls).toBe(true);
  expect(m.overflow).toBeLessThanOrEqual(0);
  expect(m.fsRight).toBeLessThanOrEqual(m.boxRight);
});
