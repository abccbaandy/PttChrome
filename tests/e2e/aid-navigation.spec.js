// 好讀模式 AID 一鍵跳文 live e2e。
// 流程：進板 → 游標列按 Q 撈真實 AID → 開另一篇文章（好讀）→ 呼叫
// aidNavigation.start(aid, board)（等同點擊 AID 連結）→ 驗證最終落在目標文章。
// 保留 settle facts / sent bytes 記錄：失敗時直接可讀出卡在哪一步
// （2026-07-10 曾因 # 跳文落地 footer 空白被判 transient 而誤報「找不到」）。
const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  applyPrefs,
  resetSession,
  gotoBoard,
} = require('./helpers/ptt');

// 返回測試專用看板。挑選條件有兩個（都是實測踩到的）：
//   - 不能是 C_Chat：本測會開列表好讀（大量 prefetch）並反覆進出，跑在 C_Chat 上會
//     改變該板的 server 游標(getkeep)/currtitle，後面用 C_Chat 的 enhance /
//     easy-reading 測試就會開到別篇文章（單獨跑綠、整包跑紅）。
//   - 不能是 Test：那裡幾乎只有置底公告，而 mbbsd/read.c:404 的 FIXME 就是置底文
//     的 AID 搜尋（搜 .DIR.bottom 那段）會失手 → 正向跳轉直接「找不到文章」。
const BACK_TEST_BOARD = 'movie';

