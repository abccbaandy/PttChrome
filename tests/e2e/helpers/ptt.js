// 可重用的 PTT E2E 工具：讀畫面、等畫面、打字、登入、擷取 console。
// 設計成「讀畫面 → 比對 → 回應」的容錯輪詢，PTT 中間提示頁不固定也能撐住。

const { totpCode, isValidOtpSecret } = require('../../../src/js/totp');

// 登入互動的決策層（純函式，unit 守護 tests/unit/e2e_login_flow.test.js）。
const {
  createLoginState,
  restartLoginBudget,
  decideLoginAction,
} = require('./login_flow');

// DDoS/BOT 封鎖的偵測與跨 worker 閂鎖（見該檔開頭）。
const { assertNotBotBlocked, markBotBlocked } = require('./bot_block');

const SCREEN_SELECTOR = '#mainContainer';

// 讀取終端機整頁文字（#mainContainer 的 innerText）。
async function readScreen(page) {
  const text = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : '';
  }, SCREEN_SELECTOR);
  return (text || '').trim();
}

// 輪詢畫面直到出現任一 substring。回傳命中的字串；timeout 時把當前畫面塞進錯誤訊息。
async function waitForScreen(page, substrings, opts = {}) {
  const list = Array.isArray(substrings) ? substrings : [substrings];
  const timeout = opts.timeout || 30000;
  const interval = opts.interval || 500;
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await readScreen(page);
    const hit = list.find((s) => last.includes(s));
    if (hit) return hit;
    await page.waitForTimeout(interval);
  }
  throw new Error(
    `waitForScreen timeout (${timeout}ms) 等不到 [${list.join(' | ')}]\n` +
    `--- 當前畫面 ---\n${last}\n----------------`
  );
}

// focus 隱藏 input #t，打字後送出（Enter）。
async function typeLine(page, text) {
  await page.locator('#t').focus();
  if (text) await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// 送單一鍵（不換行），用於回應「按任意鍵」等提示。
async function sendKey(page, key) {
  await page.locator('#t').focus();
  await page.keyboard.press(key);
}

// --- 連線健檢（live e2e preflight）---------------------------------------
//
// 沒有這層時，「PTT 維護中／ws.ptt.cc 不可達」與「本專案 code 壞了」的症狀一模一樣：
// 每個 case 都是 `waitForScreen timeout 等不到 [請輸入代號...]`，於是每個 session 都要
// 重新研究一次是誰的問題。這裡把「WebSocket 有沒有連上」單獨驗出來並給明確結論。
//
// connectState 語意見 src/js/pttchrome.jsx：0=連線中、1=已連上、2=已斷線。

const PTT_STATUS_HINT =
  '排查順序：\n' +
  '  1) 開 https://term.ptt.cc 看站台是否可用（PTT 維護／爆量時 live e2e 一律會紅，非本專案 code 問題）。\n' +
  '  2) 確認本機到 ws.ptt.cc 的連線沒被防火牆／VPN 擋掉。\n' +
  '  3) 以上都正常才往本專案的連線程式碼查（src/js/websocket.js、vite.config.mjs 的 /bbs proxy）。\n' +
  '  跳過本檢查：E2E_SKIP_PREFLIGHT=1';

// 純函式：把健檢蒐集到的狀態翻成「一眼看出是誰的問題」的訊息。
// 抽出來是為了能在 tests/unit/e2e_preflight_message.test.js 守護（e2e 自己驗不到它）。
function describeConnectFailure({ hasApp, connectState, screen, timeout }) {
  let verdict;
  if (!hasApp) {
    verdict =
      'app 沒有 boot 起來（window.__app 不存在）。這是**本專案／dev server 的問題**，' +
      '不是 PTT：多半是 bundle 掛了，或 dev server 沒跑起來。';
  } else if (connectState === 1) {
    verdict =
      'WebSocket 連上了，但終端機畫面一直是空的 —— PTT 端接受連線後不吐畫面' +
      '（維護模式常見）。非本專案 code 問題。';
  } else if (connectState === 2) {
    verdict =
      'WebSocket 連不上 PTT（連線已關閉）。**PTT 端不可達或維護中**，非本專案 code 問題。';
  } else {
    verdict =
      'WebSocket 一直停在連線中，握手沒完成。多半是 **PTT 端不可達或網路被擋**，' +
      '非本專案 code 問題。';
  }
  return (
    `PTT 連線健檢失敗（等了 ${timeout}ms）\n` +
    `結論：${verdict}\n` +
    `connectState=${connectState === undefined ? 'n/a' : connectState}\n` +
    `${PTT_STATUS_HINT}\n` +
    `--- 當前畫面 ---\n${screen}\n----------------`
  );
}

// 等 WebSocket 真的連上 PTT；逾時丟出 describeConnectFailure 的明確訊息。
// 呼叫端：preflight.setup.js（整包一次）與 login()（單跑一支 spec 時也有明確訊息）。
async function waitBbsConnected(page, opts = {}) {
  const timeout = opts.timeout || 25000;
  const interval = opts.interval || 300;
  const deadline = Date.now() + timeout;
  let hasApp = false;
  let connectState;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const app = window.__app;
      if (!app) return { hasApp: false };
      return {
        hasApp: true,
        connected: !!app.isConnected(),
        connectState: app.connectState,
      };
    });
    hasApp = st.hasApp;
    connectState = st.connectState;
    if (st.connected) return;
    await page.waitForTimeout(interval);
  }
  const screen = await readScreen(page);
  throw new Error(describeConnectFailure({ hasApp, connectState, screen, timeout }));
}

