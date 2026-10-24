// 列表快速捲動把手（P30，js/list_fast_scroll.js、docs/easy-reading-list.md「快速捲動把手」）——
// 真瀏覽器、真列表好讀、真滑鼠拖曳。unit（list_fast_scroll.test.js）釘死換算、出現條件與
// 「放開才送」；這裡守 unit 碰不到的：
//   - 真的捲列表（滾輪）⇒ 右緣出現把手；真滑鼠按住拖動 ⇒ 旁邊浮出「編號 N」，途中沒有跳號
//   - 放開 ⇒ 送出一次 `<N>⏎`（列表好讀的 jump-number 交易）
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');
const { startCapture, peekCapture } = require('../helpers/capture');

const nav = loadCassette('cchat-list-nav');
const HANDLE = '#listFastScrollHandle';

const probeCommands = (page) =>
  page.evaluate(() => {
    const q = window.__app.commandQueue;
    const orig = q.enqueue.bind(q);
    window.__cmds = [];
    q.enqueue = (cmd) => {
      window.__cmds.push({ kind: cmd && cmd.kind, keys: cmd && cmd.keys });
      return orig(cmd);
    };
  });
const jumps = (page) => page.evaluate(() => window.__cmds.filter((c) => c.kind === 'jump-number'));

test.describe('列表快速捲動把手（離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('捲動列表 ⇒ 右緣出現把手；拖動浮出編號、途中不跳號；放開送一次 <N>⏎', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 0 });
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    await expect(page.locator(HANDLE)).toHaveCount(0);
    await probeCommands(page);

    // 真滾輪捲列表（合成的 WheelEvent 是 untrusted，不會捲）
    const body = await waitRectStable(page, '.listBodyView');
    await page.mouse.move(body.left + body.width / 2, body.top + body.height / 2);
    await page.mouse.wheel(0, -200);
    await expect(page.locator(HANDLE)).toBeVisible();

    const h = await waitRectStable(page, HANDLE);
    // 貼著列表視口的右緣、在視口裡
    expect(h.left + h.width).toBeLessThanOrEqual(body.left + body.width + 1);
    expect(h.left + h.width).toBeGreaterThan(body.left + body.width - 4);
    expect(h.top).toBeGreaterThanOrEqual(body.top - 1);
    expect(h.top + h.height).toBeLessThanOrEqual(body.top + body.height + 1);
    await startCapture(page);
    await page.mouse.move(h.left + h.width / 2, h.top + h.height / 2);
    await page.mouse.down();
    const midY = body.top + body.height / 2;
    await page.mouse.move(h.left + h.width / 2, midY, { steps: 6 });
    const bubble = page.locator('.listFastScrollBubble');
    await expect(bubble).toBeVisible();
    const num = Number(await page.locator(HANDLE).getAttribute('aria-valuenow'));
    expect(num).toBeGreaterThan(1);
    const label = await page.evaluate((n) => window.__i18n('listFastScroll_num').replace('{n}', String(n)), num);
    await expect(bubble).toHaveText(label);
    // 拖動途中：沒有跳號
    expect(await jumps(page)).toEqual([]);
    expect(await peekCapture(page)).not.toContain(num + '\r');

    await page.mouse.up();
    await expect.poll(() => jumps(page)).toEqual([{ kind: 'jump-number', keys: num + '\r' }]);
    await expect.poll(() => peekCapture(page)).toContain(num + '\r');
    await expect(bubble).toHaveCount(0);
  });

  test('功能開關關掉 ⇒ 捲動也不出現', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, {
      enableEasyReadingList: true,
      easyReadingListPrefetchCount: 0,
      enableListFastScroll: false,
    });
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    const body = await waitRectStable(page, '.listBodyView');
    const scrollTop = () => page.evaluate(() => document.querySelector('.listBodyView').scrollTop);
    const before = await scrollTop();
    await page.mouse.move(body.left + body.width / 2, body.top + body.height / 2);
    await page.mouse.wheel(0, -200);
    // 柵欄：捲動真的發生了（scrollTop 變了）才判「沒出現」
    await expect.poll(scrollTop).not.toBe(before);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator(HANDLE)).toHaveCount(0);
  });
});
