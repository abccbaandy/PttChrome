// 真 Android Chrome（模擬器）上的長按／選取把手。守的是**我們對 Android 的假設**，
// 桌機 offline e2e 只能拿替身測（docs/mobile.md「長按選單與選取模式」）：
//   1. 拖完選取把手放手，Chrome 真的會補發一次非觸控 contextmenu（kTouchHandle：
//      RenderWidgetHostViewAndroid::ShowContextMenuAtTouchHandle → Blink
//      EventHandler::ShowNonLocatedContextMenu），而且我們放行它；
//   2. 放行後原生「Copy」工具列真的出現（browser UI，頁面內看不到，只能用 UIAutomator 查）。
// 觸控一律走 OS 的 input injection（`adb shell input swipe`），會經過 Android 自己的
// TouchSelectionController —— 這正是桌機 CDP 做不出來的那段。
const { test, expect, webviewOrigin, envError } = require('./fixtures');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { toDevicePoint } = require('./android_env');

const article = findCassette('article');

// 模擬器的觸控螢幕帶 STYLUS source ⇒ Chrome 回報 pointer: fine（實測，CDP 的
// setEmulatedMedia 蓋不掉）⇒ auto 判不成手機。用產品自己的逃生門 pref 強制手機版面；
// 觸控與選取本身仍是真的。必須在 goto 前就位（開站即套版面）。
async function forceMobileLayout(page) {
  await page.addInitScript(
    ({ KEY }) => {
      const cur = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      const values = Object.assign({}, cur.values, { mobileLayout: 'on', enableEasyReading: false });
      window.localStorage.setItem(KEY, JSON.stringify({ values }));
    },
    { KEY: ptt.PREF_KEY }
  );
}

// 一般終端機畫面（不開好讀）：被測的是 Chrome 的長按／把手，跟畫面是哪種模式無關。
// 不開好讀 ⇒ 不需要「一屏 24 列」，模擬器用原生 Pixel 6 尺寸（49 列，cassette 的 24 列
// 畫在上半部）——跟真手機同一個長條比例。
async function openScreen(page) {
  await forceMobileLayout(page);
  await bootOffline(page, ptt);
  if (!(await page.evaluate(() => window.__app.mobile))) {
    throw envError('沒有進手機版面（mobileLayout pref 沒套上）');
  }
  await replayCassette(page, article, { easyReading: false });
  await expect.poll(() => page.evaluate(() => window.__app.buf.getRowText(0).trim().length)).toBeGreaterThan(0);
}

async function setSelectMode(page, on) {
  // 選取模式在底部工具列的「更多」裡；切換後選單自動收起，再開一次讀狀態。
  await page.locator('[data-key="__more"]').click();
  if (on) {
    await page.locator('[data-key="__select"]').click();
    await page.locator('[data-key="__more"]').click();
  }
  await expect(page.locator('[data-key="__select"]')).toHaveAttribute('aria-pressed', String(on));
  await page.locator('[data-key="__more"]').click();
}

// capture 階段記下每個 contextmenu／觸控 pointerdown（React listener 之前），事後讀
// defaultPrevented。
async function recordEvents(page) {
  await page.evaluate(() => {
    window.__cm = [];
    window.__down = [];
    window.addEventListener('contextmenu', (ev) => window.__cm.push(ev), true);
    window.addEventListener('pointerdown', (ev) => window.__down.push({ x: ev.clientX, y: ev.clientY, type: ev.pointerType }), true);
  });
}

const contextMenus = (page) =>
  page.evaluate(() =>
    window.__cm.map((ev) => ({
      pointerType: ev.pointerType,
      firesTouchEvents: ev.sourceCapabilities ? ev.sourceCapabilities.firesTouchEvents : null,
      defaultPrevented: ev.defaultPrevented,
    }))
  );

const selectionText = (page) => page.evaluate(() => String(window.getSelection()));

// 目標：按鍵列上方、視窗內第一個有字列的某個非空白字元中心（CSS px）。
const targetChar = (page) =>
  page.evaluate(() => {
    const kp = document.getElementById('mobileToolbar');
    const bottom = Math.min(innerHeight, kp ? kp.getBoundingClientRect().top : innerHeight) - 8;
    for (const row of document.querySelectorAll('#mainContainer span[type="bbsrow"]')) {
      const rr = row.getBoundingClientRect();
      if (rr.top < 8 || rr.bottom > bottom) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const chars = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (let i = 0; i < n.data.length; i++) if (/\S/.test(n.data[i])) chars.push([n, i]);
      }
      if (chars.length < 8) continue;
      const [node, i] = chars[Math.floor(chars.length / 2)];
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio };
    }
    return null;
  });

