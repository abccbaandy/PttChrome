// 文章導覽軸顯示時，終端機右緣只能有一條捲軸（src/js/article_nav.js、docs/article-tools.md
// 「文章導覽軸」）。症狀：原生捲軸（.main::-webkit-scrollbar 那條灰的）與導覽軸的滑塊並排，
// 兩個滑塊各在不同位置。
// 而且原生的那條要**整個不畫**（display:none），不能只是透明：自訂捲軸由主執行緒畫，捲動時
// 每幀連同 .main 整層重畫（實機每幀 1.3～2.1 ms，docs/handoff/android-battery-drain.md U9）。
// 拿掉後空出的寬度要補回去：導覽軸一出現一消失，內容寬度（放大態圖片高度、手機換行點）不變。
//
// 為什麼獨立成一支：Playwright 的 headless Chromium 預設帶 `--hide-scrollbars`（同
// mouse_scrollbar.offline.spec.js），原生捲軸根本畫不出來，這條會恆綠。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette, waitScreenSettled } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');
const { nativeScrollbarPeak, layoutWithAndWithoutNav } = require('../helpers/article_nav');

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const article = loadCassette('stock-huang');

async function boot(page, prefs) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs || {}));
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
}

test('導覽軸顯示中 ⇒ 原生捲軸不畫（不佔寬），內容寬度與沒有導覽軸時相同', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page);
  await expect(page.locator('#articleNav')).toBeVisible();
  expect(await nativeScrollbarPeak(page)).toBeNull();
  const { on, off } = await layoutWithAndWithoutNav(page, ptt);
  expect(on.gutter, '原生捲軸還在（只是透明的話捲動時照樣每幀重畫）').toBe(0);
  expect(off.gutter, '原生捲軸沒有佔寬（--hide-scrollbars 沒拿掉？）').toBeGreaterThan(4);
  expect(on.outer).toBe(off.outer);
  expect(on.content).toBe(off.content);
  expect(on.inner).toBe(off.inner);
  expect(on.scrollHeight).toBe(off.scrollHeight);
});

// 一頁就讀完的短文（照 pttbbs 版面手寫，同 mobile_next_article spec：從文章列表進文章，好讀才接手）。
// 內容沒超出 ⇒ 原本就沒有原生捲軸、內容是全寬；導覽軸出現時不能憑空窄 10px（只有超出時才補
// 捲軸的寬度）。
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

async function openShortArticle(page) {
  await feed(
    page,
    {
      0: { rev: true, text: '【板主：test】看板《Test》'.padEnd(80) },
      1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
      2: { rev: true, text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70) },
      3: '    101    9/01 someone      □ [閒聊] 短文',
      23: ' 文章選讀  (y)回應(X)推文(^X)轉錄 ',
    },
    3
  );
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
  await feed(
    page,
    {
      0: '作者  someone (暱稱) 看板 Test',
      1: '標題  [閒聊] 短文',
      2: '時間  Mon Sep  1 12:00:00 2025',
      4: '內文第一行',
      23: '  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~05 行  (y)回應(X%)推文(h)說明(←)離開 ',
    },
    23,
    80
  );
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

test('短文（內容沒超出）⇒ 導覽軸顯示時內容照樣全寬', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { articleNav: true });
  await ptt.applyPrefs(page, { enableEasyReading: true, enableEasyReadingList: false });
  await openShortArticle(page);
  await expect(page.locator('#articleNav')).toBeVisible();
  const { on, off } = await layoutWithAndWithoutNav(page, ptt);
  expect(off.gutter, '短文本來就不該有原生捲軸').toBe(0);
  expect(on.gutter).toBe(0);
  expect(on.content).toBe(off.content);
  expect(on.inner).toBe(off.inner);
});

test('pref 關（沒有導覽軸）⇒ 原生捲軸照常顯示', async ({ page }) => {
  test.setTimeout(90000);
  await boot(page, { enableArticleNav: false });
  await expect(page.locator('#mainContainer')).toContainText('morrislek');
  expect(await nativeScrollbarPeak(page)).toBeGreaterThan(40);
});
