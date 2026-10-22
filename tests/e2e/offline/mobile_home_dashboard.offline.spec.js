// 手機的首頁儀表板（docs/home-dashboard.md、docs/screen-refresh.md）：
//   - 下拉重整：在面板（整片都是卡片按鈕）上往下拉過門檻放手 ⇒ 重抓我的最愛，不會變成點卡片；
//   - 工具列「重整」在首頁＝重抓我的最愛；
//   - 閱讀紀錄：面板捲到中段點看板 → 進板 → 回首頁時捲回同一張卡片。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬，hasTouch）。下拉與捲動走 CDP 觸控
// （helpers/real_input.touchDrag），點卡片走 locator.tap（真觸控）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { drawFavorites, drawArticleList, drawBoardPrompt } = require('../helpers/home_screens');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { touchDrag } = require('../helpers/real_input');
const { waitRectStable, waitScrollStable } = require('../helpers/layout');

const ZA_FAV = '\x1af';
// 18 個：一頁不滿（不走跳號翻頁），兩欄排起來比面板高、捲得動。
const FAVS = Array.from({ length: 18 }, (_, i) => ({
  name: 'Board' + (i + 1),
  desc: '測試看板 ' + (i + 1),
  unread: i % 4 === 0,
}));

const dashboard = (page) => page.locator('#homeDashboard');

async function bootHome(page) {
  await bootOffline(page, ptt, { homeDashboard: true });
  await ptt.applyPrefs(page, { enableEasyReadingList: false, refreshMinIntervalSec: 0 });
  await startCapture(page);
}

// 面板出現 → （自動或手動）Ctrl+Z f → 畫我的最愛 → 送 q → 畫回主功能表 → 卡片。
async function answerFetch(page) {
  await expect.poll(() => peekCapture(page)).toContain(ZA_FAV);
  await drawFavorites(page, FAVS);
  await expect.poll(() => peekCapture(page)).toContain('q');
  expect(await takeCapture(page)).toBe(ZA_FAV + '\fq\f');
  await drawMainMenu(page);
  await expect(page.locator('[data-home-board]')).toHaveCount(FAVS.length);
}

// 面板頂端那張卡片與它離面板上緣的距離（同 home_dashboard.homeAnchorOf 的定義）。
const topCard = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('homeDashboard');
    const top = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll('[data-home-board]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) return { name: el.getAttribute('data-home-board'), offset: r.top - top, scrollTop: root.scrollTop };
    }
    return null;
  });
const offsetOf = (page, name) =>
  page.evaluate((name) => {
    const root = document.getElementById('homeDashboard');
    const el = root.querySelector(`[data-home-board="${name}"]`);
    return el.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }, name);

test.describe('手機首頁儀表板（離線重放）', () => {
  test('下拉重整：在卡片上往下拉過門檻放手 ⇒ 重抓我的最愛，不會點進看板', async ({ page }) => {
    await bootHome(page);
    await drawMainMenu(page);
    await expect(dashboard(page)).toBeVisible();
    await answerFetch(page);
    await page.evaluate(() => (window.__notReloaded = true));

    const r = await waitRectStable(page, '[data-home-board="Board1"]');
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // 60px × 阻尼 0.5 ＝ 30px，不到門檻：不送、也不算點卡片。
    await touchDrag(page, { x, y }, { x, y: y + 60 });
    await expect(page.locator('.pullRefreshIndicator.visible')).toHaveCount(0);
    expect(await peekCapture(page)).toBe('');

    await touchDrag(page, { x, y }, { x, y: y + 180 });
    await expect.poll(() => peekCapture(page)).toContain(ZA_FAV);
    // 沒有變成點 Board1（s<板> 的第一鍵）。
    expect(await peekCapture(page)).not.toContain('s');
    await expect(page.locator('.pullRefreshIndicator.visible')).toHaveCount(0);
    await answerFetch(page);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
  });

  test('工具列「重整」在首頁 ⇒ 重抓我的最愛', async ({ page }) => {
    await bootHome(page);
    await drawMainMenu(page);
    await answerFetch(page);
    const refresh = page.locator('[data-key="__refresh"]');
    await expect(refresh).toBeEnabled();
    await refresh.tap();
    await answerFetch(page);
  });

  test('點 App Bar 標題 ⇒ 面板捲回頂端，不送鍵', async ({ page }) => {
    await bootHome(page);
    await drawMainMenu(page);
    await answerFetch(page);
    const box = await waitRectStable(page, '#homeDashboard');
    const x = box.left + box.width / 2;
    await touchDrag(page, { x, y: box.top + box.height - 30 }, { x, y: box.top + 30 });
    expect(await waitScrollStable(page, '#homeDashboard')).toBeGreaterThan(20);
    await page.locator('#mobileAppBar [data-key="__title"]').tap();
    await expect.poll(() => page.evaluate(() => document.getElementById('homeDashboard').scrollTop)).toBe(0);
    expect(await takeCapture(page)).toBe('');
  });

  test('閱讀紀錄：捲到中段點看板 → 進板 → 回首頁時捲回同一張卡片', async ({ page }) => {
    await bootHome(page);
    await drawMainMenu(page);
    await answerFetch(page);

    // 真觸控往上滑，讓面板捲到中段。
    const box = await waitRectStable(page, '#homeDashboard');
    const x = box.left + box.width / 2;
    await touchDrag(page, { x, y: box.top + box.height - 30 }, { x, y: box.top + 30 });
    await waitRectStable(page, '[data-home-board="Board18"]');
    const before = await topCard(page);
    expect(before.scrollTop).toBeGreaterThan(20);

    // 點一張整張都看得到的卡片。
    const target = await page.evaluate(() => {
      const root = document.getElementById('homeDashboard').getBoundingClientRect();
      for (const el of document.querySelectorAll('[data-home-board]')) {
        const r = el.getBoundingClientRect();
        if (r.top >= root.top && r.bottom <= root.bottom) return el.getAttribute('data-home-board');
      }
      return null;
    });
    await page.locator(`[data-home-board="${target}"]`).tap();
    await expect.poll(() => peekCapture(page)).toContain('s');
    await drawBoardPrompt(page);
    await expect.poll(() => peekCapture(page)).toContain(target + '\r');
    await drawArticleList(page, target, [[1, ' '], [2, ' ']]);
    await expect(dashboard(page)).toHaveCount(0);
    expect(await takeCapture(page)).toBe('s\f' + target + '\r');

    await drawMainMenu(page);
    await expect(dashboard(page)).toBeVisible();
    await expect.poll(() => offsetOf(page, before.name)).toBeCloseTo(before.offset, 0);
    expect((await topCard(page)).name).toBe(before.name);
  });
});
