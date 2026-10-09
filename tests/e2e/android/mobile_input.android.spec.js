// 真 Android Chrome（模擬器）上的底部工具列、軟鍵盤、系統返回鍵。
// 守的是桌機 offline e2e（Pixel 7 模擬，`offline/mobile_toolbar.offline.spec.js`）只能替身測、
// 或根本測不到的那層（docs/mobile.md「規則」、docs/android-e2e.md）：
//   1. `#t` 的 inputmode="none"：真觸控 tap 終端機／工具列，Android 真的不彈軟鍵盤；
//   2. ⌨ 在 click handler 內同步 blur→focus（user activation）⇒ 軟鍵盤真的升起，而且
//      工具列（--kb-inset）與終端機底列（setKeyboardInset）都被推到鍵盤上方；
//   3. 鍵盤開著時按系統返回鍵：IME 吃掉返回、只收鍵盤，不可以走到 history sentinel 送 ←；
//      收起後 softKeyboard 歸零（`_onVisualViewport`）⇒ 再按 ⌨ 一次就叫得出來；
//   4. 系統返回鍵 → history sentinel → 送鍵出口，連按都接得住（返回鍵不是 user activation，
//      sentinel 補回來必須走 traversal，見 history_back_guard.js 坑 3）。第一層 sentinel 在
//      觸控 pointerdown 疊（HTML 規範上觸控要到 pointerup 才算 activation）在 Chrome 113 上
//      實測不會被跳過：返回照樣變成 popstate（CI 現場紀錄）。
// 下拉重整（pull-to-refresh）沒有測：拿掉 overscroll-behavior 的對照組在模擬器上也拉不出
// 重整（body 是 overflow:hidden），否定斷言證明不了什麼。
// 觸控與按鍵一律走 OS 的 input injection（screen.js）。
const { test, expect } = require('./fixtures');
const {
  article,
  openScreen,
  recordTouches,
  tap,
  keyevent,
  collectSent,
  sentText,
  keyboardCover,
} = require('./screen');

// 左鍵關掉：真 tap 落在終端機上時不可以自己送鍵（左側退出帶、邊緣翻頁）。
const PREFS = { mouseLeftClick: false };

const byKey = (k) => `[data-key="${k}"]`;
const inputMode = (page) => page.evaluate(() => document.getElementById('t').getAttribute('inputmode'));
const focusedIsT = (page) => page.evaluate(() => document.activeElement === document.getElementById('t'));
const rectOf = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }, sel);
const lastRowBottom = (page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('#mainContainer [data-type="bbsline"]');
    return rows[rows.length - 1].getBoundingClientRect().bottom;
  });
// 可視區（visual viewport）底，CSS px。
const visibleBottom = (page) => page.evaluate(() => window.visualViewport.offsetTop + window.visualViewport.height);

// 站在 sentinel 那一層上（返回被接住之後 guard 用 history.forward() 走回來，非同步）。
const waitOnSentinel = (page) =>
  page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));

