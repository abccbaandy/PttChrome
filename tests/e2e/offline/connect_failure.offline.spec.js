// 「從未連線成功」情境的 UI 守門（PTT 維護中 / ws.ptt.cc 不可達）。
//
// 與 ui_behavior.offline.spec.js 的「斷線提示掛著時：設定頁仍能打字」是**兩條不同路徑**，
// 別把其中一條當成涵蓋另一條：
//   - 先連上再斷線：App.onConnect 跑過 → view.conn 是已關閉的 TelnetConnection。
//     WebSocket.send() 對 CLOSED socket 依規範是 no-op，不會 throw。
//   - 從未連上（本檔）：onConnect 從不執行 → TermView.setConn 沒被呼叫 →
//     **view.conn === undefined** → 任何直接 `view.conn.send()` 立刻 TypeError。
//
// 原始症狀（使用者回報）：連不上 PTT 時開設定頁，X／點空白處／Esc 都關不掉，而且一旦
// 嘗試關閉，整頁就再也打不了字（點輸入框焦點被搶走）。根因鏈：
//   關閉 → onPrefSaveImpl 先把 modalShown 設 false，再呼叫 switchToEasyReadingMode
//   → pttchrome.jsx 的 view.conn.send('^L') throw → update({showsSettings:false}) 沒跑
//   → 對話框還在、app 卻以為沒有 modal → term_view 的 keyup / pttchrome 的
//     mouseover/mouseup 永久把焦點搶回隱藏 input #t，只能重整。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, installOfflineNetwork, feedRaw } = require('../helpers/replay');

// window.__i18n 是 main.jsx 在 `new App()` **之後**才掛的 e2e 探針，而 page.goto
// 只等到 load —— 機器忙的時候（整包 offline 一起跑）module script 可能還沒執行完，
// 直接 evaluate 會噴 "window.__i18n is not a function"。先等探針就緒。
const label = async (page, key) => {
  await page.waitForFunction(() => typeof window.__i18n === 'function');
  return page.evaluate((k) => window.__i18n(k), key);
};

// 右鍵叫出 context menu（無選取 → normalEnabled 路徑）。餵一行畫面純粹是讓
// #mainContainer 有東西可以按，不需要連線。
async function openContextMenu(page) {
  await feedRaw(page, '\x1b[2J\x1b[H  OFFLINE CONNECT FAILURE TEST  ');
  await page.waitForTimeout(200);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
}

async function openSettings(page) {
  await openContextMenu(page);
  await page
    .locator('.DropdownMenu')
    .first()
    .getByText(await label(page, 'cmenu_settings'), { exact: true })
    .click();
  await expect(page.locator('.PrefModal')).toBeVisible();
}

test.describe('連線失敗（從未連上）', () => {
  test('設定頁關得掉，且關閉後終端機焦點/鍵盤恢復正常', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await installReplay(page, { neverOpen: true });
    await installOfflineNetwork(page);
    await page.goto('/');

    // 連線失敗 → App.onClose → ConnectionAlert；且 isConnected() 始終為 false。
    const alert = page
      .locator('.PageTopAlert')
      .filter({ hasText: await label(page, 'alert_connectionHeader') });
    await expect(alert).toBeVisible();
    expect(await page.evaluate(() => window.__app.isConnected())).toBe(false);
    // 前提確認：這正是本檔要守的現場（view.conn 從沒被 setConn 過）。
    expect(await page.evaluate(() => window.__app.view.conn === undefined)).toBe(true);

    await openSettings(page);

    // 點 X 關閉 —— 修正前這裡就會紅（switchToEasyReadingMode throw → modal 不會關）。
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.PrefModal')).toBeHidden();

    // 關閉路徑不得留下 modalShown=true（否則終端機從此收不到鍵盤），
    // 焦點也要回到隱藏 input #t。
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id))
      .toBe('t');

    // 症狀直測：再開一次設定頁，逐鍵打字要打得進去。
    // （fill 不發 keydown，測不到「keyup 把焦點搶回 #t」這個 bug。）
    await openSettings(page);
    await page
      .locator('.PrefModal__Grid__Col--left')
      .getByText(await label(page, 'options_connection'), { exact: true })
      .click();
    const url = page.locator('.PrefModal input[name="imgurProxyUrl"]');
    await expect(url).toBeVisible();
    await url.click();
    await url.pressSequentially('my.example.dev');
    await expect(url).toHaveValue('my.example.dev');

    // 全程不得有未捕捉例外（view.conn undefined 的 TypeError 會在這裡現形）。
    expect(errors).toEqual([]);
  });

  test('Esc 與點擊遮罩也關得掉設定頁', async ({ page }) => {
    await installReplay(page, { neverOpen: true });
    await installOfflineNetwork(page);
    await page.goto('/');
    await expect(
      page
        .locator('.PageTopAlert')
        .filter({ hasText: await label(page, 'alert_connectionHeader') })
    ).toBeVisible();

    // Esc
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.PrefModal')).toBeHidden();

    // 點對話框外（Mantine overlay）
    await openSettings(page);
    await page.locator('.mantine-Modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.PrefModal')).toBeHidden();
  });
});
