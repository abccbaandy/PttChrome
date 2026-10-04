// 看板列表（choose_board）—— 重放真 PTT 錄的往返（分類看板子清單，guest 也錄得到）。
//
//   1. 平滑捲動（pref enableBoardListSmoothScroll）：engage → body 住進捲動視口、header 不跟著捲
//      → End／Home 交易 → B 類鍵 `/` 切原生鏡像、取消後自動回來（← 離開見測試內註解）。
//      unit 蓋掉純邏輯（docs/board-list-smooth-scroll.md §6）；這裡驗真瀏覽器＋完整 boot 鏈下
//      捲動視口真的建得起來、交易真的收得回去。
//   2. 按 s 的「搜尋看板」prompt：不破字、整頁不上底色、殘留列表不可點。修法的判準是
//      「游標格是 fg=0/bg=7」，而那是 pfterm 實際吐的 bytes（不是 vtuikit.c 的 ESC[0;7m）——
//      2026-10 前只有 live 量得到，現在素材把那幾個 bytes 固定下來。
// 素材：tests/e2e/cassettes/scn-boardlist-class.json、scn-board-search-prompt.json
// （yarn record:scenarios）。純邏輯另有 unit：board_list_* / cursor_highlight /
// mouse_regions / term_buf_input_field / highlight_col_dbcs。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootScenario, waitFed } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const smooth = loadCassette('scn-boardlist-class');
const prompt = loadCassette('scn-board-search-prompt');

const viewportState = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const view = document.querySelector('#mainContainer .listBodyView');
    const container = document.querySelector('#mainContainer');
    const outer = container ? Array.from(container.children) : [];
    const nums = app.buf.brdListLineNums || [];
    return {
      owner: app.buf.listRenderOwner,
      mode: app.buf.listRenderMode,
      state: app.boardListSession.state,
      hasView: !!view,
      outerCount: outer.length,
      viewIndex: view ? outer.indexOf(view) : -1,
      clientHeight: view ? view.clientHeight : -1,
      scrollHeight: view ? view.scrollHeight : -1,
      buffered: nums.length,
      maxNum: nums.slice(-1)[0],
      selected: app.boardListSession._selectedNum,
      queueIdle: app.commandQueue.idle,
    };
  });

// 素材裡第一個 on===kind 的 step index（＋1 ＝餵完它之後的 fed 值）。
const fedAfter = (cassette, kind) => cassette.steps.findIndex((s) => s.on === kind) + 1;

const settledActive = (page) =>
  page.waitForFunction(() => {
    const app = window.__app;
    return (
      app.boardListSession.state === 'active' &&
      app.buf.listRenderMode === 'buffer' &&
      app.commandQueue.idle &&
      !app.buf.timerUpdate &&
      !app.buf._settleTimer
    );
  });

test.describe('看板列表平滑捲動（scenario 重放）', () => {
  test('engage → 捲動 → End/Home → `/` 原生鏡像來回', async ({ page }) => {
    test.skip(!smooth, '缺 scn-boardlist-class（yarn record:scenarios）');
    await bootScenario(page, ptt, smooth);
    await ptt.applyPrefs(page, { enableBoardListSmoothScroll: true });
    await settledActive(page);

    // 接管畫面：header 3 列 + 視口 + footer ＝ 容器的 5 個直系子節點，視口在第 4 個。
    const st = await viewportState(page);
    expect(st.owner).toBe('board-list');
    expect(st.hasView).toBe(true);
    expect(st.outerCount).toBe(5);
    expect(st.viewIndex).toBe(3);
    expect(st.clientHeight).toBeGreaterThan(0);
    expect(st.buffered).toBeGreaterThan(0);
    expect(st.selected).not.toBeNull();
    expect(st.scrollHeight).toBeGreaterThan(st.clientHeight + 1); // 素材挑的是超過兩個視口的清單

    // 捲動只移動 body，header 原地不動（直接驅動視口；真滾輪另有列表好讀的 smoke）。
    const geo = () =>
      page.evaluate(() => {
        const c = document.querySelector('#mainContainer');
        const v = c.querySelector('.listBodyView');
        return {
          scrollTop: v.scrollTop,
          headerTop: c.children[0].getBoundingClientRect().top,
          firstBodyTop: v.children[0].getBoundingClientRect().top,
        };
      });
    // engage 時視口會捲到游標（可能已在底）⇒ 先捲到頂當基準，再捲到底。
    const scrollTo = (y) =>
      page.evaluate((v) => {
        document.querySelector('#mainContainer .listBodyView').scrollTop = v;
      }, y);
    await scrollTo(0);
    await expect.poll(async () => (await geo()).scrollTop).toBe(0);
    const g0 = await geo();
    await scrollTo(1e6);
    await expect.poll(async () => (await geo()).scrollTop).toBeGreaterThan(0);
    const g1 = await geo();
    expect(Math.abs(g1.headerTop - g0.headerTop)).toBeLessThan(1);
    // body 恰好位移捲動量（整段序列都在視口裡，header 不在）。
    expect(Math.abs(g0.firstBodyTop - g1.firstBodyTop - g1.scrollTop)).toBeLessThan(1);

    // End／Home：抓到板尾與板頭，畫面不卡在 frozen。
    await ptt.sendKey(page, 'End');
    await waitFed(page, fedAfter(smooth, 'end'));
    await settledActive(page);
    const atEnd = await viewportState(page);
    expect(atEnd.selected).toBe(atEnd.maxNum);
    await ptt.sendKey(page, 'Home');
    await settledActive(page);
    await expect.poll(async () => (await viewportState(page)).selected).toBe(1);

    // B 類鍵 `/`：一鍵切原生鏡像（沒有捲動視口），取消後自動回平滑捲動。
    await ptt.sendKey(page, '/');
    await page.waitForFunction(
      () =>
        window.__app.buf.listRenderOwner === null &&
        window.__app.boardListSession.state === 'functionMode' &&
        window.__app.buf.isCursorOnInputField()
    );
    expect((await viewportState(page)).hasView).toBe(false);
    await ptt.sendKey(page, 'Enter');
    await page.waitForFunction(
      () =>
        window.__app.boardListSession.state === 'active' &&
        !!document.querySelector('#mainContainer .listBodyView')
    );

    // 到此為止。素材之後的「自動回復重新 seed（21→22→1）→ ← 離開」**不重放**：重新 seed
    // 要探幾次邊界取決於靜置探針的計時（live 在 21 的回應之後還探了 22，offline 回應瞬間到、
    // 21 之後就判定 seed 完成），送出序列在 bytes 層級對不上。← 離開的交易收攤由
    // tests/unit/board_list_session.test.js 守。
  });
});

