// 讀完接著讀下一篇（src/js/next_article.js、docs/next-article.md）：好讀文章讀到文末 ⇒ 最後一列
// 下面出現列表上下一篇的標題卡；點它走 aid_navigation.startNum（第一步文章內 s<板>⏎）；
// 從搜尋結果進的走 startSubNum（第一步文章內 ← 回同一份結果）；沒有下一篇 ⇒ 終點卡（不能點）；
// pref 關不出現。只有真瀏覽器驗得出來：卡片真的排在文末之後（不蓋字、跟著捲）、
// 真的滑鼠點卡片不變成點終端機（滑鼠瀏覽開著也不送 ←／Enter）、不搶 #t 焦點、換文途中遮罩
// 真的蓋在原生鏡像上面、真滾輪（page.mouse.wheel）停一下再捲過門檻才開。
// 畫面照 pttbbs 版面手寫，與 split_reader.offline.spec.js 同一套（各自一份，spec 之間不相依）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitRectStable, elementUnder } = require('../helpers/layout');

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
// pinned：最後一列換成置底文（read.c：置底恆排在所有編號文章後面 ⇒ 看得到列表盡頭）。
async function drawList(page, cursorIndex, { sub = false, pinned = false, entries = ENTRIES } = {}) {
  const caption = sub ? '系列文章' : '文章選讀';
  const map = {
    0: { rev: true, text: ('【板主：test】' + (sub ? '系列' : '看板') + '《Test》').padEnd(80) },
    1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
    2: { rev: true, text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70) },
    23: ' ' + caption + '  (y)回應(X)推文(^X)轉錄 ',
  };
  entries.forEach(
    (e, i) => (map[3 + i] = listRow(sub ? i + 1 : e.num, e.author, e.title, e.unread ? '+' : ' '))
  );
  if (pinned) map[3 + entries.length - 1] = '    ★ ' + '    ' + ' 9/01 ' + 'sysop'.padEnd(13) + '□ [公告] 置底';
  await onData(page, map, 3 + cursorIndex);
  await waitScreenSettled(page, { 2: '編號', 23: caption });
}

// 文章第一頁（標頭讓 term_view 認出看板／作者／標題；100% ⇒ 好讀一頁就讀到文末、線路是閒的）。
// 預設只有一行內文：pmore 把文章後面剩下的列畫成空白（推文很少的文章就是這樣）。full：內文
// 填滿整頁（卡片在視窗外，要捲到底才看得到）。
async function drawArticle(page, entry, { full = false } = {}) {
  const map = {
    0: '作者  ' + entry.author + ' (暱稱) 看板 Test',
    1: '標題  ' + entry.title,
    2: '時間  Mon Sep  1 12:00:00 2025',
    4: '內文第一行',
    23: '  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~' + (full ? 23 : '05') + ' 行  (y)回應(X%)推文(h)說明(←)離開 ',
  };
  if (full) for (let r = 5; r < 23; r++) map[r] = '內文第 ' + (r - 3) + ' 行';
  await onData(page, map, 23, 80);
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

// 最後一列有內容的列的下緣（卡片的頂端要在它下面：不蓋字）。
async function lastTextBottom(page, text) {
  const r = await page
    .locator('#mainContainer span[type="bbsrow"]', { hasText: text })
    .last()
    .evaluate((el) => el.getBoundingClientRect());
  return r.top + r.height;
}

async function scrollToEnd(page) {
  await page.evaluate(() => {
    const m = document.querySelector('.main');
    m.scrollTop = m.scrollHeight;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = document.querySelector('.main');
        return m.scrollTop + m.clientHeight >= m.scrollHeight - 1;
      })
    )
    .toBe(true);
}

