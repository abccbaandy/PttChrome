// 寬螢幕雙欄閱讀（src/js/split_reader.js、docs/split-reader.md）：從文章列表進文章 ⇒ 終端機
// 左邊的空白列出剛才那份列表、標出正在讀的那篇；點另一篇走 aid_navigation.startNum（第一步
// 文章內 s<板>⏎）；滾輪捲左欄不翻文章；放不下、pref 關就不出現。
// 只有真瀏覽器驗得出來：左欄真的落在終端機左邊的空白（不蓋字）、點左欄不搶 #t 焦點也不
// 變成點終端機、滾輪被左欄吃下而不是變成文章翻頁。畫面照 pttbbs 版面手寫（列表＝
// bbs.c#readdoent，文章＝pmore 標頭＋狀態列），同 long_push.offline.spec.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitRectStable } = require('../helpers/layout');

// 16:9 桌機最大化視窗的可視區：預設「固定終端機大小」把字放大到撐滿高度，左右各剩 155px。
const WIDE = { width: 1920, height: 960 };
const NARROW = { width: 1280, height: 800 };

async function onData(page, map, cursor) {
  await page.evaluate(
    ({ map, cursor }) => {
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
      d += '\x1b[' + (cursor + 1) + ';1H';
      window.__app.onData(d);
    },
    { map, cursor }
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
async function drawList(page, cursorIndex) {
  const map = {
    0: { rev: true, text: '【板主：test】看板《Test》'.padEnd(80) },
    1: '[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄',
    2: { rev: true, text: '  編號    日 期 作  者       文  章  標  題'.padEnd(70) },
    23: ' 文章選讀  (y)回應(X)推文(^X)轉錄 ',
  };
  ENTRIES.forEach((e, i) => (map[3 + i] = listRow(e.num, e.author, e.title, e.unread ? '+' : ' ')));
  await onData(page, map, 3 + cursorIndex);
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

// 文章第一頁（標頭讓 term_view 認出看板／作者／標題；100% ⇒ 好讀不必翻頁、線路是閒的）。
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
    23
  );
  await waitScreenSettled(page, { 0: '作者', 23: '瀏覽' });
}

const pane = (page) => page.locator('#splitReader');

async function boot(page, viewport, prefs) {
  await page.setViewportSize(viewport);
  await bootOffline(page, ptt, { splitReader: true });
  // 好讀列表會自己補頁、改送鍵：這裡只測左欄，用原生列表。
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs || {}));
  await page.evaluate(() => window.__app.setInputAreaFocus());
}

async function openFromList(page, index) {
  await drawList(page, index);
  await drawArticle(page, ENTRIES[index]);
}

test.describe('寬螢幕雙欄閱讀', () => {
  test('列表 → 文章：左欄出現在終端機左邊的空白，標出正在讀的那篇', async ({ page }) => {
    await boot(page, WIDE);
    await drawList(page, 4);
    await expect(pane(page)).toHaveCount(0);
    await drawArticle(page, ENTRIES[4]);
    await expect(pane(page)).toBeVisible();
    await expect(page.locator('[data-split-num]')).toHaveCount(ENTRIES.length);
    await expect(page.locator('[data-split-num="105"]')).toHaveAttribute('data-current', '');
    await expect(page.locator('[data-split-num="101"]')).toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-split-board]')).toHaveText('Test');
    // 不蓋終端機：左欄右緣在終端機左緣之前。
    const paneBox = await waitRectStable(page, '#splitReader');
    // view.mainDisplay（#BBSWindow 下的 .main）＝終端機本體，左欄量的就是它。
    const termBox = await waitRectStable(page, '#BBSWindow > .main');
    expect(paneBox.left + paneBox.width).toBeLessThanOrEqual(termBox.left);
    await expect(page.locator('#t')).toBeFocused();
    // 回列表 ⇒ 收起（列表本身就在畫面上）。
    await drawList(page, 4);
    await expect(pane(page)).toHaveCount(0);
  });

  test('點另一篇 ⇒ 走 s<板>⏎（startNum 的第一步），不變成點終端機、不搶焦點', async ({ page }) => {
    await boot(page, WIDE, { useMouseBrowsing: true, mouseLeftClick: true });
    await openFromList(page, 4);
    await expect(pane(page)).toBeVisible();
    await startCapture(page);
    await page.locator('[data-split-num="110"]').click();
    await expect.poll(() => peekCapture(page)).toContain('sTest\r');
    // 只有板跳那一步（＋CommandQueue 的 fullRepaint \f）：沒有滑鼠瀏覽在終端機上送的 ←／Enter。
    expect(await takeCapture(page)).toBe('sTest\r\f');
    await expect(page.locator('[data-split-num="110"]')).toHaveAttribute('data-pending', '');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('滾輪在左欄上 ⇒ 捲左欄，文章不翻頁、不送鍵', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 560 });
    await bootOffline(page, ptt, { splitReader: true });
    await ptt.applyPrefs(page, { enableEasyReadingList: false, useMouseBrowsing: true });
    await page.evaluate(() => window.__app.setInputAreaFocus());
    await openFromList(page, 0);
    await expect(pane(page)).toBeVisible();
    const list = page.locator('[data-split-list]');
    // 前提：二十篇放不下 560px 高的左欄，真的有東西可捲。
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await startCapture(page);
    const box = await waitRectStable(page, '[data-split-list]');
    await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await takeCapture(page)).toBe('');
  });

  test('收起 ⇒ 只剩左緣的把手；按把手 ⇒ 展開', async ({ page }) => {
    await boot(page, WIDE);
    await openFromList(page, 2);
    await page.locator('[data-split-collapse]').click();
    await expect(page.locator('[data-split-list]')).toHaveCount(0);
    await expect(page.locator('[data-split-expand]')).toBeVisible();
    await page.locator('[data-split-expand]').click();
    await expect(page.locator('[data-split-list]')).toBeVisible();
    await expect(page.locator('#t')).toBeFocused();
  });

  test('視窗不夠寬 ⇒ 不出現', async ({ page }) => {
    await boot(page, NARROW);
    await openFromList(page, 2);
    expect(await page.evaluate(() => window.__app.view._articleBoard)).toBe('Test');
    expect(await page.evaluate(() => window.__app.splitReader.state.visible)).toBe(false);
    await expect(pane(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ 不出現', async ({ page }) => {
    await boot(page, WIDE, { enableSplitReading: false });
    await openFromList(page, 2);
    expect(await page.evaluate(() => window.__app.view._articleBoard)).toBe('Test');
    await expect(pane(page)).toHaveCount(0);
  });
});
