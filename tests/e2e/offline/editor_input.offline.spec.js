// 編輯器輸入框（P27，js/editor_input.js、docs/editor-input.md）—— 真瀏覽器、真滑鼠、真鍵盤。
// 編輯器畫面取自 upstream pttbbs 原始碼實際產生的畫面（tests/unit/fixtures/ptt_src_screens/
// editor.json，tools/ptt-src-screens 的 `editor` 場景：看板列表按 E 進編輯器）。
// unit（editor_input.test.js）釘死出現條件、濾字、不在編輯器不送；這裡守 unit 碰不到的：
//   - 編輯器畫面右下角真的出現「輸入框」鈕，真滑鼠點開 ⇒ 對話框收鍵盤（打字不漏給 PTT）
//   - 打一段（含換行）按「插入」⇒ 整段走貼上漏斗送出（換行＝Enter），框收起
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const screens = require('../../unit/fixtures/ptt_src_screens/editor.json');
// 場景在編輯器之後還有 ^X「檔案處理」那一幀：只餵到編輯器畫面為止。
const EDITOR_FRAMES = screens.frames.slice(0, screens.frames.findIndex((f) => f.name === 'edit') + 1);

const CHIP = '#editorInputChip';

async function enterEditor(page) {
  for (const f of EDITOR_FRAMES) await feedRaw(page, f.bytes);
  await page.waitForFunction(() => window.__app.buf.pageState === 6);
}

test.describe('編輯器輸入框（離線）', () => {
  test('編輯器：右下角「輸入框」→ 打字（不漏給 PTT）→ 插入 ⇒ 整段送進編輯器', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await expect(page.locator(CHIP)).toHaveCount(0);
    await enterEditor(page);
    await expect(page.locator(CHIP)).toBeVisible();

    await startCapture(page);
    const r = await waitRectStable(page, CHIP);
    await page.mouse.click(r.left + r.width / 2, r.top + r.height / 2);
    const box = page.locator('textarea[name="editorInputText"]');
    await expect(box).toBeVisible();
    await expect(box).toBeFocused();
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('world');
    // 打字只進文字框：對話框開著時終端機不收鍵盤（modalShown）
    expect(await peekCapture(page)).toBe('');
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    const insert = page.getByRole('button', { name: await page.evaluate(() => window.__i18n('editorInput_insert')) });
    const b = await insert.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect.poll(() => peekCapture(page)).toContain('world');
    expect(await takeCapture(page)).toBe('hello\rworld');
    await expect(box).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);
  });

  test('功能開關關掉 ⇒ 編輯器畫面也沒有鈕', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEditorInput: false });
    await enterEditor(page);
    // 柵欄：同一幀的其他浮層判斷都已跑過（screenSettled）再判「沒有」
    await page.waitForFunction(() => !window.__app.buf.timerUpdate && !window.__app.buf._settleTimer);
    await expect(page.locator(CHIP)).toHaveCount(0);
  });
});
