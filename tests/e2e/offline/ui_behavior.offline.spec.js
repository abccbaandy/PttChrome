// UI 行為型 offline e2e —— 框架無關、跨 bootstrap 3→5 / react-bootstrap 0.31→2 遷移存活。
//
// 目的（見 docs/handoff/bootstrap-upgrade-research.md「測試策略」）：bootstrap 升級時
// class 名會變、樣式會脫落，但「行為」（選單出現/分頁切換/按鈕反應/alert 開關）不該變。
// 故這裡只斷言「元素出現/消失/可見/值寫入」，不碰 class 名或顏色。
// 取代被刪的 bootstrap_css_guard.offline.spec.js（那是版本釘樁，遷移後必紅且無意義）。
//
// 不需任何 cassette：stub WebSocket 离线 boot 後直接操作 UI。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');

// locale 無關的 label 查詢（dev build 暴露 window.__i18n）。
const label = (page, key) => page.evaluate(k => window.__i18n(k), key);

// 右鍵叫出 context menu（無選取 → normalEnabled 路徑）。
async function openContextMenu(page) {
  await feedRaw(page, '\x1b[2J\x1b[H  CONTEXT MENU TEST LINE  ');
  await page.waitForTimeout(200);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
}

test.describe('UI 行為（offline，跨 bootstrap 版本守門）', () => {
  test('DeveloperModeAlert：開發者模式提示出現且可關閉', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    const dismiss = page.getByRole('button', { name: 'Yes, I understand.' });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(dismiss).toBeHidden();
  });

  test('右鍵選單出現 → 點 Settings → PrefModal 開啟', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await ptt.dismissDeveloperModeAlert(page);
    await waitConnected(page);

    await openContextMenu(page);

    const menu = page.locator('#cmenuReact .dropdown-menu').first();
    await expect(menu).toBeVisible();
    // 選單含預期項目（無選取時：Settings 一定在）。
    const settings = await label(page, 'cmenu_settings');
    await expect(menu.getByText(settings, { exact: true })).toBeVisible();

    // 點 Settings → PrefModal 出現（以 general 分頁的 proxyUrl 欄位為 marker，class 無關）。
    await menu.getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();
    await expect(page.locator('.PrefModal input[name="proxyUrl"]')).toBeVisible();
  });

  test('PrefModal 分頁切換：general → enhance → about 內容對應切換', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await ptt.dismissDeveloperModeAlert(page);
    await waitConnected(page);

    await openContextMenu(page);
    const settings = await label(page, 'cmenu_settings');
    await page.locator('#cmenuReact .dropdown-menu').first()
      .getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();

    const nav = page.locator('.PrefModal__Grid__Col--left');
    const proxyUrl = page.locator('.PrefModal input[name="proxyUrl"]');     // general only
    const autoLoginUser = page.locator('.PrefModal input[name="autoLoginUser"]'); // enhance only

    // 起始：general 可見
    await expect(proxyUrl).toBeVisible();
    await expect(autoLoginUser).toBeHidden();

    // → enhance
    await nav.getByText(await label(page, 'options_enhance'), { exact: true }).click();
    await expect(autoLoginUser).toBeVisible();
    await expect(proxyUrl).toBeHidden();

    // → about（含 PttChrome 版本字樣）
    await nav.getByText(await label(page, 'options_about'), { exact: true }).click();
    await expect(page.locator('.PrefModal').getByText('PttChrome').first()).toBeVisible();
    await expect(autoLoginUser).toBeHidden();

    // → 回 general
    await nav.getByText(await label(page, 'options_general'), { exact: true }).click();
    await expect(proxyUrl).toBeVisible();
  });

  test('PrefModal 勾選 + 關閉：值寫入 localStorage 且 modal 消失', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await ptt.dismissDeveloperModeAlert(page);
    await waitConnected(page);

    await openContextMenu(page);
    const settings = await label(page, 'cmenu_settings');
    await page.locator('#cmenuReact .dropdown-menu').first()
      .getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();

    // 到 enhance 分頁，切換 showFloorNumbers 勾選狀態。
    const nav = page.locator('.PrefModal__Grid__Col--left');
    await nav.getByText(await label(page, 'options_enhance'), { exact: true }).click();
    const checkbox = page.locator('.PrefModal input[name="showFloorNumbers"]');
    await expect(checkbox).toBeVisible();
    const before = await checkbox.isChecked();
    await checkbox.click();

    // 用當前（enhance）分頁 legend 的 × 關閉（onCloseClick → 寫入 + onSave）。
    // 每個分頁各有一個 .close，只有 active 分頁的可見。
    await page.locator('.PrefModal button.close').filter({ visible: true }).first().click();
    await expect(page.locator('.PrefModal')).toBeHidden();

    // localStorage 應持久化新值。
    const saved = await page.evaluate(() => {
      try {
        return JSON.parse(window.localStorage.getItem('pttchrome.pref.v1') || '{}');
      } catch (e) {
        return {};
      }
    });
    expect(saved.values && saved.values.showFloorNumbers).toBe(!before);
  });

  test('InputHelper：從選單開啟並完成 render（顏色盤 + 送出鈕）', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await ptt.dismissDeveloperModeAlert(page);
    await waitConnected(page);

    await openContextMenu(page);
    const inputHelper = await label(page, 'cmenu_showInputHelper');
    await page.locator('#cmenuReact .dropdown-menu').first()
      .getByText(inputHelper, { exact: true }).click();

    // InputHelperModal 出現（顏色盤 + 送出 SplitButton 為 marker）。
    // 這些元件（Modal/Tab/Nav/NavDropdown/SplitButton）若遷移後 render 崩潰，
    // modal 根本不會出現 → 這條會紅，即為守門。NavDropdown 內部切換太脆弱不在此測，
    // Tab.Container 行為由 PrefModal 分頁測試承接（同 API）。
    await expect(page.locator('.InputHelperModal__ColorList')).toBeVisible();
    const sendText = await label(page, 'colorHelperSend');
    await expect(
      page.locator('.InputHelperModal__Dialog').getByText(sendText, { exact: true })
    ).toBeVisible();
  });
});