// 目前 WebSocket 還連著嗎（登入迴圈用來區分「server 還在跑」與「連線已死」）。
// 讀不到 window.__app 時回 undefined，讓決策層當成「未知」而不是「已斷線」。
async function isBbsConnected(page) {
  return page.evaluate(() => (window.__app ? !!window.__app.isConnected() : undefined));
}

// 登入迴圈的輪詢間隔。
const LOGIN_POLL_INTERVAL_MS = 700;

// 核心登入流程。env PTT_USER/PTT_PASS 有值用真實帳號，否則 guest。
// 帳號有 2FA 時另需 PTT_OTP_SECRET。回傳登入結果摘要字串，供測試印出。
//
// 「看到這個畫面該做什麼、逾時該吐什麼訊息」全部在 helpers/login_flow.js 的純函式裡
// （unit 守護：tests/unit/e2e_login_flow.test.js）；這裡只負責把決策變成真正的副作用。
// 這樣切的理由：最會偶發紅的分支是「PTT 端驗證慢，卡在『正在檢查帳號與密碼...』」，
// 真 PTT 上無法穩定重現，只有純函式測得到。
async function login(page) {
  // 這一輪稍早已經判定被 PTT 封鎖 ⇒ 一個 byte 都不要再送（每次重試都在延長封鎖）。
  assertNotBotBlocked();
  const user = process.env.PTT_USER || 'guest';
  const pass = process.env.PTT_PASS || '';
  const otpSecret = process.env.PTT_OTP_SECRET || '';

  // 0. 先確認 WebSocket 連得上：PTT 掛掉時直接給明確結論，而不是讓下面的
  // waitForScreen 逾時、看起來像本專案的畫面解析壞掉。
  await waitBbsConnected(page);

  // 送帳密（節流退避重試時會再呼叫一次）
  const sendCredentials = async () => {
    // 1. 等首畫面（請輸入代號）
    await waitForScreen(page, ['請輸入代號', '請輸入帳號', 'guest'], { timeout: 40000 });

    // 2. 送帳號
    await typeLine(page, user);

    // 3. 真實帳號才需要密碼
    if (user !== 'guest' && pass) {
      await waitForScreen(page, ['請輸入您的密碼', '密碼', 'Password'], { timeout: 20000 });
      await typeLine(page, pass);
    }
  };
  await sendCredentials();

  // 4. 容錯迴圈：處理登入後各種中間提示，直到出現主選單或可辨識的結束標記。
  let state = createLoginState({ user, hasOtpSecret: isValidOtpSecret(otpSecret) });

  for (;;) {
    const screen = await readScreen(page);
    const connected = await isBbsConnected(page);
    const decision = decideLoginAction({ screen, connected, now: Date.now(), state });
    state = decision.state;

    switch (decision.action) {
      case 'done':
        return decision.message;

      case 'fail':
        // 封鎖是**整輪**的事實，不是這條 spec 的事實：立閂鎖，後續 spec 連都不用連。
        // （Playwright 在 test 失敗後會重啟 worker → 共用 session 的 fixture 重建 →
        //   又登入一次，「被鎖」會自己放大成「一直重試」。閂鎖寫檔就是為了跨 worker。）
        if (decision.phase === 'bot-blocked') markBotBlocked(decision.message);
        throw new Error(decision.message);

      case 'send-otp':
        await typeLine(
          page,
          await totpCode(otpSecret, { atMs: Date.now() + decision.otpSkew * 30000 })
        );
        await page.waitForTimeout(800);
        break;

      case 'answer-no':
        await typeLine(page, 'n');
        await page.waitForTimeout(800);
        break;

      case 'press-any-key':
        await sendKey(page, 'Space');
        await page.waitForTimeout(800);
        break;

      case 'reconnect':
        console.log(
          decision.reason === 'server-stall'
            ? `PTT 端停在 ${decision.phase} 不動，${decision.backoffMs}ms 後重新連線重送帳密` +
                `（第 ${decision.attempt} 次）`
            : `偵測到登入節流，等待 ${decision.backoffMs}ms 後重新連線重試（第 ${decision.attempt} 次）`
        );
        await page.waitForTimeout(decision.backoffMs);
        await page.goto('/');
        await waitBbsConnected(page);
        await sendCredentials();
        state = restartLoginBudget(state, Date.now());
        break;

      default:
        // 'wait'：server 正在跑（或畫面還沒變），什麼都別送 —— 亂送鍵只會被緩衝到
        // 下一個 prompt 汙染輸入（依據見 login_flow.js 開頭對 auth_start 的說明）。
        await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
        break;
    }
  }
}

