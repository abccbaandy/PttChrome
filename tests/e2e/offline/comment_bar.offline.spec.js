// 好讀文章底部常駐推文列（src/js/comment_bar.js、docs/long-push.md「底部常駐推文列」）：
// 好讀讀文章 ⇒ 終端機最下面疊一條「推／噓／→＋文字」輸入列。只有真瀏覽器驗得出來：
// 列真的與終端機同寬、捲到底時最後一列不被它蓋住（累積頁尾端多留的空白）、在列裡打字
// 一個 byte 都不送給 PTT（焦點真的在列上、終端機不搶回）、Enter 真的接上長推文的探路。
// 送出之後的分段／冷卻／錯誤處理整條沿用長推文，守在 long_push.offline.spec.js。
// 素材 stock-huang（49 則推文的長文）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled, waitRectStable, waitScrollStable } = require('../helpers/layout');
const { rightClickElement } = require('../helpers/real_input');

const article = loadCassette('stock-huang');
const VIEWPORT = { width: 1280, height: 800 };

const bar = (page) => page.locator('#commentBar');
const input = (page) => page.locator('#commentBar [name="commentBarText"]');

async function boot(page, prefs, opts = {}) {
  await page.setViewportSize(VIEWPORT);
  await bootOffline(page, ptt, { commentBar: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: opts.easyReading !== false });
  await waitPreviewsSettled(page);
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

test.describe('底部常駐推文列', () => {
  test('好讀文章 ⇒ 列出現、與終端機同寬；捲到底最後一列在列的上方', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await expect(bar(page)).toBeVisible();
    const term = await waitRectStable(page, '#BBSWindow > .main');
    const box = await waitRectStable(page, '#commentBar');
    expect(Math.abs(box.left - term.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - term.width)).toBeLessThanOrEqual(1);
    expect(box.top + box.height).toBeLessThanOrEqual(term.top + term.height + 1);

    await page.evaluate(() => {
      const el = window.__app.view.mainDisplay;
      el.scrollTop = el.scrollHeight;
    });
    await waitScrollStable(page, '#BBSWindow > .main');
    await waitPreviewsSettled(page);
    const last = await page.evaluate(() => {
      const rows = document.querySelectorAll('#mainContainer [type="bbsrow"][srow]');
      return Math.max(...Array.from(rows, (r) => Number(r.getAttribute('srow'))));
    });
    const lastBox = await waitRectStable(page, `#mainContainer [type="bbsrow"][srow="${last}"]`);
    const barBox = await waitRectStable(page, '#commentBar');
    expect(lastBox.top + lastBox.height).toBeLessThanOrEqual(barBox.top + 1);
  });

  test('在列裡打字不送鍵；Enter ⇒ 接上長推文探路，列清空', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await expect(bar(page)).toBeVisible();
    await input(page).click();
    await expect(input(page)).toBeFocused();
    await startCapture(page);
    // 英文字母在終端機上都是 PTT 的指令鍵：漏一個就是真的在 PTT 上做了事。
    await page.keyboard.type('qabc ');
    await page.keyboard.insertText('測試');
    await expect(input(page)).toHaveValue('qabc 測試');
    // Enter 本身就是柵欄：打字時若同步送了 byte，一定排在探路的 X 前面而被抓到。
    await page.keyboard.press('Enter');
    await expect.poll(() => peekCapture(page)).toContain('X');
    const sent = await takeCapture(page);
    expect(sent.slice(0, sent.indexOf('X'))).not.toMatch(/[qabc]/);
    await expect(page.getByText(await page.evaluate(() => window.__i18n('longPushProgress_preflight')))).toBeVisible();
    // 列在送出期間（functionMode）收起；回來時輸入框是空的。
    expect(await page.evaluate(() => window.__app.longPush.active)).toBe(true);
  });

  test('打字時列的右邊顯示剩幾個字；打長了改成會分成幾則', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await input(page).click();
    const counter = page.locator('#commentBar [data-comment-counter]');
    await expect(counter).toHaveCount(0);
    await page.keyboard.insertText('推推');
    const max = await page.evaluate(() => window.__app.commentBar.maxBytes());
    const remaining = Math.floor((max - 4) / 2);
    const fmt = (key, n) => page.evaluate(([k, v]) => window.__i18n(k).replace('{0}', v), [key, String(n)]);
    await expect(counter).toHaveText(await fmt('commentBar_remaining', remaining));
    await page.keyboard.insertText('好'.repeat(remaining + 1));
    await expect(counter).toHaveText(await fmt('commentBar_segments', 2));
    // 計數擠在輸入框與送出鈕之間，不可以把送出鈕推出列外。
    const barBox = await waitRectStable(page, '#commentBar');
    const send = await waitRectStable(page, '#commentBar [data-comment-send]');
    expect(send.left + send.width).toBeLessThanOrEqual(barBox.left + barBox.width + 1);
  });

  test('Esc ⇒ 離開列，焦點回終端機', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await input(page).click();
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('原生 pmore（好讀關）⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableEasyReading: false }, { easyReading: false });
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
    await expect(bar(page)).toHaveCount(0);
  });

  // 「回覆這則」：真右鍵推文列 → 選單「回覆 'id'」→ 推文列切成 →、預填「id 」、游標在框裡。
  // 只是預填：一個 byte 都不送。開關關掉 ⇒ 選單沒有這一項。
  for (const on of [true, false]) {
    test(`右鍵推文「回覆」${on ? '⇒ 推文列預填 → 與帳號、不送鍵' : '（開關關掉）不出現'}`, async ({ page }) => {
      test.setTimeout(90000);
      await boot(page, { commentReplyMenu: on });
      await expect(bar(page)).toBeVisible();
      // data-pusher 是小寫過的；回覆照推文上顯示的大小寫填。
      const pusher = await page.evaluate(() => {
        const el = document.querySelector('#mainContainer [type="bbsrow"][data-pusher]');
        el.setAttribute('data-e2e-reply', '1');
        const id = el.getAttribute('data-pusher');
        const i = el.textContent.toLowerCase().indexOf(id);
        return el.textContent.substr(i, id.length);
      });
      expect(pusher).toBeTruthy();
      await startCapture(page);
      await rightClickElement(page, '[data-e2e-reply]');
      const menu = page.locator('.DropdownMenu').first();
      await expect(menu).toBeVisible();
      const label = await page.evaluate(() => window.__i18n('cmenu_replyComment'));
      const reply = menu.getByText(`${label} '${pusher}'`, { exact: true });
      if (!on) {
        await expect(menu.getByText(await page.evaluate(() => window.__i18n('cmenu_paste')))).toBeVisible();
        await expect(reply).toHaveCount(0);
        return;
      }
      await reply.click();
      await expect(input(page)).toBeFocused();
      await expect(input(page)).toHaveValue(pusher + ' ');
      await expect(page.locator('#commentBar [data-comment-type="arrow"]')).toHaveAttribute('aria-checked', 'true');
      // 接著打字：游標在最後（接在帳號後面），終端機沒有把焦點搶回去。
      await page.keyboard.type('ok');
      await expect(input(page)).toHaveValue(pusher + ' ok');
      expect(await takeCapture(page)).toBe('');
    });
  }

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableCommentBar: false });
    expect(await page.evaluate(() => window.__app.buf.pageLines.length)).toBeGreaterThan(0);
    await expect(bar(page)).toHaveCount(0);
  });
});
