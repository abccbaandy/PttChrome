// 浮層不准蓋住文末（helpers/overlay_guard.js）：好讀文章捲到底，最後一則推文與接在文末的
// 東西（下一篇卡片）都要看得到、不被任何 fixed／sticky 浮層蓋住。
//
// 為什麼是功能組合的矩陣：每個功能的 spec 預設把別的功能關掉（helpers/replay.js），各自
// 單獨看都對，疊在一起才壞（錄製檔 ptt-debug-20261021-171601：底部推文列壓在下一篇卡片
// 上）。這裡把會佔畫面邊緣的功能一起打開，推文少（PTT 補空白列）／長文（要捲）兩種文章
// 都跑。新增會疊在畫面上的功能時，把它加進 COMBOS。手機版面同一套在 mobile_bottom_overlay。
// 畫面照 pttbbs 版面手寫（與 next_article.offline.spec.js 同一套，各自一份，spec 之間不相依）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { bottomOverlayViolations } = require('../helpers/overlay_guard');

async function onData(page, map, cursor, col) {
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
  title: '[閒聊] 第 ' + num + ' 篇的標題',
}));

// bbs.c#readdoent 的列表（游標在第 2 篇）→ 開第 2 篇（100% ⇒ 好讀一頁就讀到文末）。
// full：內文＋推文填滿整頁（要捲）；否則只有一行內文＋一則推文，pmore 把剩下的列畫成空白。
async function openArticle(page, { full }) {
  const list = {
    0: { rev: true, text: '【板主：test】看板《Test》'.padEnd(80) },
    1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
    2: {
      rev: true,
      text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70),
    },
    23: ' 文章選讀  (y)回應(X)推文(^X)轉錄 ',
  };
  POSTS.forEach(
    (p, i) => (list[3 + i] = String(p.num).padStart(7) + '    ' + ' 9/01 ' + p.author.padEnd(13) + '□ ' + p.title)
  );
  await onData(page, list, 4);
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
  await onData(page, art, 23, 80);
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

// 會佔畫面邊緣的功能（bootOffline 的 opts）。
const COMBOS = [
  [],
  ['commentBar'],
  ['nextArticle'],
  ['commentBar', 'nextArticle'],
  ['commentBar', 'nextArticle', 'articleTools', 'splitReader'],
];

// 視窗大小也是一維：終端機字級跟著視窗高度走，em 寫的間距與 px 寫的浮層高度在某些尺寸才
// 撞在一起（推文列壓卡片 7px 只在 1280×800 出現，1920×900 剛好沒事）。雙欄閱讀／文章工具
// 側欄只用終端機左右的空白，要夠寬才出現。
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1920, height: 900 },
];
const SIDE_PANELS = {
  articleTools: '.articleTools',
  splitReader: '.splitReader',
};

test.describe('浮層不蓋住文末', () => {
  for (const combo of COMBOS) {
    for (const vp of VIEWPORTS) {
      if (vp.width < 1920 && combo.some((k) => SIDE_PANELS[k])) continue;
      for (const full of [false, true]) {
        const title =
          (combo.join('+') || '全關') + '・' + vp.width + 'x' + vp.height + '・' + (full ? '長文捲到底' : '推文很少');
        test(title, async ({ page }) => {
          await page.setViewportSize(vp);
          const opts = {};
          for (const k of combo) opts[k] = true;
          await bootOffline(page, ptt, opts);
          await ptt.applyPrefs(page, { enableEasyReadingList: false });
          await openArticle(page, { full });
          if (combo.includes('nextArticle')) await expect(page.locator('#nextArticleCard')).toBeVisible();
          if (combo.includes('commentBar')) await expect(page.locator('#commentBar')).toBeVisible();
          // 側欄真的出現了（不然這個組合等於沒測）。
          for (const k of combo) if (SIDE_PANELS[k]) await expect(page.locator(SIDE_PANELS[k]).first()).toBeVisible();
          expect(await bottomOverlayViolations(page)).toEqual([]);
        });
      }
    }
  }
});
