// 設定搜尋的離線 e2e（真瀏覽器、真渲染、不連 PTT）。
//
// 為什麼這條非 e2e 不可：jsdom 沒有版面，unit 那層的 scrollIntoView 是
// tests/unit/setup.js 的空 stub ⇒「右欄真的捲到那一項了嗎」只有真瀏覽器量得到。
// 比對／排序在 tests/unit/pref_search.test.js，索引覆蓋度在
// tests/unit/pref_search_index.test.js，UI 接線在 tests/unit/pref_modal_search.test.jsx。
//
// 不需要 cassette、也不需要登入（設定頁不連 PTT）⇒ 不佔 live e2e 的登入預算。
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openSettings(page) {
  await installReplay(page);
  await page.goto('/');
  await waitConnected(page);
  await feedRaw(page, '\x1b[2J\x1b[H  PREF SEARCH TEST LINE  ');
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
  await page
    .locator('.DropdownMenu')
    .first()
    .getByText(await label(page, 'cmenu_settings'), { exact: true })
    .click();
  await expect(page.locator('.PrefModal')).toBeVisible();
}

const searchBox = async (page) =>
  page.getByLabel(await label(page, 'options_settingsSearchLabel'));

const dropdown = (page) => page.locator('.PrefModal__Search__Dropdown');
const rightCol = (page) => page.locator('.PrefModal__Grid__Col--right');
const anchor = (page, key) => page.locator(`[data-pref-anchor="${key}"]`);

test.describe('設定搜尋（offline）', () => {
  test('搜尋框在左欄，打字後下拉出現且比左欄寬', async ({ page }) => {
    await openSettings(page);
    const box = await searchBox(page);
    await expect(box).toBeVisible();

    await box.fill('sync');
    await expect(dropdown(page)).toBeVisible();

    // 左欄只有 160px；不給 Combobox width 的話下拉會跟著 target 寬度，窄到讀不了。
    const left = await page.locator('.PrefModal__Grid__Col--left').boundingBox();
    const drop = await dropdown(page).boundingBox();
    expect(drop.width).toBeGreaterThan(left.width);
  });

  test('選一筆結果 → 切分頁、右欄捲到那一項、目標可見並高亮', async ({ page }) => {
    await openSettings(page);
    const box = await searchBox(page);

    // 「工作模式」在「本機設定」分頁，開啟時停在 general ⇒ 必須換分頁才到得了。
    await box.fill('enableWorkMode');
    await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    await dropdown(page).locator('[role="option"]').first().click();

    const target = anchor(page, 'enableWorkMode');
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/PrefModal__Anchor--flash/);

    // 目標確實落在右欄的可視範圍內（這是 jsdom 測不到的那一半）。
    await waitRectStable(page, `[data-pref-anchor="enableWorkMode"]`);
    const col = await rightCol(page).boundingBox();
    const rect = await target.boundingBox();
    expect(rect.y).toBeGreaterThanOrEqual(col.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(col.y + col.height + 1);
  });

  test('跳到長分頁的下半部會真的捲動（scrollTop > 0）', async ({ page }) => {
    await openSettings(page);
    expect(await rightCol(page).evaluate((el) => el.scrollTop)).toBe(0);

    const box = await searchBox(page);
    // 游標所在列是「一般」分頁最底下那一區，不捲就看不到。
    await box.fill('keyboardCursorHighlight');
    await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    await dropdown(page).locator('[role="option"]').first().click();

    const target = anchor(page, 'keyboardCursorHighlight');
    await expect(target).toBeVisible();
    await waitRectStable(page, `[data-pref-anchor="keyboardCursorHighlight"]`);
    expect(await rightCol(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test('跳到條件渲染的「自動登入」分頁也到得了', async ({ page }) => {
    await openSettings(page);
    // 這一頁刻意只在切過去時才渲染（不讓瀏覽器的密碼管理員在使用者沒看它時
    // 跑自動填入）⇒ 錨點在點下去的那一刻還不存在，跳轉必須等一個 frame。
    await expect(anchor(page, 'autoLoginOtpSecret')).toHaveCount(0);

    const box = await searchBox(page);
    await box.fill('autoLoginOtpSecret');
    await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    await dropdown(page).locator('[role="option"]').first().click();

    const target = anchor(page, 'autoLoginOtpSecret');
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/PrefModal__Anchor--flash/);
  });

  test('鍵盤操作：Enter 直接送出第一筆', async ({ page }) => {
    await openSettings(page);
    const box = await searchBox(page);
    await box.fill('mouseServerReport');
    await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    await box.press('Enter');

    await expect(anchor(page, 'mouseServerReport')).toBeVisible();
  });

  test('下拉開著時 Escape 只關下拉，設定頁還在', async ({ page }) => {
    await openSettings(page);
    const box = await searchBox(page);
    await box.fill('sync');
    await expect(dropdown(page)).toBeVisible();

    await box.press('Escape');
    await expect(dropdown(page)).toBeHidden();
    await expect(page.locator('.PrefModal')).toBeVisible();

    // 再按一次才輪到設定頁（Modal 的 Esc 監聽是 window + capture）。
    await box.press('Escape');
    await expect(page.locator('.PrefModal')).toBeHidden();
  });

  test('高亮會自己消失，不會留在畫面上', async ({ page }) => {
    await openSettings(page);
    const box = await searchBox(page);
    await box.fill('enableBell');
    await expect(dropdown(page).locator('[role="option"]').first()).toBeVisible();
    await dropdown(page).locator('[role="option"]').first().click();

    const target = anchor(page, 'enableBell');
    await expect(target).toHaveClass(/PrefModal__Anchor--flash/);
    // PREF_FLASH_MS = 1700ms 之後移除；toHaveClass 會自己輪詢到逾時為止，
    // 不用 waitForTimeout。
    await expect(target).not.toHaveClass(/PrefModal__Anchor--flash/);
  });
});