const selectionRect = (page) =>
  page.evaluate(() => {
    const s = window.getSelection();
    if (!s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0).getBoundingClientRect();
    return { right: r.right, bottom: r.bottom };
  });

// 真長按：OS 層按住 1.2s（Android 長按門檻 500ms）。觸控落點用頁面收到的 pointerdown
// 自檢 —— 對不上就是座標換算錯（環境問題），不是被測行為。
async function longPress(page, device, pt) {
  const origin = await webviewOrigin(device);
  const p = toDevicePoint(origin, pt.dpr, pt);
  await device.shell(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} 1200`);
  await expect.poll(() => page.evaluate(() => window.__cm.length)).toBeGreaterThan(0);
  const down = await page.evaluate(() => window.__down.find((d) => d.type === 'touch'));
  if (!down || Math.abs(down.x - pt.x) > 4 || Math.abs(down.y - pt.y) > 4) {
    throw envError(`觸控落點偏移：目標 ${JSON.stringify(pt)}，實際 ${JSON.stringify(down)}，WebView ${JSON.stringify(origin)}`);
  }
}

test.describe('Android Chrome：長按與選取把手（真觸控）', () => {
  test.skip(!article, '尚無 article cassette');

  test('選取模式開：拖結尾把手放手 ⇒ Chrome 補發非觸控 contextmenu、我們放行、原生 Copy 工具列出現', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page);
    await setSelectMode(page, true);
    await recordEvents(page);

    const pt = await targetChar(page);
    expect(pt).not.toBeNull();
    await longPress(page, device, pt);

    // 長按本身：觸控 contextmenu、放行、選取留著、我們的選單不出現。
    const [press] = await contextMenus(page);
    expect(press).toEqual({ pointerType: 'touch', firesTouchEvents: true, defaultPrevented: false });
    const before = await selectionText(page);
    expect(before.trim().length).toBeGreaterThan(0);
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);

    // 拖結尾把手往右：把手畫在選取右下方。
    const rect = await selectionRect(page);
    expect(rect).not.toBeNull();
    const origin = await webviewOrigin(device);
    const from = toDevicePoint(origin, pt.dpr, { x: rect.right + 4, y: rect.bottom + 10 });
    const to = toDevicePoint(origin, pt.dpr, { x: rect.right + 120, y: rect.bottom + 10 });
    await device.shell(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} 800`);

    // 前提（替身測試成立的依據）：Android 真的補發了那次事件，而且它沒有觸控標記。
    await expect.poll(() => page.evaluate(() => window.__cm.length)).toBe(2);
    const [, handle] = await contextMenus(page);
    expect(handle.pointerType).not.toBe('touch');
    expect(handle.firesTouchEvents).toBe(false);
    // 被測行為：放行 ⇒ 沒有我們的選單、選取是拖過之後的範圍。
    expect(handle.defaultPrevented).toBe(false);
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
    expect((await selectionText(page)).length).toBeGreaterThan(before.length);
    // 結果：原生複製工具列（模擬器固定 en-US）。**輪詢 device.info，不用 device.wait**：
    // wait 等的是 UI 變化，工具列若在 wait 開始前就出現、之後畫面不再變，畫面上明明有它
    // 也會等滿逾時（實測：失敗截圖裡工具列就在那裡）。info 偶爾第一次讀不到，~1s 內一定讀得到。
    await expect
      .poll(
        () =>
          device
            .info({ res: 'android:id/floating_toolbar_menu_item_text', text: 'Copy' })
            .then(() => true, () => false),
        { intervals: [500], timeout: 10000 }
      )
      .toBe(true);
  });

  test('對照組：選取模式關 ⇒ 長按開我們的選單、選取被清掉（沒有把手可拖）', async ({ page, android }) => {
    test.setTimeout(120000);
    const { device } = android;
    await openScreen(page);
    await setSelectMode(page, false);
    await recordEvents(page);

    const pt = await targetChar(page);
    expect(pt).not.toBeNull();
    await longPress(page, device, pt);

    const cms = await contextMenus(page);
    expect(cms).toEqual([{ pointerType: 'touch', firesTouchEvents: true, defaultPrevented: true }]);
    await expect(page.locator('.DropdownMenu')).toHaveCount(1);
    expect(await page.evaluate(() => window.getSelection().isCollapsed)).toBe(true);
  });
});
