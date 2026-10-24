// 只看關注（P36，js/follow_only.js、docs/list-row-filter.md「只看關注」）—— 真瀏覽器、真列表好讀。
// unit（follow_only.test.js）釘死判準、兩處藏列同一份、切換鈕的出現條件；這裡守 unit 碰不到的：
//   - 列表好讀的文章列表右上角真的出現切換鈕，真滑鼠點一下 ⇒ 列表只剩關注作者的列
//   - 再點一下回到全部；切換本身不送鍵（不夠看時照列表好讀的規則補頁）
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const nav = loadCassette('cchat-list-nav');
const CHIP = '#followOnlyChip';

const probeKinds = (page) =>
  page.evaluate(() => {
    const q = window.__app.commandQueue;
    const orig = q.enqueue.bind(q);
    window.__kinds = [];
    q.enqueue = (cmd) => {
      window.__kinds.push(cmd && cmd.kind);
      return orig(cmd);
    };
  });
// 切換本身不送鍵；收起後不夠看時照列表好讀原本的規則補頁（跟黑名單一樣），只准出現補頁腿，
// 不准有開文、跳號、游標同步這類動到使用者位置的腿。
const nonPrefetchKinds = (page) =>
  page.evaluate(() => window.__kinds.filter((k) => !/^prefetch/.test(String(k))));

const listAuthors = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"][data-list-author]')).map((r) =>
      r.getAttribute('data-list-author').toLowerCase()
    )
  );

test.describe('只看關注（離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('列表好讀：點「只看關注」⇒ 只剩關注作者的列；再點回到全部；不動使用者位置', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 0 });
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    const all = await listAuthors(page);
    // 挑一個不是每一列都是他的作者當關注（才看得出收起）
    const target = all.find((a) => all.filter((x) => x === a).length < all.length);
    expect(target, '列表上找不到可以當對照的作者').toBeTruthy();

    // 名單空的 ⇒ 沒有鈕
    await expect(page.locator(CHIP)).toHaveCount(0);
    await ptt.applyPrefs(page, { followList: target });
    await expect(page.locator(CHIP)).toBeVisible();
    await expect(page.locator(CHIP)).toHaveAttribute('aria-pressed', 'false');

    await probeKinds(page);
    const r = await waitRectStable(page, CHIP);
    await page.mouse.click(r.left + r.width / 2, r.top + r.height / 2);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => [...new Set(await listAuthors(page))]).toEqual([target]);

    const r2 = await waitRectStable(page, CHIP);
    await page.mouse.click(r2.left + r2.width / 2, r2.top + r2.height / 2);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-pressed', 'false');
    // 原本那一段原封不動回來（開著時補進來的頁可能接在前後）
    await expect
      .poll(async () => (await listAuthors(page)).join('\n').includes(all.join('\n')))
      .toBe(true);
    expect(await nonPrefetchKinds(page)).toEqual([]);

    // 功能開關關掉 ⇒ 鈕收起
    await ptt.applyPrefs(page, { enableFollowOnly: false });
    await expect(page.locator(CHIP)).toHaveCount(0);
  });
});
