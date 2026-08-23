const { test, expect } = require('./helpers/fixtures');
const { readScreen, sendKey, applyPrefs, resetSession } = require('./helpers/ptt');

// 看板列表按 s 的「搜尋全站看板」畫面（2026-08 使用者回報的兩個症狀）：
//   1. prompt 那一列多出一條游標底色 —— pageState 黏在 2（prompt 只重畫 row 0/1，
//      見 docs/pttbbs-screen-protocol.md §5.1），而 vgetstring 把游標移進 row 1 的
//      反白輸入欄 ⇒「列表有鍵盤游標列」成立。
//   2. 「自動搜尋」被畫成「自動搜M」：底色起始欄 30（LIST_TITLE_COL_START）正好是
//      「尋」的 trail byte，切段把待配對的 lead byte 丟掉。
//
// **這條必須是 live**：修法的判準是「游標所在格是白底黑字」，而畫面不是 mbbsd 直接
// 吐的 ANSI（中間隔 pfterm）—— 第一版照 vtuikit.c 的 ESC[0;7m 去讀 `invert` 旗標，
// unit 全綠、線上完全沒生效（實際送的是 fg=0/bg=7）。只有連真 PTT 量得到這件事。
// 純邏輯層另有 unit 守護：cursor_highlight / mouse_regions / term_buf_input_field /
// highlight_col_dbcs。
const screenState = (page) => page.evaluate(() => {
  const buf = window.__app.buf || window.__app.view.buf;
  return {
    pageState: buf.pageState,
    curX: buf.cur_x,
    curY: buf.cur_y,
    onInputField: buf.isCursorOnInputField(),
    mouseAction: buf.mouseAction,
    // 整列底色掛在 bbsline 的 bN class 上；部分底色包在 .cursorHighlight wrapper 裡。
    highlightSpans: document.querySelectorAll('.cursorHighlight').length,
    tintedLines: Array.from(document.querySelectorAll('[data-type="bbsline"]'))
      .filter((n) => /\bb\d+\b/.test(n.className)).length,
  };
});

test('搜尋看板 prompt：不破字、整個畫面不上底色、殘留列表不可點', async ({ shared }) => {
  const { page, logs } = shared;
  logs.length = 0;
  try {
    await resetSession(page);
    await applyPrefs(page, {
      useMouseBrowsing: true,
      highlightCursor: true,
      keyboardCursorHighlight: true,
      mouseMisclickGuard: true,
      mouseLeftClick: true,
      mouseBrowsingHighlightColor: 1,
      enableEasyReading: false,
    });

    // 主功能表 → (F)avorite 看板列表（show_brdlist 版型，pageState 2）
    await sendKey(page, 'F');
    await page.waitForTimeout(400);
    await sendKey(page, 'Enter');
    await page.waitForTimeout(1800);
    const list = await screenState(page);
    console.log('BOARD LIST:', JSON.stringify(list));
    expect(list.pageState).toBe(2);
    expect(list.onInputField).toBe(false);
    // 基準：列表上底色本來就要在，否則下面的斷言全部是假綠。
    expect(list.highlightSpans + list.tintedLines).toBeGreaterThan(0);

    await sendKey(page, 's');
    await page.waitForTimeout(1500);
    const screen = await readScreen(page);
    console.log('PROMPT ROWS:', screen.split('\n').slice(0, 2).join(' | '));
    const prompt = await screenState(page);
    console.log('PROMPT:', JSON.stringify(prompt));
    expect(screen).toContain('按空白鍵自動搜尋');
    expect(screen).not.toContain('自動搜M'); // 破字回歸鎖
    expect(prompt.onInputField).toBe(true);
    expect(prompt.highlightSpans).toBe(0);
    expect(prompt.tintedLines).toBe(0);

    // 殘留在下方的列表列：不上 hover 底色、也不可點（點下去會送 Enter 給輸入框）。
    const box = await page.locator('#mainContainer').boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.waitForTimeout(400);
    const hover = await screenState(page);
    console.log('HOVER ON RESIDUAL LIST:', JSON.stringify(hover));
    expect(hover.mouseAction).toBe('none');
    expect(hover.highlightSpans + hover.tintedLines).toBe(0);

    // 取消 prompt 後底色要回來（gate 只在輸入框存在時生效）。
    await page.mouse.move(box.x + box.width * 0.6, box.y - 5);
    await sendKey(page, 'Enter');
    await page.waitForTimeout(1500);
    const back = await screenState(page);
    console.log('AFTER CANCEL:', JSON.stringify(back));
    expect(back.onInputField).toBe(false);
    expect(back.highlightSpans + back.tintedLines).toBeGreaterThan(0);
  } catch (e) {
    console.log('CONSOLE:', logs.slice(-30).join('\n'));
    throw e;
  }
});
