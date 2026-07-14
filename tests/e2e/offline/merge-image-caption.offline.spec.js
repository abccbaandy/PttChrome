// 好讀「圖左字右合併」（翻譯漫畫文）—— 離線重放守門。
// 素材 cchat-caption.json 轉自使用者 debug 錄製檔（#1gKHF5hU C_Chat 翻譯文，
// 結構：圖片連結 → 自動開圖 → 多行翻譯 → 下一張圖…；隱私掃描見 meta.source）。
// meta.mode 是專用的 'article-caption'：泛用 easy-reading.offline.spec 的 golden
// 斷言（commentCount/firstCommentAuthor）此卷沒有，不讓它被撿走。
// 守門行為：
//   1) 好讀進文章、偵測到 ≥2 個「圖＋翻譯」塊 → 浮動「圖文並排」按鈕出現。
//   2) 點擊 → 出現 .mergedImageBlock 兩欄 wrapper；翻譯行搬進 .mergedCaptionCol
//      （sticky 欄），且 data-row 保留（選取複製依據）。
//   3) 再點一次 → 切「上文下圖」配對（wrapper 仍在，此卷屬上圖下文素材、
//      captionFirst 至少把前導文配進首圖）；第三次點 → wrapper 全部消失、
//      版面還原（session-only、可逆、零內容遺失）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');

const cassette = findCassettes('article-caption')[0];

test.describe('好讀圖文合併（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 article-caption cassette（tests/e2e/cassettes/cchat-caption.json）', () => {});
  } else {
    test(`按鈕出現 → 合併兩欄 → 還原 [${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, cassette, { easyReading: true });

      // 1) 偵測到圖文結構 → 浮動按鈕出現，且尚未合併。
      const btn = page.locator('#mergeImageCaptionBtn');
      await expect(btn).toBeVisible();
      await expect(page.locator('.mergedImageBlock')).toHaveCount(0);

      // 2) 點擊合併：兩欄 wrapper 出現、右欄有翻譯列（帶 data-row 的 bbsline）。
      await btn.click();
      const blocks = page.locator('.mergedImageBlock');
      const blockCount = await blocks.count();
      expect(blockCount).toBeGreaterThanOrEqual(2);
      const captionRows = page.locator('.mergedCaptionCol [data-type="bbsline"]');
      expect(await captionRows.count()).toBeGreaterThan(0);
      // data-row 保留絕對 index（不是 re-pack 的 0..n）：右欄第一列的 data-row
      // 必須大於其所屬圖行（圖行在前）。
      const firstBlock = blocks.first();
      const imgRow = await firstBlock
        .locator('.mergedImageCol [data-type="bbsline"]')
        .first()
        .getAttribute('data-row');
      const capRow = await firstBlock
        .locator('.mergedCaptionCol [data-type="bbsline"]')
        .first()
        .getAttribute('data-row');
      expect(parseInt(capRow, 10)).toBeGreaterThan(parseInt(imgRow, 10));
      // 左欄 inline 圖以欄寬為上限（regression：.easyReadingImg 的 max-width:39em
      // 是絕對值，左欄較窄時圖片溢出壓到右欄文字，要點放大/縮小才恢復）。
      const mergedImgs = page.locator('.mergedImageCol .easyReadingImg');
      if ((await mergedImgs.count()) > 0) {
        const maxWidth = await mergedImgs
          .first()
          .evaluate((el) => getComputedStyle(el).maxWidth);
        expect(maxWidth).toBe('100%');
      }
      // 合併不遺失內容：右欄翻譯列有非空文字。
      const capText = await captionRows.first().textContent();
      expect((capText || '').trim().length).toBeGreaterThan(0);

      // 3) 再點一次 → 切「上文下圖」配對：仍是合併狀態（wrapper 存在），且右欄
      //    第一列的 data-row 小於所屬圖行（文字在圖之前）。
      const rowsBefore = await page
        .locator('#mainContainer [data-type="bbsline"]')
        .count();
      await btn.click();
      expect(await blocks.count()).toBeGreaterThanOrEqual(1);
      const cfBlock = blocks.first();
      const cfImgRow = await cfBlock
        .locator('.mergedImageCol [data-type="bbsline"]')
        .first()
        .getAttribute('data-row');
      const cfCapRow = await cfBlock
        .locator('.mergedCaptionCol [data-type="bbsline"]')
        .first()
        .getAttribute('data-row');
      expect(parseInt(cfCapRow, 10)).toBeLessThan(parseInt(cfImgRow, 10));

      // 4) 第三次點 → 還原（wrapper 全消失，翻譯列回頂層）。
      await btn.click();
      await expect(page.locator('.mergedImageBlock')).toHaveCount(0);
      const rowsAfter = await page
        .locator('#mainContainer [data-type="bbsline"]')
        .count();
      expect(rowsAfter).toBe(rowsBefore); // 可逆、零內容遺失
    });
  }
});
