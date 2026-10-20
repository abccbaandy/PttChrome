// 首頁儀表板（src/js/home_dashboard.js、docs/home-dashboard.md）：主功能表上蓋面板 → 自動送
// Ctrl+Z f 抓我的最愛 → q 回主功能表 → 畫出卡片；點卡片走 s<板>；真鍵盤打字收起面板、鍵照送。
// 進看板讀完最新一篇回來 ⇒ 該板不再標有新文章（不重抓）；F5 ＝重抓我的最愛。
// server 的回應由測試照 pttbbs 版面畫（主功能表＝helpers/main_menu，我的最愛／文章列表＝helpers/home_screens）。
// 焦點留在 #t、點面板不變成點終端機、面板開著打字照常送 PTT，只有真瀏覽器驗得出來。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { drawFavorites, drawArticleList } = require('../helpers/home_screens');
const { startCapture, peekCapture, takeCapture, expectOnlyFence } = require('../helpers/capture');

const ZA_FAV = '\x1af';

const FAVS = [
  { name: 'C_Chat', desc: '[希洽] 閒聊', unread: true },
  { name: 'Stock', desc: '[股票] 今天漲了', unread: false },
];

const dashboard = (page) => page.locator('#homeDashboard');

async function bootHome(page, prefs) {
  await bootOffline(page, ptt, { homeDashboard: true });
  if (prefs) await ptt.applyPrefs(page, prefs);
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await startCapture(page);
}

// 面板出現 → 自動 Ctrl+Z f → 畫我的最愛 → 送 q → 畫回主功能表 → 卡片。
async function fetchFlow(page) {
  await drawMainMenu(page);
  await expect(dashboard(page)).toBeVisible();
  await expect.poll(() => peekCapture(page)).toContain(ZA_FAV);
  await drawFavorites(page, FAVS);
  await expect.poll(() => peekCapture(page)).toContain('q');
  expect(await takeCapture(page)).toBe(ZA_FAV + '\fq\f');
  await drawMainMenu(page);
  await expect(page.locator('[data-home-board]')).toHaveCount(2);
}

test.describe('首頁儀表板', () => {
  test('自動抓我的最愛：Ctrl+Z f → q，卡片與未讀標記照畫面', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await expect(page.locator('[data-home-board="C_Chat"]')).toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-home-board="Stock"]')).not.toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-home-board="C_Chat"]')).toContainText('[希洽] 閒聊');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('點卡片 ⇒ 走 s<板>（同搜尋彈窗的前往看板），點下去不變成點終端機', async ({ page }) => {
    await bootHome(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await fetchFlow(page);
    await page.locator('[data-home-board="Stock"]').click();
    await expect.poll(() => peekCapture(page)).toContain('s');
    // 只有搜尋的第一步（s＋\f），沒有滑鼠瀏覽送的 ↑↓／Enter。
    expect(await takeCapture(page)).toBe('s\f');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('面板開著用真鍵盤打字 ⇒ 面板收起、鍵照常送給 PTT', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await page.keyboard.press('ArrowDown');
    await expect(dashboard(page)).toHaveCount(0);
    await expect.poll(() => peekCapture(page)).toContain('\x1b[B');
    expect(await takeCapture(page)).toBe('\x1b[B');
  });

  test('「原生主選單」⇒ 收起，主功能表留在原地', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await page.locator('[data-home-native]').click();
    await expect(dashboard(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.buf.getRowText(0, 0, 80))).toContain('主功能表');
  });

  test('進了看板、最新一篇讀過 ⇒ 回首頁時不再標有新文章，一個 byte 都不送', async ({ page }) => {
    await bootHome(page, { enableEasyReadingList: false });
    await fetchFlow(page);
    await expect(page.locator('[data-home-board="C_Chat"]')).toHaveAttribute('data-unread', '');
    // 使用者自己逛進 C_Chat、讀完最新一篇退回列表（最新一篇的標記從 + 變成空白）。
    await drawArticleList(page, 'C_Chat', [[1, ' '], [2, '+']]);
    await expect(dashboard(page)).toHaveCount(0);
    await drawArticleList(page, 'C_Chat', [[1, ' '], [2, ' ']]);
    await drawMainMenu(page);
    await expect(dashboard(page)).toBeVisible();
    await expect(page.locator('[data-home-board="C_Chat"]')).not.toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-home-board="Stock"]')).not.toHaveAttribute('data-unread', '');
    // 快取也寫回去了（重新整理頁面先畫出來的就是對的）。
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('pttchrome.homeFavorites.v1')));
    expect(cached.boards.find((b) => b.name === 'C_Chat').unread).toBe(false);
    // 不重抓：沒排自動抓（TTL 內），逛看板到回來整段只有柵欄那一鍵。
    expect(await page.evaluate(() => window.__app.homeDashboard._autoTimer)).toBeNull();
    await expectOnlyFence(page, () => page.keyboard.press('ArrowDown'), '\x1b[B');
  });

  test('F5 ＝ 重抓我的最愛（與文章列表同一個重新整理入口），不重載網頁', async ({ page }) => {
    await bootHome(page, { refreshMinIntervalSec: 0 });
    await fetchFlow(page);
    await page.evaluate(() => (window.__notReloaded = true));
    await page.keyboard.press('F5');
    await expect.poll(() => peekCapture(page)).toContain(ZA_FAV);
    await expect(dashboard(page)).toBeVisible();
    await expect(page.locator('[data-home-status]')).toHaveText(/更新中|Updating/);
    await drawFavorites(page, [{ name: 'Stock', desc: '[股票] 今天漲了', unread: true }]);
    await expect.poll(() => peekCapture(page)).toContain('q');
    expect(await takeCapture(page)).toBe(ZA_FAV + '\fq\f');
    await drawMainMenu(page);
    await expect(page.locator('[data-home-board]')).toHaveCount(1);
    await expect(page.locator('[data-home-board="Stock"]')).toHaveAttribute('data-unread', '');
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
  });

  test('pref 關 ⇒ 不蓋面板、不排自動抓', async ({ page }) => {
    await bootHome(page, { enableHomeDashboard: false });
    await drawMainMenu(page);
    await expect(dashboard(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.homeDashboard._autoTimer)).toBeNull();
  });
});
