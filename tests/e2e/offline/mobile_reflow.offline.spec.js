// 手機版面 Phase 3（docs/mobile.md）：好讀文章改正常字級＋超寬自動換行（term_view.reflow）。
// 只在 offline-mobile project 跑（Pixel 7 模擬、視窗高 390 ⇒ 24 列）。
//
// 同檔另守「長按叫出的選單」：Chromium 長按先選字、後發 contextmenu，舊規則把那個
// 自動選取當成使用者的選取 ⇒ 「加入黑名單」「前已讀後未讀」整組消失（使用者回報）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled, scrollIntoViewStable } = require('../helpers/layout');

const article = findCassette('article');

// NAWS（IAC SB NAWS）＝重送終端機尺寸。換行版面只換字級與寬度，不可以改列數。
const nawsCount = (page) =>
  page.evaluate(
    () => (window.__replay ? window.__replay.sent : []).filter((s) => String(s).includes('\xff\xfa\x1f')).length
  );

const layout = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const main = document.querySelector('.main');
    const r = main.getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]'));
    const chh = app.view.chh;
    return {
      reflow: app.view.reflow,
      cls: main.classList.contains('mobileReflow'),
      chh,
      rows: app.buf.rows,
      mainLeft: r.left,
      mainWidth: r.width,
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      // 只有文字、沒有預覽盒的列，高度超過 1.5 列 ＝ 被折成多行
      wrapped: rows.filter(
        (el) => !el.querySelector('.inlinePreviewSlot, img, video, iframe') && el.getBoundingClientRect().height > chh * 1.5
      ).length,
    };
  });

test.describe('手機 Phase 3：好讀文章換行版面（離線重放）', () => {
  test.skip(!article, '尚無 article cassette');

  test('好讀文章：正常字級、寬＝視窗寬、不橫向溢出、超寬列換行；列數不變不重送 NAWS', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    const before = await page.evaluate(() => ({ rows: window.__app.buf.rows, chh: window.__app.view.chh }));
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);

    const g = await layout(page);
    expect(g.cls).toBe(true);
    expect(g.chh).toBeGreaterThan(before.chh);
    expect(g.chh).toBeLessThanOrEqual(16);
    expect(g.rows).toBe(before.rows);
    expect(Math.abs(g.mainWidth - g.innerWidth)).toBeLessThanOrEqual(1);
    expect(g.mainLeft).toBeGreaterThanOrEqual(-0.5);
    expect(g.mainScrollWidth).toBeLessThanOrEqual(g.mainClientWidth + 1);
    expect(g.docScrollWidth).toBeLessThanOrEqual(g.innerWidth);
    expect(g.wrapped).toBeGreaterThan(0);
    expect(await nawsCount(page)).toBe(0);
  });

  test('進 functionMode（原生鏡像）／退出好讀 ⇒ 回到 Phase 2 的塞滿縮放', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    const grid = await page.evaluate(() => window.__app.view.chh);
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);

    await page.evaluate(() => window.__app.easyReading._enterFunctionMode());
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(false);
    let g = await layout(page);
    expect(g.cls).toBe(false);
    expect(g.chh).toBeCloseTo(grid, 5);
    expect(g.mainLeft).toBeGreaterThanOrEqual(0);
    expect(g.mainLeft + g.mainWidth).toBeLessThanOrEqual(g.innerWidth + 0.5);

    await page.evaluate(() => window.__app.easyReading.exitEasyReading());
    await expect.poll(() => page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(false);
    g = await layout(page);
    expect(g.reflow).toBe(false);
    expect(g.chh).toBeCloseTo(grid, 5);
    expect(await nawsCount(page)).toBe(0);
  });

  test('換行版面下 tap 內文左緣不會被當成「左側退出帶」跳出文章', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const sentBefore = await page.evaluate(() => window.__replay.sent.length);
    const box = await page.locator('.main').boundingBox();
    // tap 的 click handler 是同步送鍵的：tap() resolve 時該送的早就送了。
    await page.touchscreen.tap(box.x + 4, box.y + 60);
    const sent = await page.evaluate((n) => window.__replay.sent.slice(n), sentBefore);
    expect(sent.join('')).not.toContain('\x1b[D');
    expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
  });
});

