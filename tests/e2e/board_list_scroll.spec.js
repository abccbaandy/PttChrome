const { test, expect } = require('./helpers/fixtures');
const { readScreen, sendKey, applyPrefs, resetSession } = require('./helpers/ptt');

// 看板列表平滑捲動（pref enableBoardListSmoothScroll）連真 PTT 的煙霧測試。
//
// unit 已經把純邏輯全部蓋掉（指紋／reducer／鍵盤白名單／抓頁與探邊／累積／render
// 合約，見 docs/board-list-smooth-scroll.md §6）。這一支只驗 unit 抓不到的那一類：
// **真瀏覽器 + 真 WebSocket + 完整 boot 鏈**下不會一進去就炸，捲動視口真的建得起來、
// 真的捲得動，交易真的收得回去。
//
// **全部走共用登入 session**（helpers/fixtures.js）——整輪只登入一次，這裡不 goto、
// 不 login（守護 tests/unit/e2e_login_budget.test.js）。
//
// guest 沒有我的最愛（board.c:1665 的 `if (!cuser.userlevel) LIST_BRD();`），按 F 會
// 落到「全部看板」＝本期不 engage 的變體 ⇒ 那種情況直接 skip，不是失敗。

// 進到「我的最愛」並等平滑捲動接管。回 null ＝這個帳號的畫面不在本期範圍（guest）。
async function enterFavorites(page) {
  // 主功能表：字母鍵只是把游標移到那一項，**還要按 Enter 才會進去**
  //（menu.c 的 hotkey 語意，先例見 search_prompt.spec.js）。
  await sendKey(page, 'F');
  await page.waitForTimeout(400);
  await sendKey(page, 'Enter');
  // 判準直接問**產品自己**（classifyBoardListScreen），不要在測試裡複製一份指紋：
  // 複製品與本尊漂移時，紅的會是一條看不出真正原因的 timeout。
  const engaged = await page
    .waitForFunction(
      () => window.__app && window.__app.buf.listRenderOwner === 'board-list',
      null,
      { timeout: 12000 }
    )
    .then(() => true)
    .catch(() => false);
  const screen = await readScreen(page);
  if (!engaged) {
    // 沒接管的原因只有兩種：不是看板列表（F 沒進去），或是本期不 engage 的變體
    // （guest 的「全部看板」）。兩者都不是失敗，但要把畫面印出來才分得出來。
    const rows = screen.split('\n');
    console.log(
      'NOT ENGAGED:',
      JSON.stringify([rows[0], rows[2], rows[rows.length - 1]])
    );
    return null;
  }
  return screen;
}

// 背景填充跑完（佇列空了）。導覽類斷言一定要等這個：抓頁在飛時 _requestEnd/
// _requestHome 會靜默 early-return（`if (!this._queue.idle) return;`），
// 測試就會在「什麼都沒發生」上綠掉（2026-09-03 實測：End 按了選取沒動）。
async function waitFillDone(page) {
  await page.waitForFunction(() => window.__app.commandQueue.idle, null, {
    timeout: 20000,
  });
}

const viewportState = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const view = document.querySelector('#mainContainer .listBodyView');
    const container = document.querySelector('#mainContainer');
    const outer = container ? Array.from(container.children) : [];
    return {
      owner: app.buf.listRenderOwner,
      mode: app.buf.listRenderMode,
      state: app.boardListSession.state,
      hasView: !!view,
      // header 3 列 + 視口 + footer ＝ 容器的 5 個直系子節點
      outerCount: outer.length,
      viewIndex: view ? outer.indexOf(view) : -1,
      bodyRows: view ? view.children.length : 0,
      scrollTop: view ? view.scrollTop : -1,
      scrollHeight: view ? view.scrollHeight : -1,
      clientHeight: view ? view.clientHeight : -1,
      buffered: (app.buf.brdListLineNums || []).length,
      maxNum: (app.buf.brdListLineNums || []).slice(-1)[0],
      edgeUp: app.boardListSession._edgeUp,
      edgeDown: app.boardListSession._edgeDown,
      selected: app.boardListSession._selectedNum,
    };
  });

