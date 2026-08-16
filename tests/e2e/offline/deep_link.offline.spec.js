// Deep link 的瀏覽器端接線（真瀏覽器、真 boot 鏈、無網路）。
//
// **不驗完整跳轉**：cassette 是錄好的固定 byte 流，不會回應我們送出的 s/#/⏎，
// 所以跳轉序列本身留在 tests/unit/aid_navigation.test.js 驗。這裡守的是 unit
// 測不到的那一段——URL 真的被 boot 流程讀到、待跳目標真的被收下、網址真的被
// 清乾淨（F5 不重跳），以及整條路徑不炸。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, installOfflineNetwork } = require('../helpers/replay');

const AID = '1gIeu-3A';

// 開站到「deep link 已被 boot 流程處理完」為止。
// 沒有其他分頁在線 ⇒ BroadcastChannel 的 claim 會等滿逾時（400ms）才自己開站，
// 所以後面一律用 expect.poll 等，不寫死 timeout。
async function boot(page, hash) {
  await installReplay(page);
  await installOfflineNetwork(page);
  await page.goto('/' + (hash || ''));
  await ptt.dismissDeveloperModeAlert(page);
}

const pending = (page) =>
  page.evaluate(() => !!(window.__app && window.__app.deepLinkController.hasPending()));

test.describe('deep link', () => {
  test('帶 #<Board>/<AID> 開站：未登入 → 收下等登入，網址清乾淨', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page, '#Gossiping/' + AID);

    // cassette 重放不會走到主功能表 ⇒ controller 認定未登入 ⇒ 目標留著。
    await expect.poll(() => pending(page)).toBe(true);
    // 用過的參數必須從網址上消失，否則 F5 會再跳一次。
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    expect(errors).toEqual([]);
  });

  test('query 形式（?board=&aid=）也吃', async ({ page }) => {
    await boot(page, '?board=movie&aid=' + AID);
    await expect.poll(() => pending(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => location.search)).toBe('');
  });

  test('AID 不合法（7 碼）→ 當成沒有 deep link，網址原樣留著', async ({ page }) => {
    await boot(page, '#Gossiping/1gIeu-3');
    await expect.poll(() => pending(page)).toBe(false);
    expect(await page.evaluate(() => location.hash)).toBe('#Gossiping/1gIeu-3');
  });

  test('沒帶 deep link 的一般開站不受影響', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page);
    await expect.poll(() => pending(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  // 跨分頁交接（BroadcastChannel）。必須是**同一個 BrowserContext** 的兩個
  // page：BroadcastChannel 只在同 origin＋同 profile 之間廣播，Playwright 每個
  // context 是獨立 profile，分開開就永遠收不到。
  test('既有分頁接手：新分頁不連線，只顯示提示', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:8080' });
    try {
      const existing = await context.newPage();
      await installReplay(existing);
      await installOfflineNetwork(existing);
      await existing.goto('/');
      await ptt.dismissDeveloperModeAlert(existing);
      // 有資格接手的條件就是連線中。
      await expect
        .poll(() => existing.evaluate(() => window.__app.connectState))
        .toBe(1);

      const fresh = await context.newPage();
      await installReplay(fresh);
      await installOfflineNetwork(fresh);
      await fresh.goto('/#Gossiping/' + AID);
      await ptt.dismissDeveloperModeAlert(fresh);

      // 既有分頁收下目標。
      await expect
        .poll(() =>
          existing.evaluate(() => window.__app.deepLinkController.hasPending())
        )
        .toBe(true);
      // 新分頁只顯示提示，**不連線**（否則白佔一個 PTT 連線名額）。
      // 注意 window.__app 一定存在：它在 startApp 開頭就掛上了，bootstrap() 才是
      // 呼叫 connect() 的地方 —— 所以要看的是 conn，不是 __app。
      await expect(fresh.locator('.PageTopAlert')).toBeVisible();
      expect(await fresh.evaluate(() => window.__app.conn === undefined)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('hashchange：同一個分頁再貼一次連結也會被收下', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      location.hash = '#C_Chat/2AbCdEf0';
    });
    await expect.poll(() => pending(page)).toBe(true);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  });
});
