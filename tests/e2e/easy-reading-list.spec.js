// 文章列表好讀模式 e2e（連真 PTT）。原生視窗仿真（24 行固定、'>' 游標、read.c 語意）：
// 驗證進看板啟用、多頁累積、序號**嚴格遞增**(ascending：舊上新下)、置底文最底、
// 黑名單列被隱藏且視窗補滿、PgUp 游標停新頁頂、demand 續抓、開文(序列化跳號)/返回
// 還原、原生功能(`/`)functionMode 直通，以及 v3 不穩重現法的 soak 自動化。
//
// 斷言讀 v4 狀態機欄位：app.listSession.state（idle/active/functionMode/opening/
// suspended）、buf.listRenderMode（native/buffer/frozen）、listSession._selectedNum。
//
// gotoBoard 靠原生列表表頭判斷進板，而 list 好讀會改寫畫面，故一律「先關著進板 →
// 再用 pref 開啟」（onPrefChange 會 evaluateNow 立即 engage）。帳密走 env
// PTT_USER/PTT_PASS（guest 名額常滿）。
//
// **共用登入 session**（`helpers/fixtures.js` 的 `shared`）：這 9 條以前各自
// `page.goto('/')` + `login()`，一輪就是 9 次登入，實測會踩到 PTT 的 DDoS/BOT
// 保護把帳號鎖住（見 `tests/e2e/README.md`）。現在整包共用一個已登入的 page，
// 每條開頭用 `resetSession` 回主選單重設 prefs。連帶規則：
//   - `describe.serial`（共用 page 有狀態，順序不可打散）；
//   - prefs 一律用 runtime 的 `applyPrefs`，**不可** `addInitScript`（不會 reload）；
//   - 失敗時沒有內建的自動截圖，catch 內自己 `test.info().attach`。
const { test, expect } = require('./helpers/fixtures');
const {
  resetSession,
  gotoBoard,
  applyPrefs,
  sendKey,
  typeLine,
  waitForScreen,
  readScreen,
} = require('./helpers/ptt');

async function dumpListState(page) {
  return await page.evaluate(() => {
    const app = window.__app;
    const ls = app.listSession;
    return {
      state: ls.state,
      renderMode: app.buf.listRenderMode,
      pageState: app.buf.pageState,
      listLen: (app.buf.listLines || []).length,
      nums: (app.buf.listLineNums || []).slice(),
      selectedNum: ls._selectedNum,
      // 視窗頂端的序號：平滑捲動不搬選取，「捲了沒」只能看這個錨。
      topNum: ls._topNum,
      queueIdle: app.commandQueue.idle,
      row0: app.buf.getRowText(0, 0, app.buf.cols),
      rowLast: app.buf.getRowText(app.buf.rows - 1, 0, app.buf.cols),
      selectMode: ls._selectMode,
      cursorHidden: document.getElementById('cursor').style.display === 'none',
      domRows: document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        .length,
      seqLen: ls._sequence().length,
      chh: app.view.chh,
      // 捲動視口：整段序列住在裡面，但**畫面高度**恆是 body 那 20 列。
      viewportPx: (() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return v ? v.clientHeight : -1;
      })(),
    };
  });
}

// 「畫面看起來仍是 24 列」：DOM 列數 = 3 header + 序列（不足補到 bodyRows）+ footer，
// 而使用者看到的那 20 列是視口高度 —— 那才是原本 `domRows === 24` 想守的東西。
function expectListViewport(s) {
  expect(s.domRows).toBe(4 + Math.max(s.seqLen, 20));
  expect(s.viewportPx).toBe(20 * s.chh);
}

// 等 list 好讀穩定：active、佇列 idle、listLen 連續三次輪詢不變。
async function waitListSettled(page, opts = {}) {
  const deadline = Date.now() + (opts.timeout || 45000);
  let prev = -1;
  let stable = 0;
  let s = null;
  while (Date.now() < deadline) {
    s = await dumpListState(page);
    if (
      s.state === 'active' &&
      s.queueIdle &&
      s.listLen === prev &&
      s.listLen > 0
    ) {
      if (++stable >= 3) return s;
    } else {
      stable = 0;
    }
    prev = s.listLen;
    await page.waitForTimeout(700);
  }
  return s || (await dumpListState(page));
}

