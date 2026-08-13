// AID 返回鈕的 UI 整合守門（真瀏覽器、離線）。
//
// stack 與按鍵序列的邏輯已由 tests/unit/{nav_history,aid_navigation}.test.js 覆蓋；
// 這裡守的是 jsdom 抓不到的三個整合點（都是本專案踩過的坑）：
//   1. 它必須是「可以按的」——flashListHint 家族是 pointer-events:none，直接沿用
//      會做出一顆按不下去的按鈕。
//   2. className 要進 App.checkClass 的白名單（nomouse_command），否則滑鼠瀏覽
//      開著時，點按鈕會連帶把游標指令送給 PTT。
//   3. click 必須 stopPropagation：window 上有 capture 階段的 mousedown/click
//      監聽會把焦點搶回隱藏 input。
// 另外驗快捷鍵（pref aidNavBackKey，預設 F9）真的接到 aidNavigation.back()。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, installOfflineNetwork, feedRaw } = require('../helpers/replay');

async function boot(page) {
  await installReplay(page);
  await installOfflineNetwork(page);
  await page.goto('/');
  await ptt.dismissDeveloperModeAlert(page);
  await feedRaw(page, '\x1b[2J\x1b[H  OFFLINE AID BACK BUTTON TEST  ');
  await page.waitForTimeout(200);
}

test.describe('AID 返回鈕', () => {
  test('顯示／可點／隱藏，且不被當成終端機區域', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await boot(page);

    // 尚未跳文 → 沒有按鈕
    expect(await page.evaluate(() => !!window.__app.view._aidBackEl)).toBe(false);

    await page.evaluate(() => {
      window.__backClicks = 0;
      window.__app.view.showBackButton('C_Chat 第 353218 篇', () => {
        window.__backClicks++;
      });
    });

    const pill = page.locator('.nomouse_command', { hasText: '返回' });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('353218');

    // 整合點 1/2：真的收得到滑鼠事件，且 checkClass 把它排除在終端機區域外。
    expect(
      await page.evaluate(() => {
        const el = window.__app.view._aidBackEl;
        return {
          pointerEvents: getComputedStyle(el).pointerEvents,
          whitelisted: window.__app.checkClass(el.className)
        };
      })
    ).toEqual({ pointerEvents: 'auto', whitelisted: true });

    // 整合點 3：點下去只跑 callback，不會把焦點/按鍵漏給終端機。
    await pill.click();
    expect(await page.evaluate(() => window.__backClicks)).toBe(1);

    await page.evaluate(() => window.__app.view.hideBackButton());
    await expect(pill).toBeHidden();

    expect(errors).toEqual([]);
  });

  test('快捷鍵（預設 F9）叫得動 back()', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.__backCalls = 0;
      window.__app.aidNavigation.back = () => {
        window.__backCalls++;
      };
    });

    await page.locator('#t').press('F9');
    expect(await page.evaluate(() => window.__backCalls)).toBe(1);

    // 沒設定成快捷鍵的功能鍵不得誤觸
    await page.locator('#t').press('F10');
    expect(await page.evaluate(() => window.__backCalls)).toBe(1);
  });
});
