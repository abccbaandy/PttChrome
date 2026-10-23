// 更新後的新功能小卡（src/js/whats_new.js、docs/whats-new.md）：主功能表右下角，不是 modal。
// 真瀏覽器才驗得出：README chunk 真的動態載得到、焦點留在 #t、卡片開著打字照常送 PTT、
// 點卡片不變成點終端機。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');

const SEEN_KEY = 'pttchrome.whatsNew.seen.v1';
const card = (page) => page.locator('#whatsNewCard');

async function boot(page, seen) {
  await bootOffline(page, ptt);
  await page.evaluate(
    ({ key, seen }) => {
      if (seen) localStorage.setItem(key, JSON.stringify(seen));
      else localStorage.removeItem(key);
    },
    { key: SEEN_KEY, seen }
  );
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

test.describe('更新後的新功能小卡', () => {
  test('第一次用 ⇒ 不出現，默默記下整份清單', async ({ page }) => {
    await boot(page, null);
    await drawMainMenu(page);
    await expect
      .poll(() => page.evaluate((k) => (JSON.parse(localStorage.getItem(k)) || []).length, SEEN_KEY))
      .toBeGreaterThan(30);
    await expect(card(page)).toHaveCount(0);
  });

  test('有沒看過的功能 ⇒ 主功能表右下角出現；打字照送 PTT、點 ✕ 收起且不送鍵', async ({ page }) => {
    await boot(page, []);
    await drawMainMenu(page);
    await expect(card(page)).toBeVisible();
    await expect(page.locator('#t')).toBeFocused();

    await startCapture(page);
    await page.keyboard.press('x');
    await expect.poll(() => peekCapture(page)).toContain('x');
    expect(await takeCapture(page)).toBe('x');

    await startCapture(page);
    await card(page).locator('.whatsNewAll').click();
    await expect(card(page).locator('li').first()).toBeVisible();
    await card(page).locator('.whatsNewClose').click();
    await expect(card(page)).toHaveCount(0);
    expect(await takeCapture(page)).toBe('');
    await expect(page.locator('#t')).toBeFocused();
  });
});
