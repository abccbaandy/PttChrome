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
const { waitScrollStable } = require('../helpers/layout');

const nav = loadCassette('cchat-list-nav');

const CARD_ROWS = 2;

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
        // header／footer 仍是一般列（容器直系子層）
        outerCards: document.querySelectorAll('#mainContainer > .listCard').length,
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
    // 視口高度仍是 body 那 20 列（畫面面積不變，只是一筆佔兩列）
    expect(Math.abs(s.viewportPx - (s.rows - 4) * s.chh)).toBeLessThan(1);
  });

  test('PgUp／PgDn 一次翻一屏卡片（bodyRows/2 筆），小數卡片高下不被量化吃掉一筆', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const s0 = await state(page);
    const PAGE = Math.floor((s0.rows - 4) / CARD_ROWS);
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

  test('長按卡片的作者 → 選單有「加入黑名單」；長按標題 → 「加入標題黑名單」', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);
    const label = (k) => page.evaluate((key) => window.__i18n(key), k);
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
    const menu = page.locator('.DropdownMenu').first();

    const author = await longPress('.listCardAuthor');
    const addAuthor = await label('cmenu_addAuthorBlacklist');
    const item = menu.getByRole('menuitem').filter({ hasText: addAuthor });
    await expect(item).toBeVisible();
    await expect(item).toContainText(author);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await longPress('.listCardTitleText');
    await expect(
      menu.getByRole('menuitem').filter({ hasText: await label('cmenu_addTitleBlacklist') })
    ).toBeVisible();
  });
});