test.describe('長按選單（觸控 contextmenu）', () => {
  test.skip(!article, '尚無 article cassette');

  // 每次 contextmenu 在 window capture 階段記下：當下選取是否為空、事件本身（事後讀
  // defaultPrevented）、pointerType。capture 在 React 的 listener 之前跑 ⇒ 看到的是
  // 我們的 handler 動手前的選取。
  const recordContextMenu = (page) =>
    page.evaluate(() => {
      window.__cm = [];
      if (window.__cmInstalled) return;
      window.__cmInstalled = true;
      window.addEventListener(
        'contextmenu',
        (ev) => window.__cm.push({ ev, collapsed: window.getSelection().isCollapsed }),
        true
      );
    });
  const lastContextMenu = async (page) => {
    await expect.poll(() => page.evaluate(() => window.__cm.length)).toBeGreaterThan(0);
    return page.evaluate(() => {
      const { ev, collapsed } = window.__cm[window.__cm.length - 1];
      return {
        collapsed,
        defaultPrevented: ev.defaultPrevented,
        pointerType: ev.pointerType,
        collapsedAfter: window.getSelection().isCollapsed,
      };
    });
  };

  const targetPoint = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('[data-e2e-target] [data-type="bbsline"]') ||
        document.querySelector('[data-e2e-target]');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width - 2, 60)), y: Math.round(r.top + 4) };
    });

  // 把手指下那個字選起來（Chromium 長按的第一步；也是「使用者已選取」的狀態布置）。
  const selectWordAt = (page, { x, y }) =>
    page.evaluate(({ x, y }) => {
      const range = document.caretRangeFromPoint(x, y);
      const sel = window.getSelection();
      sel.removeAllRanges();
      if (range) {
        range.expand('word');
        sel.addRange(range);
      }
    }, { x, y });

  // 模擬 Chromium 的長按：先選字，再發 pointerType=touch 的 contextmenu。
  // **只能手捏**：CDP 的觸控長按（Input.synthesizeTapGesture duration 900／
  // dispatchTouchEvent 按住 1.2s）在桌機 Chromium（headless shell、new headless、headed
  // 皆然）只產生 pointerdown/up，**不發 contextmenu** —— 拿它斷言「選單 0 個」會是假陽性。
  // 這個 helper 只代表長按事件序列的**第一個**事件；拖選取把手後補發的那次見下方
  // ContextMenu 鍵的 REGRESSION case。
  const longPress = async (page) => {
    const pt = await targetPoint(page);
    await selectWordAt(page, pt);
    await recordContextMenu(page);
    await page.evaluate(({ x, y }) => {
      const el = document.querySelector('[data-e2e-target] [data-type="bbsline"]') ||
        document.querySelector('[data-e2e-target]');
      el.dispatchEvent(
        new PointerEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch' })
      );
    }, pt);
    return lastContextMenu(page);
  };

  const markPusherRow = async (page) => {
    const pusher = await page.evaluate(() => {
      const el = document.querySelector('#mainContainer span[type="bbsrow"][data-pusher]');
      if (!el) return null;
      el.setAttribute('data-e2e-target', '1');
      return el.getAttribute('data-pusher');
    });
    if (pusher) await scrollIntoViewStable(page, '[data-e2e-target]');
    return pusher;
  };

  const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);
  const menu = (page) => page.locator('.DropdownMenu').first();

  test('REGRESSION：長按推文列（手指下的字已被選起來）仍出現「加入黑名單」', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const pusher = await markPusherRow(page);
    test.skip(!pusher, '這份 cassette 沒有推文列');

    const { collapsed, collapsedAfter, pointerType } = await longPress(page);
    expect(pointerType).toBe('touch');
    expect(collapsed).toBe(false); // 前提：事件發生時真的有選取（Chromium 長按的現場）
    const add = await label(page, 'cmenu_addAuthorBlacklist');
    const item = menu(page).getByRole('menuitem').filter({ hasText: add });
    await expect(item).toBeVisible();
    await expect(item).toContainText(pusher, { ignoreCase: true });
    // 選取模式關（預設）：長按選到的字被收掉，不留原生選取把手跟選單打架；
    // 複製類項目跟著不出現（要選字複製就開選取模式）。
    expect(collapsedAfter).toBe(true);
    // 「複製」項目認它的快捷鍵字樣（cmenu_copy 的字面也是「複製本篇文章連結」等的子字串）。
    await expect(menu(page).getByRole('menuitem').filter({ hasText: 'Ctrl+C' })).toHaveCount(0);
  });

  test('選取模式開：長按＝一般網頁操作（不 preventDefault、不開我們的選單、選取留著）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const pusher = await markPusherRow(page);
    test.skip(!pusher, '這份 cassette 沒有推文列');

    // 走按鍵列的開關（真的 UI 入口），不是直接改 App 狀態。
    await page.locator('[data-key="__open"]').click();
    await page.locator('[data-key="__select"]').click();
    await expect(page.locator('[data-key="__select"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.body.classList.contains('mobileSelectMode'))).toBe(true);

    const r = await longPress(page);
    expect(r.collapsed).toBe(false);
    expect(r.defaultPrevented).toBe(false);
    expect(r.collapsedAfter).toBe(false);
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
  });

  // REGRESSION：拖完選取把手放手，Android Chrome 會再補發一次 contextmenu
  // （RenderWidgetHostViewAndroid::ShowContextMenuAtTouchHandle → Blink
  // EventHandler::ShowNonLocatedContextMenu），事件是 pointerType 'mouse'、沒有觸控標記。
  // 舊規則（觸控＋選取模式才放行）讓那次跳出我們的選單、原生複製工具列被吃掉。
  // 桌機的 ContextMenu 鍵走的是**同一個** Blink 函式、事件形狀相同，所以用它當替身。
  test('REGRESSION：選取模式開，拖把手後補發的非觸控 contextmenu 也不開我們的選單', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const pusher = await markPusherRow(page);
    test.skip(!pusher, '這份 cassette 沒有推文列');

    await page.locator('[data-key="__open"]').click();
    await page.locator('[data-key="__select"]').click();
    await expect(page.locator('[data-key="__select"]')).toHaveAttribute('aria-pressed', 'true');

    // 拖完把手後的現場：有選取、把手在。選取用 Selection API 布置（狀態準備），
    // 觸發用真的 ContextMenu 鍵（瀏覽器自己造 contextmenu，不是測試手捏）。
    await selectWordAt(page, await targetPoint(page));
    await recordContextMenu(page);
    const cdp = await page.context().newCDPSession(page);
    const key = { key: 'ContextMenu', code: 'ContextMenu', windowsVirtualKeyCode: 93, nativeVirtualKeyCode: 93 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    const r = await lastContextMenu(page);
    expect(r.collapsed).toBe(false);
    // 前提：這次真的是「沒有觸控標記」的那種事件，不然測不到舊 bug。
    expect(r.pointerType).not.toBe('touch');
    expect(r.defaultPrevented).toBe(false);
    expect(r.collapsedAfter).toBe(false);
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
  });

  test('滑鼠右鍵＋有選取：維持桌機規則（只有複製那一組）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const pusher = await markPusherRow(page);
    test.skip(!pusher, '這份 cassette 沒有推文列');

    // 先選一段字（使用者已選取），再用真的滑鼠右鍵點在選取上。
    const pt = await targetPoint(page);
    await selectWordAt(page, pt);
    await recordContextMenu(page);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    const r = await lastContextMenu(page);
    expect(r.pointerType).toBe('mouse');
    expect(r.collapsed).toBe(false);
    await expect(menu(page)).toBeVisible();
    const add = await label(page, 'cmenu_addAuthorBlacklist');
    await expect(menu(page).getByRole('menuitem').filter({ hasText: add })).toHaveCount(0);
  });
});

