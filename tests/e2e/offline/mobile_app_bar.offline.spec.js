// 手機頂部 App Bar（docs/mobile.md「App Bar」）：標題依畫面、終端機排在 App Bar 與底部工具列
// 之間、點 App Bar 不會被當成點終端機。只在 offline-mobile project 跑（Pixel 7 模擬）。
//
// unit（tests/unit/mobile_app_bar.test.js／.test.jsx）守標題決策與元件分支；這裡守 unit 摸不到的：
// 真 CSS／真幾何下終端機不被兩條 bar 蓋住、真觸控 tap 不送鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');

const article = findCassette('article');
const title = (page) => page.locator('#mobileAppBar [data-key="__title"]');
const subtitle = (page) => page.locator('#mobileAppBar [data-key="__subtitle"]');

// .main 的上下緣 vs App Bar 下緣／工具列上緣（CSS px）。
const chrome = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('.main').getBoundingClientRect();
    const bar = document.getElementById('mobileAppBar').getBoundingClientRect();
    const tb = document.querySelector('.mobileToolbarBar').getBoundingClientRect();
    return { mainTop: main.top, mainBottom: main.bottom, barBottom: bar.bottom, toolbarTop: tb.top };
  });

test.describe('手機頂部 App Bar', () => {
  test('主功能表：標題＝主功能表；選單撐滿兩條 bar 之間', async ({ page }) => {
    await bootOffline(page, ptt);
    await drawMainMenu(page);
    await page.waitForFunction(() => window.__app.view.menuCards === true);
    await expect(title(page)).toHaveText('主功能表');
    // 終端機自己的標題列與狀態列收起（標題已在 App Bar）
    const collapsed = await page.evaluate(() => {
      const rows = window.__app.buf.rows;
      return [0, rows - 1].map((r) => {
        const n = document.querySelector(`#mainContainer [type="bbsrow"][srow="${r}"]`);
        return n.classList.contains('mobileCollapsedRow') && n.getBoundingClientRect().height === 0;
      });
    });
    expect(collapsed).toEqual([true, true]);
    const c = await chrome(page);
    expect(c.mainTop).toBeGreaterThanOrEqual(c.barBottom - 0.5);
    expect(c.mainBottom).toBeLessThanOrEqual(c.toolbarTop + 0.5);
  });

  test('好讀文章：標題＝文章標題、副標＝看板；第一列不被 App Bar 蓋住', async ({ page }) => {
    await bootOffline(page, ptt);
    await replayCassette(page, article, { easyReading: true });
    await page.waitForFunction(() => window.__app.view.reflow === true);
    const want = await page.evaluate(() => ({
      title: window.__app.view._articleTitle,
      board: window.__app.view._articleBoard,
    }));
    expect(want.title).toBeTruthy();
    await expect(title(page)).toHaveText(want.title);
    if (want.board) await expect(subtitle(page)).toHaveText(want.board);
    const c = await chrome(page);
    expect(c.mainTop).toBeGreaterThanOrEqual(c.barBottom - 0.5);
    const firstRowTop = await page.evaluate(
      () => document.querySelector('#mainContainer [data-type="bbsline"]').getBoundingClientRect().top
    );
    expect(firstRowTop).toBeGreaterThanOrEqual(c.barBottom - 0.5);
  });

  test('tap App Bar 不送任何鍵（不會被當成點終端機）', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await drawMainMenu(page);
    await page.waitForFunction(() => window.__app.view.menuCards === true);
    await page.evaluate(() => {
      window.__sent = [];
      window.__stubWSSent = (s) => window.__sent.push(s);
    });
    await page.locator('#mobileAppBar').tap();
    // 給 App 的滑鼠入口一個機會（若外洩，click → 送 \r 是同步的）。
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.evaluate(() => (window.__sent || []).join(''))).toBe('');
    expect(await page.evaluate(() => document.activeElement === document.getElementById('t'))).toBe(true);
  });

  // REGRESSION（使用者回報）：手機上 AID 跳文後的「返回原文」不見了。舊版固定在左下角
  // （bottom:16px），被常駐的底部工具列（z-index 2500）整顆蓋住 ⇒ 看不到也按不到。
  test('AID 返回鈕：在 App Bar 下方、沒被任何 bar 蓋住，tap 只跑返回不送鍵', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await replayCassette(page, article, { easyReading: true });
    await page.waitForFunction(() => window.__app.view.reflow === true);
    await page.evaluate(() => {
      window.__backClicks = 0;
      window.__sent = [];
      window.__stubWSSent = (s) => window.__sent.push(s);
      window.__app.view.showBackButton('C_Chat 第 353218 篇', () => {
        window.__backClicks++;
      });
    });
    const pill = page.locator('#aidBackButton');
    await expect(pill).toBeVisible();
    // 沒被任何 UI 蓋住：Playwright 的 hit-target 檢查（別的元素攔截 pointer 就失敗）。
    await pill.tap({ trial: true, timeout: 3000 });
    const geo = await page.evaluate(() => {
      const r = document.getElementById('aidBackButton').getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        barBottom: document.getElementById('mobileAppBar').getBoundingClientRect().bottom,
        toolbarTop: document.querySelector('.mobileToolbarBar').getBoundingClientRect().top,
      };
    });
    expect(geo.top).toBeGreaterThanOrEqual(geo.barBottom);
    expect(geo.bottom).toBeLessThanOrEqual(geo.toolbarTop);

    await pill.tap();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.evaluate(() => window.__backClicks)).toBe(1);
    expect(await page.evaluate(() => window.__sent.join(''))).toBe('');
  });
});
