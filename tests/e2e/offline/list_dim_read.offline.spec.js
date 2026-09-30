// 已讀文章低亮（pref dimReadArticles，預設開）—— 真瀏覽器驗 CSS 真的生效。
// unit 只驗得到屬性與容器 class（jsdom 不算 :has() 選擇器、不算 computed style），
// 這支補「規則真的套上去、游標列真的被排除、pref 關掉真的全亮」。
// 判定表本身在 tests/unit/list_read.test.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');

// 每一列表列：是否已讀、是否游標列（bbsline 帶 highlight class）、computed opacity。
const rowsInfo = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"][data-list-author]')).map((r) => {
      const line = r.querySelector('[data-type="bbsline"]');
      return {
        read: r.hasAttribute('data-list-read'),
        cursor: !!line && !!line.getAttribute('class'),
        opacity: Number(getComputedStyle(r).opacity),
      };
    })
  );

async function check(page) {
  await expect.poll(async () => (await rowsInfo(page)).filter((r) => r.read && !r.cursor).length).toBeGreaterThan(0);
  const rows = await rowsInfo(page);
  expect(rows.some((r) => !r.read)).toBe(true);
  for (const r of rows) {
    if (r.read && !r.cursor) expect(r.opacity).toBeCloseTo(0.45, 2);
    else expect(r.opacity).toBe(1);
  }
  await ptt.applyPrefs(page, { dimReadArticles: false });
  await expect
    .poll(async () => (await rowsInfo(page)).every((r) => r.opacity === 1))
    .toBe(true);
}

test.describe('已讀文章低亮（離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('原生列表：已讀列低亮、未讀與游標列正常；pref 關閉全亮', async ({ page }) => {
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await check(page);
  });

  test('列表好讀：同上', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 0 });
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    await check(page);
  });
});
