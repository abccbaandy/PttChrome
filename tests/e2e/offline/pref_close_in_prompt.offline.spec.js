// 好讀模式下「停在 PTT 的 prompt 上」時的兩個回歸（離線重放，真瀏覽器／真渲染）：
//
//   1) 全黑（100% 複現）：好讀讀文章 → X 推文（切原生鏡像）→ 右鍵開設定 → 關設定 →
//      整頁一片黑，只能離開文章再進。根因：關設定走 onPrefSaveImpl →
//      switchToEasyReadingMode(true)，它原本無條件 leaveCurrentPost()（清掉
//      _functionMode）＋清 pageLines；^L 的整頁重繪於是落進好讀文章分支，而 prompt 幀
//      的游標不在 (rows-1, cols-1) ⇒ accumulatePageLines 判 incomplete ⇒ pageLines 維持
//      [] ⇒ 渲染 0 列 ＝ 全黑，且之後每一幀都一樣 ⇒ 永遠回不來。
//
//   2) 推文輸入框不顯示：IME 開著時 keydown 的 e.key 是 'Process'，easy_reading 的
//      `e.key.length === 1` 判斷抓不到 → 沒進原生鏡像；字卻由 input 事件經
//      view.onTextInput 送了出去 ⇒ 看不到輸入框、打字卻有效。
//
// unit 層守護：tests/unit/switch_mode_plan.test.js、tests/unit/easy_reading_text_input.test.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette, feedRaw } = require('../helpers/replay');

// PTT 推文輸入框的畫面特徵（合成，不用真帳號）：底部那一列被換成輸入框、游標停在
// 輸入欄。這兩點就是全黑 bug 的全部前提 ——
//   - 最後一列不再是文章狀態列 ⇒ setPageState 沒有 default 分支 ⇒ pageState 停在 3
//   - 游標不在 (rows-1, cols-1) ⇒ accumulatePageLines 的 P6 complete gate 不成立
const PUSH_PROMPT =
  '\x1b[24;1H\x1b[1;33m\xb1\xc0 \x1b[mtestuser: \x1b[30;47m' +
  ' '.repeat(40) +
  '\x1b[m\x1b[K\x1b[24;16H';

const rowCount = (page) =>
  page.evaluate(
    () => document.querySelectorAll('#mainContainer [data-type="bbsline"]').length
  );
const functionMode = (page) =>
  page.evaluate(() => !!window.__app.buf.easyReadingFunctionMode);
const lastPageBytes = (cassette) =>
  Buffer.from(cassette.steps[cassette.steps.length - 1].recv, 'base64').toString('latin1');

const articles = findCassettes('article');

test.describe('好讀模式停在 prompt 上（離線重放）', () => {
  if (!articles.length) {
    test.skip('尚無 article cassette；先 yarn record:cassette（guest 或帳密）', () => {});
  }

  const cassette = articles[0];
  if (!cassette) return;

  async function openArticleInEasyReading(page) {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: true });
    expect(await rowCount(page)).toBeGreaterThan(0);
  }

  test(`REGRESSION：在推文輸入框上關設定頁，畫面不可變全黑 [${cassette.__file}]`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openArticleInEasyReading(page);

    // X 推文 → 好讀切成原生鏡像（keydown 路徑）
    await ptt.sendKey(page, 'X');
    await feedRaw(page, PUSH_PROMPT);
    await page.waitForTimeout(200);
    expect(await functionMode(page)).toBe(true);
    const mirrored = await rowCount(page);
    expect(mirrored).toBeGreaterThan(0);

    // 關設定頁（PrefModal 的 X／點外／Esc 全部匯流到這裡）
    await page.evaluate(() =>
      window.__app.switchToEasyReadingMode(window.__app.view.useEasyReadingMode)
    );
    // ^L 送出後 PTT 的整頁重繪：文章內容 + 底部仍是推文輸入框（游標停在輸入欄）
    await feedRaw(page, lastPageBytes(cassette));
    await feedRaw(page, PUSH_PROMPT);
    await page.waitForTimeout(300);

    // 修前：pageLines 被清空 + functionMode 被清掉 ⇒ 渲染 0 列 ⇒ 全黑
    expect(await rowCount(page)).toBeGreaterThan(0);
    // 使用者打到一半的推文還在畫面上（繼續鏡像原生，而不是被丟回好讀長頁）
    expect(await functionMode(page)).toBe(true);
    const text = await page.evaluate(() => document.querySelector('#mainContainer').textContent);
    expect(text).toContain('testuser:');
  });

  test(`REGRESSION：IME 路徑送出的 X（不經 keydown）也要切成原生鏡像 [${cassette.__file}]`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await openArticleInEasyReading(page);
    expect(await functionMode(page)).toBe(false);

    // 中文 IME 開著時就是走這條：keydown 的 e.key='Process' 被 easy_reading 略過，
    // 字元由 input 事件 → view.onTextInput 送出。
    await page.evaluate(() => window.__app.view.onTextInput('X'));
    await feedRaw(page, PUSH_PROMPT);
    await page.waitForTimeout(300);

    expect(await functionMode(page)).toBe(true);
    const text = await page.evaluate(() => document.querySelector('#mainContainer').textContent);
    expect(text).toContain('testuser:');
  });
});
