// 好讀「左圖右文」裝置端 AI 校正 —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
// 素材 cchat-caption-mosquito.json：翻譯被空行切成 3~4 段的翻譯漫畫文，純規則
// 只把「第一段」搬進右欄（本功能的回歸來源）。
// 這裡把 window.LanguageModel 換成 stub（回答「保留全部候選段」），驗的是**接線**：
//   1) 設定啟用 + 有 Prompt API → 第二顆浮動按鈕出現（與原本那顆分開）。
//   2) 點它 → 自動開啟合併，右欄列數比純規則明顯變多，且內容零遺失。
//   3) 再點一次 → 回到純規則結果（可逆）。
//   4) 沒有 Prompt API（其他瀏覽器）→ 按鈕不出現、畫面與現況完全相同。
// 模型真實能力不在 CI 量（中文不在 Prompt API 官方支援語言內），見
// tools/caption-ai-eval.html。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');

const cassette = loadCassette('cchat-caption-mosquito');

// 回答「保留全部候選段」：prompt 尾巴帶著 {"keep": <integer 0-N>}，取那個 N。
const STUB_LM = () => {
  const session = {
    prompt: (text) => {
      const m = /integer 0-(\d+)/.exec(text);
      window.__lmPrompts = (window.__lmPrompts || 0) + 1;
      return Promise.resolve(JSON.stringify({ keep: m ? parseInt(m[1], 10) : 0 }));
    },
    clone: () => Promise.resolve(session),
    destroy: () => {},
  };
  window.LanguageModel = {
    availability: () => Promise.resolve('available'),
    create: () => Promise.resolve(session),
  };
};

const captionRowCount = (page) =>
  page.locator('.mergedCaptionCol [data-type="bbsline"]').count();
const allRowCount = (page) =>
  page.locator('#mainContainer [data-type="bbsline"]').count();

test.describe('好讀圖文合併 × 裝置端 AI（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 cchat-caption-mosquito cassette', () => {});
    return;
  }

  test('AI 按鈕出現 → 右欄擴張 → 再點還原', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(STUB_LM);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableCaptionAi: true,
    });
    await replayCassette(page, cassette, { easyReading: true });

    const mergeBtn = page.locator('#mergeImageCaptionBtn');
    const aiBtn = page.locator('#mergeImageCaptionAiBtn');
    await expect(mergeBtn).toBeVisible();
    await expect(aiBtn).toBeVisible();
    await expect(aiBtn).toHaveAttribute('data-ai', 'off');

    // 純規則的右欄列數（先量基準）。
    const rowsTotal = await allRowCount(page);
    await mergeBtn.click();
    const ruleCaptionRows = await captionRowCount(page);
    expect(ruleCaptionRows).toBeGreaterThan(0);
    await mergeBtn.click(); // captionFirst
    await mergeBtn.click(); // 還原（AI 也一起關，見 Screen）

    // AI 開啟：推論完成後 data-ai 回到 'on'，右欄列數必須比純規則多。
    await aiBtn.click();
    await expect(aiBtn).toHaveAttribute('data-ai', 'on', { timeout: 15000 });
    await expect
      .poll(() => captionRowCount(page), { timeout: 15000 })
      .toBeGreaterThan(ruleCaptionRows);
    // 真的有問到模型。
    expect(await page.evaluate(() => window.__lmPrompts || 0)).toBeGreaterThan(0);
    // 內容零遺失：總列數不變（只是搬進右欄）。
    expect(await allRowCount(page)).toBe(rowsTotal);

    // 再點一次關掉 AI → 回到純規則結果（合併仍開著）。
    await aiBtn.click();
    await expect(aiBtn).toHaveAttribute('data-ai', 'off');
    expect(await captionRowCount(page)).toBe(ruleCaptionRows);
    expect(await allRowCount(page)).toBe(rowsTotal);
  });

  // 注意：Playwright 的 Chromium **有** window.LanguageModel 這個 global，但沒有
  // 模型元件（availability() 回 'unavailable'）。所以「不支援」要用刪掉 global 來
  // 模擬 Firefox/Safari；另一種情況（有 API 沒模型）由 availability 探測擋掉，
  // 守護在 tests/unit/merge_image_caption_ai_render.test.jsx。
  test('沒有 Prompt API → AI 按鈕不出現，畫面與純規則完全相同', async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => {
      delete window.LanguageModel;
    });
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      enableCaptionAi: true,
    });
    await replayCassette(page, cassette, { easyReading: true });

    await expect(page.locator('#mergeImageCaptionBtn')).toBeVisible();
    await expect(page.locator('#mergeImageCaptionAiBtn')).toHaveCount(0);
    await page.locator('#mergeImageCaptionBtn').click();
    await expect(page.locator('.mergedImageBlock').first()).toBeVisible();
  });
});
