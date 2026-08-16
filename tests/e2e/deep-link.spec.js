// Deep link live e2e：帶 #<Board>/<AID> 開站 → 自動登入 → 自動落在那篇文章。
//
// 這是**唯一**驗得到完整鏈的地方：unit 驗按鍵序列、offline 驗 URL 進得來，但
// 「冷啟動 → 登入 → 主功能表 → s<board> → #<aid> → ⏎」整條只有真 PTT 跑得出來。
// 特別是主功能表那個起手式（跳過 escape preamble，不然 ← 會把反白移到 G)oodbye）。
//
// 需要獨立 page（要測開站流程本身，不能用共用 session 的已登入 page），但**同時**
// 拿 shared 來撈一個真實 AID —— 隨機挑 AID 是不行的，PTT 上不存在的 AID 只會得到
// 「找不到」。
const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  attachConsole,
  dismissDeveloperModeAlert,
  resetSession,
  gotoBoard,
} = require('./helpers/ptt');

const KEY = 'pttchrome.pref.v1';

// 刻意挑一個**有進板畫面**的看板：deep link 冷啟動走的是 viaMenu 板跳
// （ReadSelect() → Read()），本 session 首次進板一定先吃到進板畫面 pmore ＋
// pressanykey（mbbsd/bbs.c:4482-4492）。而文章內的 s 走 more.c:177 的 Select()，
// 從來不顯示進板畫面 —— 所以既有的 AID 點擊跳文測試涵蓋不到這條路徑，2026-08-16
// 就是在這裡卡死的（好讀模式把進板公告當文章、自動送 PageDown 餵掉 pressanykey）。
// 同時避開 C_Chat（會動到 enhance / easy-reading 依賴的 server 游標）與 Test
// （幾乎只有置底文，而置底文的 AID 搜尋在 mbbsd/read.c:404 就是會失手）。
const BOARD = 'Steam';

const AID_RE = /文章代碼\(AID\):\s*#([0-9A-Za-z_-]{8})/;

test('deep link：帶 #<Board>/<AID> 開站 → 自動登入後落在該篇文章', async ({ shared, page }) => {
  const user = process.env.PTT_USER;
  const pass = process.env.PTT_PASS;
  const otpSecret = process.env.PTT_OTP_SECRET || '';
  test.skip(!user || !pass, '需 env PTT_USER/PTT_PASS：deep link 要等登入完成才跳');
  test.setTimeout(180000);
  const logs = attachConsole(page);

  // 1) 用共用 session 撈一個真的存在的 AID。
  await resetSession(shared.page);
  await gotoBoard(shared.page, BOARD);
  await sendKey(shared.page, 'Q'); // 大寫 Q＝文章資訊框（小寫 q 是離板）
  await shared.page.waitForTimeout(1500);
  const infoScreen = await readScreen(shared.page);
  const m = infoScreen.match(AID_RE);
  console.log('DEEP LINK TARGET AID:', m && m[1]);
  expect(m).not.toBeNull();
  const aid = m[1];
  await sendKey(shared.page, 'Space'); // 關資訊框
  await shared.page.waitForTimeout(1000);

  try {
    // 2) 新分頁帶 deep link 開站。autoLoginDupConn:'N' —— 共用 session 還掛著，
    //    PTT 會多問一次「重複登入」。
    await page.addInitScript((args) => {
      try {
        const cur = JSON.parse(window.localStorage.getItem(args.KEY) || '{}');
        const values = Object.assign({}, cur.values, args.extra);
        window.localStorage.setItem(args.KEY, JSON.stringify({ values }));
      } catch (e) {}
    }, {
      KEY,
      extra: {
        autoLogin: true,
        autoLoginUser: user,
        autoLoginPassword: pass,
        autoLoginOtpSecret: otpSecret,
        autoLoginDupConn: 'N',
        autoLoginSkipWelcome: true,
        enableEasyReading: true,
      },
    });

    await page.goto('/#' + BOARD + '/' + aid);
    await dismissDeveloperModeAlert(page);

    // 診斷：hint 是失敗時唯一講得清楚卡在哪一步的東西；sent 用來確認真的走過
    // 進板畫面的關框（← ），也就是這條路徑真的被覆蓋到了。
    await page.evaluate(() => {
      const app = window.__app;
      window.__diag = { hints: [], sent: [] };
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

    // 3) 完全不按任何鍵：自動登入 → controller 在主功能表 settle 時派工 → 落地。
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

    // 4) 用過的 hash 要被清掉（F5 不重跳）。
    expect(await page.evaluate(() => location.hash)).toBe('');

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
      };
    });
    console.log('BEFORE COPY:', JSON.stringify(before));
    expect(before.pageState).toBe(3);

    await sendKey(page, 'F2');
    await expect
      .poll(() => page.evaluate(() => window.__copied.length), { timeout: 20000 })
      .toBe(1);
    const copied = await page.evaluate(() => window.__copied[0]);
    console.log('COPIED LINK:', copied);
    expect(copied).toContain('#' + BOARD + '/' + aid);

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
  }
});