test.describe('Android Chrome：工具列、軟鍵盤、返回鍵（真觸控／真按鍵）', () => {
  test.skip(!article, '尚無 article cassette');

  test('工具列：真 tap 終端機與按鍵面板 ⇒ 送鍵、焦點留在 #t、不彈軟鍵盤', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page, PREFS);
    await recordTouches(page);
    expect(await keyboardCover(page)).toBe(0);

    await tap(page, device, 'blank-terminal');
    await tap(page, device, byKey('__keys'));
    await expect(page.locator('#mobileKeypad')).toBeVisible();
    await collectSent(page);
    await tap(page, device, byKey('Escape'));
    await expect.poll(() => sentText(page)).toBe('\x1b');

    // 三次真 tap、一次送鍵來回之後：鍵盤若會被叫出來早就升起了（對照組：下一條測試
    // 按 ⌨ 時同一台模擬器確實會升起鍵盤，所以這裡的 0 不是「這台根本沒有軟鍵盤」）。
    expect(await inputMode(page)).toBe('none');
    expect(await focusedIsT(page)).toBe(true);
    expect(await keyboardCover(page)).toBe(0);
    expect(await page.evaluate(() => window.__app.softKeyboard)).toBe(false);
  });

  test('⌨ 叫出軟鍵盤 ⇒ 工具列與終端機底列在鍵盤上方；返回鍵只收鍵盤、不送 ←；再按一次 ⌨ 就叫得出來', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page, PREFS);
    await recordTouches(page);
    await tap(page, device, byKey('__keys'));
    await expect(page.locator('#mobileKeypad')).toBeVisible();

    await tap(page, device, byKey('__keyboard'));
    expect(await inputMode(page)).toBe('text');
    await expect.poll(() => keyboardCover(page), { timeout: 10000 }).toBeGreaterThan(100);
    expect(await page.evaluate(() => window.__app.softKeyboard)).toBe(true);

    // 版面：工具列浮在鍵盤上、面板在工具列上、終端機底列在面板上（PTT 的輸入列不可被蓋）。
    // 鍵盤升起是動畫 ⇒ 等到工具列下緣貼齊可視區底再量。
    await expect
      .poll(async () => Math.abs((await rectOf(page, '.mobileToolbarBar')).bottom - (await visibleBottom(page))))
      .toBeLessThanOrEqual(1);
    const bar = await rectOf(page, '.mobileToolbarBar');
    const panel = await rectOf(page, '#mobileKeypad');
    expect(panel.bottom).toBeLessThanOrEqual(bar.top + 0.5);
    await expect.poll(() => lastRowBottom(page)).toBeLessThanOrEqual(panel.top + 0.5);

    // 系統返回鍵：鍵盤開著 ⇒ IME 吃掉，只收鍵盤。
    await collectSent(page);
    await keyevent(device, 'KEYCODE_BACK');
    await expect.poll(() => keyboardCover(page), { timeout: 10000 }).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__app.softKeyboard)).toBe(false);
    expect(await inputMode(page)).toBe('none');
    // 柵欄：再送一個必定會送的鍵；送出的 bytes 依序，所以若返回鍵被當成 ← 送了，會排在它前面。
    await tap(page, device, byKey('Escape'));
    await expect.poll(() => sentText(page)).toContain('\x1b');
    expect(await sentText(page)).toBe('\x1b');
    // 收起後 softKeyboard 已歸零 ⇒ ⌨ 一次就叫得出來（不是「先收起、再按才出來」）。
    await tap(page, device, byKey('__keyboard'));
    await expect.poll(() => keyboardCover(page), { timeout: 10000 }).toBeGreaterThan(100);
  });

  // Android 專屬的那段是「系統返回鍵 → popstate → guard 接住 → 用 traversal 補回 sentinel」；
  // 接住之後送不送得出 ←（nav_key_gate 依畫面判斷）與平台無關，由 offline/swipe_back 與 unit 守。
  // 原生 49 列下 cassette 畫面是 pageState 0，guard 會照實被擋（送不出 ←、閃離站提示），
  // 所以這裡斷言的是 guard 每次都收到返回並交給 sendNavKeyAsUser，而且三次都還在站內。
  // （壓 setDeviceMetricsOverride 湊 24 列試過：觸控 y 會偏、返回鍵也不再產生 popstate，棄用。）
  test('系統返回鍵 ⇒ guard 接住並交給送鍵出口，連按三次都接得住、沒有離站', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page, PREFS);
    await recordTouches(page);
    // sentinel 等第一次 user activation 才疊（History Manipulation Intervention）。
    await tap(page, device, 'blank-terminal');
    await waitOnSentinel(page);
    await page.evaluate(() => {
      window.__sameDocument = true;
      // 失敗時的現場：返回鍵有沒有變成 popstate、送鍵出口被呼叫幾次。
      window.__diag = { pops: [], navs: [] };
      window.addEventListener('popstate', (e) => window.__diag.pops.push(JSON.stringify(e.state)), true);
      const app = window.__app;
      const orig = app.sendNavKeyAsUser.bind(app);
      app.sendNavKeyAsUser = (k) => {
        window.__diag.navs.push(k);
        return orig(k);
      };
    });
    const diag = () =>
      page
        .evaluate(() => JSON.stringify({ ...window.__diag, state: history.state, length: history.length }))
        .catch((e) => String(e));
    const navs = () => page.evaluate(() => window.__diag.navs.length).catch(() => -1);

    for (let i = 1; i <= 3; i++) {
      await keyevent(device, 'KEYCODE_BACK');
      await expect
        .poll(navs, { message: `第 ${i} 次返回沒有被 guard 接住` })
        .toBe(i)
        .catch(async (e) => {
          throw new Error(`${e.message}\n現場：${await diag()}`);
        });
      await waitOnSentinel(page);
    }
    expect(await page.evaluate(() => window.__diag.navs)).toEqual(['ArrowLeft', 'ArrowLeft', 'ArrowLeft']);
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  });
});
