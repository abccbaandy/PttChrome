// 推文篩選（P29，docs/comment-filter.md）：好讀文章右鍵推文 →「只看這個人的推文」→ 只留那個人
// 的推文＋「略過 N 則」細線＋上方橫幅；橫幅切換鈕直接換（P41）、「全部」還原。真右鍵、真點擊、真重畫，一個 byte 都不送。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');
const { assertElementUnder, scrollIntoViewStable, waitRectStable } = require('../helpers/layout');
const { startCapture, takeCapture } = require('../helpers/capture');

const article = findCassettes('article')[0];
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 看得到的推文列各是推／噓／→（列文字第一個字）。
const visibleTypes = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"][data-pusher]')).map((el) =>
      el.textContent.trim().charAt(0)
    )
  );

const visiblePushers = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"][data-pusher]')).map((el) =>
      el.getAttribute('data-pusher')
    )
  );

test.describe('推文篩選（離線重放）', () => {
  test.skip(!article, '尚無 article cassette');

  test(`右鍵推文 → 只看這個人 → 只剩他的推文＋略過細線＋橫幅；「全部」還原 [${article && article.__file}]`, async ({ page }) => {
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

    await expect(page.locator('#commentFilterBar [data-filter="user"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#commentFilterBar [data-filter="all"]').click();
    await expect(page.locator('#commentFilterBar')).toHaveCount(0);
    await expect.poll(() => visiblePushers(page)).toEqual(all);
    await expect(page.locator('#mainContainer .commentFilterSkip')).toHaveCount(0);
    // 只改顯示：一個 byte 都不送
    expect(await takeCapture(page)).toBe('');
  });

  test(`P39 右鍵推文 → 只看噓文／只看推文 → 只剩那一種＋橫幅；橫幅直接切換、「全部」還原 [${article && article.__file}]`, async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, mergeSameAuthorComments: false });
    await replayCassette(page, article, { easyReading: true });

    const all = await visiblePushers(page);
    const types = await visibleTypes(page);
    // 有噓文就驗「只看噓」，沒有就驗「只看推」；都要有別種推文才看得出篩選。
    const want = types.includes('噓') ? '噓' : '推';
    expect(types.includes(want) && types.some((t) => t !== want)).toBe(true);
    const menuKey = want === '噓' ? 'cmenu_filterCommentBoo' : 'cmenu_filterCommentPush';
    const bannerKey = want === '噓' ? 'commentFilter_bannerBoo' : 'commentFilter_bannerPush';

    await page.evaluate(() => {
      document.querySelector('#mainContainer span[type="bbsrow"][data-pusher]').setAttribute('data-e2e-target', '1');
    });
    const target = all[0];
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
      .filter({ hasText: await label(page, menuKey) });
    await expect(item).toBeVisible();
    await startCapture(page);
    await item.click();

    await expect.poll(async () => [...new Set(await visibleTypes(page))]).toEqual([want]);
    await expect(page.locator('#mainContainer .commentFilterSkip').first()).toBeAttached();
    await expect(page.locator('#commentFilterBar')).toHaveAttribute('aria-label', await label(page, bannerKey));
    const wantChip = want === '噓' ? 'boo' : 'push';
    await expect(page.locator(`#commentFilterBar [data-filter="${wantChip}"]`)).toHaveAttribute('aria-pressed', 'true');
    // P44：亮著那顆的則數＝畫面上留下來的那種推文則數（沒讀到文末多一個 +）。
    const shown = (await visibleTypes(page)).length;
    await expect(page.locator(`#commentFilterBar [data-filter="${wantChip}"] .commentFilterChipCount`)).toHaveText(
      new RegExp(`^${shown}\\+?$`)
    );

    // P46：讀到文末還是 0 則的鈕變淡，點了只閃一句、不切過去。沒有這種鈕的卷就跳過這段。
    const emptyChip = page.locator('#commentFilterBar [data-filter][data-empty]').first();
    if (await emptyChip.count()) {
      const key = await emptyChip.getAttribute('data-filter');
      const hintKey = { push: 'commentFilter_emptyPush', boo: 'commentFilter_emptyBoo', op: 'commentFilter_emptyOp' }[key];
      await expect(emptyChip.locator('.commentFilterChipCount')).toHaveText('0');
      // aria-disabled ⇒ Playwright 的 locator.click 會等它變可用；照使用者的真點擊打在鈕中央。
      const r = await emptyChip.boundingBox();
      await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
      await expect(page.locator('.ListHint')).toHaveText(await label(page, hintKey));
      await expect(emptyChip).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator(`#commentFilterBar [data-filter="${wantChip}"]`)).toHaveAttribute('aria-pressed', 'true');
    }

    // P41：橫幅直接切到另一顆有推文的鈕，不用先還原再右鍵重選
    const switchTo = page.locator(`#commentFilterBar [data-filter]:not([data-empty]):not([aria-pressed="true"]):not([data-filter="all"])`).first();
    const switchKey = await switchTo.getAttribute('data-filter');
    await switchTo.click();
    await expect(page.locator(`#commentFilterBar [data-filter="${switchKey}"]`)).toHaveAttribute('aria-pressed', 'true');
    if (switchKey !== 'op') {
      const other = switchKey === 'push' ? '推' : '噓';
      await expect.poll(async () => (await visibleTypes(page)).every((t) => t === other)).toBe(true);
    } else {
      const author = await page.evaluate(() => window.__app.view.articleAuthorId());
      await expect.poll(async () => [...new Set(await visiblePushers(page))]).toEqual([author]);
    }

    await page.locator('#commentFilterBar [data-filter="all"]').click();
    await expect(page.locator('#commentFilterBar')).toHaveCount(0);
    await expect.poll(() => visiblePushers(page)).toEqual(all);
    expect(await takeCapture(page)).toBe('');
  });
});
