import {
  LOGIN_IDLE_BUDGET_MS,
  LOGIN_SERVER_PROGRESS_BUDGET_MS,
  LOGIN_SERVER_STALL_MS,
  LOGIN_STALL_BACKOFF_MS,
  classifyLoginScreen,
  createLoginState,
  restartLoginBudget,
  decideLoginAction,
  describeLoginTimeout,
} from '../e2e/helpers/login_flow';

// live e2e 登入迴圈的決策層（tests/e2e/helpers/ptt.js#login 用）。
//
// 為什麼在 unit 測：這裡最會偶發紅的分支是「PTT 端驗證慢，畫面停在
// 『正在檢查帳號與密碼...』」——真 PTT 快的時候永遠走不到，慢的時候整條 spec 紅，
// 而且重跑就過。live e2e 沒辦法穩定重現，只有純函式餵畫面序列測得到。

// 依 pttbbs daemon/logind/logind.c 的實際字串組出畫面（帳號一律遮成 ***，
// 這是公開 repo）。
const PROMPT = '請輸入代號，或以 guest 參觀，或以 new 註冊: ***';
const VERIFYING = `${PROMPT}\n正在檢查帳號與密碼...`;
const STARTING = `${PROMPT}\n密碼正確！ 開始登入系統...`;
const MAIN_MENU = '【主功能表】 (C)類別 (F)分類 ...';

// 把「一連串畫面」餵進 reducer，回傳每一輪的決策，模擬 login() 的輪詢迴圈。
function drive(steps, opts = {}) {
  let state = createLoginState({ now: 0, user: '***', ...opts });
  const log = [];
  for (const step of steps) {
    const d = decideLoginAction({
      screen: step.screen,
      now: step.at,
      connected: step.connected,
      state,
    });
    state = d.state;
    log.push(d);
    if (d.action === 'done' || d.action === 'fail') break;
  }
  return { log, state, last: log[log.length - 1] };
}

