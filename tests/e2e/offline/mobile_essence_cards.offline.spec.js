// 手機精華區卡片（P88，docs/mobile.md「精華區卡片」）：精華區項目畫成兩行卡片、標題列改畫
// 「板名 精華區 › 這一層」，tap 卡片送原生「移游標＋⏎」（同主功能表／信件卡片）。
// 只在 offline-mobile project 跑（Pixel 7：hasTouch＋isMobile）。
// 畫面照 upstream pttbbs 產的精華區（tests/unit/fixtures/ptt_src_screens/essence.json，
// 版型 announce.c#announce_renderer）合成：手機列數由視窗決定，狀態列要畫在最後一列。
//
// unit（tests/unit/essence_card.test.js）守解析、指紋與 DOM；這裡守 unit 摸不到的：
// 真 CSS 下卡片高度、surface 對帳真的切到卡片、真觸控 tap 送出的鍵、PTT 開輸入欄時退回格線。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, expectOnlyFence } = require('../helpers/capture');
const { scrollIntoViewStable } = require('../helpers/layout');

const ESSENCE_CARD_PX = 60;
const TITLE = '【精華文章】                      本板精華                     看板《Gossip》';
const BODY = [
  '[→]讀取資料 [/]搜尋',
  '   編號   標  題                                        編  選       日  期',
  '      1.  ◆ [板規] 本板板規與公告                       sysop        [01/02/26]',
  '      2.  ◆ [新手] 新手入門必讀                         judy         [03/15/26]',
  '>     3.  ◇ [爆卦] 收進精華區的文章                     judy         [09/27/26]',
];
const FOOTER = ' 精華列表  (F)寄回信箱 (c)複製項目 (→)讀取資料 (/)搜尋       (←)離開 (h)說明 ';
const CURSOR_ROW = 5;

// prompt：在底列上一列開 getdata 輸入欄（反白、游標停在欄裡），底列 caption 留著。
async function drawEssence(page, { footer = FOOTER, prompt = false } = {}) {
  await page.evaluate(
    ({ TITLE, BODY, footer, CURSOR_ROW, prompt }) => {
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
      d += '\x1b[1;1H' + REV + u2b(TITLE + ' '.repeat(Math.max(0, 80 - width(TITLE)))) + OFF;
      BODY.forEach((t, i) => {
        d += '\x1b[' + (i + 2) + ';1H' + u2b(t);
      });
      d += '\x1b[' + rows + ';1H' + REV + u2b(footer + ' '.repeat(Math.max(0, 80 - width(footer)))) + OFF;
      if (prompt) {
        const label = '搜尋標題: ';
        d += '\x1b[' + (rows - 1) + ';1H' + u2b(label) + REV + ' '.repeat(20) + OFF;
        d += '\x1b[' + (rows - 1) + ';' + (width(label) + 1) + 'H';
      } else {
        d += '\x1b[' + (CURSOR_ROW + 1) + ';1H';
      }
      window.__app.onData(d);
    },
    { TITLE, BODY, footer, CURSOR_ROW, prompt }
  );
  await waitScreenSettled(page, { 3: '板規', 5: '爆卦' });
  // 柵欄：這一幀的 surface 對帳已跑過，再判「有／沒有」卡片。
  await page.waitForFunction(() => !window.__app.buf.timerUpdate && !window.__app.buf._settleTimer);
}

const cardCount = (page) => page.locator('#mainContainer .essenceCard').count();

test.describe('手機精華區卡片', () => {
  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { useMouseBrowsing: true, mouseLeftClick: true });
  });

  test('項目是 60px 高的卡片、頂端寫所在位置；tap 第一項 ⇒ 送「↑↑＋Enter」', async ({ page }) => {
    await drawEssence(page);
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .essenceCard').length === 3);
    const m = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#mainContainer .essenceCard'));
      return {
        menuCards: window.__app.view.menuCards,
        rows: cards.map((c) => Number(c.getAttribute('data-menu-row'))),
        heights: cards.map((c) => c.getBoundingClientRect().height),
        dirs: cards.map((c) => c.classList.contains('essenceCardDir')),
        titleFont: parseFloat(getComputedStyle(cards[0].querySelector('.essenceCardTitle')).fontSize),
        crumb: document.querySelector('#mainContainer .essenceCrumb').textContent,
        headerH: document.querySelector('#mainContainer [type="bbsrow"][srow="2"]').getBoundingClientRect().height,
      };
    });
    expect(m.menuCards).toBe(true);
    expect(m.rows).toEqual([3, 4, 5]);
    for (const h of m.heights) expect(Math.abs(h - ESSENCE_CARD_PX)).toBeLessThan(1);
    expect(m.dirs).toEqual([true, true, false]);
    expect(m.titleFont).toBe(16);
    expect(m.crumb).toBe('Gossip 精華區 › 本板精華');
    expect(m.headerH).toBe(0);

    await startCapture(page);
    await expectOnlyFence(
      page,
      async () => {
        const b = await scrollIntoViewStable(page, '#mainContainer [data-menu-row="3"]');
        await page.touchscreen.tap(b.left + b.width / 2, b.top + b.height / 2);
      },
      '\x1b[A\x1b[A\r',
      'tap 第一項'
    );
  });

  test('開關關掉 ⇒ 照舊格線、沒有卡片', async ({ page }) => {
    await ptt.applyPrefs(page, { mobileEssenceCards: false });
    await drawEssence(page);
    expect(await cardCount(page)).toBe(0);
    expect(await page.evaluate(() => window.__app.view.menuCards)).toBe(false);
  });

  test('認不出（底列不是精華區）⇒ 照舊格線、沒有卡片', async ({ page }) => {
    await drawEssence(page, { footer: ' 某個新版底列  (F)寄回信箱' });
    expect(await cardCount(page)).toBe(0);
    expect(await page.evaluate(() => window.__app.view.menuCards)).toBe(false);
  });

  // 精華區的搜尋是 getdata 開在舊畫面上：底列 caption 還在、項目也還在，只多了一條輸入欄。
  // 收成卡片的話輸入欄（倒數第二列）會被當空白列收掉，看不到自己打的字。
  test('PTT 開輸入欄（底列 caption 還在）⇒ 退回格線，輸入欄看得到', async ({ page }) => {
    await drawEssence(page);
    await page.waitForFunction(() => document.querySelectorAll('#mainContainer .essenceCard').length === 3);
    await drawEssence(page, { prompt: true });
    await expect.poll(() => cardCount(page)).toBe(0);
    const h = await page.evaluate(() => {
      const rows = window.__app.buf.rows;
      return document.querySelector(`#mainContainer [type="bbsrow"][srow="${rows - 2}"]`).getBoundingClientRect().height;
    });
    expect(h).toBeGreaterThan(0);
  });
});
