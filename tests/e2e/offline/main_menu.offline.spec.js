// 選單（主功能表與子選單）的滑鼠可點區（桌機，真滑鼠）—— 離線，合成畫面（helpers/main_menu.js）。
//
// 回歸：選單上半的 ANSI 圖／心情點播被當成選單項 —— 滑鼠移上去上底色、點下去送
// ↑↓＋Enter 進了別的項。選單項以列文字形狀判定（src/js/menu_items.js，依據
// mbbsd/menu.c#menu_renderer），區域決策在 mouse_regions（unit 另守）。這裡守真瀏覽器
// 的接線：真的滑鼠移動 → term_buf → 底色／送鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { nextFrames } = require('../helpers/real_input');
const {
  drawMainMenu,
  drawUserMenu,
  drawPressAnyKey,
  CURSOR_ROW,
  FIRST_ITEM_ROW,
  ART_ROWS,
} = require('../helpers/main_menu');

const waitClickSettled = (page) =>
  page.waitForFunction(() => !window.__app.dblclickTimer, null, { timeout: 5000 });

async function cellPoint(page, col, row) {
  return page.evaluate(
    ({ c, r }) => {
      const v = window.__app.view;
      return {
        x: parseFloat(v.firstGridOffset.left) + v.chw * (c + 0.5),
        y: parseFloat(v.firstGridOffset.top) + v.chh * (r + 0.5),
      };
    },
    { c: col, r: row }
  );
}

async function hover(page, col, row) {
  const p = await cellPoint(page, col, row);
  await page.mouse.move(p.x, p.y);
  await nextFrames(page);
  return page.evaluate(() => ({
    action: window.__app.buf.mouseAction,
    mouseRow: window.__app.buf.nowHighlight,
    painted: window.__app.view.componentScreen.highlight.row,
  }));
}

async function clickCell(page, col, row) {
  const p = await cellPoint(page, col, row);
  await page.mouse.move(p.x, p.y);
  await nextFrames(page);
  await page.mouse.down();
  await page.mouse.up();
  await waitClickSettled(page);
}

test.describe('主功能表：只有選單項可點', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseMisclickGuard: true,
    });
    await drawMainMenu(page);
  });

  test('ANSI 圖／心情點播／分隔線：hover 不上底色、不是可點區', async ({ page }) => {
    for (const row of ART_ROWS) {
      const s = await hover(page, 40, row);
      expect([row, s.action, s.mouseRow]).toEqual([row, 'none', -1]);
      expect(s.painted).not.toBe(row);
    }
  });

  test('選單項：hover 上底色、可點', async ({ page }) => {
    const s = await hover(page, 30, 17);
    expect(s).toEqual({ action: 'enter', mouseRow: 17, painted: 17 });
  });

  // 子選單的標題不在 MENU_TITLES：「是選單」靠狀態列（menu_items.isMenuScreen →
  // string_util.parseListRow）。先畫 pressanykey 讓上一幀的 pageState 是 5，確認子選單
  // 自己判得出來，不是靠沿用主選單的狀態。
  test('子選單（從 pressanykey 回來）：art 不可點、選單項可點', async ({ page }) => {
    await drawPressAnyKey(page);
    await drawUserMenu(page);
    for (const row of [3, 8, 12]) {
      const s = await hover(page, 40, row);
      expect([row, s.action, s.mouseRow]).toEqual([row, 'none', -1]);
    }
    const s = await hover(page, 30, FIRST_ITEM_ROW + 2);
    expect(s).toEqual({
      action: 'enter',
      mouseRow: FIRST_ITEM_ROW + 2,
      painted: FIRST_ITEM_ROW + 2,
    });
    await startCapture(page);
    await expectOnlyFence(
      page,
      () => clickCell(page, 30, FIRST_ITEM_ROW + 2),
      '\x1b[B\x1b[B\r',
      '點 (V)'
    );
  });

  test('點 ANSI 圖什麼都不送；點 (M) 送「↓↓＋Enter」', async ({ page }) => {
    await startCapture(page);
    await clickCell(page, 40, 6);
    // 對照動作＝點 (M)：整份記錄恰好是它 ⇒ 點 art 那一下一個 byte 都沒送。
    await expectOnlyFence(
      page,
      () => clickCell(page, 30, CURSOR_ROW + 2),
      '\x1b[B\x1b[B\r',
      '點 (M)'
    );
  });
});
