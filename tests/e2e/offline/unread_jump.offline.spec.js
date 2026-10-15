// 跳到第一篇未讀（docs/unread-jump.md）：真鍵盤 F7 → 送 End → 讀這頁的已讀標記 → 跳號。
// server 的回應由測試照 pttbbs 版面畫（bbs.c#readdoent：%7d 序號、type 在 cell 8）。
// F7 的瀏覽器預設動作（Chrome 鍵盤瀏覽模式）只有真按鍵驗得出有沒有被擋。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 文章列表一整幀。entries：[[num, mark], …] 由舊到新排在第 4 列起；cursorNum 那列畫 `>`。
async function drawList(page, entries, cursorNum) {
  await page.evaluate(
    ({ entries, cursorNum }) => {
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) {
            out += ch;
            continue;
          }
          out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[2J';
      d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
      d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
      d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
      let curRow = 4;
      entries.forEach(([num, mark], i) => {
        const cursor = num === cursorNum;
        if (cursor) curRow = 4 + i;
        const head = cursor ? '>' + String(num).padStart(6) : String(num).padStart(7);
        d += '\x1b[' + (4 + i) + ';1H' + u2b(head + ' ' + mark + ' 5 9/01 testuser     □[閒聊] 測試' + num);
      });
      d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
      d += '\x1b[' + curRow + ';1H';
      window.__app.onData(d);
    },
    { entries, cursorNum }
  );
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}
const range = (from, to, markOf) => {
  const out = [];
  for (let n = from; n <= to; ++n) out.push([n, markOf(n)]);
  return out;
};

test.describe('跳到第一篇未讀（F7）', () => {
  test('F7 送 End（擋下瀏覽器預設動作）→ 讀到已讀區 → 跳號停在第一篇未讀', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await drawList(page, range(1233, 1235, () => ' '), 1233);
    await page.evaluate(() => {
      window.__f7Prevented = null;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F7') window.__f7Prevented = e.defaultPrevented;
      });
      window.__app.setInputAreaFocus();
    });
    await collectSent(page);
    await page.keyboard.press('F7');
    await expect.poll(() => sentText(page)).toContain('\x1b[4~');
    expect(await page.evaluate(() => window.__f7Prevented)).toBe(true);
    expect(await page.evaluate(() => window.__app.unreadJumpInFlight)).toBe(true);

    // End 的回應：最後 20 篇，110 以後是未讀、往上 5 篇已讀 ⇒ 第一篇未讀＝110。
    const mark = (n) => (n >= 110 ? '+' : n === 109 ? '~' : ' ');
    await collectSent(page);
    await drawList(page, range(101, 120, mark), 120);
    await expect.poll(() => sentText(page)).toContain('110\r');
    expect(await sentText(page)).not.toContain('\x1b[5~');

    await drawList(page, range(101, 120, mark), 110);
    await expect(page.locator('.ListHint')).toContainText('已跳到第一篇未讀');
    expect(await page.evaluate(() => !!window.__app.unreadJumpInFlight)).toBe(false);
  });

  test('End 這頁還沒走進已讀區 ⇒ 送 PgUp 再讀一頁', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await drawList(page, range(1233, 1235, () => ' '), 1233);
    await page.evaluate(() => window.__app.setInputAreaFocus());
    await collectSent(page);
    await page.keyboard.press('F7');
    await expect.poll(() => sentText(page)).toContain('\x1b[4~');
    await collectSent(page);
    await drawList(page, range(101, 120, () => '+'), 120);
    await expect.poll(() => sentText(page)).toContain('\x1b[5~');
  });

  test('不是文章列表 ⇒ 不送鍵、只有提示（F7 仍被擋下）', async ({ page }) => {
    await bootOffline(page, ptt);
    await page.evaluate(() => {
      window.__app.onData('\x1b[2J\x1b[1;1H\x1b[7m' + ' '.repeat(10) + 'Main Menu\x1b[0m\x1b[5;1HHello');
      window.__f7Prevented = null;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'F7') window.__f7Prevented = e.defaultPrevented;
      });
      window.__app.setInputAreaFocus();
    });
    await collectSent(page);
    await page.keyboard.press('F7');
    await expect(page.locator('.ListHint')).toContainText('只有在文章列表');
    expect(await page.evaluate(() => window.__f7Prevented)).toBe(true);
    expect(await sentText(page)).toBe('');
  });
});
