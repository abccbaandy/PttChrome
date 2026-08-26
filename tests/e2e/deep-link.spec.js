// Deep link live e2e：在已登入的分頁貼上 #<Board>/<AID> → 自動落在那篇文章。
//
// 這是**唯一**驗得到「主功能表 → s<board> → #<aid> → ⏎ → 落地」整條的地方：unit 驗
// 按鍵序列、offline 驗 URL 進得來，但真正會壞的是與 PTT 的往返（特別是主功能表那個
// 起手式：跳過 escape preamble，不然 ← 會把反白移到 G)oodbye）。
//
// ## 為什麼不自己開站（2026-08-26）
//
// 以前這條會另開一個分頁冷啟動 ⇒ 整輪多一次登入，而登入次數正是 PTT DDoS/BOT 防護的
// 觸發條件（見 tests/e2e/README.md）。現在改走 deep_link_entry.js 明列的**第 2 條**
// 進入路徑：「hashchange（同一個分頁再貼一次連結，不重載、不用重新登入）」——那本來就
// 是產品支援的真實使用路徑，而且跳轉本體與冷啟動**完全同一段 code**：
//
//   location.hash = '#Board/AID'
//     → deep_link_entry 的 hashchange 監聽 → consume()
//     → DeepLinkController.request(target)
//     → _canNavigate()（連著 + 看過主功能表 + 沒有跳轉在跑）
//     → _dispatch()：startedEasyReading === false ⇒ nav.startExternal()  ← 冷啟動同一支
//
// 所以前置條件要對齊冷啟動落地當下的狀態：**停在主功能表、好讀尚未啟動**
// （resetSession 兩件事都做到）。
//
// 換掉的覆蓋度（刻意）：冷啟動特有的「連結先到、人還沒登入 ⇒ _hold 收著等登入完成」
// 那段時序。DeepLinkController 的 _hold/_pending 守在
// tests/unit/deep_link_controller.test.js（含 handoff 來源的通知）。
const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  applyPrefs,
  resetSession,
  gotoBoard,
} = require('./helpers/ptt');

// 刻意挑一個**有進板畫面**的看板：deep link 走的是 viaMenu 板跳
// （ReadSelect() → Read()），本 session 首次進板一定先吃到進板畫面 pmore ＋
// pressanykey（mbbsd/bbs.c:4482-4492）。而文章內的 s 走 more.c:177 的 Select()，
// 從來不顯示進板畫面 —— 所以既有的 AID 點擊跳文測試涵蓋不到這條路徑，2026-08-16
// 就是在這裡卡死的（好讀模式把進板公告當文章、自動送 PageDown 餵掉 pressanykey）。
// 同時避開 C_Chat（會動到 enhance / easy-reading 依賴的 server 游標）與 Test
// （幾乎只有置底文，而置底文的 AID 搜尋在 mbbsd/read.c:404 就是會失手）。
const BOARD = 'Steam';

const AID_RE = /文章代碼\(AID\):\s*#([0-9A-Za-z_-]{8})/;

