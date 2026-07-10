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
});
