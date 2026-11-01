// 只看關注（P36）手機版：切換入口在底部工具列「更多」（浮動鈕在手機會蓋到第一張卡片，
// 只在整段都被收起時才浮出來）。真觸控 tap、真列表卡片，不送使用者的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');
const { waitDialogSettled } = require('../helpers/layout');

const ITEM = '[data-panel="more"] [data-key="__followOnly"]';

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
    Array.from(document.querySelectorAll('#mainContainer [data-list-author]')).map((r) =>
      r.getAttribute('data-list-author').toLowerCase()
    )
  );

test.describe('只看關注（手機，離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('「更多」→ 只看關注 ⇒ 只剩關注作者的卡片；沒有關注的人時浮出「這一段沒有」；不動使用者位置', async ({ page }) => {
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
    const target = all.find((a) => all.filter((x) => x === a).length < all.length);
    expect(target, '列表上找不到可以當對照的作者').toBeTruthy();
    await ptt.applyPrefs(page, { followList: target });
    await probeKinds(page);

    await page.locator('[data-key="__more"]').tap();
    await expect(page.locator(ITEM)).toHaveAttribute('aria-pressed', 'false');
    await waitDialogSettled(page, ITEM);
    await page.locator(ITEM).tap();
    await expect.poll(async () => [...new Set(await listAuthors(page))]).toEqual([target]);
    // 有卡片 ⇒ 不浮出鈕（不蓋卡片）
    await expect(page.locator('#followOnlyChip')).toHaveCount(0);

    // 名單換成列表上沒有的人 ⇒ 整段收起，浮出「這一段沒有」，點它關掉
    await ptt.applyPrefs(page, { followList: 'nobody-here-zz' });
    await expect.poll(() => listAuthors(page)).toEqual([]);
    const chip = page.locator('#followOnlyChip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(await page.evaluate(() => window.__i18n('followOnly_empty')));
    await chip.tap();
    // 原本那一段原封不動回來（開著時補進來的頁可能接在前後）
    await expect
      .poll(async () => (await listAuthors(page)).join('\n').includes(all.join('\n')))
      .toBe(true);
    expect(await nonPrefetchKinds(page)).toEqual([]);
  });
});