const card = (page) => page.locator('#nextArticleCard');
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function boot(page, prefs, { commentBar = false } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { nextArticle: true, commentBar });
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
    // 排在文末之後：卡片頂端在最後一列內容底下（蓋住的只有 PTT 補的空白列），而且在捲動容器裡。
    const cardBox = await waitRectStable(page, '#nextArticleCard');
    expect(cardBox.top).toBeGreaterThanOrEqual(await lastTextBottom(page, '內文第一行'));
    expect(await card(page).evaluate((el) => el.parentElement.classList.contains('main'))).toBe(true);
    await expect(page.locator('#t')).toBeFocused();
    // 回列表 ⇒ 收起。
    await drawList(page, 4);
    await expect(card(page)).toBeHidden();
  });

  // 推文很少的文章，卡片排在 PTT 補的空白列後面，要捲一段
  // 才看得到；捲下去之後底部推文列又壓在卡片上。
  test('推文列開著、推文很少 ⇒ 不用捲就看到整張卡片，推文列不蓋卡片', async ({ page }) => {
    await boot(page, {}, { commentBar: true });
    await openFromList(page, 4);
    await expect(card(page)).toBeVisible();
    await expect(page.locator('#commentBar')).toBeVisible();
    const cardBox = await waitRectStable(page, '#nextArticleCard');
    const barBox = await waitRectStable(page, '#commentBar');
    expect(await page.evaluate(() => document.querySelector('.main').scrollTop)).toBe(0);
    expect(cardBox.top + cardBox.height).toBeLessThanOrEqual(barBox.top);
    expect(cardBox.top).toBeGreaterThanOrEqual(await lastTextBottom(page, '內文第一行'));
  });

  test('推文列開著、長文章捲到底 ⇒ 卡片在推文列上面，點得到', async ({ page }) => {
    await boot(page, {}, { commentBar: true });
    await drawList(page, 4);
    await drawArticle(page, ENTRIES[4], { full: true });
    await expect(card(page)).toBeVisible();
    await scrollToEnd(page);
    const cardBox = await waitRectStable(page, '#nextArticleCard');
    const barBox = await waitRectStable(page, '#commentBar');
    expect(cardBox.top + cardBox.height).toBeLessThanOrEqual(barBox.top);
    expect(cardBox.top).toBeGreaterThanOrEqual(await lastTextBottom(page, '內文第 19 行'));
    expect(
      await elementUnder(page, cardBox.left + cardBox.width / 2, cardBox.top + cardBox.height - 2, {
        closest: '#nextArticleCard',
        attribute: 'id',
      })
    ).toBe('nextArticleCard');
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

  // 從搜尋結果開的文章讀到文末，卡片沒出現。
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

  // 使用者回報：最後一篇讀到底什麼都沒有，以為功能壞了。
  test('最後一篇（下一列是置底文）⇒ 卡片寫「已無下一篇」，點了不送鍵', async ({ page }) => {
    await boot(page);
    await drawList(page, ENTRIES.length - 2, { pinned: true });
    await drawArticle(page, ENTRIES[ENTRIES.length - 2]);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-end', 'last');
    await expect(card(page)).toContainText(await label(page, 'next_article_last'));
    await startCapture(page);
    // aria-disabled ⇒ Playwright 的可點檢查會一直等；這裡就是要驗「真的點下去也不送鍵」。
    await card(page).click({ force: true });
    await expect(card(page)).not.toHaveAttribute('data-pending', '');
    expect(await takeCapture(page)).toBe('');
    await expect(page.locator('#nextArticleVeil')).toHaveCount(0);
  });

  test('這篇在列表頁的最底一列（下一號沒看過）⇒ 卡片寫「已到文末」', async ({ page }) => {
    await boot(page);
    await openFromList(page, ENTRIES.length - 1);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-end', 'unknown');
    await expect(card(page)).toContainText(await label(page, 'next_article_unknown'));
  });

  // 使用者回報：開下一篇的過程會短暫切回原生（換文是真的走一趟原生鍵，途中鏡像原生畫面）。
  test('換文途中遮罩蓋著，原生列表一幀都看不到；新文章畫好後遮罩拿掉', async ({ page }) => {
    await boot(page);
    await openFromList(page, 4);
    await expect(card(page)).toBeVisible();
    const veil = page.locator('#nextArticleVeil');
    // .main 中央那一點最上面是誰：遮罩（或它裡面的東西）才算蓋住。
    const veilOnTop = async () => {
      const r = await waitRectStable(page, '.main');
      return elementUnder(page, r.left + r.width / 2, r.top + r.height / 2, {
        closest: '#nextArticleVeil',
        attribute: 'id',
      });
    };
    await startCapture(page);
    await card(page).click();
    await expect(veil).toBeVisible();
    await expect(veil).toContainText(ENTRIES[5].title);
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    expect(await takeCapture(page)).toBe('sTest\r\f');
    // 板跳落地：原生列表進了 #mainContainer（鏡像），但被蓋著。
    await startCapture(page);
    await drawList(page, 4);
    await expect.poll(() => page.evaluate(() => document.getElementById('mainContainer').innerText)).toContain('編號');
    expect(await veilOnTop()).toBe('nextArticleVeil');
    await expect.poll(() => peekCapture(page)).toContain(ENTRIES[5].num + '\r');
    expect(await takeCapture(page)).toBe(ENTRIES[5].num + '\r\f');
    // 跳號落地（游標在下一篇）⇒ ⏎ 開文。
    await startCapture(page);
    await drawList(page, 5);
    expect(await veilOnTop()).toBe('nextArticleVeil');
    await expect.poll(() => peekCapture(page)).toContain('\r');
    await drawArticle(page, ENTRIES[5]);
    await expect(veil).toBeHidden();
    await expect(page.locator('#mainContainer')).toContainText(ENTRIES[5].title);
    // 新文章也讀到文末了：卡片換成再下一篇。
    await expect(card(page)).toContainText(ENTRIES[6].title);
  });

  test('桌機：讀到文末停住後再往下捲過門檻 ⇒ 開下一篇；只捲一格不開', async ({ page }) => {
    await boot(page);
    await openFromList(page, 4);
    await expect(card(page)).toBeVisible();
    const box = await waitRectStable(page, '.main');
    await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
    // 讀到最底（卡片也進到視窗裡）。
    await scrollToEnd(page);
    await startCapture(page);
    await page.mouse.wheel(0, 100);
    await expect(card(page)).toHaveAttribute('data-pull', 'wheel');
    await expect(card(page)).toContainText(await label(page, 'next_article_wheel'));
    // 停住 ⇒ 字樣還原、沒送鍵。
    await expect(card(page)).not.toHaveAttribute('data-pull', 'wheel');
    expect(await peekCapture(page)).toBe('');
    // 一口氣捲過門檻（WHEEL_THRESHOLD_PX 480）。
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 100);
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    expect(await takeCapture(page)).toBe('sTest\r\f');
    await expect(page.locator('#nextArticleVeil')).toBeVisible();
  });

  // P28：列表上同主題的下一篇（不是緊接的下一篇）⇒ 卡片下面多一顆「同主題下一篇」，真滑鼠點它
  // 走同一條 startNum（第一步 s<板>⏎），不變成點終端機、不搶焦點。
  test('同主題下一篇：卡片下面多一顆按鈕，點它走 s<板>⏎', async ({ page }) => {
    const entries = ENTRIES.map((e, i) => (i === 8 ? Object.assign({}, e, { title: 'Re: ' + ENTRIES[4].title }) : e));
    await boot(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await drawList(page, 4, { entries });
    await drawArticle(page, entries[4]);
    await expect(card(page)).toBeVisible();
    const btn = page.locator('#nextThreadRow .nextThreadCard[data-dir="next"]');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(await label(page, 'next_article_thread_next'));
    await expect(btn).toContainText(entries[8].title);
    await expect(page.locator('#nextThreadRow .nextThreadCard[data-dir="prev"]')).toBeHidden();
    const box = await waitRectStable(page, '#nextThreadRow .nextThreadCard[data-dir="next"]');
    const cardBox = await waitRectStable(page, '#nextArticleCard');
    expect(box.top).toBeGreaterThanOrEqual(cardBox.top + cardBox.height);
    await startCapture(page);
    await btn.click();
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    expect(await takeCapture(page)).toBe('sTest\r\f');
    await expect(btn).toHaveAttribute('data-pending', '');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    await boot(page, { enableNextArticleCard: false });
    await openFromList(page, 2);
    expect(await page.evaluate(() => window.__app.view._articleBoard)).toBe('Test');
    await expect(card(page)).toHaveCount(0);
  });
});
