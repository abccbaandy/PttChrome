// 推文篩選（P29，docs/comment-filter.md）：好讀文章右鍵推文 →「只看這個人的推文」→ 只留那個人
// 的推文＋「略過 N 則」細線＋上方橫幅；橫幅 ✕ 還原。真右鍵、真點擊、真重畫，一個 byte 都不送。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');
const { assertElementUnder, scrollIntoViewStable, waitRectStable } = require('../helpers/layout');
const { startCapture, takeCapture } = require('../helpers/capture');

const article = findCassettes('article')[0];
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

const visiblePushers = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"][data-pusher]')).map((el) =>
      el.getAttribute('data-pusher')
    )
  );

test.describe('推文篩選（離線重放）', () => {
  test.skip(!article, '尚無 article cassette');

  test(`右鍵推文 → 只看這個人 → 只剩他的推文＋略過細線＋橫幅；✕ 還原 [${article && article.__file}]`, async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, mergeSameAuthorComments: false });
    await replayCassette(page, article, { easyReading: true });

    const all = await visiblePushers(page);
    // 挑一個不是每一則都是他的推文者（才看得出篩選）
    const target = all.find((p) => all.filter((x) => x === p).length < all.length);
    expect(target).toBeTruthy();
    await page.evaluate((p) => {
      const el = document.querySelector(`#mainContainer span[type="bbsrow"][data-pusher="${p}"]`);
      el.setAttribute('data-e2e-target', '1');
    }, target);
    await scrollIntoViewStable(page, '[data-e2e-target]');
    const pt = await page.evaluate(() => {
      const el = document.querySelector('[data-e2e-target]');
      const r = el.getBoundingClientRect();
      return { x: r.left + 4.5 * window.__app.view.chw, y: r.top + Math.min(r.height / 2, 10) };
    });
    await assertElementUnder(page, pt.x, pt.y, target, { closest: '[data-pusher]', attribute: 'data-pusher' });
    await page.mouse.click(pt.x, pt.y, { button: 'right' });

    const item = page
      .locator('.DropdownMenu')
      .first()
      .getByRole('menuitem')
      .filter({ hasText: await label(page, 'cmenu_filterCommentUser') });
    await expect(item).toBeVisible();
    await startCapture(page);
    await item.click();

    await expect.poll(async () => [...new Set(await visiblePushers(page))]).toEqual([target]);
    await expect(page.locator('#mainContainer .commentFilterSkip').first()).toBeAttached();
    await expect(page.locator('#commentFilterBar')).toContainText(target);

    // P38：點「略過 N 則」⇒ 就地展開那幾則（細線變「收起」、留在手指下）；再點收回去。
    const SKIP = '#mainContainer .commentFilterSkip';
    const before = await scrollIntoViewStable(page, SKIP);
    await page.mouse.click(before.left + before.width / 2, before.top + before.height / 2);
    await expect(page.locator(SKIP).first()).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await visiblePushers(page)).some((p) => p !== target)).toBe(true);
    await expect(page.locator('#mainContainer .commentFilterShown').first()).toBeAttached();
    const after = await waitRectStable(page, SKIP);
    expect(Math.abs(after.top - before.top)).toBeLessThan(2);
    await page.mouse.click(after.left + after.width / 2, after.top + after.height / 2);
    await expect(page.locator(SKIP).first()).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => [...new Set(await visiblePushers(page))]).toEqual([target]);

    await page.locator('#commentFilterBar .commentFilterClose').click();
    await expect(page.locator('#commentFilterBar')).toHaveCount(0);
    await expect.poll(() => visiblePushers(page)).toEqual(all);
    await expect(page.locator('#mainContainer .commentFilterSkip')).toHaveCount(0);
    // 只改顯示：一個 byte 都不送
    expect(await takeCapture(page)).toBe('');
  });
});