const PREF_KEY = 'pttchrome.pref.v1';

// runtime 套用 prefs（共用 session 不 reload，故不能用 addInitScript）：
// 1) 寫 localStorage —— enableEasyReading 由 easy_reading.js 在 pageState 變化時 live 讀取，下次進文章生效；
// 2) 立即生效的 key 走 window.__app.onPrefChange（showFloorNumbers/blacklist 等，會 redraw）。
async function applyPrefs(page, extra) {
  await page.evaluate(
    (args) => {
      let cur = {};
      try {
        cur = JSON.parse(window.localStorage.getItem(args.KEY) || '{}');
      } catch (e) {}
      const values = Object.assign({}, cur.values, args.extra);
      window.localStorage.setItem(args.KEY, JSON.stringify({ values }));

      const app = window.__app;
      if (!app) return;
      for (const k of Object.keys(args.extra)) {
        const v = args.extra[k];
        if (k === 'enableEasyReading') {
          // onPrefChange('enableEasyReading') 是 no-op；開啟交給 easy_reading live 讀。
          // 關閉時不能只設 useEasyReadingMode=false（React 樹 desync → 畫面凍結），
          // 必須走完整退出配方：easy_reading.js 的 exitEasyReading()
          // （還原 DOM/pageLines + Ctrl-L 重畫 + unmount React 樹）。
          if (!v && app.view.useEasyReadingMode) {
            app.easyReading.exitEasyReading();
          }
        } else {
          app.onPrefChange(k, v);
        }
      }
    },
    { KEY: PREF_KEY, extra }
  );
}

// 動態讀取「有效 pref 值」（DEFAULT_PREFS 疊 localStorage），避免在測試裡 hardcode 可設定的快捷鍵。
// 預設鍵改動（如 easyReadingEndSwitchKey: End→F8）時測試免改。dev build 由 main.js 暴露 window.__readPrefs。
async function getPref(page, key) {
  return page.evaluate((k) => window.__readPrefs()[k], key);
}

