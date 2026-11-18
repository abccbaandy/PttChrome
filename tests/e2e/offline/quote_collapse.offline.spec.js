// 好讀文章把長引言收起來（P106，js/quote_collapse.js、render/quote_fold.js）—— 真瀏覽器、真好讀渲染。
// unit（quote_collapse.test.js）釘死找段／展開 key／標註；這裡守 unit 碰不到的：
//   - 9 行引言只露前 2 行＋「展開引言（還有 7 行）」；收起的 7 列還在 DOM（hidden="until-found"）
//   - 真滑鼠選取跨過收起段、Ctrl+C ⇒ 複製到完整原文（收起的行也在），接著整段展開
//   - 真滑鼠點「展開引言」⇒ 整段出現、鈕消失；不送鍵
//   - 設定關掉 ⇒ 不收
// 素材 cassettes/synthetic-quote-reply.json：照 pttbbs mbbsd/edit.c 回文引用格式手做的單頁回文
// （「※ 引述《bob (鮑伯)》之銘言：」＋9 行「: 」引言），離線素材裡沒有長引言的回文。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { textRect, waitClickSettled } = require('../helpers/real_input');
const { waitRectStable } = require('../helpers/layout');

const cas = loadCassette('synthetic-quote-reply');

const visibleQuoteRows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
      .filter((r) => /^: /.test(r.textContent) && !r.closest('[hidden]'))
      .map((r) => r.textContent.trim())
  );
const foldedRows = (page) =>
  page.evaluate(() => document.querySelectorAll('#mainContainer .quoteFold[hidden="until-found"] [data-type="bbsline"]').length);

async function open(page, prefs) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied.push(String(t));
          return Promise.resolve();
        },
        readText: () => Promise.resolve(''),
      },
    });
  });
  await bootOffline(page, ptt, { quoteCollapse: true });
  await ptt.applyPrefs(page, { enableEasyReading: true, enableEasyReadingList: false, ...(prefs || {}) });
  await replayCassette(page, cas, { easyReading: true });
  await page.waitForFunction(() => /引述/.test(document.getElementById('mainContainer').textContent));
}

test.describe('好讀長引言收起（離線重放）', () => {
  test.skip(!cas, '缺 synthetic-quote-reply cassette');

  test('9 行引言只露 2 行＋展開鈕；選取跨過收起段複製得到完整原文、該段整段展開', async ({ page }) => {
    test.setTimeout(60000);
    await open(page);
    expect(await visibleQuoteRows(page)).toHaveLength(2);
    expect(await foldedRows(page)).toBe(7);
    const btn = page.locator('#mainContainer .quoteSkip');
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(/展開引言（還有 7 行）/);

    // 真滑鼠從「引述」拖到回文第一句，再 Ctrl+C（term_view 的複製走 readSelectionText）。
    const from = await textRect(page, '引述');
    const to = await textRect(page, '我覺得運動番');
    await page.mouse.move(from.x + 1, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBeGreaterThan(0);
    const copied = await page.evaluate(() => window.__copied[window.__copied.length - 1]);
    expect(copied).toContain('推理番，伏筆很多');
    expect(copied).toContain('也歡迎推冷門的');
    expect(copied).toContain('我覺得運動番');
    // 選取碰到收起段 ⇒ 該段整段展開（下一個 task）。
    await expect.poll(() => foldedRows(page)).toBe(0);
    await expect(btn).toHaveCount(0);
    expect(await visibleQuoteRows(page)).toHaveLength(9);
  });

  test('點「展開引言」整段展開、不送鍵', async ({ page }) => {
    test.setTimeout(60000);
    await open(page);
    const btn = page.locator('#mainContainer .quoteSkip');
    await expect(btn).toHaveCount(1);
    await page.evaluate(() => (window.__sentBefore = window.__replay.sent.length));
    const r = await waitRectStable(page, '#mainContainer .quoteSkip');
    await page.mouse.click(r.left + 20, r.top + r.height / 2);
    await waitClickSettled(page);
    await expect(btn).toHaveCount(0);
    expect(await visibleQuoteRows(page)).toHaveLength(9);
    expect(await foldedRows(page)).toBe(0);
    expect(await page.evaluate(() => window.__replay.sent.length - window.__sentBefore)).toBe(0);
  });

  test('設定關掉 ⇒ 引言全部照原樣', async ({ page }) => {
    test.setTimeout(60000);
    await open(page, { enableQuoteCollapse: false });
    expect(await visibleQuoteRows(page)).toHaveLength(9);
    await expect(page.locator('#mainContainer .quoteSkip')).toHaveCount(0);
  });
});
