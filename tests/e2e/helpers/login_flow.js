'use strict';

// PTT 登入互動迴圈的**純決策層**：吃「當前畫面文字 ＋ 現在時間 ＋ WebSocket 還連著嗎」，
// 吐「下一步該做什麼」與「逾時要吐什麼訊息」。副作用（打字／重連／丟例外）留在
// tests/e2e/helpers/ptt.js#login。
//
// 為什麼要抽出來（同 describeConnectFailure 的理由）：這裡最容易壞的分支是
// 「PTT 端驗證慢，畫面停在『正在檢查帳號與密碼...』」——真 PTT 快的時候永遠走不到，
// 慢的時候整條 spec 紅。live e2e 沒辦法穩定重現，只能用純函式在 unit 餵畫面序列守護
// （tests/unit/e2e_login_flow.test.js）。
//
// 畫面字串的依據一律是 pttbbs 原始碼，不從錄到的畫面反推（CLAUDE.md 慣例段）：
//   daemon/logind/logind.c  PASSWD_CHECK_MSG /AUTH_SUCCESS_MSG / FREEAUTH_SUCCESS_MSG /
//                           AUTH_FAIL_MSG(ERR_PASSWD) / TFA_PROMPT_MSG / TFA_FAIL_MSG /
//                           SERVICE_FAIL_MSG / OVERLOAD_CPU_MSG / OVERLOAD_USER_MSG /
//                           TOO_MANY_GUEST_MSG / REJECT_FREE_UID_MSG
//   mbbsd/talk.c            「登入太頻繁, 為避免系統負荷過重, 請稍後再試」
//   mbbsd/mbbsd.c           「您想刪除其他重複登入的連線嗎？」
//
// 關鍵事實（決定了「卡住時該等還是該重連」）：
//   logind 的 auth_start() 先畫 PASSWD_CHECK_MSG，接著**同步**呼叫 auth_user_challenge()
//   驗帳密（passwd_load_user / checkuser_passwd / 2FA 檔案讀取）。驗完才會再吐畫面。
//   期間 server 不吃鍵盤、也不會有任何輸出，所以 client 除了「等」沒有別的事可做——
//   亂送鍵只會被緩衝到下一個 prompt 汙染輸入。
//   通過之後畫 AUTH_SUCCESS_MSG 並 start_service() 把連線交給 mbbsd 等 ack
//   （server 端 ACK_TIMEOUT_SEC = 5 分鐘）；mbbsd 那側的 multi_user_check() 還有
//   usleep(0~1s) ＋ usleep(0~5s) ＋ 踢連線迴圈 usleep(1~3s)。這兩段都屬「server 正在跑」，
//   同樣只能等。

// 沒有可辨識進度時的預算（＝原本整個登入迴圈的固定 40 秒）。
const LOGIN_IDLE_BUDGET_MS = 40000;
// 停在「server 正在跑」畫面時，從進入該畫面起算的額外預算。
// 上限存在的理由：不能無限等——真的卡死時要吐出「這是 PTT 端的問題」，而不是讓
// Playwright 的 test timeout 蓋掉我們的訊息（那則訊息不帶畫面，無從判斷是誰的問題）。
const LOGIN_SERVER_PROGRESS_BUDGET_MS = 45000;
// 停在同一個「server 正在跑」畫面超過這麼久 ⇒ 就地重連重送帳密（理由見下方 case）。
// 正常驗證是一瞬間的事，15 秒已經遠超任何合理值。
const LOGIN_SERVER_STALL_MS = 15000;
// 卡住重連的退避。與登入節流那個 30 秒不同：這裡不是被 PTT 擋，只是這條連線卡住，
// 不需要長退避。
const LOGIN_STALL_BACKOFF_MS = 2000;

// 時鐘偏差階梯（30 秒為一階），與 src/js/auto_login.js#OTP_SKEW_STEPS 同義：
// server 自己已容忍 ±30s，所以 step 0 就吃掉小偏差；偏差更大時只有換窗才救得回來。
const OTP_SKEW_STEPS = [0, -1, 1];

