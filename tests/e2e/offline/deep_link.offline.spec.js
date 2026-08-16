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
      // 有資格接手的條件就是連線中。
      await expect
        .poll(() => existing.evaluate(() => window.__app.connectState))
        .toBe(1);

      const fresh = await context.newPage();
      await installReplay(fresh);
      await installOfflineNetwork(fresh);
      await fresh.goto('/#Gossiping/' + AID);

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

  // 接手的分頁必須**主動出聲**：使用者的眼睛在新開的那個分頁上，不通知的話跳轉
  // 等於靜默發生（實測回報：分頁本身沒有任何反應，得自己翻分頁找）。
  //
  // 預設 context 沒有通知權限 —— 那正是要驗的常態路徑：系統通知拿不到，但標題
  // 閃爍與頁內橫幅照常，而且整段不可以 throw。
  test('既有分頁接手：標題閃爍 + 頁內橫幅，切回來就停', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://localhost:8080' });
    const errors = [];
    try {
      const existing = await context.newPage();
      existing.on('pageerror', (e) => errors.push(e.message));
      await installReplay(existing);
      await installOfflineNetwork(existing);
      await existing.goto('/');
      await expect
        .poll(() => existing.evaluate(() => window.__app.connectState))
        .toBe(1);
      // 基準是**當下的標題**（index.html 的 <title>），不是 connectedUrl.site —— app
      // 從來沒把 title 設成連線位址過，拿 site 當基準的話這條斷言會恆真（假綠燈）。
      const baseTitle = await existing.title();
      expect(baseTitle).not.toBe('');

      const fresh = await context.newPage();
      await installReplay(fresh);
      await installOfflineNetwork(fresh);
      await fresh.goto('/#Gossiping/' + AID);
      // fresh 現在是前景分頁 ⇒ existing 進背景，標題閃爍才有意義。

      // 標題離開原本的值（每 1500ms 交替一次，用 poll 等）。
      await expect
        .poll(() => existing.title(), { timeout: 8000 })
        .not.toBe(baseTitle);
      // 頁內橫幅：切回來之後唯一還看得到的痕跡。
      await expect(existing.locator('.ListHint')).toContainText(AID);

      // 使用者切回這個分頁 → 停止閃爍、標題復原（visibilitychange / focus）。
      await existing.bringToFront();
      await expect.poll(() => existing.title(), { timeout: 8000 }).toBe(baseTitle);

      // 沒有通知權限是常態，不能因此炸掉（new Notification 在非 granted 時
      // 我們回 null；非 secure context 連建構子都不存在）。
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('授權通知的情況下同樣不炸', async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: 'http://localhost:8080',
      permissions: ['notifications']
    });
    const errors = [];
    try {
      const existing = await context.newPage();
      existing.on('pageerror', (e) => errors.push(e.message));
      await installReplay(existing);
      await installOfflineNetwork(existing);
      await existing.goto('/');
      await expect
        .poll(() => existing.evaluate(() => window.__app.connectState))
        .toBe(1);

      const fresh = await context.newPage();
      await installReplay(fresh);
      await installOfflineNetwork(fresh);
      await fresh.goto('/#Gossiping/' + AID);

      await expect
        .poll(() =>
          existing.evaluate(() => window.__app.deepLinkController.hasPending())
        )
        .toBe(true);
      expect(errors).toEqual([]);
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
