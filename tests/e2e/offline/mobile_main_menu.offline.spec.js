// 手機版面 Phase 5（docs/mobile.md「Phase 5」）：選單（主功能表與子選單）的選單項畫成大按鈕，
// ANSI 圖／標題／狀態列維持縮小的 80 欄格線。只在 offline-mobile project 跑
// （Pixel 7 模擬：hasTouch + isMobile）。合成畫面見 helpers/main_menu.js。
//
// unit（tests/unit/menu_card.test.js）守渲染與點擊分派；這裡守 unit 摸不到的：
// 真 CSS 下按鈕真的有 44px 高、surface 對帳真的切到 menu、真觸控 tap 送出的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { scrollIntoViewStable, waitRectStable } = require('../helpers/layout');
const {
  drawMainMenu,
  drawUserMenu,
  USER_MENU,
  FIRST_ITEM_ROW,
  CURSOR_ROW,
  ITEMS,
} = require('../helpers/main_menu');

const MENU_CARD_PX = 44;

test.describe('手機主功能表大按鈕', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    // 這組守「動態看板維持縮小格線」那一版：P87 收起動態看板關掉（收起的行為在下面那組）。
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true, mobileMenuBannerCollapse: false });
    await drawMainMenu(page);
    await page.waitForFunction(() => window.__app.view.menuCards === true);
  });

  test('選單項是 44px 高的按鈕；ANSI 圖仍是格線列', async ({ page }) => {
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#mainContainer .menuCard'));
      const art = document.querySelector('#mainContainer [type="bbsrow"][srow="5"]');
      return {
        mainClass: window.__app.view.mainDisplay.classList.contains('mobileMenu'),
        rows: cards.map((c) => Number(c.getAttribute('data-menu-row'))),
        heights: cards.map((c) => c.getBoundingClientRect().height),
        fontSize: parseFloat(getComputedStyle(cards[0].querySelector('.menuCardBody')).fontSize),
        artIsCard: art.classList.contains('menuCard'),
        artHeight: art.getBoundingClientRect().height,
        chh: window.__app.view.chh,
      };
    });
    expect(m.mainClass).toBe(true);
    expect(m.rows).toEqual(ITEMS.map((_, i) => FIRST_ITEM_ROW + i));
    for (const h of m.heights) expect(Math.abs(h - MENU_CARD_PX)).toBeLessThan(1);
    expect(m.fontSize).toBe(16);
    expect(m.artIsCard).toBe(false);
    expect(Math.abs(m.artHeight - m.chh)).toBeLessThan(1);
  });

  test('tap (M) 按鈕 ⇒ 送「↓↓＋Enter」；tap ANSI 圖什麼都不送', async ({ page }) => {
    await startCapture(page);
    const a = await scrollIntoViewStable(page, '#mainContainer [type="bbsrow"][srow="6"]');
    await page.touchscreen.tap(a.left + a.width / 2, a.top + a.height / 2);
    await page.waitForFunction(() => !window.__app.dblclickTimer, null, { timeout: 5000 });
    await expectOnlyFence(
      page,
      async () => {
        const b = await scrollIntoViewStable(page, `#mainContainer [data-menu-row="${CURSOR_ROW + 2}"]`);
        await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      },
      '\x1b[B\x1b[B\r',
      'tap (M)'
    );
  });

  test('子選單（個人設定區）也是大按鈕；tap (V) ⇒ 送「↓↓＋Enter」', async ({ page }) => {
    await drawUserMenu(page);
    await page.waitForFunction(
      (n) => document.querySelectorAll('#mainContainer .menuCard').length === n,
      USER_MENU.items.length
    );
    const sel = `#mainContainer [data-menu-row="${FIRST_ITEM_ROW + 2}"]`;
    expect(Math.abs((await waitRectStable(page, sel)).height - MENU_CARD_PX)).toBeLessThan(1);
    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        const b = await scrollIntoViewStable(page, sel);
        await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      },
      '\x1b[B\x1b[B\r',
      'tap (V)'
    );
  });

  test('離開主功能表（換成一般畫面）⇒ 退回格線', async ({ page }) => {
    await page.evaluate(() => window.__app.onData('\x1b[H\x1b[2J\x1b[1;1Hplain screen'));
    await page.waitForFunction(() => window.__app.view.menuCards === false);
    expect(await page.locator('#mainContainer .menuCard').count()).toBe(0);
  });
});

