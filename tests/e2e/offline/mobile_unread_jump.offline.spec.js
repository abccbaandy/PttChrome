// 手機：「更多」裡的「跳到第一篇未讀」（docs/unread-jump.md）。只在文章列表出現；
// 點下去與桌機 F7 同一個入口（先送 End）。只在 offline-mobile project 跑。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

const byKey = (page, k) => page.locator(`[data-key="${k}"]`);

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 文章列表一整幀（指紋同 mobile_toolbar.offline.spec.js）。
async function drawArticleList(page) {
  await page.evaluate(() => {
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
    for (let i = 0; i < 3; i++)
      d += '\x1b[' + (4 + i) + ';1H' + u2b(String(1233 + i).padStart(7) + ' +   9/01 testuser     □[閒聊] 測試' + i);
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  });
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

test.describe('手機：跳到第一篇未讀', () => {
  test('文章列表的「更多」裡有這一項，點下去送 End', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await drawArticleList(page);
    await collectSent(page);
    await byKey(page, '__more').tap();
    await byKey(page, '__unreadJump').tap();
    await expect.poll(() => sentText(page)).toContain('\x1b[4~');
    // sheet 收起
    await expect(byKey(page, '__unreadJump')).toHaveCount(0);
  });

  test('主功能表的「更多」沒有這一項', async ({ page }) => {
    await bootOffline(page, ptt);
    await byKey(page, '__more').tap();
    await expect(byKey(page, '__settings')).toBeVisible();
    await expect(byKey(page, '__unreadJump')).toHaveCount(0);
  });
});
