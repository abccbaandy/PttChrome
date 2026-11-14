// 手機：跳到第一篇未讀的畫面回饋（P83／P84，docs/unread-jump.md「過程回饋」）。真觸控點「更多」→
// 「跳到第一篇未讀」、真觸控點「取消」。server 是頁面裡的假 PTT 列表（helpers/fake_board.js）。
// 板子同桌機那支：1～200 篇、150 以後未讀、游標在 100。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { installFakeBoard, jumpsAfterEnd, listCursorNum } = require('../helpers/fake_board');
const { waitDialogSettled } = require('../helpers/layout');

async function engage(page, delayMs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 0 });
  await installFakeBoard(page, { total: 200, unreadFrom: 150, cursor: 100, delayMs });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = window.__app;
        return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
      })
    )
    .toBe(true);
}

async function tapUnreadJump(page) {
  await page.locator('[data-key="__more"]').tap();
  await waitDialogSettled(page, '[data-key="__unreadJump"]');
  await page.locator('[data-key="__unreadJump"]').tap();
}

test.describe('手機：跳到第一篇未讀的過程回饋', () => {
  test('進度卡在底部工具列上方（不被蓋住）；落地後卡片上緣畫「以下未讀 51 篇」', async ({ page }) => {
    await engage(page, 150);
    await tapUnreadJump(page);
    const card = page.locator('.unreadJumpProgress');
    await expect(card).toBeVisible();
    const boxes = await page.evaluate(() => {
      const c = document.querySelector('.unreadJumpProgress').getBoundingClientRect();
      const bar = document.querySelector('[data-key="__more"]').getBoundingClientRect();
      return { cardBottom: c.bottom, cardLeft: c.left, cardRight: c.right, barTop: bar.top, vw: window.innerWidth };
    });
    expect(boxes.cardBottom).toBeLessThanOrEqual(boxes.barTop);
    expect(boxes.cardLeft).toBeGreaterThanOrEqual(0);
    expect(boxes.cardRight).toBeLessThanOrEqual(boxes.vw);

    await expect(page.locator('.ListHint')).toContainText('已跳到第一篇未讀 #150');
    expect(await listCursorNum(page)).toBe(150);
    await expect(card).toHaveCount(0);
    const layer = page.locator('.unreadJumpDividerLayer');
    await expect(layer).toBeVisible();
    await expect(layer.locator('.unreadJumpDividerLabel')).toHaveText('以下未讀 51 篇');
    const geo = await page.evaluate(() => {
      const row = window.__app.view._listCursorRow;
      const el = document.querySelector('#mainContainer [data-type="bbsline"][data-row="' + row + '"]');
      const line = document.querySelector('.unreadJumpDivider').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { text: el.textContent, rowTop: r.top, rowLeft: r.left, lineTop: line.top, lineLeft: line.left };
    });
    // 卡片次行把編號和日期排在同一段，textContent 黏成「15011/14」。
    expect(geo.text).toContain('15011/14');
    expect(Math.abs(geo.lineTop - (geo.rowTop - 1))).toBeLessThanOrEqual(1);
    expect(Math.abs(geo.lineLeft - geo.rowLeft)).toBeLessThanOrEqual(1);
  });

  test('點「取消」回到原本那篇，列表回好讀', async ({ page }) => {
    await engage(page, 200);
    await tapUnreadJump(page);
    const card = page.locator('.unreadJumpProgress');
    await expect(card).toBeVisible();
    await card.locator('.unreadJumpCancel').tap();
    await expect(page.locator('.ListHint')).toContainText('已取消，回到原本的位置');
    // 第一個跳號就是回原處（之後的是卡片一屏放不滿的背景補頁）。
    expect((await jumpsAfterEnd(page))[0]).toBe('100\r');
    expect(await listCursorNum(page)).toBe(100);
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => document.body.classList.contains('unreadJumpBusy'))).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.__app.listSession.state === 'active' && window.__app.buf.listRenderMode === 'buffer'))
      .toBe(true);
  });
});