describe('classifyLoginScreen', () => {
  test.each([
    [MAIN_MENU, 'main-menu'],
    [VERIFYING, 'server-verifying'],
    [STARTING, 'server-starting'],
    ['開始登入系統...', 'server-starting'], // FREEAUTH_SUCCESS_MSG（guest）
    ['密碼不對喔！請檢查帳號及密碼大小寫有無輸入錯誤。', 'bad-credentials'],
    ['登入太頻繁, 為避免系統負荷過重, 請稍後再試', 'throttled'],
    ['您想刪除其他重複登入的連線嗎？[Y/n]', 'confirm-no'],
    ['請按任意鍵繼續', 'any-key'],
    ['抱歉，目前已有太多 guest 在站上。', 'guest-full'],
    ['抱歉，部份系統正在維護中，請稍候再試。', 'maintenance'],
    [' 系統過載, 請稍後再來... ', 'overloaded'],
    [' 由於人數過多，請您稍後再來... ', 'overloaded'],
    [' 抱歉，此帳號或服務已達上限。 ', 'quota-rejected'],
    ['請輸入兩階段(2FA)驗證碼(6位限時數字 或8位救援碼):', 'tfa-prompt'],
    ['兩階段驗證失敗次數過多。', 'tfa-locked'],
    [PROMPT, 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (screen, phase) => {
    expect(classifyLoginScreen(screen)).toBe(phase);
  });

  test('2FA 成功訊息不可被當成 2FA prompt（marker 不能用 "2FA"）', () => {
    expect(classifyLoginScreen('2FA 兩階段驗證成功。')).not.toBe('tfa-prompt');
    expect(classifyLoginScreen('[系統提示] 找不到 2FA 設定檔，已自動重設 2FA 狀態。')).not.toBe(
      'tfa-prompt'
    );
  });
});

describe('「正在檢查帳號與密碼...」＝PTT 端正在驗，不是「不知道發生什麼事」', () => {
  // 這幾條把「延長預算」與「卡住就地重連」分開測：前者關掉重連（maxServerStallRetries: 0）
  // 才看得出預算本身有沒有撐住，後者另開一個 describe。
  const noRetry = { maxServerStallRetries: 0 };

  // 這條就是本次 bug 的回歸守護：改動前整個登入迴圈只有固定 40 秒，
  // 帳密送出後 PTT 端慢一點就會在這個畫面上撞死，吐一則泛用逾時。
  test('超過原本的 40 秒固定預算仍繼續等，不逾時', () => {
    const { last } = drive(
      [
        { screen: PROMPT, at: 500 },
        { screen: VERIFYING, at: 1000 },
        { screen: VERIFYING, at: LOGIN_IDLE_BUDGET_MS + 1000 },
      ],
      noRetry
    );
    expect(last.phase).toBe('server-verifying');
    expect(last.action).toBe('wait');
  });

  test('等待期間什麼鍵都不送（亂送會被緩衝到下一個 prompt）', () => {
    const { log } = drive(
      [
        { screen: VERIFYING, at: 1000 },
        { screen: VERIFYING, at: 5000 },
        { screen: VERIFYING, at: 20000 },
      ],
      noRetry
    );
    expect(log.map((d) => d.action)).toEqual(['wait', 'wait', 'wait']);
  });

  test('延長有上限：停在同一畫面超過 server 進度預算就逾時', () => {
    const { last } = drive(
      [
        { screen: VERIFYING, at: 1000 },
        { screen: VERIFYING, at: 1000 + LOGIN_SERVER_PROGRESS_BUDGET_MS },
      ],
      noRetry
    );
    expect(last.action).toBe('fail');
  });

  test('逾時訊息講清楚是 PTT 端的問題，別讓下個 session 去追被測 code', () => {
    const { last } = drive(
      [
        { screen: VERIFYING, at: 1000 },
        { screen: VERIFYING, at: 1000 + LOGIN_SERVER_PROGRESS_BUDGET_MS },
      ],
      noRetry
    );
    expect(last.message).toContain('正在檢查帳號與密碼');
    expect(last.message).toContain('PTT 端驗證逾時');
    expect(last.message).toContain('非本專案 code 問題');
    expect(last.message).toContain('auth_start');
    expect(last.message).toContain('phase=server-verifying');
    // 泛用訊息（改動前唯一會吐的那則）不可以是這個 case 的結論
    expect(last.message).not.toContain('無法辨識的狀態');
  });

  test('server 往前走一步（verifying → 開始登入系統）就重新起算預算', () => {
    const { last } = drive(
      [
        { screen: VERIFYING, at: 1000 },
        { screen: STARTING, at: LOGIN_SERVER_PROGRESS_BUDGET_MS },
        { screen: STARTING, at: LOGIN_SERVER_PROGRESS_BUDGET_MS + 10000 },
      ],
      noRetry
    );
    expect(last.phase).toBe('server-starting');
    expect(last.action).toBe('wait');
  });

  test('「開始登入系統」卡住的逾時訊息指向 logind→mbbsd 交接，不指向本專案', () => {
    const { last } = drive(
      [
        { screen: STARTING, at: 1000 },
        { screen: STARTING, at: 1000 + LOGIN_SERVER_PROGRESS_BUDGET_MS },
      ],
      noRetry
    );
    expect(last.action).toBe('fail');
    expect(last.message).toContain('開始登入系統');
    expect(last.message).toContain('非本專案 code 問題');
    expect(last.message).toContain('ACK_TIMEOUT_SEC');
  });

  test('驗證途中連線斷掉 → 立刻收工，不用把延長預算等滿', () => {
    const { last } = drive([
      { screen: VERIFYING, at: 1000, connected: true },
      { screen: VERIFYING, at: 3000, connected: false },
    ]);
    expect(last.action).toBe('fail');
    expect(last.message).toContain('斷線');
    expect(last.message).toContain('connected=false');
  });

  test('connected 未知（讀不到 window.__app）時不可誤判成斷線', () => {
    const { last } = drive([{ screen: VERIFYING, at: 1000, connected: undefined }]);
    expect(last.action).toBe('wait');
  });
});

describe('卡在「server 正在跑」太久 → 就地重連重送帳密', () => {
  // 實測依據：整輪 live e2e 只有一條卡滿 46 秒紅掉，下一條 spec 12 秒後另開連線就登入
  // 成功 ⇒ 壞的是那條連線而不是站台，換一條比乾等有用。
  test('停在同一畫面超過 stall 門檻 → reconnect（短退避，不是節流那種 30 秒）', () => {
    const { last } = drive([
      { screen: VERIFYING, at: 1000 },
      { screen: VERIFYING, at: 1000 + LOGIN_SERVER_STALL_MS },
    ]);
    expect(last.action).toBe('reconnect');
    expect(last.reason).toBe('server-stall');
    expect(last.backoffMs).toBe(LOGIN_STALL_BACKOFF_MS);
    expect(last.attempt).toBe(1);
  });

  test('門檻之內不重連（正常的驗證是一瞬間，不要浪費登入次數）', () => {
    const { last } = drive([
      { screen: VERIFYING, at: 1000 },
      { screen: VERIFYING, at: 1000 + LOGIN_SERVER_STALL_MS - 1 },
    ]);
    expect(last.action).toBe('wait');
  });

  test('重連次數用完後改回等待，等到預算用完才判逾時', () => {
    // 模擬 login()：收到 reconnect 就重送帳密並重新起算預算，然後又卡在同一畫面。
    let state = createLoginState({ now: 0, user: '***' });
    let now = 0;
    const actions = [];
    for (let round = 0; round < 3; round++) {
      now += 1000;
      let d = decideLoginAction({ screen: VERIFYING, now, state, connected: true });
      state = d.state;
      now += LOGIN_SERVER_STALL_MS;
      d = decideLoginAction({ screen: VERIFYING, now, state, connected: true });
      state = d.state;
      actions.push(d.action);
      if (d.action === 'reconnect') state = restartLoginBudget(state, now + d.backoffMs);
    }
    expect(actions).toEqual(['reconnect', 'reconnect', 'wait']);

    // 第三輪不再重連 ⇒ 撐到 server 進度預算用完才逾時，並在結論裡寫出重連過幾次。
    const d = decideLoginAction({
      screen: VERIFYING,
      now: state.progressSince + LOGIN_SERVER_PROGRESS_BUDGET_MS,
      state,
      connected: true,
    });
    expect(d.action).toBe('fail');
    expect(d.message).toContain('已就地重連重送帳密 2 次');
    expect(d.message).toContain('非本專案 code 問題');
  });
});

describe('既有分支的行為不變', () => {
  test('主選單 → done', () => {
    const { last } = drive([{ screen: MAIN_MENU, at: 1000 }]);
    expect(last.action).toBe('done');
    expect(last.message).toContain('登入成功');
  });

  test('重複登入提示 → 送 n；請按任意鍵 → 送空白', () => {
    const { log } = drive([
      { screen: '您想刪除其他重複登入的連線嗎？[Y/n]', at: 1000 },
      { screen: '請按任意鍵繼續', at: 2000 },
      { screen: MAIN_MENU, at: 3000 },
    ]);
    expect(log.map((d) => d.action)).toEqual(['answer-no', 'press-any-key', 'done']);
  });

  test('帳密錯誤 → 直接報帳密錯誤（連線隨後被 logind 關掉也不可誤報成斷線）', () => {
    const { last } = drive([
      { screen: '密碼不對喔！請檢查帳號及密碼大小寫有無輸入錯誤。', at: 1000, connected: false },
    ]);
    expect(last.action).toBe('fail');
    expect(last.message).toContain('帳密錯誤');
    expect(last.message).not.toContain('斷線');
  });

  test('guest 名額已滿 → 提示改用真實帳號', () => {
    const { last } = drive([{ screen: '抱歉，目前已有太多 guest 在站上。', at: 1000 }]);
    expect(last.action).toBe('fail');
    expect(last.message).toContain('PTT_USER');
  });

  test('PTT 維護／過載 → 明講非本專案 code（原本只會空轉到泛用逾時）', () => {
    for (const screen of [
      '抱歉，部份系統正在維護中，請稍候再試。',
      ' 由於人數過多，請您稍後再來... ',
    ]) {
      const { last } = drive([{ screen, at: 1000 }]);
      expect(last.action).toBe('fail');
      expect(last.message).toContain('非本專案 code 問題');
    }
  });

  test('登入節流 → 退避重連，超過次數才放棄', () => {
    const throttled = '登入太頻繁, 為避免系統負荷過重, 請稍後再試';
    let state = createLoginState({ now: 0, user: '***' });
    const actions = [];
    for (let i = 0; i < 3; i++) {
      const d = decideLoginAction({ screen: throttled, now: 1000, state });
      actions.push(d.action);
      // 重連成功後 login() 會重送帳密並重新起算預算
      state = d.action === 'reconnect' ? restartLoginBudget(d.state, 1000) : d.state;
      if (d.action === 'fail') {
        expect(d.message).toContain('退避重試 2 次仍失敗');
      }
    }
    expect(actions).toEqual(['reconnect', 'reconnect', 'fail']);
  });

  test('重連後預算重新起算（不會沿用舊 deadline 馬上再逾時）', () => {
    const state = createLoginState({ now: 0 });
    const restarted = restartLoginBudget(state, 100000);
    expect(restarted.deadline).toBe(100000 + LOGIN_IDLE_BUDGET_MS);
    expect(restarted.progressSince).toBeNull();
  });
});

describe('兩階段驗證', () => {
  const TFA = '請輸入兩階段(2FA)驗證碼(6位限時數字 或8位救援碼):';
  const TFA_REJECTED = `${TFA}\n驗證碼錯誤！請確認後重新輸入。`;

  test('沒有 PTT_OTP_SECRET → 直接說要設哪個環境變數', () => {
    const { last } = drive([{ screen: TFA, at: 1000 }], { hasOtpSecret: false });
    expect(last.action).toBe('fail');
    expect(last.message).toContain('PTT_OTP_SECRET');
  });

  test('第一次用偏差 0 的窗；被拒才換下一個窗', () => {
    const { log } = drive(
      [
        { screen: TFA, at: 1000 },
        { screen: TFA_REJECTED, at: 3000 },
        { screen: TFA_REJECTED, at: 5000 },
      ],
      { hasOtpSecret: true }
    );
    expect(log.map((d) => d.action)).toEqual(['send-otp', 'send-otp', 'send-otp']);
    expect(log.map((d) => d.otpSkew)).toEqual([0, -1, 1]);
  });

  test('prompt 還在但沒有錯誤訊息＝server 還在驗，不重送', () => {
    const { log } = drive(
      [
        { screen: TFA, at: 1000 },
        { screen: TFA, at: 2000 },
      ],
      { hasOtpSecret: true }
    );
    expect(log.map((d) => d.action)).toEqual(['send-otp', 'wait']);
  });

  test('三個時鐘偏差窗都被拒 → 指向密鑰錯誤或本機時鐘偏差', () => {
    const { last } = drive(
      [
        { screen: TFA, at: 1000 },
        { screen: TFA_REJECTED, at: 2000 },
        { screen: TFA_REJECTED, at: 3000 },
        { screen: TFA_REJECTED, at: 4000 },
      ],
      { hasOtpSecret: true }
    );
    expect(last.action).toBe('fail');
    expect(last.message).toContain('本機時鐘偏差');
  });

  test('失敗次數過多 → 停手（別把 PTT 給的 5 次機會用光）', () => {
    const { last } = drive([{ screen: '兩階段驗證失敗次數過多。', at: 1000 }], {
      hasOtpSecret: true,
    });
    expect(last.action).toBe('fail');
    expect(last.message).toContain('兩階段驗證失敗次數過多');
  });
});

describe('describeLoginTimeout', () => {
  test('辨識不出畫面時，明講可能是 login() 少了分支並指到該補的地方', () => {
    const msg = describeLoginTimeout({
      user: '***',
      phase: 'unknown',
      screen: '某個沒看過的提示頁',
      connected: true,
      waitedMs: 40000,
    });
    expect(msg).toContain('classifyLoginScreen');
    expect(msg).toContain('某個沒看過的提示頁');
    expect(msg).toContain('40000ms');
  });

  test('一律附上當前畫面與 phase，方便下一個 session 直接判讀', () => {
    const msg = describeLoginTimeout({
      user: '***',
      phase: 'server-verifying',
      screen: VERIFYING,
      connected: true,
      waitedMs: 46000,
    });
    expect(msg).toContain('--- 當前畫面 ---');
    expect(msg).toContain('phase=server-verifying');
  });
});
