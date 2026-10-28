// 編輯器輸入框（P27）手機版：底部導覽第一格「輸入框」→ bottom sheet → 打字 → 插入。
// 編輯器畫面同桌機那支（upstream pttbbs 產的 editor.json）。真觸控 tap、真鍵盤。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const screens = require('../../unit/fixtures/ptt_src_screens/editor.json');
// 場景在編輯器之後還有 ^X「檔案處理」那一幀：只餵到編輯器畫面為止。
const EDITOR_FRAMES = screens.frames.slice(0, screens.frames.findIndex((f) => f.name === 'edit') + 1);

test.describe('編輯器輸入框（手機，離線）', () => {
  test('工具列「輸入框」→ sheet 打字 → 插入 ⇒ 整段送進編輯器', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    for (const f of EDITOR_FRAMES) await feedRaw(page, f.bytes);
    await page.waitForFunction(() => window.__app.buf.pageState === 6);
    const btn = page.locator('[data-key="__editorInput"]');
    await expect(btn).toBeVisible();
    // 桌機的浮動鈕在手機不出現（入口在工具列）
    await expect(page.locator('#editorInputChip')).toHaveCount(0);

    await startCapture(page);
    await btn.tap();
    const box = page.locator('.mobileSheet textarea[name="editorInputText"]');
    await expect(box).toBeVisible();
    await box.tap();
    await page.keyboard.type('abc');
    expect(await peekCapture(page)).toBe('');
    const label = await page.evaluate(() => window.__i18n('editorInput_insert'));
    await page.locator('.mobileSheet').getByRole('button', { name: label }).tap();
    await expect.poll(() => peekCapture(page)).toContain('abc');
    expect(await takeCapture(page)).toBe('abc');
    await expect(box).toHaveCount(0);
  });
});
