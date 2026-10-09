// 真 Android Chrome（模擬器）上的底部工具列、軟鍵盤、系統返回鍵、下拉重整。
// 守的是桌機 offline e2e（Pixel 7 模擬，`offline/mobile_toolbar.offline.spec.js`）只能替身測、
// 或根本測不到的那層（docs/mobile.md「規則」、docs/android-e2e.md）：
//   1. `#t` 的 inputmode="none"：真觸控 tap 終端機／工具列，Android 真的不彈軟鍵盤；
//   2. ⌨ 在 click handler 內同步 blur→focus（user activation）⇒ 軟鍵盤真的升起，而且
//      工具列（--kb-inset）與終端機底列（setKeyboardInset）都被推到鍵盤上方；
//   3. 鍵盤開著時按系統返回鍵：IME 吃掉返回、只收鍵盤，不可以走到 history sentinel 送 ←；
//      收起後 softKeyboard 歸零（`_onVisualViewport`）⇒ 再按 ⌨ 一次就叫得出來；
//   4. 系統返回鍵 → history sentinel → ←，連按都接得住（返回鍵不是 user activation，
//      sentinel 補回來必須走 traversal，見 history_back_guard.js 坑 3）；
//   5. 下拉不會觸發 Chrome 的 pull-to-refresh（重整＝斷線）。
// 觸控與按鍵一律走 OS 的 input injection（screen.js）。
const { test, expect, webviewOrigin } = require('./fixtures');
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
const { toDevicePoint } = require('./android_env');

const ARROW_LEFT = '\x1b[D';
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
const countLefts = async (page) => (await sentText(page)).split(ARROW_LEFT).length - 1;

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

    await tap(page, device, '#mainContainer');
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

  test('系統返回鍵 ⇒ 送 ←，連按三次都接得住、沒有離站', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page, PREFS);
    await recordTouches(page);
    // sentinel 等第一次 user activation 才疊（History Manipulation Intervention）。
    await tap(page, device, '#mainContainer');
    await waitOnSentinel(page);
    await page.evaluate(() => {
      window.__sameDocument = true;
    });

    await collectSent(page);
    for (let i = 1; i <= 3; i++) {
      await keyevent(device, 'KEYCODE_BACK');
      await expect.poll(() => countLefts(page)).toBe(i);
      await waitOnSentinel(page);
    }
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  });

  // 下拉重整會重新載入頁面 ⇒ WebSocket 斷線（PTT 連線沒了）。
  for (const easyReading of [false, true]) {
    test(`下拉不觸發重新整理（${easyReading ? '文章好讀' : '終端機格線'}）`, async ({ page, android }) => {
      test.setTimeout(120000);
      await openScreen(page, { ...PREFS, enableEasyReading: easyReading });
      expect(await pullDown(page, android.device)).toBe(false);
    });
  }

  // 對照組：拿掉 overscroll-behavior 之後同一個手勢**會**觸發重整 ⇒ 上面的 false 不是
  // 「這個手勢在模擬器上本來就拉不出重整」。
  test('對照組：拿掉 overscroll-behavior ⇒ 同一個下拉手勢會重新整理', async ({ page, android }) => {
    test.setTimeout(120000);
    await openScreen(page, PREFS);
    await page.addStyleTag({
      content: 'html, body, .main, .listBodyView { overscroll-behavior: auto !important; }',
    });
    expect(await pullDown(page, android.device)).toBe(true);
  });
});

// 從終端機頂端往下拉 400 CSS px（手指放開才會觸發重整）。回傳頁面有沒有被重新載入。
async function pullDown(page, device) {
  await page.evaluate(() => {
    window.__noReload = true;
    window.__touchEnded = false;
    const end = () => {
      window.__touchEnded = true;
    };
    window.addEventListener('touchend', end, true);
    window.addEventListener('touchcancel', end, true);
  });
  const pt = await page.evaluate(() => {
    const r = document.getElementById('mainContainer').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: Math.max(r.top, 0) + 30, dpr: devicePixelRatio };
  });
  const origin = await webviewOrigin(device);
  const from = toDevicePoint(origin, pt.dpr, pt);
  const to = toDevicePoint(origin, pt.dpr, { x: pt.x, y: pt.y + 400 });
  await device.shell(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} 600`);
  // 重整是放手後才開始的導航；頁面一旦換掉，舊的 window 狀態就讀不到了（evaluate 落在新
  // document 或導航中途丟錯）。先確認手勢收尾，再給它一段觀察窗。
  const alive = () => page.evaluate(() => window.__noReload === true).catch(() => false);
  await expect.poll(async () => (await alive()) === false || (await page.evaluate(() => window.__touchEnded).catch(() => true))).toBe(true);
  // 觀察窗：放手後 3s 內有沒有導航（Chrome 的重整在放手後立刻開始，動畫不到 1s）。
  await page.waitForEvent('framenavigated', { timeout: 3000 }).catch(() => null);
  return !(await alive());
}