// 兩階段驗證 prompt 的 marker，同 src/js/auto_login.js（勿用 '2FA' 當 marker：
// 成功訊息與「找不到 2FA 設定檔」自癒訊息都含它）。
const OTP_PROMPT_MARKERS = ['請輸入兩階段', '位限時數字', '位救援碼'];
const otpPromptVisible = (screen) => OTP_PROMPT_MARKERS.some((m) => screen.includes(m));

const MAIN_MENU_MARKERS = ['主功能表', '【主功能表】'];

const has = (screen, markers) => markers.some((m) => screen.includes(m));

// 「server 正在跑，client 只能等」的階段。
const SERVER_PROGRESS_PHASES = ['server-verifying', 'server-starting'];

// 畫面 → 階段。順序即優先權，與原本 login() 迴圈的分支順序一致。
function classifyLoginScreen(screen) {
  const s = screen || '';
  if (has(s, MAIN_MENU_MARKERS)) return 'main-menu';
  if (s.includes('兩階段驗證失敗次數過多')) return 'tfa-locked';
  if (otpPromptVisible(s)) return 'tfa-prompt';
  if (s.includes('登入太頻繁') || s.includes('登入次數太頻繁')) return 'throttled';
  if (s.includes('您想刪除其他重複登入') || s.includes('重複登入')) return 'confirm-no';
  if (
    s.includes('您要刪除以上錯誤嘗試') ||
    s.includes('是否保留') ||
    s.includes('保留上次') ||
    s.includes('清除錯誤嘗試')
  )
    return 'confirm-no';
  if (
    s.includes('請按任意鍵') ||
    s.includes('按任意鍵') ||
    s.includes('任意鍵繼續') ||
    s.includes('Press any key')
  )
    return 'any-key';
  if (s.includes('密碼不對') || s.includes('無法登入') || s.includes('密碼或代號錯誤'))
    return 'bad-credentials';
  if (s.includes('太多 guest') || s.includes('guest 在站上')) return 'guest-full';
  // 以下三個是 PTT 端的容量／維護狀態（logind 畫完就關連線），原本沒有分支 ⇒
  // 只會空轉到 40 秒逾時，然後吐一則看不出是誰的問題的泛用訊息。
  if (s.includes('部份系統正在維護中')) return 'maintenance';
  if (s.includes('系統過載') || s.includes('人數過多')) return 'overloaded';
  if (s.includes('此帳號或服務已達上限')) return 'quota-rejected';
  // server 正在跑的兩個階段。
  if (s.includes('正在檢查帳號與密碼')) return 'server-verifying';
  if (s.includes('開始登入系統')) return 'server-starting';
  return 'unknown';
}

function createLoginState(opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const idleBudgetMs = o.idleBudgetMs == null ? LOGIN_IDLE_BUDGET_MS : o.idleBudgetMs;
  return {
    user: o.user || 'guest',
    hasOtpSecret: !!o.hasOtpSecret,
    idleBudgetMs,
    serverProgressBudgetMs:
      o.serverProgressBudgetMs == null
        ? LOGIN_SERVER_PROGRESS_BUDGET_MS
        : o.serverProgressBudgetMs,
    maxThrottleRetries: o.maxThrottleRetries == null ? 2 : o.maxThrottleRetries,
    maxServerStallRetries: o.maxServerStallRetries == null ? 2 : o.maxServerStallRetries,
    startedAt: now,
    deadline: now + idleBudgetMs,
    phase: null,
    progressSince: null,
    otpSent: 0,
    throttleRetries: 0,
    serverStallRetries: 0,
  };
}

// 節流重連／重送帳密之後，把「無進度預算」整個重新起算（原本 login() 的作法）。
function restartLoginBudget(state, now) {
  const t = now == null ? Date.now() : now;
  return Object.assign({}, state, {
    deadline: t + state.idleBudgetMs,
    phase: null,
    progressSince: null,
  });
}

