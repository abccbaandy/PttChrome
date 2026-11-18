// 手機好讀文章把長引言收起來（P106）：同 quote_collapse.offline.spec.js，手機版面（推文卡片、折行）
// 下照樣只露前 2 行＋「展開引言」，真觸控點一下整段展開、不送鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitRectStable, waitDialogSettled } = require('../helpers/layout');
const { waitClickSettled } = require('../helpers/real_input');

const cas = loadCassette('synthetic-quote-reply');

const visibleQuoteRows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
      .filter((r) => /^: /.test(r.textContent) && !r.closest('[hidden]'))
      .length
  );

test.describe('手機好讀長引言收起（離線重放）', () => {
  test.skip(!cas, '缺 synthetic-quote-reply cassette');

  test('只露 2 行＋展開鈕；點一下整段展開、不送鍵', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, enableEasyReadingList: false });
    await replayCassette(page, cas, { easyReading: true });
    const btn = page.locator('#mainContainer .quoteSkip');
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(/展開引言（還有 7 行）/);
    expect(await visibleQuoteRows(page)).toBe(2);

    await page.evaluate(() => (window.__sentBefore = window.__replay.sent.length));
    const r = await waitRectStable(page, '#mainContainer .quoteSkip');
    await page.touchscreen.tap(r.left + 30, r.top + r.height / 2);
    await waitClickSettled(page);
    await expect(btn).toHaveCount(0);
    expect(await visibleQuoteRows(page)).toBe(9);
    expect(await page.evaluate(() => window.__replay.sent.length - window.__sentBefore)).toBe(0);
  });

  test('找字命中收起的那幾行 ⇒ 算得到、跳到那裡時整段展開', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, enableEasyReadingList: false });
    await replayCassette(page, cas, { easyReading: true });
    await expect(page.locator('#mainContainer .quoteSkip')).toHaveCount(1);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, '[data-key="__findText"]');
    await page.locator('[data-key="__findText"]').tap();
    await waitDialogSettled(page, '[data-article-find]');
    // 「伏筆」只出現在收起的第 7 行引言與回文第 2 句：兩處都要算到。
    await page.keyboard.type('伏筆');
    await expect(page.locator('[data-article-find-count]')).toHaveText('1/2');
    // 第一處就在收起段裡 ⇒ 跳過去時整段展開。
    await expect(page.locator('#mainContainer .quoteSkip')).toHaveCount(0);
    await expect.poll(() => visibleQuoteRows(page)).toBe(9);
  });
});
