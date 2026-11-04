// 手機推文列收進底部導覽（pref mobileCommentBarFold，docs/long-push.md「底部常駐推文列」）。
// 只在 offline-mobile project 跑（Pixel 7 模擬）。
//
// unit（comment_bar.test.js／comment_bar_ui.test.jsx／mobile_toolbar.test.jsx）守分支；這裡守
// unit 摸不到的：真觸控點導覽的「推文」⇒ 列真的滑出來、輸入框拿到焦點、一個 byte 都沒送；
// 系統返回（真 popstate）只收推文列、不送 ←；Esc（離開輸入框）收回；收合關掉 ⇒ 照原生送 X；
// 長推文打字中列改上下兩層、輸入框吃滿寬往上長高，整段看得到、仍不蓋文末也不壓導覽列。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled, waitRectStable } = require('../helpers/layout');
const { bottomOverlayViolations } = require('../helpers/overlay_guard');

const article = findCassette('article');
const pushBtn = (page) => page.locator('[data-key="X"]');
const bar = (page) => page.locator('#commentBar');
const input = (page) => page.locator('#commentBar [name="commentBarText"]');

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

async function openArticle(page, opts) {
  await bootOffline(page, ptt, opts);
  await ptt.applyPrefs(page, { enableEasyReading: true });
  await replayCassette(page, article, { easyReading: true });
  await expect(page.locator('body')).toHaveClass(/mobile-layout/);
  await waitPreviewsSettled(page);
  await expect.poll(() => page.evaluate(() => window.__app.commentBar.state.available)).toBe(true);
}

test.describe('手機：推文列收進底部導覽', () => {
  test('平常收著；點「推文」⇒ 滑出並聚焦、不送鍵；Esc ⇒ 收回、再點又出來', async ({ page }) => {
    await openArticle(page, { commentBar: true, commentBarFold: true });
    await expect(bar(page)).toHaveCount(0);
    // 收著時累積頁尾端不多留推文列的空白。
    expect(await page.evaluate(() => document.documentElement.classList.contains('commentBarShown'))).toBe(false);

    await collectSent(page);
    await pushBtn(page).tap();
    await expect(bar(page)).toBeVisible();
    await expect(input(page)).toBeFocused();
    expect(await sentText(page)).toBe('');

    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);

    await pushBtn(page).tap();
    await expect(input(page)).toBeFocused();
    expect(await sentText(page)).toBe('');
  });

  test('系統返回（popstate）＝收起推文列，不送 ←、不離開文章', async ({ page }) => {
    await openArticle(page, { commentBar: true, commentBarFold: true });
    await pushBtn(page).tap(); // 這一下也是 user activation ⇒ sentinel 疊上
    await expect(input(page)).toBeFocused();
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
    await collectSent(page);
    await page.goBack();
    await expect(bar(page)).toHaveCount(0);
    expect(await sentText(page)).not.toContain('\x1b[D');
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
    // sentinel 補回來了：下一次返回照常送 ←
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
  });

  // 症狀：手機推文列只有一行、又被推／噓／→／計數／送出擠到剩十來個字寬，長推文打到後面
  // 前面就捲出框外，看不到全文。
  test('長推文：打字中上下兩層、輸入框吃滿寬並長高，整段看得到；不蓋文末、不壓導覽列', async ({ page }) => {
    await openArticle(page, { commentBar: true, commentBarFold: true });
    await collectSent(page);
    await pushBtn(page).tap();
    await expect(input(page)).toBeFocused();
    const before = await waitRectStable(page, '#commentBar');
    // 真鍵盤送字（IME 選字後的 insertText 同一條路）。
    const LONG = '這是一則很長很長的推文，'.repeat(6);
    await page.keyboard.insertText(LONG);
    await expect(input(page)).toHaveValue(LONG);
    await expect(bar(page)).toHaveClass(/commentBar--stacked/);
    const box = await waitRectStable(page, '#commentBar');
    const field = await waitRectStable(page, '#commentBar [name="commentBarText"]');
    const send = await waitRectStable(page, '#commentBar [data-comment-send]');
    // 輸入框獨佔一層、吃滿寬，在送出鈕上面；列往上長、下緣不動。
    expect(field.width).toBeGreaterThan(box.width - 20);
    expect(field.top + field.height).toBeLessThanOrEqual(send.top + 0.5);
    expect(box.height).toBeGreaterThan(before.height);
    expect(Math.abs(box.top + box.height - (before.top + before.height))).toBeLessThanOrEqual(1);
    // 整段看得到：沒有被捲走的行。
    const fits = await input(page).evaluate((el) => el.scrollHeight <= el.clientHeight);
    expect(fits).toBe(true);
    expect(await sentText(page)).toBe('');
    expect(await bottomOverlayViolations(page)).toEqual([]);
  });

  // X 走鍵盤同一條分派（長推文接手時探路也是送 X），跟收合前一樣。
  test('收合關掉 ⇒ 推文列常駐，導覽的「推文」照舊送 X', async ({ page }) => {
    await openArticle(page, { commentBar: true });
    await expect(bar(page)).toBeVisible();
    await collectSent(page);
    await pushBtn(page).tap();
    await expect.poll(() => sentText(page)).toContain('X');
    expect(await page.evaluate(() => window.__app.commentBar.state.expanded)).toBe(false);
  });
});