// P87：動態看板收成一列（預設開，js/menu_banner.js）。真觸控 tap 展開／收起，不送任何鍵；
// 收起時第一顆選單按鈕緊接在摘要下面，整份選單一屏看得完。
test.describe('手機選單動態看板收成一列（P87）', () => {
  const visibleBars = (page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer .menuBannerBar'))
        .filter((n) => getComputedStyle(n).display !== 'none')
        .map((n) => ({
          srow: Number(n.getAttribute('srow')),
          text: n.textContent,
          expanded: n.querySelector('button').getAttribute('aria-expanded'),
        }))
    );

  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await page.evaluate(() => localStorage.removeItem('pttchrome.menuBannerExpanded'));
    await drawMainMenu(page);
    await page.waitForFunction(() => window.__app.view.menuCards === true);
  });

  test('收起：只剩一條摘要，選單從第二條開始', async ({ page }) => {
    const bars = await visibleBars(page);
    expect(bars.length).toBe(1);
    expect(bars[0].expanded).toBe('false');
    expect(bars[0].text).toContain('右繞佛塔');
    const g = await page.evaluate((rows) => {
      // 第一條有可讀字的摘要（純框線的 row 1 是 .menuBannerArtOnly，被 CSS 藏起來）。
      const bar = document
        .querySelector('#mainContainer .menuBannerSummary:not(.menuBannerArtOnly)')
        .getBoundingClientRect();
      const cards = rows.map((r) =>
        document.querySelector(`#mainContainer [data-menu-row="${r}"]`).getBoundingClientRect()
      );
      const main = document.querySelector('#mainContainer').getBoundingClientRect();
      return { barTop: bar.top, barBottom: bar.bottom, firstTop: cards[0].top, mainTop: main.top };
    }, ITEMS.map((_, i) => FIRST_ITEM_ROW + i));
    // 摘要是畫面上第一條，第一顆選單按鈕緊接在它下面（原本前面有 12 列縮小 ANSI 圖）。
    expect(Math.abs(g.barTop - g.mainTop)).toBeLessThan(1);
    expect(Math.abs(g.firstTop - g.barBottom)).toBeLessThan(1);
  });

  // 選單上按 s 選擇看板：board.c#Select 在 row 1 開輸入欄（upstream 產的畫面，ptt_src_screens/menu_search.json）。
  // 那一列落在動態看板區，收起來就看不到自己打的字 ⇒ 輸入欄開著時整區照原生格線。
  test('選擇看板的輸入列不被收進摘要', async ({ page }) => {
    const fx = require('../../unit/fixtures/ptt_src_screens/menu_search.json');
    const frame = fx.frames.find((f) => f.name === 'board');
    await page.evaluate((b) => window.__app.onData(b), frame.bytes);
    await page.waitForFunction(() => window.__app.buf.isPromptPending());
    await expect
      .poll(() =>
        page.evaluate(() => {
          const row = document.querySelector('#mainContainer [type="bbsrow"][srow="1"]');
          return !!row && getComputedStyle(row).display !== 'none' && row.textContent.includes('請輸入看板名稱');
        })
      )
      .toBe(true);
    expect(await visibleBars(page)).toEqual([]);
    // 前提：這一幀仍被當成選單（大按鈕還在）。不然上面兩條會因為別的原因變綠。
    expect(await page.evaluate(() => window.__app.view.menuCards)).toBe(true);
    // 輸入結束、PTT 畫回選單 ⇒ 又收成一條摘要。
    await drawMainMenu(page);
    await expect.poll(async () => (await visibleBars(page)).length).toBe(1);
  });

  test('tap 摘要 ⇒ 展開、不送鍵；tap「收起」⇒ 收回；選擇記在本機', async ({ page }) => {
    await startCapture(page);
    const bar = await waitRectStable(page, '#mainContainer .menuBannerSummary:not(.menuBannerArtOnly) button');
    await page.touchscreen.tap(bar.left + bar.width / 2, bar.top + bar.height / 2);
    await page.waitForFunction(() => !!document.querySelector('#mainContainer .menuBannerHead'));
    expect(await page.locator('#mainContainer .menuBannerSummary').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('pttchrome.menuBannerExpanded'))).toBe('1');
    // 原圖回來（縮小格線列）。
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('#mainContainer [type="bbsrow"][srow="2"]')).display)
    ).not.toBe('none');

    const head = await waitRectStable(page, '#mainContainer .menuBannerHead button');
    await page.touchscreen.tap(head.left + head.width / 2, head.top + head.height / 2);
    await page.waitForFunction(() => !!document.querySelector('#mainContainer .menuBannerSummary'));
    expect(await page.evaluate(() => localStorage.getItem('pttchrome.menuBannerExpanded'))).toBe(null);
    await page.waitForFunction(() => !window.__app.dblclickTimer, null, { timeout: 5000 });

    // 兩次 tap 都沒送鍵：接著 tap (M) 只送它自己的「↓↓＋Enter」。
    await expectOnlyFence(
      page,
      async () => {
        const b = await scrollIntoViewStable(page, `#mainContainer [data-menu-row="${CURSOR_ROW + 2}"]`);
        await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      },
      '\x1b[B\x1b[B\r',
      'tap (M)'
    );
  });
});
