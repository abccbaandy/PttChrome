// 手機版面 Phase 2（docs/mobile.md）：畫面不被切。只在 offline-mobile project 跑。
// 症狀原型：雲端同步把桌機的 fixed-font-size 20px（80 欄 ≈ 800px）帶到手機，
// 終端機右半邊被切掉。手機模式必須無視 termSizeMode，而且不寫回 prefs。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');

const articles = findCassettes('article');

const geometry = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.main').getBoundingClientRect();
    const v = window.__app.view;
    return {
      left: r.left,
      right: r.right,
      // 內容底（最後一列的下緣）。不用 r.bottom：.main 固定多 10px 空白
      // （setTermFontSize 的 chh*rows+10），置中時不算它，桌機一向如此、不切內容。
      bottom: r.top + v.chh * window.__app.buf.rows,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      rows: window.__app.buf.rows,
      cols: window.__app.buf.cols
    };
  });

// 底部工具列常駐（mobile_layout.MOBILE_TOOLBAR_PX）：終端機內容必須完整落在它上面。
const TOOLBAR_PX = 48;

const assertFits = (g) => {
  expect(g.left).toBeGreaterThanOrEqual(0);
  expect(g.right).toBeLessThanOrEqual(g.innerWidth + 0.5);
  expect(g.bottom).toBeLessThanOrEqual(g.innerHeight - TOOLBAR_PX + 0.5);
  expect(g.scrollWidth).toBeLessThanOrEqual(g.innerWidth);
  expect(g.cols).toBe(80);
  expect(g.rows).toBeGreaterThanOrEqual(24);
};

test.describe('手機版面：畫面不被切（離線重放）', () => {
  test('同步來的 fixed-font-size 20px 在手機上被無視，80 欄完整落在畫面內，pref 原封不動', async ({ page }) => {
    await bootOffline(page, ptt);
    const synced = {
      termSizeMode: 'fixed-font-size',
      fontSize: 20,
      termSize: { cols: 80, rows: 24 },
      fontFitWindowWidth: false
    };
    // 存進 storage（模擬雲端同步寫入）＋整組套用：這組 pref 只走 onValuesPrefChange，
    // ptt.applyPrefs 的逐 key onPrefChange 對它無效（docs/terminal-size.md §1）。
    await ptt.applyPrefs(page, synced);
    await page.evaluate((v) => window.__app.onValuesPrefChange(v), synced);
    assertFits(await geometry(page));
    const stored = await page.evaluate(() => {
      const raw = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n');
      return raw;
    });
    expect(stored).toContain('fixed-font-size');
  });

  test('旋轉成橫向：重新排版後仍完整落在畫面內', async ({ page }) => {
    await bootOffline(page, ptt);
    await page.setViewportSize({ width: 915, height: 412 });
    await expect.poll(async () => (await geometry(page)).innerWidth).toBe(915);
    // onWindowResize 的 resizer 有 500ms debounce。列數從工具列上方的高度算：
    // (412 - 48) / 16 = 22.75 ⇒ 夾到下限 24（term_size 的 LOCKED 範圍）。
    await expect.poll(async () => {
      const g = await geometry(page);
      return (
        g.right <= g.innerWidth + 0.5 && g.bottom <= g.innerHeight - TOOLBAR_PX + 0.5 && g.rows === 24
      );
    }).toBe(true);
    assertFits(await geometry(page));
  });

  test.describe('文章好讀', () => {
    test.skip(!articles.length, '尚無 article cassette');
    test('好讀文章同樣完整落在畫面內（Phase 3 換行版面：寬＝視窗寬）', async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, articles[0], { easyReading: true });
      assertFits(await geometry(page));
    });
  });
});
