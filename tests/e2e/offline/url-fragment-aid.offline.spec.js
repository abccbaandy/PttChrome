// 網址 fragment 被誤判成文章代碼(AID) —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
//
// 回歸來源（使用者 2026-08 回報）：
//   https://abccbaandy.github.io/PttChrome/#Browsers/1gU3wwNZ
// 的 "#Browsers" 恰好是合法 AIDc 形狀（'#' 前是非 AID 字元、8 個 AID 字元、第 9 格
// 又是非 AID 字元）→ aid_parse 認走 → LinkSegmentBuilder 在那個 col 切開 segment：
// 網址的 <a> 只到 '#'，中段變成 href="#" 的 .aidLink（滑鼠停在那裡狀態列就顯示
// https://…/PttChrome/#），尾段 /1gU3wwNZ 連 <a> 都不是（底線只畫到 #Browsers）。
// 修法在 src/js/term_url_flag.js：已被 TermBuf.uriRegEx 標成 URL 的格子不產生候選。
//
// 為什麼要 e2e 而不只是 unit：判準的兩端分屬不同層 —— uriRegEx 的 partOfURL 旗標
// （term_buf）與 aid_parse 的欄位掃描 —— unit 只能用假旗標。這裡跑的是真的
// parser→termBuf→<Screen> 鏈，旗標由真正的 uriRegEx 設。
//
// 素材注入手法沿用 url-fix-gray.offline.spec.js（AID 連結只在好讀模式偵測，
// 見 Screen#detectRowExtras 的 `easyReading && onAidClick` gate）：
// 原生重放進文章第一頁 → enterEasyReading() → 一次餵完測試列＋游標 park
// （accumulatePageLines 的完整幀閘門）→ 好讀累積並 render。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  feedRaw,
} = require('../helpers/replay');

const cassette = findCassette('article');

const URL = 'https://abccbaandy.github.io/PttChrome/#Browsers/1gU3wwNZ';
// 2026-08 起分享連結改成檔名形式（#<Board>/M.<v1>.A.<v2>.html）。同一個坑：
// "#Browsers" 依舊是合法 AIDc 形狀，貼進文章裡一樣不可以被切開。
const URL_FN =
  'https://abccbaandy.github.io/PttChrome/#Browsers/M.1786265274.A.5E3.html';
// 正對照：不在網址裡的 #AID 仍要變成 .aidLink（否則「aidLink 為 0」可能只是
// AID 偵測整個沒跑起來的假綠）。
const REAL_AID = '#1gIeu-3A';

async function setupRows(page) {
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForTimeout(200);
  const { rows, cols } = await page.evaluate(() => ({
    rows: window.__app.buf.rows,
    cols: window.__app.buf.cols,
  }));
  const blank = ' '.repeat(cols - 1);
  const at = (r, text) => `\x1b[${r};1H${blank}\x1b[${r};1H${text}`;
  await feedRaw(
    page,
    at(10, 'see ' + URL + ' here') +
      at(11, 'ref ' + REAL_AID + ' there') +
      at(12, 'new ' + URL_FN + ' here') +
      `\x1b[${rows};${cols}H`
  );
  await page.waitForTimeout(800);
}

test.describe('網址 fragment 不被當成 AID（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
    return;
  }

  test('整段網址是單一連結，#Browsers 不變成 aidLink', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);

    // 正對照先驗：AID 偵測確實有在跑。
    const realAid = page.locator('a.aidLink', { hasText: REAL_AID });
    await expect(realAid).toHaveCount(1);

    // 網址的 fragment 不得產生 aidLink。
    await expect(page.locator('a.aidLink', { hasText: '#Browsers' })).toHaveCount(0);

    // 整段網址＝**一個** <a class="y">，href 與可見文字都要完整（文字完整＝底線
    // 畫到尾，那正是使用者看到「底線只到 #Browsers」的那件事）。
    const link = page.locator(`a.y[href="${URL}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText(URL);
  });

  test('新的檔名形式分享連結也是單一完整連結', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: false });
    await setupRows(page);

    await expect(page.locator('a.aidLink', { hasText: REAL_AID })).toHaveCount(1);
    await expect(page.locator('a.aidLink', { hasText: '#Browsers' })).toHaveCount(0);

    const link = page.locator(`a.y[href="${URL_FN}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText(URL_FN);
  });
});
