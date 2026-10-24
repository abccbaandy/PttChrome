// 列表快速捲動把手（P30）手機版：真觸控（CDP touch）捲卡片列表 ⇒ 右緣出現把手；
// 手指按住把手拖到最上面放開 ⇒ 送一次跳號 `1⏎`。把手 touch-action:none，拖它不會捲到列表。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');
const { touchDrag } = require('../helpers/real_input');

const nav = loadCassette('cchat-list-nav');
const HANDLE = '#listFastScrollHandle';

test.describe('列表快速捲動把手（手機，離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('觸控捲卡片 ⇒ 出現把手；拖到最上面放開 ⇒ 跳到 1 號', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 0 });
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    await page.evaluate(() => {
      const q = window.__app.commandQueue;
      const orig = q.enqueue.bind(q);
      window.__cmds = [];
      q.enqueue = (cmd) => {
        window.__cmds.push({ kind: cmd && cmd.kind, keys: cmd && cmd.keys });
        return orig(cmd);
      };
    });
    const jumps = () => page.evaluate(() => window.__cmds.filter((c) => c.kind === 'jump-number'));

    const body = await waitRectStable(page, '.listBodyView');
    const x = body.left + body.width / 2;
    await touchDrag(page, { x, y: body.top + body.height * 0.35 }, { x, y: body.top + body.height * 0.65 });
    await expect(page.locator(HANDLE)).toBeVisible();
    expect(await jumps()).toEqual([]);

    const h = await waitRectStable(page, HANDLE);
    const hx = h.left + h.width / 2;
    await touchDrag(page, { x: hx, y: h.top + h.height / 2 }, { x: hx, y: body.top - 40 }, 10);
    await expect.poll(jumps).toEqual([{ kind: 'jump-number', keys: '1\r' }]);
  });
});
