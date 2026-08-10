// 黑名單快速新增（右鍵選單）—— 離線重放版。
// 守護：列表作者欄/標題欄、文章推文者 id 的右鍵快速加入黑名單；其他區塊不出現
// 快速新增項目；已在黑名單者反灰不可點。渲染/選單都是真路徑（stub WS 重放 cassette）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, findCassette, bootOffline, replayCassette } = require('../helpers/replay');

const articles = findCassettes('article');
const list = findCassette('list');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 找第一个带指定 data-* 的已渲染列，回传其属性值与「终端 col」对应的 client 座标
// （x = 列左缘 + (col+0.5)*chw；clientToPos 反推回同一 col）。列先 scrollIntoView，
// 好读长页折叠下方的列也可点。
// 捲到目標列並回傳點擊座標。
//
// **量測必須等版面靜下來**：好讀的自動開圖是延遲載入的（LazyInlinePreview），
// scrollIntoView 之後附近的圖才開始掛上，內容高度會再長一輪 —— 捲完立刻讀
// getBoundingClientRect 會拿到過期座標，右鍵就點在別列上（選單裡沒有
// 「加入黑名單」）。故捲動與量測分兩次 evaluate，中間等高度連續兩輪不變。
async function targetAt(page, attr, col) {
  const found = await page.evaluate(
    async ({ attr }) => {
      const rows = Array.from(
        document.querySelectorAll('#mainContainer span[type="bbsrow"]')
      );
      const el = rows.find((r) => r.getAttribute(attr));
      if (!el) return null;
      el.setAttribute('data-e2e-target', '1');
      el.scrollIntoView({ block: 'center' });
      const scroller = document.querySelector('.main');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let prev = -1;
      let stable = 0;
      for (let i = 0; i < 20 && stable < 2; ++i) {
        await sleep(200);
        const h = scroller ? scroller.scrollHeight : 0;
        if (h === prev) ++stable;
        else {
          stable = 0;
          prev = h;
        }
      }
      // 高度長完之後目標可能已被推離視窗中央，再捲一次並讓 layout 落定。
      el.scrollIntoView({ block: 'center' });
      await sleep(300);
      return true;
    },
    { attr }
  );
  if (!found) return null;
  return page.evaluate(
    ({ attr, col }) => {
      const app = window.__app;
      const el = document.querySelector('[data-e2e-target]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        value: el.getAttribute(attr),
        x: rect.left + (col + 0.5) * app.view.chw,
        y: rect.top + rect.height / 2,
      };
    },
    { attr, col }
  );
}

const menu = (page) => page.locator('.DropdownMenu').first();
const menuItem = (page, text) =>
  menu(page).getByRole('menuitem').filter({ hasText: text });

const readPref = (page, key) =>
  page.evaluate(
    (k) => JSON.parse(localStorage.getItem('pttchrome.pref.v1')).values[k],
    key
  );

