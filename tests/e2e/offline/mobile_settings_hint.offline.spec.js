// 手機設定頁開著時的狀態提示（term_view.setHintDialogCover，docs/mobile.md「設定頁窄版」）。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬）。
//
// 症狀：設定頁全螢幕蓋住底部工具列，但提示的位置還在替工具列讓位 ⇒ 背景功能的提示
// （例：紅底「AID 跳文失敗：逾時」）停在畫面約 2/3 高，壓住設定說明文字。
// 合約：設定頁開著時錯誤提示貼到畫面最底、一般提示先不顯示；關掉設定頁後回到工具列上方。
// 只動顯示，不送鍵。分支邏輯在 tests/unit/status_hint.test.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw, waitScreenSettled } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const ESC = '\x1b';
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 手機的右鍵／長按選單是 bottom sheet（ContextMenu/ContextSheet.jsx）。
const CONTEXT_SHEET = '[data-sheet="context"]';

async function openSettings(page) {
  await page
    .locator('#mainContainer [data-type="bbsline"]')
    .first()
    .click({ button: 'right', position: { x: 40, y: 2 } });
  const menu = page.locator(CONTEXT_SHEET).first();
  await expect(menu).toBeVisible();
  await menu.getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
  await expect(page.locator('.PrefModal')).toBeVisible();
  await waitRectStable(page, '.PrefModal');
}

const flash = (page, msg, level) =>
  page.evaluate(([m, l]) => window.__app.view.flashListHint(m, 20000, l), [msg, level]);

const hintState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.ListHint');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { opacity: el.style.opacity, top: r.top, bottom: r.bottom, level: el.dataset.level };
  });

test('手機：設定頁開著時，錯誤提示貼底、一般提示不顯示；關掉後回到工具列上方', async ({ page }) => {
  await bootOffline(page, ptt);
  await feedRaw(page, `${ESC}[2J${ESC}[H  MOBILE HINT TEST LINE  `);
  await waitScreenSettled(page);
  const vh = page.viewportSize().height;
  const bar = await waitRectStable(page, '.mobileToolbarBar');

  // 一般提示在設定頁打開前顯示中 ⇒ 開設定頁就收掉。
  await flash(page, '已切至原生操作');
  expect((await hintState(page)).opacity).toBe('1');
  await openSettings(page);
  expect((await hintState(page)).opacity).toBe('0');

  // 設定頁開著時才到的一般提示：不顯示。
  await flash(page, '推文已送出');
  expect((await hintState(page)).opacity).toBe('0');

  // 錯誤提示照常顯示，但貼到畫面最底（不停在原本替工具列讓位的高度）。
  await flash(page, 'AID 跳文失敗：逾時（已停在原生畫面）', 'error');
  await expect.poll(async () => (await hintState(page)).opacity).toBe('1');
  const under = await waitRectStable(page, '.ListHint');
  // 貼底＝離底 16px（模擬器沒有 safe-area）；舊版停在工具列上方 48px 那個高度。
  expect(under.top + under.height).toBeGreaterThan(vh - 24);

  // 關掉設定頁 ⇒ 還在顯示的錯誤提示回到工具列上方（不被工具列蓋住）。
  await page.locator('.PrefModal button[aria-label="Close"]').click();
  await expect(page.locator('.PrefModal')).toBeHidden();
  const back = await waitRectStable(page, '.ListHint');
  expect(back.top + back.height).toBeLessThanOrEqual(bar.top);

  // 關掉之後一般提示恢復顯示。
  await flash(page, '已切至原生操作');
  expect((await hintState(page)).opacity).toBe('1');
});
