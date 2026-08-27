// 黑名單快速新增（右鍵選單）—— 離線重放版。
// 守護：列表作者欄/標題欄、文章推文者 id 的右鍵快速加入黑名單；其他區塊不出現
// 快速新增項目；已在黑名單者反灰不可點。渲染/選單都是真路徑（stub WS 重放 cassette）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, findCassette, bootOffline, replayCassette } = require('../helpers/replay');
// 量座標前一律先等版面停（判準單一來源，靜態掃描守護 tests/unit/e2e_layout_settle.test.js）。
const {
  assertElementUnder,
  scrollIntoViewStable,
} = require('../helpers/layout');

const articles = findCassettes('article');
const list = findCassette('list');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 找第一个带指定 data-* 的已渲染列，回传其属性值与「终端 col」对应的 client 座标
// （x = 列左缘 + (col+0.5)*chw；clientToPos 反推回同一 col）。列先 scrollIntoView，
// 好读长页折叠下方的列也可点。
//
// **量測必須等版面靜下來**：好讀的自動開圖是延遲載入的，scrollIntoView 之後附近的圖
// 才開始掛上，內容高度會再長一輪 —— 捲完立刻讀 getBoundingClientRect 會拿到過期座標，
// 右鍵就點在別列上（選單裡沒有「加入黑名單」）。
//
// 2026-08-27 改用 helpers/layout.js。舊版自己在 page.evaluate 裡等「scroller 的
// scrollHeight 連續兩輪不變」，有兩個洞：
//   (a) 穩定的是**整份長頁的總高**，不是目標列的 top —— 目標**上方**的圖長高照樣把它
//       推走，總高卻可能同時因別處卸載而抵銷成不變；
//   (b) `document.querySelector('.main')` 回 null 時 `h` 恆為 0 ⇒ stable 兩輪後就過，
//       整個迴圈退化成一個沒有任何訊號的固定 sleep。
// 現在改成：等整頁終局（含 Node 端在途圖片請求）→ 捲 → 再等終局 → 等**該列自己的
// rect** 連續三次不動。`.main` 不存在就直接丟錯，不再靜默降級。
async function targetAt(page, attr, col) {
  const found = await page.evaluate(
    ({ attr }) => {
      if (!document.querySelector('.main'))
        throw new Error('找不到捲動容器 .main —— 版面結構變了，不可靜默當成「已穩定」');
      const rows = Array.from(
        document.querySelectorAll('#mainContainer span[type="bbsrow"]')
      );
      const el = rows.find((r) => r.getAttribute(attr));
      if (!el) return null;
      el.setAttribute('data-e2e-target', '1');
      el.scrollIntoView({ block: 'center' });
      return true;
    },
    { attr }
  );
  if (!found) return null;
  // 捲動會把新的佔位盒帶進「接近視野」而觸發載入，載完又把目標推走 ⇒ 要捲到
  //「等完之後它仍在視窗內且不再動」為止（一次捲＋一次等會量到穩定但已捲出視窗的
  // rect，實測 offline-mixed 下量到 y=1090 而視窗只有 720 高）。
  await scrollIntoViewStable(page, '[data-e2e-target]');
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
        attr: attr,
      };
    },
    { attr, col }
  );
}

// 右鍵之前再確認一次指標底下還是那一列（版面位移的話直接說出來）。
const rightClickTarget = async (page, t) => {
  await assertElementUnder(page, t.x, t.y, t.value, {
    closest: '[' + t.attr + ']',
    attribute: t.attr,
  });
  await page.mouse.click(t.x, t.y, { button: 'right' });
};

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
    await rightClickTarget(page, t);

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
    await rightClickTarget(page, t);

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

    await rightClickTarget(page, t);
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
    await rightClickTarget(page, t);

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
    await rightClickTarget(page, t);

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
