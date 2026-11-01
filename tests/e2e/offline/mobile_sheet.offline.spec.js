// 手機 bottom sheet（docs/mobile.md「Bottom sheet」，components/MobileSheet）：「更多」、
// 長按選單、搜尋在手機上的外殼。只在 offline-mobile project 跑（Pixel 7 模擬）。
//
// unit（mobile_toolbar.test.jsx／context_sheet.test.jsx／history_back_guard.test.js）守分支；
// 這裡守 unit 摸不到的：真觸控點遮罩不會漏成「點終端機」送鍵、系統返回（真 popstate）
// 只收 sheet 不送 ←、搜尋 sheet 的輸入框真的拿到焦點。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { waitRectStable, waitDialogSettled, installPaintedFrameProbe } = require('../helpers/layout');

const byKey = (page, k) => page.locator(`[data-key="${k}"]`);
const sheet = (page, k) => page.locator(`[data-sheet="${k}"]`);

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

async function bootMenu(page) {
  await bootOffline(page, ptt);
  // 滑鼠瀏覽開著：點到終端機（選單大按鈕）會送鍵 ⇒ 「遮罩點擊漏出去」才測得出來。
  await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
  await drawMainMenu(page);
  await page.waitForFunction(() => window.__app.view.menuCards === true);
}

