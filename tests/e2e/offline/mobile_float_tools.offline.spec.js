// 手機 RWD（docs/mobile.md「浮動工具」「設定頁窄版」）：只在 `offline-mobile` project
// 跑（Pixel 7 模擬：hasTouch + isMobile ⇒ hover: none，桌機的 :hover 展開不成立）。
//   - 文章工具收在「⋯」：預設只佔一顆圓鈕（不蓋文章字），tap 展開、點了工具自動收合；
//   - 「⋯」與底部工具列不重疊；工具列與展開的按鍵面板疊在「⋯」上面（z-index）；
//   - 「⋯」可以用真觸控拖走（位置存 localStorage）；
//   - 設定頁全螢幕、分頁在頂端、內容佔滿寬度。
// 拖曳／展開方向的分支邏輯在 tests/unit/float_tools.test.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw, waitScreenSettled } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const ESC = '\x1b';
// 中文測試（Big5）以 fg=bg 隱藏 ⇒ 開燈鈕的軌 A（純 CSS，不送任何鍵給 PTT）。
const B5_HIDDEN_CJK = '\xa4\xa4\xa4\xe5\xb4\xfa\xb8\xd5';

function articleFrame() {
  const rows = [];
  const at = (row, text) => rows.push(`${ESC}[${row};1H${ESC}[K${text}`);
  at(1, ' 作者  someone (nick)                                             看板  Test');
  at(2, ' 標題  [測試] 手機浮動工具');
  at(3, ' 時間  Fri Sep  4 16:53:28 2026');
  at(5, 'plain body line');
  at(7, `${ESC}[30m${B5_HIDDEN_CJK}${ESC}[m`);
  at(
    24,
    `${ESC}[0;44;37m  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  ` +
      `(y)回應(X%)推文(h)說明(←)離開  ${ESC}[m`
  );
  return `${ESC}[H${ESC}[2J` + rows.join('') + `${ESC}[24;80H`;
}

async function bootArticle(page) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: false });
  await feedRaw(page, articleFrame());
  await expect(page.locator('#floatTools .floatTools__fab')).toBeVisible({ timeout: 15000 });
}

// waitRectStable 回 {top,left,width,height}
const overlap = (a, b) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

test.describe('手機：文章浮動工具「⋯」', () => {
  test('預設收合；tap 展開；點了工具 ⇒ 生效並自動收合', async ({ page }) => {
    await bootArticle(page);
    const lights = page.locator('#lightsOnBtn');
    await expect(lights).toBeHidden();

    await page.locator('#floatTools .floatTools__fab').tap();
    await expect(lights).toBeVisible();

    await lights.tap();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById('mainContainer').classList.contains('lightsOn')
        )
      )
      .toBe(true);
    await expect(lights).toBeHidden();
    // 收合時「⋯」標示有工具作用中
    await expect(page.locator('#floatTools')).toHaveAttribute('data-active', '');
  });

  test('「⋯」不與底部工具列重疊；工具列（含展開的按鍵面板）疊在上面', async ({ page }) => {
    await bootArticle(page);
    const fab = await waitRectStable(page, '#floatTools .floatTools__fab');
    const bar = await waitRectStable(page, '.mobileToolbarBar');
    expect(overlap(fab, bar)).toBe(false);

    await page.locator('[data-key="__keys"]').tap();
    await waitRectStable(page, '#mobileKeypad');
    const z = await page.evaluate(() => ({
      tools: Number(getComputedStyle(document.getElementById('floatTools')).zIndex),
      toolbar: Number(getComputedStyle(document.getElementById('mobileToolbar')).zIndex),
    }));
    expect(z.tools).toBeLessThan(z.toolbar);
  });

  test('真觸控拖「⋯」⇒ 跟著移動、位置存進 localStorage', async ({ page }) => {
    await bootArticle(page);
    const before = await waitRectStable(page, '#floatTools .floatTools__fab');
    const x = before.left + before.width / 2;
    const y = before.top + before.height / 2;
    // CDP 觸控序列（瀏覽器產生 pointerdown/move/up，不手捏事件）。
    const client = await page.context().newCDPSession(page);
    const touch = (type, px, py) =>
      client.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: px, y: py }],
      });
    await touch('touchStart', x, y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x - 10 * i, y - 15 * i);
    await touch('touchEnd');
    const after = await waitRectStable(page, '#floatTools .floatTools__fab');
    expect(after.left).toBeLessThan(before.left - 30);
    expect(after.top).toBeLessThan(before.top - 50);
    const saved = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('pttchrome.floatToolsPos'))
    );
    expect(saved).not.toBe(null);
    // 拖曳那一下不算點擊（不展開）
    await expect(page.locator('#lightsOnBtn')).toBeHidden();
  });
});

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

test('手機：設定頁全螢幕、分頁在頂端、內容佔滿寬度', async ({ page }) => {
  await bootOffline(page, ptt);
  await feedRaw(page, `${ESC}[2J${ESC}[H  MOBILE PREF TEST LINE  `);
  await waitScreenSettled(page);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
  const menu = page.locator('.DropdownMenu').first();
  await expect(menu).toBeVisible();
  await menu.getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
  const modal = page.locator('.PrefModal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveClass(/PrefModal--narrow/);

  const vw = page.viewportSize().width;
  const box = await waitRectStable(page, '.PrefModal');
  expect(box.width).toBeGreaterThanOrEqual(vw - 2);
  const right = await waitRectStable(page, '.PrefModal__Grid__Col--right');
  expect(right.width).toBeGreaterThanOrEqual(vw * 0.9);
  const tabs = await page.locator('.PrefModal [role="tablist"]').boundingBox();
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(right.top + 1);

  // 切到其他分頁仍正常（橫向分頁列可點）
  await page
    .locator('.PrefModal [role="tablist"]')
    .getByText(await label(page, 'options_enhance'), { exact: true })
    .click();
  await expect(page.locator('.PrefModal input[name="showLightsOnButton"]')).toBeVisible();
});
