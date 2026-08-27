// 跨行推文 AID 接合 —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
//
// 回歸來源（使用者 2026-08-27 的除錯錄製檔 ptt-debug-20260828-002500）：ask 板
// M.1787109393 第 2 頁的末兩則同作者推文
//   推 abccbaandy: 我仿照這樣式實作了一版，有興趣可到  #1gU3wwNZ      08/26 22:17
//   →  abccbaandy: (Browsers) 體驗(懷舊?)                             08/26 22:17
// AID 打在一則的結尾、看板打在下一則的開頭。修好之前 aid_parse.parseBoardSuffix 一
// 撞到合併塊的 '\n' cell 就放棄 ⇒ board 為 null ⇒ 退回「目前文章所在看板」，錄製檔
// 把後果整段錄下來了：送出 `sask` 跳到 ask 板 → `#1gU3wwNZ` 搜不到 → queue.miss。
//
// 為什麼要 e2e 而不只是 unit：判準橫跨三層 —— term_buf 造出的真 TermChar（含 Big5
// 雙位元組與 partOfURL 旗標）、comment_merge 對真實推文列切出的內容邊界、
// screen_annotations→LinkSegmentBuilder 的渲染接線。unit 只能用假 cell 逐層驗，
// 這裡跑的是真的 parser→termBuf→render 鏈。
//
// 素材：tests/e2e/cassettes/ask-aid-wrap.json，刻意保留 meta.mode='debug-derived'
// ⇒ findCassettes('article') 不會撿到它（不影響任何逐卷 spec），只由本檔指名載入。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  loadCassette,
  bootOffline,
  replayCassette,
} = require('../helpers/replay');

const CASSETTE = 'ask-aid-wrap';
const AID = '1gU3wwNZ';
const BOARD = 'Browsers';

let cassette = null;
try {
  cassette = loadCassette(CASSETTE);
} catch (e) {
  cassette = null;
}

test.describe('跨行 AID 接合（離線重放）', () => {
  test.skip(!cassette, `缺 cassette ${CASSETTE}.json`);

  test('看板後綴被切到下一則推文，AID 連結仍帶對的看板', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    // 不顯式傳 mergeSameAuthorComments —— 跨行接合的前提是「預設即開」。
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: true });

    // 正對照 1：那兩則真的被合併了（沒合併就沒有換行邊界，整個測試失去意義）。
    await expect(page.locator('.mergedCommentBlock')).not.toHaveCount(0);

    // 正對照 2：AID 偵測本身有跑起來（否則「board 對」可能只是零筆的假綠）。
    const links = page.locator(`a.aidLink[data-aid="${AID}"]`);
    await expect(links).toHaveCount(1);

    // 本體斷言：看板來自**下一則**推文開頭的 "(Browsers)"。
    await expect(links.first()).toHaveAttribute('data-board', BOARD);
    // 連結範圍只包 #AID 自己，看板後綴不進 <a>。
    await expect(links.first()).toHaveText('#' + AID);
    // 它確實長在合併塊裡（逐列路徑看不到下一則，不可能得到這個看板）。
    expect(
      await links.first().evaluate((el) => !!el.closest('.mergedCommentBlock')),
    ).toBe(true);
  });

  test('點下去送出的是 (Browsers) 的跳板指令，不是目前看板', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: true });

    const before = await page.evaluate(() => window.__replay.sent.length);
    await page.locator(`a.aidLink[data-aid="${AID}"]`).first().click();
    // aid_navigation 先送「跳看板」（s + 板名 + CR + FF），這正是錄製檔裡送成
    // "sask" 的那一步。stub WS 吞掉送出的 bytes，只記帳。
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.__replay.sent)).slice(before).join(''),
        { timeout: 15000 },
      )
      .toContain('s' + BOARD);

    const sent = (await page.evaluate(() => window.__replay.sent))
      .slice(before)
      .join('');
    expect(sent).not.toContain('sask');
  });
});