function fail(state, message) {
  return { state, phase: state.phase, action: 'fail', message };
}

function withScreen(msg, screen) {
  return `${msg}\n--- 當前畫面 ---\n${screen}\n----------------`;
}

// 核心 reducer：回傳 { state（下一輪的計時狀態）, phase, action, ... }。
// action：
//   done          登入完成
//   wait          什麼都別做，睡一下再讀一次畫面
//   send-otp      送兩階段驗證碼（otpSkew ＝這次要用的時鐘偏差格數）
//   answer-no     送 'n' + Enter
//   press-any-key 送空白
//   reconnect     退避 backoffMs → 重新連線 → 重送帳密（節流專用）
//   fail          丟出 message
function decideLoginAction(input) {
  const screen = input.screen || '';
  const connected = input.connected;
  const now = input.now == null ? Date.now() : input.now;
  const phase = classifyLoginScreen(screen);
  const state = Object.assign({}, input.state, { phase });

  // 進入／停在「server 正在跑」的畫面：從第一次看到它起算，把 deadline 撐到該階段的預算。
  // 換階段（server-verifying → server-starting）重新起算，因為那代表 server 真的往前走了。
  if (SERVER_PROGRESS_PHASES.indexOf(phase) >= 0) {
    if (input.state.phase !== phase || input.state.progressSince == null) {
      state.progressSince = now;
    }
    const until = state.progressSince + state.serverProgressBudgetMs;
    if (until > state.deadline) state.deadline = until;
  } else {
    state.progressSince = null;
  }

  if (phase === 'main-menu') {
    return { state, phase, action: 'done', message: `登入成功（${state.user}）` };
  }

  if (now >= state.deadline) {
    return fail(
      state,
      describeLoginTimeout({
        user: state.user,
        phase,
        screen,
        connected,
        waitedMs: now - state.startedAt,
        serverStallRetries: state.serverStallRetries,
      })
    );
  }

  // 連線在登入途中斷掉：畫面不會再更新了，等到預算用完只是浪費時間。
  // 只對「server 還在跑／看不懂的畫面」這樣判：帳密錯誤、guest 名額滿、維護中這些**終局
  // 畫面**，logind 本來就會畫完之後把連線關掉（AUTHFAIL_SLEEP_SEC），那要報畫面上寫的原因，
  // 不是報斷線。
  if (connected === false && (phase === 'unknown' || SERVER_PROGRESS_PHASES.indexOf(phase) >= 0)) {
    return fail(
      state,
      describeLoginTimeout({
        user: state.user,
        phase,
        screen,
        connected,
        waitedMs: now - state.startedAt,
        serverStallRetries: state.serverStallRetries,
      })
    );
  }

  switch (phase) {
    case 'tfa-locked':
      return fail(state, withScreen('兩階段驗證失敗次數過多', screen));

    case 'tfa-prompt': {
      if (!state.hasOtpSecret) {
        return fail(
          state,
          withScreen(
            `帳號 ${state.user} 需要兩階段驗證，但沒有可用的 PTT_OTP_SECRET。\n` +
              '  $env:PTT_OTP_SECRET="你的 2FA 密鑰（Base32 或整段 otpauth:// 網址）"',
            screen
          )
        );
      }
      const rejected = screen.includes('驗證碼錯誤');
      if (rejected && state.otpSent >= OTP_SKEW_STEPS.length) {
        return fail(
          state,
          withScreen(
            `兩階段驗證碼連續 ${state.otpSent} 次未通過（試過時鐘偏差 ` +
              `${OTP_SKEW_STEPS.join('/')} 窗都被拒 → 密鑰錯誤，或本機時鐘偏差超過 ±90 秒）`,
            screen
          )
        );
      }
      if (state.otpSent === 0 || rejected) {
        // 被拒就換下一個時鐘偏差窗——**不可以只是等 30 秒再送**：那只是把同一個相位
        // 往後推一格，本機時鐘固定偏 N 秒時每次都落在同樣（錯的）窗，於是「重試」
        // 永遠是同一個結論（2026-08 實測：本機快 33 秒 → 連兩次被拒）。
        const skew = OTP_SKEW_STEPS[state.otpSent] || 0;
        return {
          state: Object.assign({}, state, { otpSent: state.otpSent + 1 }),
          phase,
          action: 'send-otp',
          otpSkew: skew,
        };
      }
      // prompt 還在但沒有錯誤訊息＝server 還在驗，繼續等。
      return { state, phase, action: 'wait' };
    }

    case 'throttled': {
      // 實測節流後畫面卡在該訊息不動、按鍵無效，必須重新連線。依據 mbbsd/talk.c：
      // multi_user_check() 判定 flooding 後 outs() 完就 sleep(30); exit(0)，連線等同已死。
      if (state.throttleRetries >= state.maxThrottleRetries) {
        return fail(
          state,
          withScreen(`登入節流，退避重試 ${state.throttleRetries} 次仍失敗`, screen)
        );
      }
      const next = Object.assign({}, state, {
        throttleRetries: state.throttleRetries + 1,
      });
      return {
        state: next,
        phase,
        action: 'reconnect',
        backoffMs: 30000,
        attempt: next.throttleRetries,
      };
    }

    case 'server-verifying':
    case 'server-starting': {
      // 實測（2026-08）：卡在這個畫面時，壞掉的是**這條連線**而不是整個站台——同一輪
      // live e2e 裡，這條 spec 卡滿 46 秒紅掉，下一條 spec 12 秒後另開連線就登入成功；
      // 使用者單獨重跑該 spec 也是 3 秒就過。所以停太久就地重連重送帳密，比乾等有用。
      // 仍保留「等到預算用完才判逾時」當最後一道：PTT 真的整體慢時重連也沒用，那時要
      // 吐的是「PTT 端的問題」而不是無限重試。
      if (
        now - state.progressSince >= LOGIN_SERVER_STALL_MS &&
        state.serverStallRetries < state.maxServerStallRetries
      ) {
        const next = Object.assign({}, state, {
          serverStallRetries: state.serverStallRetries + 1,
        });
        return {
          state: next,
          phase,
          action: 'reconnect',
          reason: 'server-stall',
          backoffMs: LOGIN_STALL_BACKOFF_MS,
          attempt: next.serverStallRetries,
        };
      }
      return { state, phase, action: 'wait' };
    }

    case 'confirm-no':
      return { state, phase, action: 'answer-no' };

    case 'any-key':
      return { state, phase, action: 'press-any-key' };

    case 'bad-credentials':
      return fail(state, withScreen('登入失敗（帳密錯誤）', screen));

    case 'guest-full':
      return fail(
        state,
        withScreen(
          'guest 名額已滿（PTT 端限制）。請設定環境變數 PTT_USER / PTT_PASS 用真實帳號登入：\n' +
            '  $env:PTT_USER="你的帳號"; $env:PTT_PASS="你的密碼"; yarn test:e2e',
          screen
        )
      );

    case 'maintenance':
      return fail(
        state,
        withScreen(
          '結論：**PTT 端維護中**（logind 的 SERVICE_FAIL_MSG），非本專案 code 問題。\n' +
            '先開 https://term.ptt.cc 確認站台，恢復後重跑即可。',
          screen
        )
      );

    case 'overloaded':
      return fail(
        state,
        withScreen(
          '結論：**PTT 端過載／人數已滿**（logind 的 OVERLOAD_MSG），非本專案 code 問題。\n' +
            '晚點重跑即可。',
          screen
        )
      );

    case 'quota-rejected':
      return fail(
        state,
        withScreen('結論：**PTT 端拒絕此帳號／服務（已達上限）**，非本專案 code 問題。', screen)
      );

    default:
      break;
  }

  return { state, phase, action: 'wait' };
}