test.describe('手機 bottom sheet', () => {
  // 點 sheet 裡的項目之前一律先 waitDialogSettled（守護 e2e_layout_settle「打開「更多」之後…」）：
  // 開場 slide-up 途中 tap，pointerdown 落在項目上、Chrome 產生 click 前重新 hit-test 時項目已經
  // 滑走 ⇒ click 只到共同祖先，onClick 沒跑（mobile_toolbar「同主題下篇送 ]」偶發零送鍵）。
  // 鎖兩件事：①前提還在（sheet 開場真的會滑，否則這條該重寫）；②waitDialogSettled 放行那一刻，
  // 項目已經在最終位置（之後不再動）。
  test('「更多」開場會滑動；waitDialogSettled 放行時項目已在最終位置', async ({ page }) => {
    await bootMenu(page);
    const sel = '[data-sheet="more"] [data-key="__settings"]';
    // 逐幀在 paint 前取樣（helpers/layout.js#installPaintedFrameProbe），1.5 秒。
    await installPaintedFrameProbe(page);
    await page.evaluate((s) => {
      const tops = [];
      const rec = { tops, done: false };
      window.__sheetTops = rec;
      const t0 = performance.now();
      const sample = () => {
        const b = document.querySelector(s);
        if (b) tops.push(b.getBoundingClientRect().top);
        if (performance.now() - t0 >= 1500) {
          window.__paintedFrame.remove(sample);
          rec.done = true;
        }
      };
      window.__paintedFrame.add(sample);
    }, sel);
    await byKey(page, '__more').tap();
    await waitDialogSettled(page, sel);
    const atSettle = await page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top, sel);
    // 取樣本身就是時間軸（逐幀 1.5 秒），等它跑完，不另外睡。
    await page.waitForFunction(() => window.__sheetTops.done);
    const tops = await page.evaluate(() => window.__sheetTops.tops);
    const final = tops[tops.length - 1];
    expect(Math.max(...tops) - Math.min(...tops), '前提：開場時項目會滑動').toBeGreaterThan(5);
    expect(Math.abs(atSettle - final)).toBeLessThan(0.5);
  });

  test('更多：開著＝modal；點遮罩（壓在選單按鈕上）只收 sheet，不送任何鍵', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap();
    await expect(sheet(page, 'more')).toBeVisible();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    // 遮罩上、正下方是一顆選單大按鈕的位置（sheet 動畫停了再量）
    const card = await waitRectStable(page, '#mainContainer .menuCard');
    const sheetBox = await waitRectStable(page, '[data-sheet="more"]');
    const y = card.top + card.height / 2;
    expect(y).toBeLessThan(sheetBox.top);
    await collectSent(page);
    await page.touchscreen.tap(card.left + card.width / 2, y);
    await expect(sheet(page, 'more')).toHaveCount(0);
    expect(await sentText(page)).toBe('');
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);
  });

  test('系統返回（popstate）＝收起 sheet，不送 ←、不出逃生提示', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap(); // 這一下也是 user activation ⇒ sentinel 疊上
    await expect(sheet(page, 'more')).toBeVisible();
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
    await collectSent(page);
    await page.goBack();
    await expect(sheet(page, 'more')).toHaveCount(0);
    expect(await sentText(page)).not.toContain('\x1b[D');
    expect(await page.evaluate(() => !!window.__app)).toBe(true);
    // sentinel 補回來了：下一次返回照常送 ←（不會被當成逃生而離站）
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
  });

  test('搜尋：從底部導覽開成 sheet，輸入框拿到焦點；遮罩收起後焦點回終端機', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__search').tap();
    await expect(sheet(page, 'search')).toBeVisible();
    const input = sheet(page, 'search').locator('input[name="searchKeyword"]');
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet(page, 'search')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.getElementById('t')))
      .toBe(true);
  });

  // 焦點從隱藏 input #t（文字輸入框恆為 :focus-visible）被 focus trap 搬進 sheet ⇒ Chromium
  // 讓新焦點繼承 :focus-visible ⇒ 觸控打開就有一圈焦點框，「選取模式」看起來像被選中。
  // 焦點框只該在鍵盤操作時出現（src/js/focus_ring.js）。
  test('觸控打開 sheet／設定：沒有焦點框；按 Tab 之後才畫', async ({ page }) => {
    await bootMenu(page);
    const activeOutline = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return a && a !== document.body ? getComputedStyle(a).outlineStyle : 'no-focus';
      });
    await byKey(page, '__more').tap();
    await expect(sheet(page, 'more')).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement.closest('[data-sheet="more"]'))).toBe(true);
    expect(await activeOutline()).toBe('none');

    await page.keyboard.press('Tab');
    await expect.poll(activeOutline).not.toBe('none');

    // sheet 開場動畫可能先停幾幀再滑（同 #232 的 Mantine Modal），Playwright 的 stable 會提早放行，
    // tap 落在還在滑的按鈕旁邊 ⇒ 設定沒開。動畫停了再點。
    await waitRectStable(page, '[data-key="__settings"]');
    await byKey(page, '__settings').tap();
    const close = page.locator('.mantine-Modal-close');
    await expect(close).toBeFocused();
    expect(await activeOutline()).toBe('none');
  });

  // 手機的 sheet 外殼恆為暗色（同 App Bar／底部導覽），但淺色主題時裡面的 Mantine 元件
  // 跟著 <html data-mantine-color-scheme="light"> 變淺：指令面板選中項變成淺灰底＋sheet
  // 繼承的淺色字，幾乎看不見；搜尋框是一塊白。sheet 內一律照暗色畫（MobileSheet）。
  test('淺色主題：sheet 裡的 Mantine 元件照暗色畫，選中項的字看得清楚', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('mantine-color-scheme-value', 'light');
      } catch (e) {}
    });
    await bootMenu(page);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme'))).toBe('light');

    // 相對亮度（WCAG）與對比；背景透明就往上找第一個不透明的祖先。
    const contrastOf = (sel) =>
      page.evaluate((sel) => {
        const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = ([r, g, b]) => {
          const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const el = document.querySelector(sel);
        let bgEl = el;
        let bg = null;
        while (bgEl) {
          const v = parse(getComputedStyle(bgEl).backgroundColor);
          if (v.length >= 3 && (v.length < 4 || v[3] > 0.5)) {
            bg = v;
            break;
          }
          bgEl = bgEl.parentElement;
        }
        const fg = parse(getComputedStyle(el).color);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return { ratio: (a + 0.05) / (b + 0.05), bgLum: lum(bg) };
      }, sel);

    await page.keyboard.press('F4');
    const active = '[data-sheet="commandPalette"] .commandPaletteItem[data-active] .commandPaletteTitle';
    await expect(page.locator(active)).toBeVisible();
    expect((await contrastOf(active)).ratio).toBeGreaterThanOrEqual(4.5);
    // 輸入框不是暗色 sheet 上的一塊白
    expect((await contrastOf('[data-sheet="commandPalette"] input')).bgLum).toBeLessThan(0.2);
  });

  test('拖曳把手往下拉＝收起', async ({ page }) => {
    await bootMenu(page);
    await byKey(page, '__more').tap();
    await expect(sheet(page, 'more')).toBeVisible(); // Drawer 內容是非同步掛上的
    // slide-up 動畫中量到的是還在視窗外的位置 ⇒ 等版面穩定再量。
    const b = await waitRectStable(page, '[data-sheet="more"] [data-sheet-handle]');
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    // 觸控拖曳：CDP 觸控事件（real_input 的規範：瀏覽器負責的手勢不手捏 DOM 事件）。
    const cdp = await page.context().newCDPSession(page);
    const pt = (yy) => [{ x, y: yy }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) });
    for (let d = 20; d <= 160; d += 20)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(sheet(page, 'more')).toHaveCount(0);
  });
});
