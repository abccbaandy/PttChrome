// 手機「選取文字」頁（P81，src/js/select_text_page.js、components/SelectTextPage）。
// 只在 offline-mobile project 跑（Pixel 7 模擬，hasTouch）。入口用真觸控（tap）與真右鍵
// （page.mouse；觸控長按桌機 Chromium 做不出來，見 tests/e2e/README.md「真輸入」）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitDialogSettled, scrollIntoViewStable } = require('../helpers/layout');
const { rightClickElement } = require('../helpers/real_input');

const article = loadCassette('stock-huang');
const ITEM = '[data-key="__selectText"]';
const PAGE = '[data-key="__selectTextPage"]';
const BODY = '[data-select-text-body]';

async function openArticle(page, prefs = {}) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => (window.__copied.push(String(t)), Promise.resolve()) },
    });
  });
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, ...prefs });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
}

test.describe('手機：選取文字頁', () => {
  test('「更多」→「選取文字」：整篇文字、全選、複製、✕ 關掉回終端機，一個 byte 都不送', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await startCapture(page);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, ITEM);
    await page.locator(ITEM).tap();
    await waitDialogSettled(page, PAGE);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    // 頁面文字＝好讀累積頁每一列（沒有被藏的列）的文字，列尾空白去掉。
    const { pageText, bufText } = await page.evaluate((sel) => {
      const app = window.__app;
      const buf = app.buf;
      const acc = buf.pageLines;
      const want = [];
      for (let r = 0; r < acc.length; r++) want.push(buf.getRowText(r, 0, buf.cols, acc).replace(/\s+$/, ''));
      const lines = [...document.querySelectorAll(sel + ' [data-line]')].map((el) =>
        el.textContent === ' ' ? '' : el.textContent
      );
      return { pageText: lines, bufText: want };
    }, BODY);
    expect(pageText.length).toBeGreaterThan(20);
    expect(pageText).toEqual(bufText);

    // 文字區左右都有留白：第一個字不貼螢幕邊。
    const pad = await page.evaluate((sel) => {
      const body = document.querySelector(sel);
      const line = body.querySelector('[data-line]');
      const r = line.getBoundingClientRect();
      return { left: r.left, right: window.innerWidth - r.right, scrollW: body.scrollWidth, clientW: body.clientWidth };
    }, BODY);
    expect(pad.left).toBeGreaterThanOrEqual(16);
    expect(pad.right).toBeGreaterThanOrEqual(16);
    expect(pad.scrollW).toBeLessThanOrEqual(pad.clientW); // 長行自動換行，不橫捲

    await page.locator('[data-key="__selectTextAll"]').tap();
    await expect(page.locator('[data-key="__selectTextCopy"]')).not.toHaveAttribute('data-empty', '');
    await page.locator('[data-key="__selectTextCopy"]').tap();
    await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1);
    const copied = await page.evaluate(() => window.__copied[0]);
    expect(copied).toContain(bufText.find((t) => t.trim().length > 4).trim());
    await expect(page.locator('[data-key="__selectTextCopy"]')).toHaveText(
      await page.evaluate(() => window.__i18n('selectText_copied'))
    );

    await page.locator('[data-key="__selectTextClose"]').tap();
    await expect(page.locator(PAGE)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);
    expect(await takeCapture(page)).toBe('');
  });

  test('長按（右鍵）選單「選取文字」：開到按的那一行', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    // 挑一列有字、在畫面中段的列（不在檔頭，捲動才看得出有對到）。
    const row = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#mainContainer [data-type="bbsline"]')];
      const el = rows.filter((r) => r.textContent.trim().length > 6)[12];
      el.setAttribute('data-e2e-target', '1');
      return Number(el.getAttribute('data-row'));
    });
    await rightClickElement(page, '[data-e2e-target]');
    const item = page.locator('[data-cmenu="selectText"]');
    await expect(item).toBeVisible();
    await item.tap();
    await waitDialogSettled(page, PAGE);
    const hit = await page.evaluate(({ sel, row }) => {
      const body = document.querySelector(sel);
      const line = body.querySelector(`[data-row="${row}"]`);
      const b = body.getBoundingClientRect();
      const r = line.getBoundingClientRect();
      return { inView: r.top >= b.top && r.bottom <= b.bottom, scrolled: body.scrollTop > 0 };
    }, { sel: BODY, row });
    expect(hit).toEqual({ inView: true, scrolled: true });
  });

  test('長按同作者合併塊的第二則：開到第二則那一列，不是第一則', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    // 合併塊：一張卡片的內容區有兩行以上，都標第一則的 data-row。
    const want = await page.evaluate(() => {
      const buf = window.__app.buf;
      const acc = buf.pageLines;
      for (const body of document.querySelectorAll('#mainContainer .commentCardText')) {
        const lines = [...body.querySelectorAll('[data-type="bbsline"]')].filter((n) => n.textContent.trim());
        if (lines.length < 2) continue;
        const el = lines[lines.length - 1];
        const shared = Number(el.getAttribute('data-row'));
        const text = el.textContent.replace(/ /g, ' ').trim();
        for (let r = shared + 1; r < acc.length; r++) {
          if (buf.getRowText(r, 0, buf.cols, acc).includes(text)) {
            el.setAttribute('data-e2e-target', '1');
            return { shared, row: r };
          }
        }
      }
      return null;
    });
    expect(want).not.toBeNull(); // 前提：素材裡有合併塊
    // 合併塊的第二行 span 是接在第一行後面的 inline 盒，第一個 client rect 落在上一行尾 ⇒
    // 用它的文字範圍量點（rightClickElement 量的是 span 的第一個 rect）。
    await scrollIntoViewStable(page, '[data-e2e-target]');
    const pt = await page.evaluate(() => {
      const el = document.querySelector('[data-e2e-target]');
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 4);
      const r = rects[rects.length - 1];
      return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
    });
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await page.locator('[data-cmenu="selectText"]').tap();
    await waitDialogSettled(page, PAGE);
    const focus = await page.evaluate((sel) => {
      const body = document.querySelector(sel);
      const b = body.getBoundingClientRect();
      // 捲到的那一行放在上方 1/3：取那個高度上的行。
      const y = b.top + body.clientHeight / 3 + 4;
      const el = document.elementsFromPoint(b.left + 40, y).find((e) => e.hasAttribute && e.hasAttribute('data-row'));
      return el ? Number(el.getAttribute('data-row')) : null;
    }, BODY);
    expect(focus).toBe(want.row);
  });

  test('系統返回（popstate）＝關掉頁面、終端機拿回鍵盤，一個 byte 都不送', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page);
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, ITEM);
    await page.locator(ITEM).tap();
    await waitDialogSettled(page, PAGE);
    await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
    await startCapture(page);
    await page.goBack();
    await expect(page.locator(PAGE)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);
    expect(await takeCapture(page)).toBe('');
  });

  test('開關關掉 ⇒「更多」與長按選單都沒有這一項', async ({ page }) => {
    test.setTimeout(90000);
    await openArticle(page, { mobileSelectTextPage: false });
    await page.locator('[data-key="__more"]').tap();
    await waitDialogSettled(page, '[data-key="__select"]');
    await expect(page.locator(ITEM)).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('[data-key="__select"]')).toHaveCount(0);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#mainContainer [data-type="bbsline"]')];
      rows.filter((r) => r.textContent.trim().length > 6)[12].setAttribute('data-e2e-target', '1');
    });
    await rightClickElement(page, '[data-e2e-target]');
    // 選單真的開了（有別的項目），只是沒有選取文字。
    await expect(page.locator('[data-cmenu="saveLocal"]')).toBeVisible();
    await expect(page.locator('[data-cmenu="selectText"]')).toHaveCount(0);
  });
});
