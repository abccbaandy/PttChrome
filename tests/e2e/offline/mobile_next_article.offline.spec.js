// 手機「讀到文末再往上拉 ⇒ 開下一篇」（src/js/pull_next_article.js、docs/next-article.md）。
// 只在 `offline-mobile` project 跑（Pixel 7 模擬，hasTouch）。拉動走 CDP 觸控
// （helpers/real_input.touchDrag）：瀏覽器自己產生 touch 事件與捲動／overscroll 處理，
// 驗得到「被動監聽不擋捲動、拉過門檻放手才送鍵」。
// 畫面照 pttbbs 版面手寫（與 next_article.offline.spec.js 同一套，各自一份，spec 之間不相依）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture } = require('../helpers/capture');
const { touchDrag } = require('../helpers/real_input');
const { waitRectStable } = require('../helpers/layout');

async function feed(page, map, cursor, col) {
  await page.evaluate(
    ({ map, cursor, col }) => {
      const u2b = (str) =>
        [...str]
          .map((ch) => {
            const c = ch.charCodeAt(0);
            if (c < 0x80) return ch;
            return String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
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

// bbs.c#readdoent 的列表＋一頁就讀完的文章（100% ⇒ 好讀讀到文末、卡片出現）。
async function openSecondPost(page) {
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
  await feed(
    page,
    {
      0: '作者  ' + p.author + ' (暱稱) 看板 Test',
      1: '標題  ' + p.title,
      2: '時間  Mon Sep  1 12:00:00 2025',
      4: '內文第一行',
      23: '  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~05 行  (y)回應(X%)推文(h)說明(←)離開 ',
    },
    23,
    80
  );
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

const card = (page) => page.locator('#nextArticleCard');

async function setup(page) {
  await bootOffline(page, ptt, { nextArticle: true });
  await ptt.applyPrefs(page, { enableEasyReadingList: false });
  await openSecondPost(page);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText(POSTS[2].title);
  // 從文章內文起手（不是卡片本身、不在工具列／App Bar 上）。
  const box = await waitRectStable(page, '#mainContainer');
  return { x: box.left + box.width / 2, y: box.top + 40 };
}

test.describe('手機：讀到文末往上拉開下一篇', () => {
  test('往上拉沒過門檻 ⇒ 不送鍵；拉過門檻放手 ⇒ 走 s<板>⏎ 開下一篇', async ({ page }) => {
    const at = await setup(page);
    await startCapture(page);
    // 60px × 阻尼 0.5 ＝ 30px，不到門檻 64px。
    await touchDrag(page, { x: at.x, y: at.y + 120 }, { x: at.x, y: at.y + 60 });
    await expect(card(page)).not.toHaveAttribute('data-pull');
    expect(await peekCapture(page)).toBe('');

    await touchDrag(page, { x: at.x, y: at.y + 230 }, { x: at.x, y: at.y - 30 });
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    await expect(card(page)).toHaveAttribute('data-pending', '');
  });

});
