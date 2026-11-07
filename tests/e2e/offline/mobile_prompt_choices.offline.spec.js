// P61 手機提問選項（src/js/prompt_choices.js、components/MobileToolbar，docs/mobile.md「提問選項」）：
// PTT 問「選一個」時底部導覽上方浮出可點選項，tap ＝替使用者打那個字＋Enter。
// 畫面是 upstream pttbbs 產的（tests/unit/fixtures/ptt_src_screens/*.json）。真觸控 tap。
//
// unit（prompt_choices.test.js、mobile_toolbar.test.jsx）守認法與送鍵；這裡守 unit 摸不到的：
// 真 CSS 下選項面板不蓋住提問那一列（終端機排在面板上方）、真 tap 送出的 byte、開關關掉不出現。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw, waitScreenSettled } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitRectStable } = require('../helpers/layout');

const fx = (name) => require(`../../unit/fixtures/ptt_src_screens/${name}.json`);

async function feedUntil(page, screens, frameName) {
  const idx = screens.frames.findIndex((f) => f.name === frameName);
  for (const f of screens.frames.slice(0, idx + 1)) await feedRaw(page, f.bytes);
  await waitScreenSettled(page);
}

// 游標那一列（提問）整列在 App Bar 下緣與選項面板上緣之間、看得到。
async function expectPromptRowVisible(page) {
  await waitRectStable(page, '#mobilePromptChoices');
  const r = await page.evaluate(() => {
    const y = window.__app.buf.cur_y;
    const row = document.querySelector(`#mainContainer [data-row="${y}"]`);
    const p = document.getElementById('mobilePromptChoices').getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const bar = document.getElementById('mobileAppBar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    return { rowTop: rr.top, rowBottom: rr.bottom, panelTop: p.top, barBottom };
  });
  expect(r.rowTop).toBeGreaterThanOrEqual(r.barBottom - 0.5);
  expect(r.rowBottom).toBeLessThanOrEqual(r.panelTop + 0.5);
}

const SCENES = [
  { name: '發文種類', screens: 'post_flow', frame: 'post', tap: '3', bytes: '3\r', titleRe: /種類/ },
  { name: '回文對象', screens: 'reply_prompt', frame: 'reply', tap: 'm', bytes: 'm\r', titleRe: /回應至/ },
  { name: '編輯器檔案處理', screens: 'editor', frame: 'save-menu', tap: 'a', bytes: 'a\r', titleRe: /確定要儲存檔案嗎/ },
  // 主功能表卡片版面比視窗高（390px 視窗裡提問列落在折疊線下）：提問列本身不保證看得到，
  // 但選項面板的標題就是提問全文，使用者不用捲也知道在問什麼。
  { name: '離站確認', screens: 'goodbye', frame: 'confirm', tap: 'n', bytes: 'n\r', titleRe: /^您確定要離開【.*】嗎$/, rowHidden: true },
];

test.describe('手機提問選項（離線）', () => {
  for (const s of SCENES) {
    test(`${s.name}：選項浮在工具列上方、不蓋提問；tap 送「字＋Enter」`, async ({ page }) => {
      test.setTimeout(60000);
      await bootOffline(page, ptt);
      await feedUntil(page, fx(s.screens), s.frame);
      const panel = page.locator('#mobilePromptChoices');
      await expect(panel).toBeVisible();
      await expect(panel.locator('.mobilePromptChoicesTitle')).toHaveText(s.titleRe);
      if (!s.rowHidden) await expectPromptRowVisible(page);

      await startCapture(page);
      await panel.locator(`[data-choice="${s.tap}"]`).tap();
      await expect.poll(() => peekCapture(page)).toBe(s.bytes);
      expect(await takeCapture(page)).toBe(s.bytes);
    });
  }

  test('不是選擇題（列表、文章）不出現；開關關掉也不出現', async ({ page }) => {
    test.setTimeout(60000);
    await bootOffline(page, ptt);
    await feedUntil(page, fx('reply_prompt'), 'article');
    await expect(page.locator('#mobileToolbar')).toBeVisible();
    await expect(page.locator('#mobilePromptChoices')).toHaveCount(0);
    await ptt.applyPrefs(page, { mobilePromptChoices: false });
    await feedUntil(page, fx('goodbye'), 'confirm');
    await expect(page.locator('#mobilePromptChoices')).toHaveCount(0);
  });
});
