// 水球收件匣（src/js/message_inbox.js、docs/message-inbox.md）的整合守門（真瀏覽器、離線）。
//
// 解析／去重／跨包接續由 tests/unit/message_inbox.test.js 守；這裡守 unit 抓不到的接線：
//   1. 真的 App.onData 收到水球位元組（appFocused，失焦通知那條不跑）→ 鈴鐺出現、帶未讀數；
//   2. 真滑鼠點鈴鐺 → 清單打開，一個 byte 都沒送給 PTT（不被當成點終端機）；
//   3. 點終端機（清單外）→ 清單收起；斷線 → 收件匣清空、鈴鐺消失。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  bootOffline,
  feedRaw,
  waitScreenSettled,
} = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { elementUnder } = require('../helpers/layout');

// 文字轉 Big5 位元組（同 helpers/main_menu.js 的做法：查 app 已載入的表）。
async function feedBig5(page, text) {
  const raw = await page.evaluate((s) => {
    return [...s]
      .map((ch) => {
        const c = ch.charCodeAt(0);
        return c < 0x80
          ? ch
          : String.fromCharCode(window.lib.u2bArray[2 * c]) +
              String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      })
      .join('');
  }, text);
  await feedRaw(page, raw);
}

const waterball = (from, msg) =>
  '\x1b[1;1H\x1b[1;33;46m★' + from + '\x1b[0;1;37;45m ' + msg + ' \x1b[m\x1b[K';

test.describe('水球收件匣', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await feedRaw(page, '\x1b[2J\x1b[H  OFFLINE MESSAGE INBOX TEST  ');
    await waitScreenSettled(page, { 0: 'OFFLINE MESSAGE INBOX TEST' });
  });

  test('收到水球 → 鈴鐺帶未讀；點開列出且不送鍵；點外面收起；斷線清空', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const inbox = page.locator('#messageInbox');
    await expect(inbox).toHaveCount(0);

    await feedBig5(page, waterball('friend01', '晚上一起吃飯嗎'));
    await feedBig5(page, waterball('friend02', '收到請回'));
    await expect(page.locator('[data-inbox-unread]')).toHaveText('2');

    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        await page.locator('[data-inbox-bell]').click();
        await expect(page.locator('.inboxPanel')).toBeVisible();
        await page.keyboard.press('x');
      },
      'x',
      '點鈴鐺不送鍵（只有對照的 x）'
    );
    const froms = await page.locator('.inboxItem .inboxFrom').allTextContents();
    expect(froms).toEqual(['friend02', 'friend01']);
    await expect(page.locator('.inboxItem').first().locator('.inboxText')).toHaveText('收到請回');
    await expect(page.locator('[data-inbox-unread]')).toHaveCount(0);

    // 點終端機（清單外）收起。點之前確認指標底下真的不是收件匣。
    const term = await page.locator('#mainContainer').boundingBox();
    const x = term.x + 40;
    const y = term.y + term.height / 2;
    expect(await elementUnder(page, x, y, { closest: '#messageInbox' })).toBeNull();
    await page.mouse.click(x, y);
    await expect(page.locator('.inboxPanel')).toHaveCount(0);
    await expect(inbox).toHaveCount(1);

    await page.evaluate(() => window.__app.onClose());
    await expect(inbox).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('點「回覆」＝送一下 Ctrl+R（真滑鼠），只有最新一位寄件人有', async ({ page }) => {
    await feedBig5(page, waterball('friend01', '早'));
    await feedBig5(page, waterball('friend02', '在嗎'));
    await page.locator('[data-inbox-bell]').click();
    await expect(page.locator('[data-inbox-reply]')).toHaveCount(1);
    await expect(
      page.locator('.inboxItem', { has: page.locator('[data-inbox-reply]') }).locator('.inboxFrom')
    ).toHaveText('friend02');
    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        await page.locator('[data-inbox-reply]').click();
        await expect(page.locator('.inboxPanel')).toHaveCount(0);
        await page.keyboard.press('x');
      },
      '\x12x',
      '回覆只送 Ctrl+R，焦點仍在終端機（對照的 x 送得出去）'
    );
  });

  test('pref 關掉就不收', async ({ page }) => {
    await ptt.applyPrefs(page, { enableMessageInbox: false });
    await feedBig5(page, waterball('friend01', '嗨'));
    await waitScreenSettled(page, { 0: 'friend01' });
    await expect(page.locator('#messageInbox')).toHaveCount(0);
  });
});