test.describe.serial('看板列表平滑捲動（共用 session）', () => {
  test('我的最愛：接管畫面、body 住進捲動視口、header/footer 不跟著捲', async ({
    shared,
  }) => {
    const { page, logs } = shared;
    logs.length = 0;
    await resetSession(page);
    await applyPrefs(page, { enableBoardListSmoothScroll: true });

    const screen = await enterFavorites(page);
    test.skip(!screen, 'guest／此帳號按 F 不是「我的最愛」（本期不 engage）');

    await waitFillDone(page);
    const st = await viewportState(page);
    console.log('BRD LIST:', JSON.stringify(st));
    expect(st.mode).toBe('buffer');
    expect(st.state).toBe('active');
    expect(st.hasView).toBe(true);
    // header 3 列 + 視口 + footer
    expect(st.outerCount).toBe(5);
    expect(st.viewIndex).toBe(3);
    // 視口高度 ＝ 原生 body 的 20 列（版面總高不變）
    expect(st.clientHeight).toBeGreaterThan(0);
    // 緩衝至少有落地那一頁
    expect(st.buffered).toBeGreaterThan(0);
    expect(st.selected).not.toBeNull();

    await sendKey(page, 'ArrowLeft'); // 收尾：回主選單
    await page.waitForTimeout(1200);
  });

  test('背景補頁後捲得動：捲動只移動 body，header 原地不動', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    await resetSession(page);
    await applyPrefs(page, { enableBoardListSmoothScroll: true });

    const screen = await enterFavorites(page);
    test.skip(!screen, 'guest／此帳號按 F 不是「我的最愛」（本期不 engage）');

    await waitFillDone(page);
    // 背景抓頁把緩衝補到比視口高（只有一頁的最愛本來就捲不動 ⇒ skip）。
    const grew = await page
      .waitForFunction(
        () => {
          const v = document.querySelector('#mainContainer .listBodyView');
          return !!v && v.scrollHeight > v.clientHeight + 1;
        },
        null,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    const before = await viewportState(page);
    console.log('BEFORE SCROLL:', JSON.stringify(before));
    test.skip(!grew, '這個帳號的最愛不足一個視口高，沒有可捲距離');

    const headerTopBefore = await page.evaluate(
      () =>
        document
          .querySelector('#mainContainer')
          .children[0].getBoundingClientRect().top
    );
    const firstBodyTopBefore = await page.evaluate(
      () =>
        document
          .querySelector('#mainContainer .listBodyView')
          .children[0].getBoundingClientRect().top
    );

    await page.evaluate(() => {
      document.querySelector('#mainContainer .listBodyView').scrollTop = 200;
    });
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => {
      const c = document.querySelector('#mainContainer');
      const v = c.querySelector('.listBodyView');
      return {
        scrollTop: v.scrollTop,
        headerTop: c.children[0].getBoundingClientRect().top,
        firstBodyTop: v.children[0].getBoundingClientRect().top,
      };
    });
    console.log('AFTER SCROLL:', JSON.stringify(after));
    expect(after.scrollTop).toBeGreaterThan(0);
    // header 不在捲動容器裡 ⇒ 一像素都不該動
    expect(Math.abs(after.headerTop - headerTopBefore)).toBeLessThan(1);
    // body 第一列被捲上去了
    expect(firstBodyTopBefore - after.firstBodyTop).toBeGreaterThan(50);

    await sendKey(page, 'ArrowLeft');
    await page.waitForTimeout(1200);
  });

  test('End/Home 交易：抓到板尾與板頭，畫面不卡在 frozen', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    await resetSession(page);
    await applyPrefs(page, { enableBoardListSmoothScroll: true });

    const screen = await enterFavorites(page);
    test.skip(!screen, 'guest／此帳號按 F 不是「我的最愛」（本期不 engage）');

    await waitFillDone(page);
    const seeded = await viewportState(page);
    console.log('SEEDED:', JSON.stringify(seeded));

    // End：緩衝已含板尾就純本地跳，否則走 `99999999\r` 交易
    //（search_num 把超過 brdnum 的輸入夾到最後一項）。
    await sendKey(page, 'End');
    await waitFillDone(page);
    const atEnd = await viewportState(page);
    console.log('AFTER End:', JSON.stringify(atEnd));
    expect(atEnd.mode).toBe('buffer'); // 沒有卡在 frozen
    expect(atEnd.state).toBe('active');
    expect(atEnd.selected).toBe(atEnd.maxNum); // 真的跳到最後一項

    await sendKey(page, 'Home');
    await waitFillDone(page);
    const atHome = await viewportState(page);
    console.log('AFTER Home:', JSON.stringify(atHome));
    expect(atHome.mode).toBe('buffer');
    expect(atHome.selected).toBe(1);

    await sendKey(page, 'ArrowLeft');
    await page.waitForTimeout(1200);
  });

  test('← 回上層：交易收攤、畫面所有權釋放回原生', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    await resetSession(page);
    await applyPrefs(page, { enableBoardListSmoothScroll: true });

    const screen = await enterFavorites(page);
    test.skip(!screen, 'guest／此帳號按 F 不是「我的最愛」（本期不 engage）');

    await sendKey(page, 'ArrowLeft');
    await page.waitForFunction(
      () =>
        window.__app.buf.listRenderOwner === null &&
        window.__app.boardListSession.state === 'idle',
      null,
      { timeout: 10000 }
    );
    const back = await readScreen(page);
    console.log('AFTER LEAVE:', back.split('\n')[0]);
    expect(back).toContain('主功能表');
    // 視口節點也要跟著從畫面上收掉（原生 24 列沒有捲動容器）
    const hasView = await page.evaluate(
      () => !!document.querySelector('#mainContainer .listBodyView')
    );
    expect(hasView).toBe(false);
  });

  test('B 類鍵（/ 中文關鍵字）：一鍵切原生鏡像，取消後自動回平滑捲動', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    await resetSession(page);
    await applyPrefs(page, { enableBoardListSmoothScroll: true });

    const screen = await enterFavorites(page);
    test.skip(!screen, 'guest／此帳號按 F 不是「我的最愛」（本期不 engage）');

    // `/` 在看板列表是 `getdata_buf` 的中文關鍵字搜尋（board.c:1843）——會開
    // prompt、會換掉整份清單 ⇒ B 類。白名單以外的 B 類鍵一律「同步游標 → 切原生
    // 鏡像 → 代送」，畫面必須真的變成原生，否則 PTT 開的 prompt 會被緩衝視窗蓋住
    // （使用者讀成「畫面卡住」）。
    // **`v`/`V` 不能拿來測這件事**：board.c 的 v/V 是 `brc_toggle_all_read` +
    // `show_brdlist` 原地重畫，**沒有 prompt**（那是 read.c 的 v 才有），
    // 2026-09-03 起歸 A 類凍結交易，全程不切原生。
    await sendKey(page, '/');
    await page.waitForFunction(
      () =>
        window.__app.buf.listRenderOwner === null &&
        window.__app.boardListSession.state === 'functionMode',
      null,
      { timeout: 10000 }
    );
    const st = await viewportState(page);
    console.log('AFTER /:', JSON.stringify(st));
    expect(st.hasView).toBe(false); // 原生 24 列，沒有捲動視口

    // **等 prompt 真的畫出來再送 Enter**（綁內容條件，不可用固定 timeout）：
    // 切原生是同步發生的（`_enterNative()`），但代送的 `/` 還排在佇列上；這時
    // 使用者的鍵已經走原生路徑直送 PTT，先按 Enter 會撞上 typeahead（協定 §2）
    // ——實測會變成「Enter 開了游標所在的看板」，測到的東西整個跑掉。
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).some((el) => (el.textContent || '').includes('看板中文關鍵字')),
      null,
      { timeout: 10000 }
    );

    // 空關鍵字 Enter＝取消（keyword[0]=0 → brdnum=-1 → 重畫原清單）。
    // 操作完成、畫面靜下來 ⇒ 靜置探針自動重新 engage（2026-09-03）。
    // prompt 期間**不得**自動回復：游標停在提示字後面（curX 大）⇒
    // classifyBoardListScreen 的 `parked` 不成立 ⇒ engageable=false ⇒ ctx 不是
    // 'brdlist'（與文章列表的不變量 N9 同一道承重牆）。
    await sendKey(page, 'Enter');
    await page.waitForFunction(
      () =>
        window.__app.boardListSession.state === 'active' &&
        !!document.querySelector('#mainContainer .listBodyView'),
      null,
      { timeout: 15000 }
    );
    await resetSession(page);
  });
});
