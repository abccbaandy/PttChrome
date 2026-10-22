// 設定頁（桌機兩欄版）的版面：左欄固定 160px，裡面的字不可以被切掉。
// 英文的「Restore defaults」曾經在按鈕裡被截成「Restore defau」（Mantine Button 的 label
// 是 nowrap＋overflow hidden）。只有完整頁面（Mantine 全域樣式＋PrefModal.css）量得到。
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openSettings(page) {
  await installReplay(page);
  await page.goto('/');
  await waitConnected(page);
  await feedRaw(page, '\x1b[2J\x1b[H  PREF LAYOUT TEST LINE  ');
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
  await page
    .locator('.DropdownMenu')
    .first()
    .getByText(await label(page, 'cmenu_settings'), { exact: true })
    .click();
  await expect(page.locator('.PrefModal')).toBeVisible();
}

test('左欄的分頁與「還原預設值」字都完整顯示', async ({ page }) => {
  await openSettings(page);
  const reset = page.locator('.PrefModal__Grid__Col--left__Reset');
  await expect(reset).toBeVisible();
  const clipped = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '.PrefModal__Grid__Col--left .mantine-Tabs-tabLabel, .PrefModal__Grid__Col--left__Reset .mantine-Button-label'
      )
    )
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent)
  );
  expect(clipped).toEqual([]);
});
