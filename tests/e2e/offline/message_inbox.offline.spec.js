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

  const replyOf = (page, from) =>
    page.locator('.inboxItem', { has: page.locator('.inboxFrom', { hasText: from }) }).locator('[data-inbox-reply]');

  test('點最新一位寄件人的「回覆」＝只送一下 Ctrl+R（真滑鼠）', async ({ page }) => {
    await feedBig5(page, waterball('friend01', '早'));
    await feedBig5(page, waterball('friend02', '在嗎'));
    await page.locator('[data-inbox-bell]').click();
    await expect(page.locator('[data-inbox-reply]')).toHaveCount(2);
    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        await replyOf(page, 'friend02').click();
        await expect(page.locator('.inboxPanel')).toHaveCount(0);
        await page.keyboard.press('x');
      },
      '\x12x',
      '回覆只送 Ctrl+R，焦點仍在終端機（對照的 x 送得出去）'
    );
  });

  // 回不是最新一位的寄件人：在原生回覆畫面裡按 ^R 換人。這裡模擬一對一模式的 ofo_my_write
  //（mbbsd/wmsg.c：row 0「丟<id>:」、row 1「↑反擊對象↓」，^R 換下一位），驗真鍵盤路徑送出的
  // 位元組、真 TermBuf 的 screenSettled 接線，以及換到對象就停手。
  test('點較早寄件人的「回覆」：^R 換到他為止就停手', async ({ page }) => {
    await feedBig5(page, waterball('friend01', '早'));
    await feedBig5(page, waterball('friend02', '在嗎'));
    await page.evaluate(() => {
      const big5 = (t) =>
        [...t]
          .map((ch) => {
            const c = ch.charCodeAt(0);
            return c < 0x80
              ? ch
              : String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
          })
          .join('');
      const order = ['friend02', 'friend01'];
      let at = -1;
      window.__sentLog = [];
      window.__stubWSSent = (sent) => {
        window.__sentLog.push(sent);
        if (sent !== '\x12') return;
        at = (at + 1) % order.length;
        const screen =
          '\x1b[1;1H\x1b[K丟' + order[at] + ':\x1b[2;30H\x1b[1;33;46m ↑反擊對象↓ \x1b[m';
        setTimeout(() => window.__app.onData(big5(screen)), 30);
      };
    });
    await page.locator('[data-inbox-bell]').click();
    await replyOf(page, 'friend01').click();
    await expect(page.locator('.inboxPanel')).toHaveCount(0);
    // waitScreenSettled 等到這一幀的 settle 跑完：要多送第三下（把對象換回 friend02）就是在
    // 那一刻送的。之後的對照鍵 x 證明前面只有兩下 ^R，而且焦點還在終端機、使用者可以直接打字。
    await waitScreenSettled(page, { 0: '丟friend01:' });
    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate(() => window.__sentLog.join(''))).toContain('x');
    expect(await page.evaluate(() => window.__sentLog.join(''))).toBe('\x12\x12x');
  });

  // 新信提示走 screenSettled（App 的 TermBuf 接線），不是 onData 的位元組掃描。
  test('標題列出現「你有新信件」→ 收一則新信提示，不送鍵', async ({ page }) => {
    await startCapture(page);
    await feedBig5(page, '\x1b[2J\x1b[H【主功能表】        你有新信件        批踢踢實業坊');
    await waitScreenSettled(page, { 0: '你有新信件' });
    await expect(page.locator('[data-inbox-unread]')).toHaveText('1');
    await page.locator('[data-inbox-bell]').click();
    const label = await page.evaluate(() => window.__i18n('inbox_newMail'));
    await expect(page.locator('.inboxItem[data-inbox-kind="mail"] .inboxText')).toHaveText(label);
    await expect(page.locator('[data-inbox-reply]')).toHaveCount(0);
    await expectOnlyFence(page, async () => page.keyboard.press('x'), 'x', '沒送任何鍵（只有對照的 x）');
  });

  test('pref 關掉就不收', async ({ page }) => {
    await ptt.applyPrefs(page, { enableMessageInbox: false });
    await feedBig5(page, waterball('friend01', '嗨'));
    await waitScreenSettled(page, { 0: 'friend01' });
    await expect(page.locator('#messageInbox')).toHaveCount(0);
  });
});