// 逾時（或途中斷線）的訊息。重點是**一眼看出是誰的問題**，別讓下一個 session 又去追
// 被測 code（先例：tests/e2e/preflight.setup.js 的 describeConnectFailure）。
function describeLoginTimeout(opts) {
  const { user, phase, screen, connected } = opts;
  const waitedMs = opts.waitedMs == null ? 0 : opts.waitedMs;
  const stallRetries = opts.serverStallRetries || 0;
  // 有重連過就寫進結論：換了新連線還是卡在同一畫面，就不是「這條連線壞掉」而已了。
  const retried = stallRetries
    ? `\n（期間已就地重連重送帳密 ${stallRetries} 次，換新連線仍卡在同一畫面）`
    : '';

  let headline;
  let verdict;

  if (connected === false) {
    headline = 'login 中斷：WebSocket 在登入途中斷線';
    verdict =
      '結論：**連線被 PTT 端關掉或網路斷了**，非本專案 code 問題（畫面停在斷線當下那一幀）。\n' +
      '先開 https://term.ptt.cc 確認站台，再看本機到 ws.ptt.cc 的連線有沒有被擋。';
  } else if (phase === 'server-verifying') {
    headline = 'login 逾時：PTT 端一直停在「正在檢查帳號與密碼...」';
    verdict =
      '結論：**PTT 端驗證逾時，非本專案 code 問題。**\n' +
      '依據 pttbbs daemon/logind/logind.c#auth_start：畫出這行之後 logind 會「同步」呼叫\n' +
      'auth_user_challenge() 驗帳密，期間不吐畫面也不吃鍵盤 —— client 除了等沒有別的事能做，\n' +
      '所以這不是等待策略寫錯，是 PTT 端這次真的慢（站台尖峰偶發）。' +
      retried +
      '\n處置：直接重跑該支 spec；連續多次卡在同一畫面才需要懷疑帳號被鎖或站台異常。';
  } else if (phase === 'server-starting') {
    headline = 'login 逾時：PTT 端停在「開始登入系統...」';
    verdict =
      '結論：**PTT 端配位／交接逾時，非本專案 code 問題。**\n' +
      '依據 pttbbs：logind 已驗過帳密並 start_service() 把連線交給 mbbsd，正在等 ack\n' +
      '（server 端 ACK_TIMEOUT_SEC = 5 分鐘）；mbbsd 的 multi_user_check() 另有數秒隨機 sleep。' +
      retried +
      '\n處置：直接重跑該支 spec。';
  } else if (phase === 'unknown') {
    headline = `login 逾時，未進入主選單（user=${user}）`;
    verdict =
      '畫面停在無法辨識的狀態。若下方畫面是 PTT 的某個提示頁，代表 login() 少了對應分支，\n' +
      '請把它加進 tests/e2e/helpers/login_flow.js#classifyLoginScreen 並補 unit 測試。';
  } else {
    headline = `login 逾時，未進入主選單（user=${user}，卡在 ${phase}）`;
    verdict =
      `辨識得出畫面（${phase}）但一直沒往前走。先看下方畫面是不是 PTT 端的狀態，\n` +
      '再考慮是不是 login() 對這個階段的處置無效。';
  }

  return (
    `${headline}（等了 ${waitedMs}ms）\n` +
    `${verdict}\n` +
    `phase=${phase} connected=${connected === undefined ? 'n/a' : connected}\n` +
    `--- 當前畫面 ---\n${screen}\n----------------`
  );
}

module.exports = {
  LOGIN_IDLE_BUDGET_MS,
  LOGIN_SERVER_PROGRESS_BUDGET_MS,
  LOGIN_SERVER_STALL_MS,
  LOGIN_STALL_BACKOFF_MS,
  OTP_SKEW_STEPS,
  SERVER_PROGRESS_PHASES,
  classifyLoginScreen,
  createLoginState,
  restartLoginBudget,
  decideLoginAction,
  describeLoginTimeout,
  otpPromptVisible,
};