// 共用 session 的每個 case 開頭呼叫：容錯迴圈回主選單 + prefs 重設 baseline，避免狀態污染。
async function resetSession(page) {
  const deadline = Date.now() + 25000;
  let screen = '';
  while (Date.now() < deadline) {
    screen = await readScreen(page);
    if (screen.includes('主功能表')) break;
    if (screen.includes('請按任意鍵') || screen.includes('按任意鍵') || screen.includes('任意鍵繼續')) {
      await sendKey(page, 'Space');
    } else {
      await sendKey(page, 'ArrowLeft');
    }
    await page.waitForTimeout(800);
  }
  if (!screen.includes('主功能表')) {
    throw new Error(`resetSession 無法回到主選單\n--- 當前畫面 ---\n${screen}\n----------------`);
  }
  await applyPrefs(page, { enableEasyReading: false, showFloorNumbers: false, blacklist: '' });
  // 關閉好讀會送 Ctrl-L 觸發整頁重畫（見 applyPrefs 註解），等它完成再繼續
  await page.waitForTimeout(800);
}

// 主選單 → s 搜尋看板 → 進到看板文章列表（處理加入最愛等中間提示）。
async function gotoBoard(page, board) {
  const inBoardList = (s) => s.includes('看板') && (s.includes('標題') || s.includes('人氣'));

  await sendKey(page, 's');
  // 必須等搜尋 prompt 真的出現再打字：太早打，板名字元會被主選單當捷徑吃掉
  // （實測 "C_Chat" 的 C 選到 (C)lass 進了分組討論區）。
  await waitForScreen(page, ['請輸入看板名稱', '搜尋看板', '自動搜尋'], { timeout: 10000 });
  await typeLine(page, board);
  await page.waitForTimeout(1500);
  let s = '';
  for (let i = 0; i < 6; i++) {
    s = await readScreen(page);
    if (inBoardList(s)) return;
    if (s.includes('加入') || s.includes('訂閱') || s.includes('我的最愛')) await typeLine(page, 'y');
    else await sendKey(page, 'Space');
    await page.waitForTimeout(800);
  }
  s = await readScreen(page);
  if (!inBoardList(s)) {
    throw new Error(`gotoBoard(${board}) 未能進入看板列表\n--- 當前畫面 ---\n${s}\n----------------`);
  }
}

// 等文章好讀「整篇累積完畢」：easyReadingReachedPageEnd（＝footer 100%，見
// nextEasyReadingRowState 的 pagePercent 判準）成立，且累積出的 DOM 列數連續數次
// 輪詢不變（最後一頁合併進 pageLines、React 也 reconcile 完）。
//
// 為什麼一定要這個 helper：好讀是**自動翻頁**的，翻多久取決於文章長度與網路。
// 用「固定次數 Space + 固定 waitTimeout」去猜停在哪裡，兩次讀同一篇會停在不同位置，
// 任何跨階段的列數比較都失去共同基準（2026-08：黑名單案第一階段 3 次 Space 停在 288
// 列、第二階段 5 次停在 412 列，`c2 < c1` 必紅，看起來像素材不穩，其實是斷言基準不同）。
// 一律等到「整篇」這個唯一可重現的終點再取樣。
//
// 回傳 { rows, reachedEnd, timedOut }；逾時不丟例外，由呼叫端決定要斷言還是 skip。
async function waitEasyReadingComplete(page, opts = {}) {
  const timeout = opts.timeout || 90000;
  const quiet = opts.quiet || 4;          // 需連續幾次輪詢列數不變
  const interval = opts.interval || 600;
  const deadline = Date.now() + timeout;
  let prev = -1;
  let stable = 0;
  let st = { end: false, rows: 0 };
  while (Date.now() < deadline) {
    st = await page.evaluate(() => ({
      end: !!(window.__app && window.__app.easyReading &&
              window.__app.easyReading.easyReadingReachedPageEnd),
      rows: document.querySelectorAll('#mainContainer [data-type="bbsline"]').length,
    }));
    if (st.rows === prev && st.rows > 0) {
      // 到底旗標成立時只要畫面停了就收；還沒到底則多等幾輪，避免翻頁空檔誤判
      if (++stable >= (st.end ? 2 : quiet) && st.end)
        return { rows: st.rows, reachedEnd: true, timedOut: false };
    } else {
      stable = 0;
    }
    prev = st.rows;
    await page.waitForTimeout(interval);
  }
  return { rows: st.rows, reachedEnd: !!st.end, timedOut: true };
}