test('deep link：貼上 #<Board>/<AID> → 自動落在該篇文章', async ({ shared }) => {
  test.skip(
    !process.env.PTT_USER || !process.env.PTT_PASS,
    '需 env PTT_USER/PTT_PASS：deep link 要等登入完成才跳'
  );
  test.setTimeout(180000);
  const { page, logs } = shared;
  logs.length = 0;

  // 1) 先撈一個真的存在的 AID —— 隨機挑是不行的，PTT 上不存在的 AID 只會得到「找不到」。
  await resetSession(page);
  await gotoBoard(page, BOARD);
  await sendKey(page, 'Q'); // 大寫 Q＝文章資訊框（小寫 q 是離板）
  await page.waitForTimeout(1500);
  const infoScreen = await readScreen(page);
  const m = infoScreen.match(AID_RE);
  console.log('DEEP LINK TARGET AID:', m && m[1]);
  expect(m).not.toBeNull();
  const aid = m[1];
  await sendKey(page, 'Space'); // 關資訊框
  await page.waitForTimeout(1000);

  try {
    // 2) 回到冷啟動落地當下的狀態：主功能表 + 好讀尚未啟動（_dispatch 因此走
    //    startExternal，與冷啟動同一支）。resetSession 會把好讀關掉，跳完之後
    //    要是好讀模式 ⇒ 得在派工前把 pref 打開。
    await resetSession(page);
    await applyPrefs(page, { enableEasyReading: true });

    // 診斷：hint 是失敗時唯一講得清楚卡在哪一步的東西；sent 用來確認真的走過
    // 進板畫面的關框（← ），也就是這條路徑真的被覆蓋到了。
    await page.evaluate(() => {
      const app = window.__app;
      window.__diag = { hints: [], sent: [] };
      // 共用 session：wrapper 一定要留得住還原路徑，否則後面每一條 spec 都在跑
      // 這裡的 JSON.stringify（見本 test 的 finally）。
      window.__diagRestore = {
        flashListHint: app.view.flashListHint,
        _send: app.commandQueue._send,
        onSettle: app.commandQueue.onSettle,
      };
      const orig = app.view.flashListHint.bind(app.view);
      app.view.flashListHint = (msg, ms) => {
        window.__diag.hints.push(msg);
        return orig(msg, ms);
      };
      const q = app.commandQueue;
      const origSend = q._send;
      q._send = (d) => {
        window.__diag.sent.push(JSON.stringify(d));
        return origSend(d);
      };
      window.__diag.settles = [];
      const origSettle = q.onSettle.bind(q);
      q.onSettle = (snap, facts) => {
        window.__diag.settles.push({
          kind: facts.kind,
          boardName: facts.boardName,
          inFlight: q.inFlightKind,
          row0: (facts.rowTexts[0] || '').slice(0, 40),
          lastRow: (facts.rowTexts[facts.rows - 1] || '').slice(0, 50),
          curY: facts.curY,
        });
        return origSettle(snap, facts);
      };
    });

    // 3) 貼上連結。**完全不按任何鍵**：hashchange → consume() → controller 派工 → 落地。
    const before0 = await page.evaluate(() => ({
      started: window.__app.buf.startedEasyReading,
      pageState: window.__app.buf.pageState,
    }));
    console.log('BEFORE HASH:', JSON.stringify(before0));
    expect(before0.started).toBe(false); // 沒有這個前提就不是 startExternal 那條路
    await page.evaluate((h) => {
      window.location.hash = h;
    }, '#' + BOARD + '/' + aid);

    await page.waitForFunction(
      () => window.__app.buf.pageState === 3 && window.__app.aidNavigation.active === false,
      null,
      { timeout: 120000 }
    );
    await page.waitForTimeout(2000);

    const diag = await page.evaluate(() => window.__diag);
    console.log('HINTS:', JSON.stringify(diag.hints));
    console.log('SENT:', JSON.stringify(diag.sent));
    // 這條路徑的重點：進板畫面真的被關掉了（← ）。沒看到就是這次剛好沒進板畫面，
    // 覆蓋度不如預期 —— 印出來讓人看得見，不硬斷言（板況不是我們能控制的）。
    console.log(
      'ENTER-BOARD DISMISS SEEN:',
      diag.sent.some((s) => s.indexOf('\\u001b[D') >= 0)
    );
    expect(diag.hints.filter((h) => h.includes('失敗')).length).toBe(0);

    // 4) 網址列必須指向**現在真的在讀的那一篇**。
    //
    // 2026-08-17 起網址列會自動同步（_syncAddressBar）：消費掉進來的 hash 之後，
    // 一旦畫面上讀得到「※ 文章網址」那行就把連結補回去。所以這裡不再是「hash 必須
    // 空」——真正的不變量是「hash 絕不可以指向**別篇**」（那才會讓 F5 跳錯地方）。
    // 補不回來（長文還沒滾到那行）時停在空字串，也是合格的。
    const hashTarget = await page.evaluate(() =>
      location.hash ? window.__parseDeepLink(location.href) : null
    );
    console.log('ADDRESS BAR:', JSON.stringify(hashTarget));
    if (hashTarget) expect(hashTarget).toEqual({ board: BOARD, aid });

    // 5) 落在「正確的那一篇」＋「複製本篇連結不影響畫面」，一次驗完。
    //
    // 刻意**不**用 sendKey 手動按 Q 來比對 AID：那是繞過 CommandQueue 的裸鍵，
    // 好讀模式沒進 functionMode，它的自動翻頁會送 PageDown 餵掉資訊框的
    // pressanykey，接著的空白鍵就落到文章 pager 上 → 直接離開該篇。也就是說
    // 那種驗法本身會弄壞被驗的狀態（實測踩過）。改用產品自己的「複製本篇連結」：
    // 它走 functionMode + CommandQueue，複製出來的連結裡就含 AID —— 既是落點的
    // 硬證據，也同時回歸守護 2026-08-16 那個「複製完就跳出文章」的 bug。
    const before = await page.evaluate(() => {
      // spy 掉剪貼簿：headless 沒有剪貼簿權限，而我們要驗的是「產品打算複製什麼」。
      window.__copied = [];
      navigator.clipboard.writeText = (t) => {
        window.__copied.push(t);
        return Promise.resolve();
      };
      return {
        pageState: window.__app.buf.pageState,
        started: window.__app.buf.startedEasyReading,
        easyReading: window.__app.view.useEasyReadingMode,
        functionMode: window.__app.buf.easyReadingFunctionMode,
      };
    });
    console.log('BEFORE COPY:', JSON.stringify(before));
    expect(before.pageState).toBe(3);

    // 落地就該是好讀模式，不需要使用者按 End（實測 2026-08-16：deep link 跳完停在
    // 原生模式）。兩個成因都在這裡守住：
    //   - 目標文章是踩著 **0→3** settle edge 進來的（前一步 AID 搜尋落地的 footer
    //     列是空的 ⇒ pageState 0），nextEasyReadingState 的 1|2→3 永遠不成立 ⇒
    //     必須由 aid_navigation 落地時的 ensureEnabledOnArticle 補上。
    //   - _enterFunctionMode 以前在好讀關閉時也會設旗標，而那個旗標只有
    //     _onScreenSettled 的 enabled 分支清得掉 ⇒ 永久卡住 ⇒ 連 End/F8 手動切回
    //     的 gate（term_view.onKeyDown 的 !easyReadingFunctionMode）都一起死掉。
    expect(before.easyReading).toBe(true);
    expect(before.functionMode).toBe(false);

    await sendKey(page, 'F2');
    await expect
      .poll(() => page.evaluate(() => window.__copied.length), { timeout: 20000 })
      .toBe(1);
    const copied = await page.evaluate(() => window.__copied[0]);
    console.log('COPIED LINK:', copied);
    // 連結是檔名形式（#<Board>/M.<v1>.A.<v2>.html），肉眼比不出 AID ⇒ 用合約自己的
    // 解析端還原回 { board, aid } 再比。這同時也驗到「產生 → 解析」真的可逆。
    expect(copied).toContain('#' + BOARD + '/M.');
    expect(await page.evaluate((l) => window.__parseDeepLink(l), copied)).toEqual({
      board: BOARD,
      aid,
    });

    // 關框後畫面必須原封不動回到這篇文章。
    await expect
      .poll(() => page.evaluate(() => window.__app.buf.pageState), { timeout: 20000 })
      .toBe(3);
    const afterCopy = await page.evaluate(() => ({
      pageState: window.__app.buf.pageState,
      started: window.__app.buf.startedEasyReading,
    }));
    console.log('AFTER COPY:', JSON.stringify(afterCopy));
    expect(afterCopy.started).toBe(true);
    expect(diag.hints.filter((h) => h.includes('複製連結失敗')).length).toBe(0);
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-40).join('\n'));
    try {
      const diag = await page.evaluate(() => window.__diag);
      if (diag) {
        console.log('HINTS:', JSON.stringify(diag.hints));
        console.log('SENT:', JSON.stringify(diag.sent));
        console.log('SETTLES:', JSON.stringify(diag.settles, null, 1));
      }
      console.log('SCREEN:', await readScreen(page));
    } catch (e) {}
    await page.screenshot({ path: 'tests/e2e/__screenshots__/deep-link-error.png', fullPage: true });
    throw err;
  } finally {
    // 共用 session 的規矩：離開時把 wrapper 拆掉、hash 清掉。page 會被後面每一條
    // spec 沿用，留著的話它們每一次 _send/onSettle 都在跑這裡的 JSON.stringify。
    await page.evaluate(() => {
      try {
        const r = window.__diagRestore;
        if (r) {
          window.__app.view.flashListHint = r.flashListHint;
          window.__app.commandQueue._send = r._send;
          window.__app.commandQueue.onSettle = r.onSettle;
          window.__diagRestore = null;
        }
      } catch (e) {}
      // 清 hash 會再觸發一次 hashchange → consume()，但 parseDeepLink('') 是 null，
      // 不會派工（deep_link_entry.consume 的第一道就是它）。
      try {
        window.location.hash = '';
      } catch (e) {}
    });
  }
});
