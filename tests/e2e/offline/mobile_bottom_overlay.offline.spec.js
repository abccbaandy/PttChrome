// 浮層不准蓋住文末・手機版面（helpers/overlay_guard.js；桌機版在 bottom_overlay.offline.spec.js）。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬）：手機多了底部導覽列、App Bar 這些 fixed
// 浮層，推文列也換成手機版。好讀文章捲到底，最後一則推文與下一篇卡片都要看得到、不被蓋住。
// 新增會疊在手機畫面上的功能時，把它加進 COMBOS。
// 畫面照 pttbbs 版面手寫（與 mobile_next_article.offline.spec.js 同一套，各自一份，spec 之間不相依）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { bottomOverlayViolations } = require('../helpers/overlay_guard');

async function feed(page, map, cursor, col) {
  await page.evaluate(
    ({ map, cursor, col }) => {
      const u2b = (str) =>
        [...str]
          .map((ch) => {
            const c = ch.charCodeAt(0);
            if (c < 0x80) return ch;
            return (
              String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1])
            );
          })
          .join('');
      let d = '\x1b[2J';
      for (const k of Object.keys(map)) {
        const v = map[k];
        d += '\x1b[' + (Number(k) + 1) + ';1H' + (v.rev ? '\x1b[7m' + u2b(v.text) + '\x1b[0m' : u2b(v));
      }
      window.__app.onData(d + '\x1b[' + (cursor + 1) + ';' + (col || 1) + 'H');
    },
    { map, cursor, col }
  );
}

const POSTS = [101, 102, 103, 104, 105].map((num, i) => ({
  num,
  author: 'user' + i,
  title: '[閒聊] 手機第 ' + num + ' 篇',
}));

// 列表（游標在第 2 篇）→ 開第 2 篇（100% ⇒ 好讀一頁就讀到文末）。full：內文＋推文填滿整頁
// （要捲）；否則只有一行內文＋一則推文，pmore 把剩下的列畫成空白。
async function openArticle(page, { full }) {
  const list = {
    0: { rev: true, text: '【板主：test】看板《Test》'.padEnd(80) },
    1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
    2: { rev: true, text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70) },
    23: ' 文章選讀  (y)回應(X)推文(^X)轉錄 ',
  };
  POSTS.forEach(
    (p, i) => (list[3 + i] = String(p.num).padStart(7) + '    ' + ' 9/01 ' + p.author.padEnd(13) + '□ ' + p.title)
  );
  await feed(page, list, 4);
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
  const p = POSTS[1];
  const last = full ? 22 : 6;
  const art = {
    0: '作者  ' + p.author + ' (暱稱) 看板 Test',
    1: '標題  ' + p.title,
    2: '時間  Mon Sep  1 12:00:00 2025',
    4: '內文第一行',
    23:
      '  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~' +
      String(last + 1).padStart(2, '0') +
      ' 行  (y)回應(X%)推文(h)說明(←)離開 ',
  };
  for (let r = 5; r < last; r++) art[r] = '內文第 ' + (r - 3) + ' 行';
  art[last] = '推 alice: 最後一則推文                                         09/01 12:34';
  await feed(page, art, 23, 80);
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

// 會佔畫面邊緣的功能（bootOffline 的 opts）；手機的底部導覽列與 App Bar 一律在。
// commentBarFold＝推文列收進底部導覽、點導覽的「推文」展開之後的樣子。
const COMBOS = [[], ['nextArticle'], ['commentBar', 'nextArticle'], ['commentBarFold', 'nextArticle']];

test.describe('手機：浮層不蓋住文末', () => {
  for (const combo of COMBOS) {
    for (const full of [false, true]) {
      const title = (combo.join('+') || '全關') + '・' + (full ? '長文捲到底' : '推文很少');
      test(title, async ({ page }) => {
        const opts = {};
        for (const k of combo) opts[k] = true;
        if (opts.commentBarFold) opts.commentBar = true;
        await bootOffline(page, ptt, opts);
        await ptt.applyPrefs(page, { enableEasyReadingList: false });
        await openArticle(page, { full });
        if (combo.includes('commentBarFold')) {
          await expect.poll(() => page.evaluate(() => window.__app.commentBar.state.available)).toBe(true);
          await page.locator('[data-key="X"]').tap();
          await expect(page.locator('#commentBar')).toBeVisible();
        }
        await expect(page.locator('body')).toHaveClass(/mobile-layout/);
        if (combo.includes('nextArticle')) await expect(page.locator('#nextArticleCard')).toBeVisible();
        if (opts.commentBar) await expect(page.locator('#commentBar')).toBeVisible();
        expect(await bottomOverlayViolations(page)).toEqual([]);
      });
    }
  }
});