async function waitFor(page, pred, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let s = null;
  while (Date.now() < deadline) {
    s = await dumpListState(page);
    if (pred(s)) return s;
    await page.waitForTimeout(300);
  }
  throw new Error('waitFor 超時：' + JSON.stringify(s));
}

// soak 用：pref 常開下進板（gotoBoard 的 header 文字偵測會被 buffer 渲染騙到，
// 改以 listSession 狀態判定成功；進板 banner 用 Space 掠過）。走的是「進板
// clean-list settle → 自動 engage」的自然路徑，正是 soak 要驗的。
async function gotoBoardListEROn(page, board) {
  await sendKey(page, 's');
  await waitForScreen(page, ['請輸入看板名稱', '搜尋看板', '自動搜尋'], {
    timeout: 10000,
  });
  await typeLine(page, board);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const st = await dumpListState(page);
    if (st.state === 'active') return;
    const s = await readScreen(page);
    if (s.includes('請按任意鍵繼續') || s.includes('空白鍵')) {
      await sendKey(page, 'Space');
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`gotoBoardListEROn(${board}) 未能進板並 engage`);
}

// 進板（list 好讀先關），再開啟並等預讀穩定。
async function enterBoardWithListER(page, board, prefs) {
  await applyPrefs(page, { enableEasyReadingList: false });
  await gotoBoard(page, board);
  await applyPrefs(
    page,
    Object.assign(
      { enableEasyReadingList: true, easyReadingListPrefetchCount: 60 },
      prefs || {}
    )
  );
  return waitListSettled(page);
}

function assertAscending(s) {
  const firstNull = s.nums.indexOf(null);
  const numbered = firstNull === -1 ? s.nums : s.nums.slice(0, firstNull);
  const tail = firstNull === -1 ? [] : s.nums.slice(firstNull);
  expect(numbered.every((n) => n != null)).toBe(true);
  expect(tail.every((n) => n == null)).toBe(true); // 置底文全在最底
  for (let i = 1; i < numbered.length; i++) {
    expect(numbered[i]).toBeGreaterThan(numbered[i - 1]);
  }
  return numbered;
}

