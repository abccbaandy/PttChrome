// 更新後的新功能介紹（src/js/whats_new.js、docs/whats-new.md）：儀表板沒開時是主功能表右下角小卡，
// 儀表板開著時是儀表板最上面的「這次更新」區塊（P71）；都不是 modal。
// 真瀏覽器才驗得出：README chunk 真的動態載得到、焦點留在 #t、卡片開著打字照常送 PTT、
// 點卡片不變成點終端機；儀表板背景抓我的最愛（畫面離開主功能表）時區塊不消失、「⚙ 設定」真的開到那個開關。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { drawFavorites } = require('../helpers/home_screens');
const { waitRectStable } = require('../helpers/layout');

const SEEN_KEY = 'pttchrome.whatsNew.seen.v1';
const card = (page) => page.locator('#whatsNewCard');

const seenCount = (page) =>
  page.evaluate((k) => (JSON.parse(localStorage.getItem(k)) || []).length, SEEN_KEY);

async function boot(page, seen, opts) {
  await bootOffline(page, ptt, opts);
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

  test('離開主功能表只是暫時藏起來，回主功能表還在；沒按 ✕ 不記成看過', async ({ page }) => {
    await boot(page, []);
    await drawMainMenu(page);
    await expect(card(page)).toBeVisible();
    await drawFavorites(page, [{ name: 'Stock', desc: '[股票] 測試', unread: false }]);
    await expect(card(page)).toHaveCount(0);
    await drawMainMenu(page);
    await expect(card(page)).toBeVisible();
    expect(await seenCount(page)).toBe(0);
  });

  test('有沒看過的功能 ⇒ 主功能表右下角出現；打字照送 PTT、點 ✕ 收起、記成看過且不送鍵', async ({ page }) => {
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
    expect(await seenCount(page)).toBeGreaterThan(30);
  });
});

test.describe('首頁儀表板的「這次更新」（P71）', () => {
  const section = (page) => page.locator('[data-home-whats-new]');

  test('畫在儀表板最上面、沒有小卡；背景抓我的最愛時不消失；「⚙ 設定」開到那個開關', async ({ page }) => {
    await boot(page, [], { homeDashboard: true });
    await startCapture(page);
    await drawMainMenu(page);
    await expect(section(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // 區塊是儀表板裡的第一個 section
    expect(
      await page.evaluate(() =>
        document.querySelector('#homeDashboard .homeSection').hasAttribute('data-home-whats-new')
      )
    ).toBe(true);

    // 儀表板自動 Ctrl+Z f ⇒ 畫面離開主功能表（這一下以前會讓小卡被收掉並記成看過）。
    await expect.poll(() => peekCapture(page)).toContain('f');
    await drawFavorites(page, [{ name: 'Stock', desc: '[股票] 測試', unread: false }]);
    await expect(section(page)).toBeVisible();
    await drawMainMenu(page);
    await expect(section(page)).toBeVisible();
    expect(await seenCount(page)).toBe(0);
    await takeCapture(page);

    const btn = section(page).locator('[data-home-whats-new-setting="enableCommentFilter"]');
    await btn.click();
    await expect(page.locator('.PrefModal')).toBeVisible();
    const target = page.locator('[data-pref-anchor="enableCommentFilter"]');
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/PrefModal__Anchor--flash/);
    await waitRectStable(page, '[data-pref-anchor="enableCommentFilter"]');
    const col = await page.locator('.PrefModal__Grid__Col--right').boundingBox();
    const rect = await target.boundingBox();
    expect(rect.y).toBeGreaterThanOrEqual(col.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(col.y + col.height + 1);
    // 開設定頁不算看過
    expect(await seenCount(page)).toBe(0);
  });

  test('「知道了」⇒ 區塊收起、記成看過，不送鍵', async ({ page }) => {
    await boot(page, [], { homeDashboard: true });
    await drawMainMenu(page);
    await expect(section(page)).toBeVisible();
    await startCapture(page);
    await section(page).locator('[data-home-whats-new-ack]').click();
    await expect(section(page)).toHaveCount(0);
    expect(await seenCount(page)).toBeGreaterThan(30);
    // 唯一可能送出的是儀表板自己的背景抓最愛（Ctrl+Z f），「知道了」本身一個 byte 都不送。
    const sent = (await takeCapture(page)).split('\f').filter((s) => s && s !== '\x1af');
    expect(sent).toEqual([]);
    await expect(page.locator('#t')).toBeFocused();
  });
});
