// 手機版面 Phase 4（docs/mobile.md「Phase 4」）：列表好讀的 body 列畫成卡片。
// 只在 offline-mobile project 跑（Pixel 7、DPR 2.625、視窗高 390 ⇒ 24 列）。
//
// 捲動數學的前提是「每筆等高」（list_scroll.js）：卡片一筆＝LIST_CARD_ROWS × chh。
// 這裡的 chh 是小數（(390-10)/24 對齊裝置像素 ＝ 15.619…），卡片高也是小數 ⇒
// 「非整數 DPR 下 scrollTop 量化少算一列」（手機 PgUp 卡住，SCROLL_QUANT_EPS）在卡片
// 模式下同樣由這支守（easy-reading-list 那支是 80 欄格線的斷言，只在桌機跑）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
const { waitScrollStable, waitRectStable, OVERRIDING_SEL } = require('../helpers/layout');

const nav = loadCassette('cchat-list-nav');

// 兩行內容＋0.5 列間距（mobile_layout.LIST_CARD_ROWS）。
const CARD_ROWS = 2.5;

const state = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const ls = app.listSession;
    const v = document.querySelector('#mainContainer .listBodyView');
    return {
      state: ls.state,
      renderMode: app.buf.listRenderMode,
      listLen: (app.buf.listLines || []).length,
      queueIdle: app.commandQueue.idle,
      listCards: app.view.listCards,
      chh: app.view.chh,
      rows: app.buf.rows,
      topNum: ls._topNum,
      selectedNum: ls._selectedNum,
      scrollTop: v ? v.scrollTop : -1,
      viewportPx: v ? v.clientHeight : -1,
    };
  });

async function waitState(page, pred, timeout = 20000) {
  let last = null;
  await expect
    .poll(async () => {
      last = await state(page);
      return pred(last);
    }, { timeout })
    .toBe(true)
    .catch(() => {
      throw new Error('waitState 逾時：' + JSON.stringify(last));
    });
  return last;
}

async function engage(page) {
  await bootOffline(page, ptt);
  const before = await page.evaluate(() => ({ chh: window.__app.view.chh, rows: window.__app.buf.rows }));
  await replayListCassette(page, nav);
  await page.waitForFunction(() => window.__app.buf.pageState === 2);
  await ptt.applyPrefs(page, {
    enableEasyReadingList: true,
    easyReadingListPrefetchCount: 200,
    useMouseBrowsing: true,
    mouseLeftClick: true,
  });
  await waitState(page, (x) => x.state === 'active' && x.listLen > 50 && x.queueIdle && x.listCards);
  return before;
}

