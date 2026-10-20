// 新推文標記（src/js/new_comments.js、docs/new-comments.md）：重開讀過的文章 ⇒ 上次讀完之後
// 的第一則推文上緣出現灰色細線「以下是新推文」，浮動工具面板多一顆「跳到新推文」，點了只捲
// 好讀的視口、一個 byte 都不送；第一次讀不標、讀完把推文數記進這個瀏覽器。
// 只有真瀏覽器驗得出來：線真的畫在那一列上緣、不蓋到上一列的字、跳過去真的把那一列捲進視野。
// 素材 stock-huang（49 則推文、AID #1g8znzQ3，好讀 golden 守在 easy-reading.offline.spec.js）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitRectStable } = require('../helpers/layout');

const article = loadCassette('stock-huang');
const KEY = 'pttchrome.newComments.v1';
const ARTICLE_KEY = article.meta.board.toLowerCase() + '/1g8znzQ3';

async function boot(page, seen) {
  await page.setViewportSize({ width: 1280, height: 800 });
  if (seen != null)
    await page.addInitScript(
      ({ KEY, ARTICLE_KEY, seen }) => {
        window.localStorage.setItem(KEY, JSON.stringify({ [ARTICLE_KEY]: [seen, 1] }));
      },
      { KEY, ARTICLE_KEY, seen }
    );
  await bootOffline(page, ptt);
  // 每則推文各自一列（合併塊的標法守在 unit：tests/unit/new_comments.test.js）。
  await ptt.applyPrefs(page, { enableEasyReading: true, mergeSameAuthorComments: false });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

const stored = (page) =>
  page.evaluate(({ KEY, ARTICLE_KEY }) => {
    const v = JSON.parse(window.localStorage.getItem(KEY) || '{}')[ARTICLE_KEY];
    return v ? v[0] : null;
  }, { KEY, ARTICLE_KEY });

test.describe('新推文標記', () => {
  test('第一次讀：不標；讀完記下推文數', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, null);
    await expect(page.locator('.newCommentsStart')).toHaveCount(0);
    await expect.poll(() => stored(page)).toBe(article.meta.commentCount);
  });

  test('重開：第 41 則上緣有灰線；跳到新推文只捲視口、不送鍵', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, 40);
    const mark = page.locator('#mainContainer [type="bbsrow"].newCommentsStart');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveAttribute('data-new-comments', /.+/);
    // 那一列就是第 41 則推文（樓層同一個數法）：前面恰好 40 則。
    const before = await mark.evaluate((el) => {
      let n = 0;
      for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (p.hasAttribute('data-pusher')) ++n;
      return n;
    });
    expect(before).toBe(40);
    // 線不蓋到上一列：它畫在留出來的空白裡（列的 margin-top）。
    const rowBox = await waitRectStable(page, '#mainContainer [type="bbsrow"].newCommentsStart');
    const prevBottom = await mark.evaluate((el) => el.previousElementSibling.getBoundingClientRect().bottom);
    expect(rowBox.top - prevBottom).toBeGreaterThan(5);
    // 讀完：紀錄更新成這一次的推文數，標線這一次照舊。
    await expect.poll(() => stored(page)).toBe(article.meta.commentCount);

    await page.evaluate(() => (window.__app.view.mainDisplay.scrollTop = 0));
    await startCapture(page);
    await page.locator('.floatTools__fab').click();
    await page.locator('#jumpNewCommentsBtn').click();
    await expect
      .poll(async () => {
        const r = await mark.evaluate((el) => el.getBoundingClientRect().top);
        const v = await page.evaluate(() => window.__app.view.mainDisplay.getBoundingClientRect());
        return r >= v.top - 1 && r < v.top + v.height;
      })
      .toBe(true);
    expect(await takeCapture(page)).toBe('');
  });

  test('沒有新推文、pref 關 ⇒ 不標', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, article.meta.commentCount);
    await expect(page.locator('.newCommentsStart')).toHaveCount(0);
    await expect(page.locator('#jumpNewCommentsBtn')).toHaveCount(0);
  });
});
