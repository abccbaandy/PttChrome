// 讀完接著讀下一篇（src/js/next_article.js、docs/next-article.md）：好讀文章讀到文末 ⇒ 最後一列
// 下面出現列表上下一篇的標題卡；點它走 aid_navigation.startNum（第一步文章內 s<板>⏎）；
// 從搜尋結果進的走 startSubNum（第一步文章內 ← 回同一份結果）；最後一篇、pref 關不出現。只有真瀏覽器驗得出來：卡片真的排在文末之後（不蓋字、跟著捲）、
// 真的滑鼠點卡片不變成點終端機（滑鼠瀏覽開著也不送 ←／Enter）、不搶 #t 焦點。
// 畫面照 pttbbs 版面手寫，與 split_reader.offline.spec.js 同一套（各自一份，spec 之間不相依）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitRectStable } = require('../helpers/layout');

// col：游標停的欄（1 起算）。好讀只收「PTT 畫完、游標停在末列末欄」的完整文章幀
// （pmore 不變量 P6，docs/pttbbs-screen-protocol.md §13）⇒ 文章幀給 80。
async function onData(page, map, cursor, col) {
  await page.evaluate(
    ({ map, cursor, col }) => {
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
      for (const k of Object.keys(map)) {
        const v = map[k];
        d += '\x1b[' + (Number(k) + 1) + ';1H' + (v.rev ? REV + u2b(v.text) + OFF : u2b(v.text || v));
      }
      d += '\x1b[' + (cursor + 1) + ';' + (col || 1) + 'H';
      window.__app.onData(d);
    },
    { map, cursor, col }
  );
}

// bbs.c#readdoent：%7d 序號、型別、推文數、日期、作者(13)、mark＋標題。
const listRow = (num, author, title, type = ' ') =>
  String(num).padStart(7) + ' ' + type + '  ' + ' 9/01 ' + author.padEnd(13) + '□ ' + title;

const ENTRIES = Array.from({ length: 20 }, (_, i) => ({
  num: 101 + i,
  author: 'user' + (i % 5),
  title: '[閒聊] 第 ' + (101 + i) + ' 篇的標題',
  unread: i % 3 === 0,
}));

// 一整幀文章列表（row0／row2 反白鋪滿、row1 不空 ⇒ pageState 2，見 long_push spec 的說明）。
// sub：搜尋結果（read.c MODE_SELECT：標題列右段「系列《板》」、底列 caption「系列文章」），
// 編號是結果自己的空間（1 起算）。
async function drawList(page, cursorIndex, { sub = false } = {}) {
  const caption = sub ? '系列文章' : '文章選讀';
  const map = {
    0: { rev: true, text: ('【板主：test】' + (sub ? '系列' : '看板') + '《Test》').padEnd(80) },
    1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
    2: { rev: true, text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70) },
    23: ' ' + caption + '  (y)回應(X)推文(^X)轉錄 ',
  };
  ENTRIES.forEach(
    (e, i) => (map[3 + i] = listRow(sub ? i + 1 : e.num, e.author, e.title, e.unread ? '+' : ' '))
  );
  await onData(page, map, 3 + cursorIndex);
  await waitScreenSettled(page, { 2: '編號', 23: caption });
}

// 文章第一頁（標頭讓 term_view 認出看板／作者／標題；100% ⇒ 好讀一頁就讀到文末、線路是閒的）。
async function drawArticle(page, entry) {
  await onData(
    page,
    {
      0: '作者  ' + entry.author + ' (暱稱) 看板 Test',
      1: '標題  ' + entry.title,
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

async function boot(page, prefs) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { nextArticle: true });
  // 好讀列表會自己補頁、改送鍵：這裡只測文末的卡片，用原生列表。
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs || {}));
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

async function openFromList(page, index) {
  await drawList(page, index);
  await drawArticle(page, ENTRIES[index]);
}

test.describe('讀完接著讀下一篇', () => {
  test('讀到文末 ⇒ 文末下面出現下一篇的標題卡，不蓋字', async ({ page }) => {
    await boot(page);
    await drawList(page, 4);
    await expect(card(page)).toHaveCount(0);
    await drawArticle(page, ENTRIES[4]);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(ENTRIES[5].title);
    await expect(card(page)).toContainText(ENTRIES[5].author);
    // 排在文末之後：卡片頂端在最後一列（#mainContainer）底下，而且在捲動容器裡。
    const cardBox = await waitRectStable(page, '#nextArticleCard');
    const textBox = await waitRectStable(page, '#mainContainer');
    expect(cardBox.top).toBeGreaterThanOrEqual(textBox.top + textBox.height);
    expect(await card(page).evaluate((el) => el.parentElement.classList.contains('main'))).toBe(true);
    await expect(page.locator('#t')).toBeFocused();
    // 回列表 ⇒ 收起。
    await drawList(page, 4);
    await expect(card(page)).toBeHidden();
  });

  test('點卡片 ⇒ 走 s<板>⏎（startNum 的第一步），不變成點終端機、不搶焦點', async ({ page }) => {
    await boot(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await openFromList(page, 4);
    await expect(card(page)).toBeVisible();
    await startCapture(page);
    await card(page).click();
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    // 只有板跳那一步（＋CommandQueue 的 fullRepaint \f）：沒有滑鼠瀏覽在終端機上送的 ←／Enter。
    expect(await takeCapture(page)).toBe('sTest\r\f');
    await expect(card(page)).toHaveAttribute('data-pending', '');
    await expect(page.locator('#t')).toBeFocused();
  });

  // 錄製檔 ptt-debug-20261021-015619：從搜尋結果開的文章讀到文末，卡片沒出現。
  test('從搜尋結果進的文章 ⇒ 卡片是結果的下一筆；點它走 ←（回同一份結果），不走 s<板>', async ({ page }) => {
    await boot(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await drawList(page, 4, { sub: true });
    await drawArticle(page, ENTRIES[4]);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText(ENTRIES[5].title);
    await startCapture(page);
    await card(page).click();
    await expect.poll(() => peekCapture(page)).toContain('\x1b[D');
    expect(await takeCapture(page)).toBe('\x1b[D\f');
    // ← 回到結果（游標在原篇）⇒ 下一步是結果裡的編號（第 6 筆），不是完整列表的 106。
    await startCapture(page);
    await drawList(page, 4, { sub: true });
    await expect.poll(() => peekCapture(page)).toContain('6\r');
    expect(await takeCapture(page)).toBe('6\r\f');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('最後一篇（下一列是置底文／沒看過）⇒ 不出現', async ({ page }) => {
    await boot(page);
    await openFromList(page, ENTRIES.length - 1);
    expect(await page.evaluate(() => window.__app.view._articleBoard)).toBe('Test');
    await expect(card(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    await boot(page, { enableNextArticleCard: false });
    await openFromList(page, 2);
    expect(await page.evaluate(() => window.__app.view._articleBoard)).toBe('Test');
    await expect(card(page)).toHaveCount(0);
  });
});
