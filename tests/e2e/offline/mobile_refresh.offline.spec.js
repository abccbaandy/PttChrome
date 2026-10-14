// 手機的重新整理（docs/screen-refresh.md）：工具列「重整」「到底」鈕、下拉重整。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬，hasTouch）。下拉走 CDP 觸控
// （helpers/real_input.touchDrag）：瀏覽器自己產生 touch 事件與捲動／overscroll 處理。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { touchDrag } = require('../helpers/real_input');
const { waitRectStable } = require('../helpers/layout');

const byKey = (page, k) => page.locator(`[data-key="${k}"]`);
async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

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
      d += '\x1b[' + (4 + i) + ';1H' + u2b(String(1233 + i).padStart(7) + '     9/01 testuser     □[閒聊] 測試' + i);
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  });
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

test.describe('手機重新整理（離線重放）', () => {
  test('文章列表：工具列有重整與到底；重整送 s、到底送 End', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false, refreshMinIntervalSec: 0 });
    await drawArticleList(page);
    await expect(byKey(page, '__refresh')).toBeVisible();
    await expect(byKey(page, '__end')).toBeVisible();
    await collectSent(page);
    await byKey(page, '__end').tap();
    await expect.poll(() => sentText(page)).toContain('\x1b[4~');
    await collectSent(page);
    await byKey(page, '__refresh').tap();
    await expect.poll(() => sentText(page)).toContain('s');
  });

  test('下拉重整：在終端機上往下拉過門檻放手 ⇒ 送 s；拉不夠 ⇒ 不送', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false, refreshMinIntervalSec: 0 });
    await drawArticleList(page);
    const r = await waitRectStable(page, '#mainContainer');
    const x = r.left + r.width / 2;
    const y = r.top + 40;

    await page.evaluate(() => (window.__notReloaded = true));
    await collectSent(page);
    // 60px × 阻尼 0.5 ＝ 30px，不到門檻 64px。
    await touchDrag(page, { x, y }, { x, y: y + 60 });
    expect(await sentText(page)).not.toContain('s');
    await expect(page.locator('.pullRefreshIndicator.visible')).toHaveCount(0);

    await touchDrag(page, { x, y }, { x, y: y + 260 });
    await expect.poll(() => sentText(page)).toContain('s');
    // 放手後指示器收起。
    await expect(page.locator('.pullRefreshIndicator.visible')).toHaveCount(0);
    // 原生 pull-to-refresh 沒有跑（沒有整頁重載）。
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
  });
});
