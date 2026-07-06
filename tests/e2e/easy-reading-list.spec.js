// 文章列表好讀模式 e2e（連真 PTT）。原生視窗仿真（24 行固定、● 游標、read.c 語意）：
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
const { test, expect } = require('@playwright/test');
const {
  login,
  attachConsole,
  dismissDeveloperModeAlert,
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
      queueIdle: app.commandQueue.idle,
      row0: app.buf.getRowText(0, 0, app.buf.cols),
      rowLast: app.buf.getRowText(app.buf.rows - 1, 0, app.buf.cols),
      selectMode: ls._selectMode,
      cursorHidden: document.getElementById('cursor').style.display === 'none',
      domRows: document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        .length,
    };
  });
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

test.describe('文章列表好讀模式（live）', () => {
  test('進看板啟用 + 多頁累積 + 序號遞增 + 置底最底 + 24行視窗 + ●游標', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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
      // 原生視窗仿真：DOM 固定 24 行；游標 = 恰一列行首 ●（body 區內）。
      expect(s.domRows).toBe(24);
      const bulletRows = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        )
          .map((el, i) => (el.textContent.includes('●') ? i : -1))
          .filter((i) => i !== -1)
      );
      expect(bulletRows.length).toBe(1);
      expect(bulletRows[0]).toBeGreaterThanOrEqual(3);
      expect(bulletRows[0]).toBeLessThanOrEqual(22);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('往舊端移動觸發 demand 續抓（往上抓更舊）', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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
      // read.c 語意：PgUp 後游標停在新頁「頂」（DOM row 3）——prepend 的新頁
      // 不得把游標往下擠（使用者症狀鎖）。
      const cursorRow = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).findIndex((el) => el.textContent.includes('●'))
      );
      expect(cursorRow).toBe(3);
      const after = await waitListSettled(page);
      expect(after.state).toBe('active'); // 不掉 native
      assertAscending(after);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('選取移動 + Enter 序列化開文 + ← 返回還原快取（article 好讀交棒）', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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
      throw e;
    }
  });

  test('置底文 Enter 開啟（End+內容定位序列）＋ ← 返回還原 pinned 選取', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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

      // ← 返回 → restore 還原 pinned 選取。
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
      throw e;
    }
  });

  test('滾輪＝原生映射本地執行：游標上移＋demand 續抓（不按任何鍵）', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat', {
        easyReadingListPrefetchCount: 20,
      });
      expect(s.state).toBe('active');
      const initial = s.listLen;

      // 滾輪往上：mouse_scroll 依原生偏好映射（素滾＝↑）本地移動游標，
      // 視窗近緩衝頂即觸發 demand-up 抓更舊頁 —— 與鍵盤同一路徑。
      const selBefore = s.selectedNum;
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
      const after = await waitListSettled(page);
      expect(after.state).toBe('active');
      expect(after.selectedNum).toBeLessThan(selBefore); // 游標真的往上走
      assertAscending(after);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v5 T2 搜尋交易：/ → frozen＋輸入框收參 → 提交進 MODE_SELECT → ← 退回主列表', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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

      // '/'：v5 交易化——frozen 凍結（不裸露原生 prompt 畫面）＋輸入框收參。
      await page.locator('#t').focus();
      await page.keyboard.press('/');
      await page.waitForSelector('input[data-list-input]', { timeout: 10000 });
      const fm = await waitFor(page, (x) => x.state === 'functionMode');
      expect(fm.renderMode).toBe('frozen'); // 非 native——封閉互動
      await page.locator('input[data-list-input]').fill('Re');
      await page.keyboard.press('Enter');

      // NEWDIRECT 全幅重建 → rebuild 進 MODE_SELECT 清單（序號空間獨立）。
      const sel = await waitFor(page, (x) => x.state === 'active' && x.queueIdle, 20000);
      expect(sel.renderMode).toBe('buffer');
      // MODE_SELECT 清單：畫面 header 板名前綴變「系列」、序號空間獨立（遠小
      // 於主列表 35 萬級）。
      expect(sel.row0).toContain('系列');
      const selNums = sel.nums.filter((n) => Number.isFinite(n));
      expect(selNums.length).toBeGreaterThan(0);
      const selMax = Math.max(...selNums);
      expect(selMax).toBeLessThan(mainMin);

      // ← 退出 select（leave 交易）→ 回主列表 rebuild（主序號空間）。
      // 注意：pttbbs 退出 select 後主列表游標落在「帳號已讀進度」處（不是進
      // select 前的位置），v5 re-seed 忠實採用 server 落點、fill 只向上補——
      // buffer 不保證含進板時取樣的最新序號（mainMin 可能在落點下方）。判準
      // 改「序號回到主空間」：任一序號 > select 空間即回主列表。
      await page.keyboard.press('ArrowLeft');
      const back = await waitFor(
        page,
        (x) =>
          x.state === 'active' &&
          x.queueIdle &&
          !x.selectMode &&
          x.nums.some((n) => Number.isFinite(n) && n > selMax),
        20000
      );
      expect(back.renderMode).toBe('buffer');
      expect(back.cursorHidden).toBe(true);
      expect(back.row0).not.toContain('系列');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v5 T2 已讀設定交易：v → frozen＋選單 → Esc 取消（\\r 收 getdata）→ resume', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
      await resetSession(page);
      const s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');

      await page.locator('#t').focus();
      await page.keyboard.press('v');
      await page.waitForFunction(
        () =>
          window.__app.listSession._paramMode &&
          window.__app.listSession._paramMode.type === 'mark',
        null,
        { timeout: 10000 }
      );
      // frozen 快照：畫面仍是列表視窗（server prompt 不裸露）。
      const fm = await waitFor(page, (x) => x.renderMode === 'frozen');
      expect(fm.state).toBe('functionMode');

      await page.keyboard.press('Escape'); // 取消 → \r 收 getdata → FULLUPDATE
      const back = await waitFor(page, (x) => x.state === 'active' && x.queueIdle, 20000);
      expect(back.renderMode).toBe('buffer');
      expect(back.cursorHidden).toBe(true);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('黑名單作者列從 DOM 真正移除（無空行）', async ({ page }) => {
    test.setTimeout(120000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
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
        return {
          domRows: lines.length,
          hasAuthor: lines.some((t) => t.includes(author)),
          listLen: window.__app.buf.listLines.length,
        };
      }, targetAuthor);
      console.log('after blacklist:', JSON.stringify(res));
      expect(res.hasAuthor).toBe(false);
      expect(res.domRows).toBe(24); // 視窗由鄰近列補滿，不缺行
      expect(res.listLen).toBeGreaterThanOrEqual(20); // 緩衝仍保留隱藏列
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // v3 不穩重現法自動化（handoff 驗收 1、2）：這兩條是 v4 的核心回歸。
  test('soak：進退板×5 模式保持、無亂版；預讀中連打導覽不掉 native', async ({ page }) => {
    test.setTimeout(240000);
    const logs = attachConsole(page);
    try {
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await login(page);
      await resetSession(page);
      let s = await enterBoardWithListER(page, 'C_Chat');
      expect(s.state).toBe('active');

      await page.locator('#t').focus();
      for (let round = 1; round <= 5; round++) {
        // ← 離板（other 鍵 → functionMode → 選單 settle → idle cleanup）。
        await page.keyboard.press('ArrowLeft');
        await waitFor(page, (x) => x.state === 'idle', 20000);
        // 重新進板（離板後停在選單，游標未必在原板上 → 回主選單再 s 搜尋進板；
        // resetSession 會把 prefs 重設 baseline，故在主選單重開 pref —— 此時
        // evaluateNow 對選單是 no-op，進板時走自然 clean-list settle engage）。
        await resetSession(page);
        await applyPrefs(page, {
          enableEasyReadingList: true,
          easyReadingListPrefetchCount: 60,
        });
        await gotoBoardListEROn(page, 'C_Chat');
        s = await waitFor(page, (x) => x.state === 'active' && x.renderMode === 'buffer', 30000);
        expect(s.cursorHidden).toBe(true);
        assertAscending(s); // 無亂版：序號恆嚴格遞增
        console.log(`round ${round}: listLen=${s.listLen}`);
        await page.locator('#t').focus();
      }

      // 預讀中連打導覽（v3 最易掉 native 的重現法）：重進板觸發 fill，立刻連打。
      await page.keyboard.press('ArrowLeft');
      await waitFor(page, (x) => x.state === 'idle', 20000);
      await resetSession(page);
      await applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 60,
      });
      await gotoBoardListEROn(page, 'C_Chat');
      await page.locator('#t').focus();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 3 === 2 ? 'PageUp' : 'ArrowUp');
        await page.waitForTimeout(120);
      }
      s = await waitListSettled(page);
      expect(s.state).toBe('active'); // 模式保持，不掉 native
      expect(s.renderMode).toBe('buffer');
      assertAscending(s);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