// 收集 console 與 pageerror，測試失敗時可印出。回傳 logs 陣列。
// opts.echo（或 env E2E_ECHO_CONSOLE）為真時即時印到 stdout，debug 免再自行 filter/join。
function attachConsole(page, opts = {}) {
  const logs = [];
  const echo = opts.echo != null ? opts.echo : !!process.env.E2E_ECHO_CONSOLE;
  const push = (line) => {
    logs.push(line);
    if (echo) console.log(line);
  };
  page.on('console', (msg) => push(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => push(`[pageerror] ${err.message}`));
  return logs;
}

// ---- 黑名單 e2e 的判定純函式（unit 守護：tests/unit/blacklist_pusher_diff.test.js）----
//
// 為什麼不比列數：live 測在同一篇文章讀兩次（封鎖前／後），但熱門板的推文會在兩次之間
// 繼續長，新增列數可以蓋過黑名單移除的列數 ⇒ 任何「c2 < c1」「列數差 >= targetCount」
// 的斷言都會偽紅（實例：黑名單確實生效、目標作者完全消失，卻量到 c2=412 > c1=289）。
// 判定一律走「內容前綴 + 樓號缺口」，對第二次多出的新推文免疫。

// 前後兩次累積的推文者序列比對：before 去掉 target 之後，必須是 after 的前綴；
// after 尾端多出來的就是期間新推文，允許存在。
function comparePusherSequences(before, after, target) {
  const expectedPrefix = before.filter((p) => p !== target);
  const actualPrefix = after.slice(0, expectedPrefix.length);
  let firstMismatch = null;
  for (let i = 0; i < expectedPrefix.length; i++) {
    if (actualPrefix[i] !== expectedPrefix[i]) {
      firstMismatch = { index: i, expected: expectedPrefix[i], actual: actualPrefix[i] };
      break;
    }
  }
  return {
    targetInBefore: before.filter((p) => p === target).length,
    targetInAfter: after.filter((p) => p === target).length,
    expectedPrefix,
    actualPrefix,
    prefixMatches: firstMismatch === null,
    firstMismatch,
    appended: after.slice(expectedPrefix.length),
  };
}

// 單次讀取內的樓號結構檢查。entries 依畫面順序：[{ floor: number|null, blank: boolean }]。
// 樓號是絕對編號（黑名單列仍占樓號），所以「跳號」＝確實有列被整列移除；
// 跳號區間內若出現空白列，代表退化成「隱藏但占行」，就是真回歸。
function inspectFloorGaps(entries) {
  const gaps = [];
  let strictlyIncreasing = true;
  let prevFloor = null;
  let prevIndex = -1;
  entries.forEach((e, i) => {
    if (e.floor == null || Number.isNaN(e.floor)) return;
    if (prevFloor !== null) {
      if (e.floor <= prevFloor) strictlyIncreasing = false;
      else if (e.floor - prevFloor > 1) {
        let blankRowsBetween = 0;
        for (let k = prevIndex + 1; k < i; k++) if (entries[k].blank) blankRowsBetween++;
        gaps.push({ from: prevFloor, to: e.floor, blankRowsBetween });
      }
    }
    prevFloor = e.floor;
    prevIndex = i;
  });
  return { gaps, blankInGaps: gaps.filter((g) => g.blankRowsBetween > 0), strictlyIncreasing };
}

module.exports = {
  readScreen,
  waitForScreen,
  typeLine,
  sendKey,
  login,
  waitBbsConnected,
  describeConnectFailure,
  attachConsole,
  waitEasyReadingComplete,
  applyPrefs,
  resetSession,
  gotoBoard,
  getPref,
  comparePusherSequences,
  inspectFloorGaps,
};