test.describe.serial('AID 一鍵跳文', () => {
  test('從好讀文章內點 AID 導航到指定文章', async ({ shared }) => {
    test.setTimeout(180000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });

      await gotoBoard(page, 'C_Chat');

      // 在列表游標列按 Q 撈該文的 AID。
      await sendKey(page, 'Q'); // 大寫 Q 開文章資訊框（小寫 q 是離板）
      await page.waitForTimeout(1500);
      const infoScreen = await readScreen(page);
      const m = infoScreen.match(/文章代碼\(AID\):\s*#([0-9A-Za-z_-]{8})/);
      console.log('AID FROM Q:', m && m[1]);
      expect(m).not.toBeNull();
      const targetAid = m[1];
      await sendKey(page, 'Space'); // 關資訊框
      await page.waitForTimeout(1000);

      // 往下移一列再開文章（讓目標 AID ≠ 目前文章，驗證真的跳走）。
      await sendKey(page, 'ArrowDown');
      await page.waitForTimeout(500);
      await sendKey(page, 'Enter');
      await page.waitForTimeout(4000);

      // 好讀已啟動
      const er = await page.evaluate(() => ({
        useER: window.__app.view.useEasyReadingMode,
        started: window.__app.buf.startedEasyReading,
        pageState: window.__app.buf.pageState,
        articleBoard: window.__app.view._articleBoard,
      }));
      console.log('ER STATE:', JSON.stringify(er));
      expect(er.started).toBe(true);

      // 掛診斷：記錄 flashListHint、queue send、每次 onSettle 的 facts 摘要。
      await page.evaluate(() => {
        const app = window.__app;
        window.__diag = { hints: [], sent: [], settles: [] };
        const origHint = app.view.flashListHint.bind(app.view);
        app.view.flashListHint = (msg, ms) => {
          window.__diag.hints.push(msg);
          return origHint(msg, ms);
        };
        const q = app.commandQueue;
        const origSend = q._send;
        q._send = (d) => {
          window.__diag.sent.push(JSON.stringify(d));
          return origSend(d);
        };
        const origSettle = q.onSettle.bind(q);
        q.onSettle = (snap, facts) => {
          window.__diag.settles.push({
            kind: facts.kind,
            boardName: facts.boardName,
            curX: facts.curX,
            curY: facts.curY,
            cursorRowNum: facts.cursorRowNum,
            inFlight: q.inFlightKind,
            lastRow: (facts.rowTexts[facts.rows - 1] || '').slice(0, 60),
          });
          return origSettle(snap, facts);
        };
      });

      // 觸發導航（模擬點擊 AID 連結；board 用 fallback 的 _articleBoard）。
      await page.evaluate((aid) => {
        const app = window.__app;
        app.aidNavigation.start(aid, app.view._articleBoard);
      }, targetAid);

      // 等導航結束（active 變 false），上限 30s。
      await page.waitForFunction(
        () => window.__app.aidNavigation.active === false,
        null,
        { timeout: 30000 }
      );
      await page.waitForTimeout(3000);

      const diag = await page.evaluate(() => window.__diag);
      console.log('HINTS:', JSON.stringify(diag.hints, null, 1));
      console.log('SENT:', JSON.stringify(diag.sent));
      console.log('SETTLES:', JSON.stringify(diag.settles, null, 1));

      const finalState = await page.evaluate(() => ({
        pageState: window.__app.buf.pageState,
        started: window.__app.buf.startedEasyReading,
      }));
      console.log('FINAL:', JSON.stringify(finalState));
      const screen = await readScreen(page);
      console.log('FINAL SCREEN HEAD:', screen.split('\n').slice(0, 3).join(' / '));

      // 斷言：無失敗 banner、最終在文章內（好讀重啟）。
      expect(diag.hints.filter((h) => h.includes('失敗')).length).toBe(0);
      expect(finalState.pageState).toBe(3);
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-40).join('\n'));
      try {
        const diag = await page.evaluate(() => window.__diag);
        if (diag) {
          console.log('HINTS:', JSON.stringify(diag.hints));
          console.log('SENT:', JSON.stringify(diag.sent));
          console.log('SETTLES:', JSON.stringify(diag.settles, null, 1));
        }
      } catch (e) {}
      await page.screenshot({ path: 'tests/e2e/__screenshots__/aid-navigation-error.png', fullPage: true });
      throw err;
    }
  });

  // 返回（nav_history）：PTT 端沒有「跳轉來源」，返回＝用離開前擷取的錨點再導航
  // 一次。這裡驗的是 unit 測不到的部分：真的 getkeep／真的序號／真的 subject
  // 落地驗證，以及回到原文後好讀重新啟動 ＋ 捲動位置還原。
  test('跳文之後可以返回原文章（序號錨點 ＋ 捲動位置）', async ({ shared }) => {
    test.setTimeout(240000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      // 列表好讀開著才會有序號錨點（listSession.currentAnchor）——這是最常見的
      // 情境：使用者從看板列表開文章，再點文章裡的 AID。
      await applyPrefs(page, {
        enableEasyReading: true,
        enableEasyReadingList: true,
      });

      await gotoBoard(page, BACK_TEST_BOARD);

      // 先跳到第一篇（數字區）。置底文沒有序號，用它當「原文」就沒有序號錨點
      // 可用（currentAnchor 會回 null，退成只回列表的 board 錨點）——那條降級
      // 路徑由 unit 覆蓋，這裡要驗的是最常見的序號錨點。
      await sendKey(page, 'Home');
      await page.waitForTimeout(1500);

      // 游標那篇的 AID＝待會要跳過去的目標。
      await sendKey(page, 'Q');
      await page.waitForTimeout(1500);
      const infoScreen = await readScreen(page);
      const m = infoScreen.match(/文章代碼\(AID\):\s*#([0-9A-Za-z_-]{8})/);
      expect(m).not.toBeNull();
      const targetAid = m[1];
      await sendKey(page, 'Space');
      await page.waitForTimeout(1000);

      // Q 的資訊框是「非列表畫面」→ list 好讀降級 functionMode，之後的方向鍵
      // 是原生 passthrough（游標移動它不知道）。重新進板讓它重新接管列表，
      // 這樣待會的 Enter 才是它自己的序列化開文（＝有可信的序號錨點）。
      await resetSession(page);
      await applyPrefs(page, {
        enableEasyReading: true,
        enableEasyReadingList: true,
      });
      await gotoBoard(page, BACK_TEST_BOARD);
      await sendKey(page, 'Home');
      await page.waitForTimeout(1500);

      // 往下一列開文章：這篇就是「原文」，返回要回到它。
      await sendKey(page, 'ArrowDown');
      await page.waitForTimeout(800);
      await sendKey(page, 'Enter');
      await page.waitForTimeout(5000);

      const originHead = (await readScreen(page)).split('\n').slice(0, 3).join(' / ');
      console.log('ORIGIN HEAD:', originHead);

      // 捲一段距離，讓錨點帶著行索引（文章太短時捲不動，後面的斷言會放行）。
      const scrolled = await page.evaluate(() => {
        const d = window.__app.view.mainDisplay;
        d.scrollTop = Math.min(400, Math.max(0, d.scrollHeight - d.clientHeight));
        return { scrollTop: d.scrollTop, chh: window.__app.view.chh };
      });
      console.log('ORIGIN SCROLL:', JSON.stringify(scrolled));

      const anchor = await page.evaluate(() => {
        const ls = window.__app.listSession;
        return {
          anchor: ls.currentAnchor ? ls.currentAnchor() : null,
          state: ls.state,
          boardName: ls._boardName,
          selectedNum: ls._selectedNum,
          nativeHold: ls._nativeHold,
          renderMode: ls._renderMode,
        };
      });
      console.log('ANCHOR:', JSON.stringify(anchor));

      // 從這裡開始記錄所有 banner（跳轉與返回都要看得到失敗訊息）
      await page.evaluate(() => {
        window.__backHints = [];
        const app = window.__app;
        const orig = app.view.flashListHint.bind(app.view);
        app.view.flashListHint = (msg, ms) => {
          window.__backHints.push(msg);
          return orig(msg, ms);
        };
      });

      // 跳過去。板名直接給（第一條測試已覆蓋 _articleBoard fallback；Test 板的
      // 文章 header 寫的是「站內 Test」而非「看板 Test」，parseArticleBoard 認不得
      // → _articleBoard 為 null，start() 會直接拒絕，那不是這條要驗的東西）。
      await page.evaluate(([aid, board]) => {
        window.__app.aidNavigation.start(aid, board);
      }, [targetAid, BACK_TEST_BOARD]);
      await page.waitForFunction(
        () => window.__app.aidNavigation.active === false,
        null,
        { timeout: 30000 }
      );
      await page.waitForTimeout(3000);

      const canBack = await page.evaluate(() =>
        window.__app.aidNavigation.canGoBack()
      );
      console.log('JUMP HINTS:', JSON.stringify(await page.evaluate(() => window.__backHints)));
      const jumpScreen = await readScreen(page);
      console.log('JUMP HEAD:', jumpScreen.split('\n').slice(0, 2).join(' / '));
      console.log('CAN GO BACK:', canBack);
      expect(canBack).toBe(true);
      // 返回鈕也應該在畫面上（UI 與 stack 是同一個投影）。
      expect(
        await page.evaluate(() => {
          const el = window.__app.view._aidBackEl;
          return !!el && el.style.display !== 'none';
        })
      ).toBe(true);

      // 返回
      await page.evaluate(() => window.__app.aidNavigation.back());
      await page.waitForFunction(
        () => window.__app.aidNavigation.active === false,
        null,
        { timeout: 30000 }
      );
      // 好讀要把整篇重新累積完，捲動還原才會落地。
      await page.waitForTimeout(6000);

      const hints = await page.evaluate(() => window.__backHints);
      console.log('BACK HINTS:', JSON.stringify(hints));
      const backHead = (await readScreen(page)).split('\n').slice(0, 3).join(' / ');
      console.log('BACK HEAD:', backHead);
      const backState = await page.evaluate(() => ({
        pageState: window.__app.buf.pageState,
        scrollTop: window.__app.view.mainDisplay.scrollTop,
      }));
      console.log('BACK STATE:', JSON.stringify(backState));

      expect(hints.filter((h) => h.includes('失敗')).length).toBe(0);
      expect(backState.pageState).toBe(3);
      // 真的回到同一篇（畫面前三列相同）。
      expect(backHead).toBe(originHead);
      // 捲動位置還原（原本捲得動時才驗）。
      if (scrolled.scrollTop > 0) expect(backState.scrollTop).toBeGreaterThan(0);
      // 這層用掉了，返回鈕跟著消失。
      expect(await page.evaluate(() => window.__app.aidNavigation.canGoBack())).toBe(
        false
      );
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-40).join('\n'));
      await page.screenshot({
        path: 'tests/e2e/__screenshots__/aid-back-error.png',
        fullPage: true,
      });
      throw err;
    } finally {
      // 這條測試是全 live 套件裡唯一開列表好讀的，而 resetSession 只關文章好讀
      // ——不還原的話後面的 easy-reading.spec 會在非預期的列表模式下跑（實測：
      // 單獨跑綠、整包跑紅）。
      await applyPrefs(page, { enableEasyReadingList: false });
      // 本測結束時人在文章裡；退回主功能表，讓下一條測試從乾淨狀態起跑。
      try {
        await resetSession(page);
      } catch (e) {}
    }
  });
});