test.describe('手機 Phase 4：列表卡片（離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('進板：body 變卡片、正常字級、寬＝視窗寬、卡片固定高、列數不變', async ({ page }) => {
    test.setTimeout(90000);
    const before = await engage(page);
    const g = await page.evaluate(() => {
      const main = document.querySelector('.main');
      const cards = Array.from(document.querySelectorAll('#mainContainer .listBodyView > .listCard'));
      const hs = cards.slice(0, 12).map((c) => c.getBoundingClientRect().height);
      return {
        cls: main.classList.contains('mobileListCards'),
        mainWidth: main.getBoundingClientRect().width,
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        cards: cards.length,
        heights: hs,
        // header／footer 不是卡片（容器直系子層），而且收起（看板名在 App Bar）
        outerCards: document.querySelectorAll('#mainContainer > .listCard').length,
        chromeRows: Array.from(document.querySelectorAll('#mainContainer > [type="bbsrow"]')).map((n) => ({
          collapsed: n.classList.contains('mobileCollapsedRow'),
          h: n.getBoundingClientRect().height,
        })),
        viewTop: document.querySelector('#mainContainer .listBodyView').getBoundingClientRect().top,
        mainTop: main.getBoundingClientRect().top,
        appBarTitle: document.querySelector('#mobileAppBar [data-key="__title"]').textContent,
        // 看板名的真相：server 畫面 row 0 的《板名》（list_session.parseBoardName 同規則）。
        boardName: (/《([^《》]+)》/.exec(window.__app.buf.getRowText(0, 0, 80)) || [])[1] || null,
        firstTitle: cards[0] && cards[0].querySelector('.listCardTitle').textContent,
      };
    });
    const s = await state(page);
    expect(g.cls).toBe(true);
    expect(s.chh).toBeGreaterThan(before.chh);
    expect(s.rows).toBe(before.rows);
    expect(Math.abs(g.mainWidth - g.innerWidth)).toBeLessThanOrEqual(1);
    expect(g.docScrollWidth).toBeLessThanOrEqual(g.innerWidth);
    expect(g.cards).toBeGreaterThan(20);
    expect(g.outerCards).toBe(0);
    expect(g.firstTitle.trim().length).toBeGreaterThan(0);
    for (const h of g.heights) expect(Math.abs(h - CARD_ROWS * s.chh)).toBeLessThan(0.1);
    // header 三列＋footer 一列收起（不佔高度），視口從 .main 頂端起、吃下整個 rows 列
    // （mobile_layout.listViewportGeometry）。
    expect(g.chromeRows).toHaveLength(4);
    for (const r of g.chromeRows) {
      expect(r.collapsed).toBe(true);
      expect(r.h).toBe(0);
    }
    expect(Math.abs(g.viewTop - g.mainTop)).toBeLessThan(1);
    expect(Math.abs(s.viewportPx - s.rows * s.chh)).toBeLessThan(1);
    expect(g.boardName).toBeTruthy();
    expect(g.appBarTitle).toBe(g.boardName);
  });

  test('PgUp／PgDn 一次翻一屏卡片（floor(rows/CARD_ROWS) 筆），小數卡片高下不被量化吃掉一筆', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const s0 = await state(page);
    // 卡片模式視口＝整個 rows 列（header／footer 收起）。
    const PAGE = Math.floor(s0.rows / CARD_ROWS);
    const cardH = CARD_ROWS * s0.chh;
    const topPos = () =>
      page.evaluate((h) => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return Math.floor((v.scrollTop + 0.5) / h);
      }, cardH);
    await page.locator('#t').focus();
    const p0 = await topPos();
    expect(p0).toBeGreaterThanOrEqual(2 * PAGE);
    for (let i = 1; i <= 2; ++i) {
      await page.keyboard.press('PageUp');
      await waitScrollStable(page, '#mainContainer .listBodyView');
      expect(await topPos()).toBe(p0 - i * PAGE);
    }
    await page.keyboard.press('PageDown');
    await waitScrollStable(page, '#mainContainer .listBodyView');
    expect(await topPos()).toBe(p0 - PAGE);
  });

  test('tap 卡片任何位置（含左緣）＝開那一筆，不是退出', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const target = await page.evaluate(() => {
      const v = document.querySelector('#mainContainer .listBodyView');
      const vr = v.getBoundingClientRect();
      const cards = Array.from(v.querySelectorAll(':scope > .listCard'));
      const seq = window.__app.listSession._sequence();
      const header = window.__app.listSession.headerRows();
      // 視口內、不是游標所在、而且有序號的一張
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (r.top < vr.top + 2 || r.bottom > vr.bottom - 2) continue;
        const idx = Number(c.getAttribute('srow')) - header;
        const num = window.__app.buf.listLineNums[seq[idx]];
        if (num == null || num === window.__app.listSession._selectedNum) continue;
        return { x: r.left + 3, y: r.top + r.height * 0.75, num };
      }
      return null;
    });
    expect(target).not.toBeNull();
    const sentBefore = await page.evaluate(() => window.__replay.sent.length);
    await page.touchscreen.tap(target.x, target.y);
    await expect.poll(async () => (await state(page)).selectedNum).toBe(target.num);
    // 左緣不是退出帶：沒有送左方向鍵
    const sent = await page.evaluate((n) => window.__replay.sent.slice(n).join(''), sentBefore);
    expect(sent).not.toContain('\x1b[D');
  });

  // 防誤點：卡片間距（.listCard 的 padding-block，本體之外）點了不開文；同一張卡片
  // 點本體照開 ⇒ 證明是間距被吞，不是 handler 整個失效。
  test('tap 卡片間距不開文；tap 同一張卡片本體才開', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const target = await page.evaluate(() => {
      const v = document.querySelector('#mainContainer .listBodyView');
      const vr = v.getBoundingClientRect();
      const cards = Array.from(v.querySelectorAll(':scope > .listCard'));
      const seq = window.__app.listSession._sequence();
      const header = window.__app.listSession.headerRows();
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (r.top < vr.top + 2 || r.bottom > vr.bottom - 2) continue;
        const idx = Number(c.getAttribute('srow')) - header;
        const num = window.__app.buf.listLineNums[seq[idx]];
        if (num == null || num === window.__app.listSession._selectedNum) continue;
        c.setAttribute('data-e2e-gap-card', '1');
        return { num };
      }
      return null;
    });
    expect(target).not.toBeNull();
    await waitRectStable(page, '[data-e2e-gap-card]');
    Object.assign(
      target,
      await page.evaluate(() => {
        const c = document.querySelector('[data-e2e-gap-card]');
        const r = c.getBoundingClientRect();
        const b = c.querySelector('.listCardBody').getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          gapY: (r.top + b.top) / 2,
          bodyY: (b.top + b.bottom) / 2,
          gapPx: b.top - r.top,
        };
      })
    );
    expect(target.gapPx).toBeGreaterThan(1);
    const before = await state(page);
    const sentBefore = await page.evaluate(() => window.__replay.sent.length);
    // 間距點下去的那一刻確實是卡片外框、不是本體，也不是會搶點擊的連結類元素
    const hit = await page.evaluate(
      ({ x, y, sel }) => {
        const el = document.elementFromPoint(x, y);
        return !!el && !!el.closest('.listCard') && !el.closest('.listCardBody') && !el.closest(sel);
      },
      { x: target.x, y: target.gapY, sel: OVERRIDING_SEL }
    );
    expect(hit).toBe(true);
    // 兩下 tap 只隔幾十 ms、相距 ~17px ⇒ Chromium 把第二下算成**雙擊**（mousedown
    // detail=2，實測 Windows 40ms）。雙擊的預設動作是選字，App.mouse_click 在選取非空時
    // 不處理點擊 ⇒ 第二下被吞、游標不動（CI Linux 必現：落點換到頁底後，量到的卡片
    // 本體中央剛好壓在字上）。真實使用者不會 40ms 內連點兩張卡片 ⇒ 等雙擊判定窗過期，
    // 讓第二下是一次獨立的單擊。等的是輸入語意，不是版面。
    await page.evaluate(() => {
      window.__e2eTapDetail = [];
      document.addEventListener('mousedown', (e) => window.__e2eTapDetail.push(e.detail), true);
    });
    await page.touchscreen.tap(target.x, target.gapY);
    const firstTapAt = await page.evaluate(() => performance.now());
    // click handler 是同步的；等兩個 rAF 讓任何後續排程有機會發生
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect((await state(page)).selectedNum).toBe(before.selectedNum);
    expect(await page.evaluate(() => window.__replay.sent.length)).toBe(sentBefore);
    // Chromium aura 的 double_tap_timeout 400ms，留餘裕。
    await page.waitForFunction((t0) => performance.now() - t0 > 600, firstTapAt);
    await page.touchscreen.tap(target.x, target.bodyY);
    const tap = await page.evaluate(() => ({
      detail: window.__e2eTapDetail[window.__e2eTapDetail.length - 1],
      selection: String(document.getSelection()),
    }));
    expect(tap, '第二下必須是單擊、且沒有選到字（否則 mouse_click 不處理）').toEqual({
      detail: 1,
      selection: '',
    });
    await expect.poll(async () => (await state(page)).selectedNum).toBe(target.num);
  });

  test('長按卡片的作者 → 選單有「加入黑名單」；長按標題 → 「加入標題黑名單」', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const label = (k) => page.evaluate((key) => window.__i18n(key), k);
    // **只能手捏**：桌機 Chromium 的 CDP 觸控長按（synthesizeTapGesture／
    // dispatchTouchEvent 按住）不發 contextmenu（CONFIRMED，docs/mobile.md「長按選單與
    // 選取模式」），拿它斷言會是假陽性。真機驗證只能走 Android emulator。
    const longPress = (sel) =>
      page.evaluate((sel) => {
        const v = document.querySelector('#mainContainer .listBodyView');
        const vr = v.getBoundingClientRect();
        const el = Array.from(v.querySelectorAll(sel)).find((e) => {
          const r = e.getBoundingClientRect();
          return r.top >= vr.top && r.bottom <= vr.bottom && r.width > 0;
        });
        const card = el.closest('.listCard');
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: r.left + Math.min(r.width / 2, 20),
            clientY: r.top + r.height / 2,
            pointerType: 'touch',
          })
        );
        return card.getAttribute('data-list-author');
      }, sel);
    // 手機的長按選單是 bottom sheet（ContextMenu/ContextSheet.jsx）。
    const menu = page.locator('[data-sheet="context"]').first();
    const items = menu.locator('[data-cmenu]');

    const author = await longPress('.listCardAuthor');
    const addAuthor = await label('cmenu_addAuthorBlacklist');
    const item = items.filter({ hasText: addAuthor });
    await expect(item).toBeVisible();
    await expect(item).toContainText(author);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await longPress('.listCardTitleText');
    await expect(items.filter({ hasText: await label('cmenu_addTitleBlacklist') })).toBeVisible();
  });
});
