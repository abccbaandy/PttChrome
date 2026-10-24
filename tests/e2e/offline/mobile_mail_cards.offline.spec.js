// 手機信件列表卡片（P31，docs/mobile.md「信件列表卡片」）：信件列畫成兩行卡片，tap 卡片送
// 原生「移游標＋⏎」（同主功能表大按鈕）。只在 offline-mobile project 跑（Pixel 7：hasTouch＋isMobile）。
// 畫面照 upstream pttbbs 產的信件列表（tests/unit/fixtures/ptt_src_screens/mail_list.json，
// 版型 mail.c#maildoent）合成：手機列數由視窗決定，狀態列要畫在最後一列。
//
// unit（tests/unit/mail_card.test.js）守解析、指紋與 DOM；這裡守 unit 摸不到的：
// 真 CSS 下卡片高度、surface 對帳真的切到卡片、真觸控 tap 送出的鍵。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { scrollIntoViewStable } = require('../helpers/layout');

const MAIL_CARD_PX = 60;
const TITLE = '【郵件選單】                       新批踢踢';
const BODY = [
  '[→]讀信 [z]信件夾 [~]資源回收筒 [/]搜尋 [a]找作者 []]主題 [O]站外信 [w]丟水球',
  '  編號   日 期 作 者          信  件  標  題               [外信:開] (大小:3篇)',
  '     1 + 10/01 alice          ◇ 第一封信',
  '     2 + 10/02 bob            R: 第一封信',
  '>    3   10/03 carol          ◇ 站方通知',
];
const FOOTER = ' 信件列表  (^P)寄信 (y)回信 (x)轉寄 (d)刪信 (v)全部已讀       (←)離開 (h)說明 ';
const CURSOR_ROW = 5;

async function drawMailList(page, { footer = FOOTER } = {}) {
  await page.evaluate(
    ({ TITLE, BODY, footer, CURSOR_ROW }) => {
      const u2b = (str) =>
        [...str]
          .map((ch) => {
            const c = ch.charCodeAt(0);
            return c < 0x80
              ? ch
              : String.fromCharCode(window.lib.u2bArray[2 * c]) +
                  String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
          })
          .join('');
      const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
      const rows = window.__app.buf.rows;
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[H\x1b[2J';
      // 標題列整列同色（term_buf.setPageState 的 isUnicolor 判準）。
      d += '\x1b[1;1H' + REV + u2b(TITLE + ' '.repeat(80 - width(TITLE))) + OFF;
      BODY.forEach((t, i) => {
        d += '\x1b[' + (i + 2) + ';1H' + u2b(t);
      });
      d += '\x1b[' + rows + ';1H' + REV + u2b(footer + ' '.repeat(Math.max(0, 80 - width(footer)))) + OFF;
      d += '\x1b[' + (CURSOR_ROW + 1) + ';1H';
      window.__app.onData(d);
    },
    { TITLE, BODY, footer, CURSOR_ROW }
  );
  await waitScreenSettled(page, { 3: 'alice', [CURSOR_ROW]: 'carol' });
}

test.describe('手機信件列表卡片', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
  });

  test('信件列是 60px 高的卡片；tap 第一封 ⇒ 送「↑↑＋Enter」', async ({ page }) => {
    await drawMailList(page);
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .mailCard').length === 3);
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#mainContainer .mailCard'));
      return {
        menuCards: window.__app.view.menuCards,
        rows: cards.map((c) => Number(c.getAttribute('data-menu-row'))),
        heights: cards.map((c) => c.getBoundingClientRect().height),
        unread: cards.map((c) => c.classList.contains('mailCardUnread')),
        subjectFont: parseFloat(getComputedStyle(cards[0].querySelector('.mailCardSubject')).fontSize),
      };
    });
    expect(m.menuCards).toBe(true);
    expect(m.rows).toEqual([3, 4, 5]);
    for (const h of m.heights) expect(Math.abs(h - MAIL_CARD_PX)).toBeLessThan(1);
    expect(m.unread).toEqual([true, true, false]);
    expect(m.subjectFont).toBe(16);

    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        const b = await scrollIntoViewStable(page, '#mainContainer [data-menu-row="3"]');
        await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      },
      '\x1b[A\x1b[A\r',
      'tap 第一封'
    );
  });

  test('認不出（底列不是信件列表）⇒ 照舊格線、沒有卡片', async ({ page }) => {
    await drawMailList(page, { footer: ' 某個新版底列  (^P)寄信 (y)回信' });
    // 柵欄：這一幀的 surface 對帳已跑過（screenSettled）再判「沒有」
    await page.waitForFunction(() => !window.__app.buf.timerUpdate && !window.__app.buf._settleTimer);
    expect(await page.locator('#mainContainer .mailCard').count()).toBe(0);
    expect(await page.evaluate(() => window.__app.view.menuCards)).toBe(false);
  });
});