test.describe('黑名單快速新增 · 看板列表（離線重放）', () => {
  test.skip(!list, '尚無 list cassette；先 yarn record:cassette（RECORD_MODE=list）');

  test('作者欄右鍵 → 加入作者黑名單 → 通知列出現且 pref 落地', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    const t = await targetAt(page, 'data-list-author', 20); // col 20 ∈ 作者欄 [17,29)
    expect(t).not.toBeNull();
    await page.mouse.click(t.x, t.y, { button: 'right' });

    const addLabel = await label(page, 'cmenu_addAuthorBlacklist');
    const item = menuItem(page, addLabel);
    await expect(item).toBeVisible();
    await expect(item).toContainText(t.value); // 项目上带该作者 id

    const noticeCnt = () =>
      page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll('#mainContainer > span[type="bbsrow"]')
          ).filter((el) => (el.textContent || '').includes('（本文已被黑名單）')).length
      );
    const before = await noticeCnt();
    await item.click();
    await page.waitForTimeout(800);

    expect(await noticeCnt()).toBeGreaterThan(before); // 原生模式 → 通知列
    expect((await readPref(page, 'blacklist')).toLowerCase()).toContain(
      t.value.toLowerCase()
    );
  });

  test('標題欄右鍵 → Modal 預填完整標題 → 確認 → 通知列出現且 pref 落地', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    const t = await targetAt(page, 'data-list-title', 45); // col 45 ∈ 標題區 (≥29)
    expect(t).not.toBeNull();
    await page.mouse.click(t.x, t.y, { button: 'right' });

    const addLabel = await label(page, 'cmenu_addTitleBlacklist');
    const item = menuItem(page, addLabel);
    await expect(item).toBeVisible();
    await item.click();

    // Modal 開啟且預填「該列完整標題」（原大小寫）。
    const input = page.locator('input[name="titleBlacklistKeyword"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(t.value);

    const noticeCnt = () =>
      page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll('#mainContainer > span[type="bbsrow"]')
          ).filter((el) => (el.textContent || '').includes('（本文已被黑名單）')).length
      );
    const before = await noticeCnt();
    await page.getByRole('button', { name: await label(page, 'titleBlacklistModal_confirm') }).click();
    await page.waitForTimeout(800);

    await expect(input).toBeHidden();
    expect(await noticeCnt()).toBeGreaterThan(before);
    expect(await readPref(page, 'titleBlacklist')).toContain(t.value);
  });

  test('已在黑名單的作者 → 選項反灰不可點', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    const t = await targetAt(page, 'data-list-author', 20);
    expect(t).not.toBeNull();
    // 只寫 localStorage（不套 runtime）→ 列仍正常渲染，但 exists 檢查命中。
    await page.evaluate((author) => {
      const key = 'pttchrome.pref.v1';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.values = { ...(cur.values || {}), blacklist: author };
      localStorage.setItem(key, JSON.stringify(cur));
    }, t.value);

    await page.mouse.click(t.x, t.y, { button: 'right' });
    const existsLabel = await label(page, 'cmenu_authorBlacklistExists');
    const item = menuItem(page, existsLabel);
    await expect(item).toBeVisible();
    await expect(item).toBeDisabled();
  });

  test('非作者/標題區塊（序號欄）右鍵 → 無快速新增項目、一般選單正常', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    const t = await targetAt(page, 'data-list-author', 5); // col 5 = 序號/推文數區
    expect(t).not.toBeNull();
    await page.mouse.click(t.x, t.y, { button: 'right' });

    await expect(menu(page)).toBeVisible();
    const addAuthor = await label(page, 'cmenu_addAuthorBlacklist');
    const addTitle = await label(page, 'cmenu_addTitleBlacklist');
    await expect(menuItem(page, addAuthor)).toHaveCount(0);
    await expect(menuItem(page, addTitle)).toHaveCount(0);
    // 一般選單項目仍在（設定）。
    const settings = await label(page, 'cmenu_settings');
    await expect(menu(page).getByText(settings, { exact: true })).toBeVisible();
  });
});

test.describe('黑名單快速新增 · 文章推文列（離線重放）', () => {
  if (!articles.length) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }
  const article = articles[0];

  test(`推文者 id 右鍵 → 加入 → 該 pusher 推文消失 [${article && article.__file}]`, async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: false });
    await replayCassette(page, article, { easyReading: true });

    const t = await targetAt(page, 'data-pusher', 4); // col 4 ∈ id 欄 [3, 3+len)
    expect(t).not.toBeNull();
    await page.mouse.click(t.x, t.y, { button: 'right' });

    const addLabel = await label(page, 'cmenu_addAuthorBlacklist');
    const item = menuItem(page, addLabel);
    await expect(item).toBeVisible();
    await expect(item).toContainText(t.value);
    await item.click();
    await page.waitForTimeout(800);

    // 好讀模式 → 該 pusher 的推文整列移除。
    const remaining = await page.evaluate(
      (p) =>
        document.querySelectorAll(
          `#mainContainer span[type="bbsrow"][data-pusher="${p}"]`
        ).length,
      t.value
    );
    expect(remaining).toBe(0);
    expect((await readPref(page, 'blacklist')).toLowerCase()).toContain(
      t.value.toLowerCase()
    );
  });
});