test.describe.serial('文章列表好讀模式（live）', () => {
  test('進看板啟用 + 多頁累積 + 序號遞增 + 置底最底 + 24行視窗 + > 游標', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);

      const s = await enterBoardWithListER(page, 'C_Chat');
      console.log(
        'list state:',
        JSON.stringify({ ...s, nums: s.nums.slice(0, 3).concat(['...'], s.nums.slice(-3)) })
      );
      expect(s.state).toBe('active');
      expect(s.renderMode).toBe('buffer');
      expect(s.cursorHidden).toBe(true);
      expect(s.listLen).toBeGreaterThan(20);
      const numbered = assertAscending(s);
      expect(numbered.length).toBeGreaterThan(20);
      // 畫面仍是 24 列高（整段序列在 DOM 裡，視口只露 20 列）；
      // 游標 = 恰一列行首 '>'。行首比對，不可用 includes——'>' 也會出現在標題文字裡。
      expectListViewport(s);
      const cursor = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        );
        const hits = rows
          .map((el, i) => (el.textContent.startsWith('>') ? i : -1))
          .filter((i) => i !== -1);
        const v = document.querySelector('#mainContainer .listBodyView');
        const inView =
          hits.length === 1 && v
            ? hits[0] - 3 - Math.round(v.scrollTop / window.__app.view.chh)
            : null;
        return { count: hits.length, row: hits[0], inView };
      });
      expect(cursor.count).toBe(1);
      expect(cursor.row).toBeGreaterThanOrEqual(3); // header 之後
      // 剛進板時游標看得見 ⇒ 相對視口落在 body 的 20 列內。（絕對列號現在是
      // 序列位置＋3，可以遠大於 22——游標本來就允許被捲出視野。）
      expect(cursor.inView).toBeGreaterThanOrEqual(0);
      expect(cursor.inView).toBeLessThan(20);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('往舊端移動觸發 demand 續抓（往上抓更舊）', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      // 小預讀量，便於觸發續抓。
      const s = await enterBoardWithListER(page, 'C_Chat', {
        easyReadingListPrefetchCount: 20,
      });
      expect(s.state).toBe('active');
      const initial = s.listLen;

      await page.locator('#t').focus();
      let grown = initial;
      for (let i = 0; i < 8 && grown <= initial; i++) {
        await page.keyboard.press('PageUp'); // 本地翻頁，視窗近頂觸發 demand-up
        await page.waitForTimeout(1200);
        grown = (await dumpListState(page)).listLen;
      }
      console.log('listLen:', initial, '→', grown);
      expect(grown).toBeGreaterThan(initial);
      // PgUp 後游標停在新頁「頂」＝**相對視口**的第 0 列（絕對列號是序列位置＋3，
      // 全序列渲染後可以很大）。prepend 的新頁不得把畫面往下擠 —— 錨定還原保證
      // 視口跟著同一列走（不變量 6），所以這裡量的是「游標相對視口」。
      const cursorInView = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        const i = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).findIndex((el) => el.textContent.startsWith('>'));
        if (i < 0 || !v) return null;
        return i - 3 - Math.round(v.scrollTop / window.__app.view.chh);
      });
      expect(cursorInView).toBe(0);
      const after = await waitListSettled(page);
      expect(after.state).toBe('active'); // 不掉 native
      assertAscending(after);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('選取移動 + Enter 序列化開文 + ← 返回還原快取（article 好讀交棒）', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat', {
        enableEasyReading: true, // 開文後 article 好讀應接手
      });
      expect(s.state).toBe('active');
      const cachedLen = s.listLen;

      await page.locator('#t').focus();
      // 往上（舊）移幾步，落在有序號的文章列（底部其下是置底文）。
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(150);
      }
      const sel = (await dumpListState(page)).selectedNum;
      console.log('selected:', sel);
      expect(sel).toBeTruthy();

      // 預先 latch article 好讀（使用者實測情境：之前讀過文章 → _enabled 鎖存，
      // 開文瞬間快路徑立刻翻頁）。v4-stabilize bug 1 紅燈：frozen 若遮蔽
      // opening→suspended 空窗的文章幀，前幾頁永久漏，pageLines[0] 就不會是
      // 「作者」標頭列。
      await page.evaluate(() => {
        window.__app.easyReading._enabled = true;
      });

      // Enter → opening(frozen) → 跳號+Enter 兩段 → article → suspended。
      await page.keyboard.press('Enter');
      const opened = await waitFor(page, (x) => x.state === 'suspended', 25000);
      expect(opened.pageState).toBe(3);
      expect(opened.renderMode).toBe('native');
      // article 好讀接手（enableEasyReading=true）。
      const er = await page.evaluate(() => ({
        useER: !!window.__app.view.useEasyReadingMode,
      }));
      console.log('article ER engaged:', er.useER);
      // 文章完整性：累積長頁必須從第一頁開始（首列＝作者標頭）。
      await page.waitForFunction(
        () => window.__app.buf.pageLines.length > 0,
        null,
        { timeout: 10000 }
      );
      const firstRow = await page.evaluate(() => {
        const buf = window.__app.buf;
        return buf.getRowText(0, 0, buf.cols, buf.pageLines);
      });
      console.log('pageLines[0]:', JSON.stringify(firstRow.slice(0, 40)));
      expect(firstRow).toContain('作者');

      // 返回列表（article 好讀下左鍵離開本篇）。
      await page.locator('#t').focus();
      await page.keyboard.press('ArrowLeft');
      const back = await waitFor(page, (x) => x.state === 'active', 25000);
      expect(back.renderMode).toBe('buffer');
      expect(back.cursorHidden).toBe(true);
      // 還原快取：maps 未重建（listLen 不明顯縮水）、選回開的那篇。
      expect(back.listLen).toBeGreaterThanOrEqual(Math.min(cachedLen, 20));
      expect(back.selectedNum).toBe(sel);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('置底文 Enter 開啟（End+內容定位序列）＋ ← 返回還原 pinned 選取', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat', {
        easyReadingListPrefetchCount: 0,
      });
      expect(s.state).toBe('active');
      test.skip(!s.nums.includes(null), '此板目前無置底文');

      // End：本地導覽到最底 → 選取落在最後一列置底文（pinned key 選取）。
      await page.locator('#t').focus();
      await page.keyboard.press('End');
      await page.waitForTimeout(300);
      const pinnedKey = await page.evaluate(
        () => window.__app.listSession._selectedPinnedKey
      );
      console.log('pinned target:', pinnedKey);
      expect(pinnedKey).toBeTruthy();

      // Enter → opening(frozen) → End+↑…+Enter 序列化 → article → suspended。
      await page.keyboard.press('Enter');
      const opened = await waitFor(page, (x) => x.state === 'suspended', 25000);
      expect(opened.pageState).toBe(3);
      expect(opened.renderMode).toBe('native');

      // ← 返回 → re-seed（v5/M4）：server 游標仍停在該置底列 → rebuild 路徑
      // 的 _seedAnchors 取回同一 pinned key。
      await page.locator('#t').focus();
      await page.keyboard.press('ArrowLeft');
      const back = await waitFor(page, (x) => x.state === 'active', 25000);
      expect(back.renderMode).toBe('buffer');
      expect(back.selectedNum).toBeNull();
      const restored = await page.evaluate(
        () => window.__app.listSession._selectedPinnedKey
      );
      expect(restored).toBe(pinnedKey);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('滾輪原生捲動本地執行：視口上移＋demand 續抓（不按任何鍵）', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat', {
        easyReadingListPrefetchCount: 20,
      });
      expect(s.state).toBe('active');
      const initial = s.listLen;

      // 滾輪往上＝**瀏覽器原生捲動**（pref mouseWheelSmoothScroll，預設開）：捲動本身
      // 完全交給瀏覽器，我們只維護內容錨；視口近緩衝頂即觸發 demand-up 抓更舊頁 ——
      // 與鍵盤同一條 demand 路徑。
      //
      // 位移的證據只能看 `topNum`（視口頂端那一列的序號），**不可以看 selectedNum**：
      // 捲動不搬選取（網頁式語意，游標可以被捲出視野）。實測（2026-08-29）進板落點的
      // 游標可能停在置底文（序號 null，前一條測試開過置底文，PTT getkeep 會還原該
      // 位置），此時整輪捲動下來 selectedNum 一直是 null —— 那是正確行為，不是沒捲到。
      // 對應的純邏輯守護：tests/unit/list_session.test.js「捲動不動游標」。
      const topBefore = s.topNum;
      const selectedBefore = s.selectedNum;
      expect(typeof topBefore).toBe('number');
      const main = page.locator('#mainContainer');
      await main.hover();
      let grown = initial;
      for (let i = 0; i < 25 && grown <= initial; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(400);
        grown = (await dumpListState(page)).listLen;
      }
      console.log('wheel demand listLen:', initial, '→', grown);
      expect(grown).toBeGreaterThan(initial);

      // 剛進板時 buffer 常常只有一頁（內容高＝視口高 ⇒ 零可捲距離），此時滾輪的
      // 作用是**請求補頁**（onWheelAtEdge）而不是捲動；補進來的舊文接在上方，而
      // 錨定還原刻意讓畫面不動（不變量 6：prepend 不擠畫面）。有了可捲距離之後
      // 再滾，才會真的往舊文走 —— 這裡驗的是後半段。
      await waitListSettled(page);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(150);
      }
      const after = await waitListSettled(page);
      expect(after.state).toBe('active');
      expect(after.topNum).toBeLessThan(topBefore); // 視口真的往舊文走
      // 捲動**不動游標**（網頁式語意）：選取還是原本那一篇，即使它已經被捲出視野。
      expect(after.selectedNum).toBe(selectedBefore);
      // 而且畫面高度不變（body 視口恆是 20 列；整段序列住在裡面由瀏覽器捲）。
      const geom = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return v
          ? { clientH: v.clientHeight, want: 20 * window.__app.view.chh, top: v.scrollTop }
          : null;
      });
      expect(geom).not.toBeNull();
      expect(geom.clientH).toBe(geom.want);
      assertAscending(after);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('捲動把游標捲出視野後，按 ↓ 會先把它帶回畫面上', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat', {
        easyReadingListPrefetchCount: 60,
      });
      expect(s.state).toBe('active');
      const selectedBefore = s.selectedNum;

      // 直接驅動視口（決定性；滾輪本身另一條測試已驗）。捲到離游標很遠的地方。
      const moved = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        if (!v) return null;
        v.scrollTop = Math.max(0, v.scrollHeight - v.clientHeight);
        return v.scrollTop;
      });
      expect(moved).not.toBeNull();
      await page.waitForTimeout(400);

      // 游標仍是原本那篇（可能已被捲出視野）。
      const mid = await dumpListState(page);
      expect(mid.selectedNum).toBe(selectedBefore);

      await page.locator('#t').focus();
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(600);

      // 游標只移動一篇，而且被帶回視野（相對視口落在 body 的 20 列內）。
      const after = await dumpListState(page);
      if (typeof selectedBefore === 'number')
        expect(after.selectedNum).toBe(selectedBefore + 1);
      const inViewport = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        const rows = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        );
        const i = rows.findIndex((el) => el.textContent.startsWith('>'));
        if (i < 0 || !v) return null;
        const pos = i - 3 - Math.round(v.scrollTop / window.__app.view.chh);
        return { pos, ok: pos >= 0 && pos < 20 };
      });
      expect(inViewport).not.toBeNull();
      expect(inViewport.ok).toBe(true);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('/ 一鍵切原生搜尋：MODE_SELECT 落地後自動回好讀 → ← 退回主列表仍好讀', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');
      expect(s.cursorHidden).toBe(true);
      // 等 buffer 有序號再取樣（enterBoard 的 dump 可能早於 seed 完成 → 空
      // nums 會讓 mainMin=Infinity、後續斷言死等）。
      const seeded = await waitFor(
        page,
        (x) => x.queueIdle && x.nums.some((n) => Number.isFinite(n)),
        15000
      );
      const mainMin = Math.min(...seeded.nums.filter((n) => Number.isFinite(n)));
      console.log('[test] mainMin=' + mainMin + ' seededLen=' + seeded.nums.length);

      // '/'：一鍵切原生（2026-07-10 passthrough）——sync 腿後切原生鏡像＋代送 '/'，
      // server 的搜尋 prompt 直接在原生畫面顯示，關鍵字對終端打字。
      // 關鍵字用 ASCII 'Re'（標題 Re: 常見恆有命中）：Playwright keyboard.type
      // 對 CJK 不產生 keypress、打不進終端（中文輸入走原生 convSend u2b 打字
      // 路徑，非列表功能特有，不在此鎖）。
      await page.locator('#t').focus();
      await page.keyboard.press('/');
      const fm = await waitFor(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      expect(fm.renderMode).toBe('native');
      await page.waitForTimeout(800); // 等 prompt 畫面到齊再打字
      await page.keyboard.type('Re', { delay: 50 });
      await page.keyboard.press('Enter');

      // 2026-09-03：搜尋結果（MODE_SELECT）落地、畫面靜下來之後**自動回好讀**
      //（resume+rebuild：MODE_SELECT 是獨立編號空間，協定 §8）。使用者不必按
      // 任何鍵，也不必先開一篇文章。
      const sel = await waitFor(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer' && x.row0.includes('系列'),
        20000
      );
      expect(sel.cursorHidden).toBe(true);

      // ← 退回主列表：這時已經是好讀 ⇒ 走序列化的離開交易，落地仍是好讀。
      await page.keyboard.press('ArrowLeft');
      const back = await waitFor(
        page,
        (x) =>
          x.state === 'active' &&
          x.renderMode === 'buffer' &&
          x.queueIdle &&
          !x.row0.includes('系列'),
        20000
      );
      expect(back.cursorHidden).toBe(true);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('v 一鍵切原生：v → 原生 prompt → Enter 取消 → 自動回好讀', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');

      // v（已讀設定）：passthrough——sync 腿後切原生，getdata prompt 由原生畫面接手。
      await page.locator('#t').focus();
      await page.keyboard.press('v');
      const fm = await waitFor(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      expect(fm.renderMode).toBe('native');
      await page.waitForTimeout(800); // 等 prompt 畫面到齊
      await page.keyboard.press('Enter'); // 空 Enter 取消 → FULLUPDATE 清單重繪
      // 2026-09-03：操作完成、畫面靜下來 ⇒ 靜置探針自動切回好讀。
      const back = await waitFor(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer',
        20000
      );
      expect(back.cursorHidden).toBe(true);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('A 類鍵（]）走凍結交易：全程看不到原生 24 列', async ({ shared }) => {
    // read.c#i_read_key 的 thread()/search_read()/ToggleTagItem 家族＝原地重繪，
    // 清單內容與編號空間都不變 ⇒ 送真鍵、等真回應、採用真落點，畫面從頭到尾
    // 都是好讀的捲動視口。這是「反覆按 [ ] 會閃動」那個老問題的正解。
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');
      await waitFor(page, (x) => x.queueIdle && x.nums.some((n) => Number.isFinite(n)), 15000);

      // 交易期間高頻取樣 listRenderMode：只要出現過一次 'native' 就是回歸。
      await page.evaluate(() => {
        window.__nativeSeen = false;
        window.__modeWatch = setInterval(() => {
          if (window.__app.buf.listRenderMode === 'native') window.__nativeSeen = true;
        }, 20);
      });
      await page.locator('#t').focus();
      await page.keyboard.press(']');
      const done = await waitFor(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer' && x.queueIdle,
        20000
      );
      const sawNative = await page.evaluate(() => {
        clearInterval(window.__modeWatch);
        return window.__nativeSeen;
      });
      expect(sawNative).toBe(false);
      expect(done.cursorHidden).toBe(true);
      // 捲動視口一直都在（原生鏡像是固定 24 列，沒有這個元素）。
      await expect(page.locator('.listBodyView')).toHaveCount(1);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  test('黑名單作者列從 DOM 真正移除（無空行）', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      const before = await enterBoardWithListER(page, 'C_Chat');
      expect(before.state).toBe('active');

      const targetAuthor = await page.evaluate(() => {
        const lines = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).map((el) => el.textContent);
        for (const t of lines) {
          const m = t.match(
            /^\s*\d+\s+[+\-\dMm~ ]+\s*\d+\/\d+\s+([A-Za-z][0-9A-Za-z]+)\b/
          );
          if (m) return m[1].toLowerCase();
        }
        return null;
      });
      console.log('target blacklist author:', targetAuthor);
      expect(targetAuthor).toBeTruthy();

      await applyPrefs(page, { blacklist: targetAuthor });
      await page.waitForTimeout(1000);
      const res = await page.evaluate((author) => {
        const lines = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).map((el) => el.textContent.toLowerCase());
        const v = document.querySelector('#mainContainer .listBodyView');
        return {
          domRows: lines.length,
          hasAuthor: lines.some((t) => t.includes(author)),
          listLen: window.__app.buf.listLines.length,
          seqLen: window.__app.listSession._sequence().length,
          viewportPx: v ? v.clientHeight : -1,
          chh: window.__app.view.chh,
        };
      }, targetAuthor);
      console.log('after blacklist:', JSON.stringify(res));
      expect(res.hasAuthor).toBe(false);
      // 隱藏列直接從序列消失（不留空隙），畫面高度不變。
      expect(res.domRows).toBe(4 + Math.max(res.seqLen, 20));
      expect(res.viewportPx).toBe(20 * res.chh);
      expect(res.listLen).toBeGreaterThanOrEqual(20); // 緩衝仍保留隱藏列
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });

  // v5/M5 soak＝枚舉操作輪播：白名單操作（T1 本地/T2 交易/未列鍵 no-op/離板重進/
  // 連打）逐一走一輪，每步驗「模式保持＋序號遞增」。操作集合＝合約
  // （docs/easy-reading-list.md §操作分類），新增白名單操作時此輪播同步補站。
  test('soak：白名單操作輪播——每站模式保持、無亂版、不掉 native', async ({ shared }) => {
    test.setTimeout(300000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      let s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');
      await page.locator('#t').focus();

      const settledActive = async (station) => {
        const st = await waitListSettled(page);
        expect({ station, state: st.state, mode: st.renderMode }).toEqual({
          station,
          state: 'active',
          mode: 'buffer',
        });
        assertAscending(st);
        console.log(`station ${station}: listLen=${st.listLen} sel=${st.selectedNum}`);
        return st;
      };

      // 站 1：T1 鍵盤導覽（↑↓ j k PgUp PgDn ＋ read.c:858-902 同義鍵
      // Space/N/P/n/p，零 server）。
      for (const k of [
        'ArrowUp',
        'ArrowUp',
        'j',
        'k',
        'PageUp',
        'PageDown',
        'Space',
        'N',
        'P',
        'n',
        'p',
      ]) {
        await page.keyboard.press(k);
        await page.waitForTimeout(150);
      }
      s = await settledActive('T1-nav');

      // 站 1b：送不出 byte 的實體鍵＝完全無作用（2026-08「按 Caps Lock/F2 畫面
      // 跑掉」回歸：舊碼會跳過 sync 腿直接切原生鏡像）。CapsLock 按偶數次還原
      // 大小寫狀態，免得污染後面用字母鍵的站。
      const selBeforeDead = s.selectedNum;
      for (const k of ['F2', 'CapsLock', 'CapsLock']) {
        await page.keyboard.press(k);
        await page.waitForTimeout(150);
      }
      s = await settledActive('dead-keys');
      expect(s.selectedNum).toBe(selBeforeDead);

      // 站 2：End 邊界確認（邊未確認 → server 交易；已確認 → 本地）。'$' 同義
      // （read.c:898）。
      await page.keyboard.press('End');
      s = await settledActive('End');
      await page.keyboard.press('$');
      s = await settledActive('End-$');

      // 站 3：滾輪（瀏覽器原生捲動，本地執行、零 byte）。
      const selBeforeWheel = s.selectedNum;
      await page.locator('#mainContainer').hover();
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(250);
      }
      s = await settledActive('wheel');
      // 捲動**不動游標**（網頁式語意）——選取只有鍵盤/點擊才會搬。
      expect(s.selectedNum).toBe(selBeforeWheel);

      // 站 4：點擊＝開被點的那一篇（59c9f9b 起的合約，治「列表好讀點了完全沒反應」；
      // 2026-07-08~2026-08-15 之間才是 no-op，此站的舊斷言即停在那個版本）。座標 →
      // 視窗 body index → 序號錨 → 走鍵盤同一條 reducer/_beginOpen 交易，零 raw byte；
      // 換算純邏輯守護在 tests/unit/list_click_open.test.js，這裡鎖端到端：真的開得成、
      // 開的是被點那一列、← 返回後好讀復原。
      // 目標要挑**視口內**看得見的那一列：body 現在放的是整段序列（絕對 data-row
      // 可以遠在視口之外，點下去會落在別的東西上）。
      const clickIdx = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return 3 + Math.round(v.scrollTop / window.__app.view.chh) + 2;
      });
      const clickTarget = page
        .locator('#mainContainer [data-type="bbsline"]')
        .nth(clickIdx);
      const clickedNum = parseInt((await clickTarget.textContent()).trim(), 10);
      const rowBox = await clickTarget.boundingBox();
      await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
      await waitFor(page, (x) => x.state === 'suspended', 25000);
      await page.locator('#t').focus();
      await page.keyboard.press('ArrowLeft');
      s = await settledActive('click-open-back');
      // 置底文（編號欄是 ★）解析不出數字 → 只驗開文/返回，不比對序號
      if (!Number.isNaN(clickedNum)) expect(s.selectedNum).toBe(clickedNum);

      // 站 5：B 類 excursion（2026-09-03 起「操作完成就自動回好讀」）——
      // `v` 會開 getdata prompt，畫面**必須真的切成原生**（否則 prompt 被累積
      // 緩衝視窗蓋住＝使用者讀成畫面卡住）；Enter 取消之後畫面靜下來，靜置探針
      // 自動把我們切回好讀，不必先開一篇文章。
      await page.keyboard.press('v');
      await waitFor(page, (x) => x.state === 'functionMode' && x.renderMode === 'native', 10000);
      await page.waitForTimeout(800); // 等 prompt 畫面到齊
      await page.keyboard.press('Enter'); // 取消
      s = await settledActive('auto-resume-after-v');

      // 站 5b：A 類鍵（`]` 同標題跳文）＝凍結交易，**全程看不到原生 24 列**。
      // 高頻取樣 listRenderMode：只要出現過一次 'native' 就是回歸。
      await page.evaluate(() => {
        window.__soakNativeSeen = false;
        window.__soakWatch = setInterval(() => {
          if (window.__app.buf.listRenderMode === 'native') window.__soakNativeSeen = true;
        }, 20);
      });
      await page.keyboard.press(']');
      s = await settledActive('inplace-relative-next');
      const soakSawNative = await page.evaluate(() => {
        clearInterval(window.__soakWatch);
        return window.__soakNativeSeen;
      });
      expect(soakSawNative).toBe(false);

      // 站 6：開文（→ 文章好讀接手）→ ← 返回恢復好讀。
      await page.keyboard.press('Enter');
      await waitFor(page, (x) => x.state === 'suspended', 25000);
      await page.locator('#t').focus();
      await page.keyboard.press('ArrowLeft');
      s = await settledActive('excursion-back');

      // 站 7：數字跳號 overlay——Esc 取消（零 server）。
      await page.keyboard.press('5');
      await page.waitForSelector('input[data-list-input]', { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('input[data-list-input]', { state: 'detached', timeout: 5000 });
      s = await settledActive('jump-cancel');

      // 站 10：Enter 開文 → ← 返回（re-seed）。
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('ArrowUp'); // 避開置底列，落在有序號的文章
        await page.waitForTimeout(150);
      }
      await page.keyboard.press('Enter');
      await waitFor(page, (x) => x.state === 'suspended', 25000);
      await page.locator('#t').focus();
      await page.keyboard.press('ArrowLeft');
      s = await settledActive('open-back');

      // 站 11：← 離板（leave 交易）→ 重進板 engage。
      await page.keyboard.press('ArrowLeft');
      await waitFor(page, (x) => x.state === 'idle', 20000);
      await resetSession(page);
      await applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 60,
      });
      await gotoBoardListEROn(page, 'C_Chat');
      s = await waitFor(page, (x) => x.state === 'active' && x.renderMode === 'buffer', 30000);
      expect(s.cursorHidden).toBe(true);
      assertAscending(s);

      // 站 12：預讀中連打導覽（v3 最易掉 native 的重現法）。
      await page.locator('#t').focus();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 3 === 2 ? 'PageUp' : 'ArrowUp');
        await page.waitForTimeout(120);
      }
      s = await settledActive('burst-nav');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      // shared 不是 Playwright 內建 page fixture ⇒ screenshot:'only-on-failure'
      // 不會生效，自己補一張進報告。
      await test
        .info()
        .attach('screen', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
        .catch(() => {});
      throw e;
    }
  });
});