// 推文卡片（render/comment_card.js、docs/mobile.md「推文卡片」）。症狀：換行版面下
// 推文列照 80 欄原樣折行，時間被擠到下一行的最左邊。
test.describe('手機推文卡片', () => {
  test.skip(!article, '尚無 article cassette');

  test('每則推文的時間與 id 同一行、靠右；內容不含時間', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);
    await waitPreviewsSettled(page);
    const cards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer > span.commentCard')).map((c) => {
        const card = c.getBoundingClientRect();
        const id = c.querySelector('.commentCardId').getBoundingClientRect();
        const time = c.querySelector('.commentCardTime');
        const t = time ? time.getBoundingClientRect() : null;
        return {
          idTop: id.top,
          idBottom: id.bottom,
          timeMid: t ? (t.top + t.bottom) / 2 : null,
          timeRight: t ? t.right : null,
          cardRight: card.right,
          body: c.querySelector('.commentCardText').textContent,
          time: time ? time.textContent : null,
        };
      })
    );
    test.skip(cards.length === 0, '這份 cassette 沒有推文列');
    for (const c of cards) {
      expect(c.time).toMatch(/\d{1,2}\/\d{2} \d{2}:\d{2}/);
      // 時間的垂直中線落在 id 那一行之內 ⇒ 同一行（字級不同，比 top 會差幾 px）。
      expect(c.timeMid).toBeGreaterThanOrEqual(c.idTop);
      expect(c.timeMid).toBeLessThanOrEqual(c.idBottom);
      expect(c.cardRight - c.timeRight).toBeLessThan(24);
      expect(c.body).not.toContain(c.time);
    }
  });
});