const promptState = (page) =>
  page.evaluate(() => {
    const buf = window.__app.buf;
    return {
      pageState: buf.pageState,
      onInputField: buf.isCursorOnInputField(),
      mouseAction: buf.mouseAction,
      // 整列底色掛在 bbsline 的 bN class 上；部分底色包在 .cursorHighlight wrapper 裡。
      highlightSpans: document.querySelectorAll('.cursorHighlight').length,
      tintedLines: Array.from(document.querySelectorAll('[data-type="bbsline"]')).filter((n) =>
        /\bb\d+\b/.test(n.className)
      ).length,
    };
  });

test('搜尋看板 prompt：不破字、整個畫面不上底色、殘留列表不可點', async ({ page }) => {
  test.skip(!prompt, '缺 scn-board-search-prompt（yarn record:scenarios）');
  await bootScenario(page, ptt, prompt);
  const list = await promptState(page);
  expect(list.pageState).toBe(2);
  expect(list.onInputField).toBe(false);
  // 基準：列表上底色本來就要在，否則下面的斷言全部是假綠。
  expect(list.highlightSpans + list.tintedLines).toBeGreaterThan(0);

  await ptt.sendKey(page, 's');
  await waitFed(page, 2);
  await expect.poll(async () => (await promptState(page)).onInputField).toBe(true);
  const rows = await page.evaluate(() => {
    const b = window.__app.buf;
    return [0, 1].map((r) => b.getRowText(r, 0, b.cols)).join('\n');
  });
  // 「自動搜尋」的「尋」trail byte 落在底色起始欄 30：切段把 lead byte 丟掉就畫成「自動搜M」。
  expect(rows).not.toContain('自動搜M');
  // 底色在 prompt 那一幀 settle 之後才重算（輸入欄是那時才認得出來）⇒ 等終局，不讀單點。
  await expect
    .poll(async () => {
      const s = await promptState(page);
      return s.highlightSpans + s.tintedLines;
    })
    .toBe(0);

  // 殘留在下方的列表列：不上 hover 底色、也不可點（點下去會送 Enter 給輸入框）。
  const box = await waitRectStable(page, '#mainContainer');
  await page.mouse.move(box.left + box.width * 0.6, box.top + box.height * 0.5);
  await expect.poll(async () => (await promptState(page)).mouseAction).toBe('none');
  const hover = await promptState(page);
  expect(hover.highlightSpans + hover.tintedLines).toBe(0);

  // 取消 prompt 後底色要回來（gate 只在輸入框存在時生效）。
  await page.mouse.move(box.left + box.width * 0.6, box.top - 5);
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, prompt.steps.length);
  await expect.poll(async () => (await promptState(page)).onInputField).toBe(false);
  await expect
    .poll(async () => {
      const s = await promptState(page);
      return s.highlightSpans + s.tintedLines;
    })
    .toBeGreaterThan(0);
});
