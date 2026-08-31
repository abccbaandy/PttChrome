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
const {
  installReplay,
  installOfflineNetwork,
  feedRaw,
  waitConnected
} = require('../helpers/replay');

async function boot(page) {
  await installReplay(page);
  await installOfflineNetwork(page);
  await page.goto('/');
  // feedRaw 直接戳 window.__app.onData，所以必須等 app 真的 boot 完。過去這裡是靠
  // dismissDeveloperModeAlert 的 waitFor 順便擋住的（modal 移除後那個天然同步點沒了）；
  // main.jsx 要先把 conv/*.bin 抓下來才 new App()，goto 回來時 __app 還不存在。
  await waitConnected(page);
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

  // 跳文期間 PTT 的線路屬於那段程式化鍵序列，使用者的 bytes 一個都不准插進去
  // （typeahead 會吞掉中間那一幀，docs/pttbbs-screen-protocol.md §2）。AID 跳文
  // **不開 modal** ⇒ onInput 開頭那道 modalShown 早退對它不成立，IME 與貼上曾經
  // 整段裸送。純邏輯在 tests/unit/serialized_op_gate.test.js，這裡守真物件的接線。
  //
  // 刻意直接翻 active 旗標而不跑真的跳文：offline 下唯一會讓它變 true 的是
  // aid_wrap 那條 in-flight 的瞬間，抓那個窗口必然 flaky。
  test('跳文期間鍵盤／IME／貼上都不會漏到 PTT', async ({ page }) => {
    await boot(page);
    // 這個檔沒有 cassette（window.__replay 不存在），記帳自己裝。
    await page.evaluate(() => {
      window.__sent = [];
      window.__stubWSSent = (s) => window.__sent.push(s);
      window.__app.aidNavigation.active = true;
    });

    await page.locator('#t').press('a');
    await page.evaluate(() => window.__app.view.onTextInput('測'));
    await page.evaluate(() => window.__app.onPasteDone('#1gIeu-3A'));
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.__sent.join(''))).toBe('');
    // 吞掉不得無聲：每一條都要看得到提示帶。
    await expect(page.locator('.ListHint')).toContainText('AID 跳文中');
  });
});
