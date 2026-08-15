// 可重用的 PTT E2E 工具：讀畫面、等畫面、打字、登入、擷取 console。
// 設計成「讀畫面 → 比對 → 回應」的容錯輪詢，PTT 中間提示頁不固定也能撐住。

const { totpCode, isValidOtpSecret } = require('../../../src/js/totp');

// 時鐘偏差階梯（30 秒為一階），與 src/js/auto_login.js#OTP_SKEW_STEPS 同義：
// server 自己已容忍 ±30s，所以 step 0 就吃掉小偏差；偏差更大時只有換窗才救得回來。
const OTP_SKEW_STEPS = [0, -1, 1];

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

// dev build 啟動時會跳 DeveloperModeAlert，按掉它 app 才會開始連線。
async function dismissDeveloperModeAlert(page) {
  const btn = page.getByRole('button', { name: 'Yes, I understand.' });
  try {
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();
  } catch (e) {
    // 非 dev / 沒有此 modal 時略過
  }
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
      '不是 PTT：多半是 bundle 掛了、Developer Mode modal 沒被關掉，或 dev server 沒跑起來。';
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

// 帳號有開 PTT 兩階段驗證時，用 env PTT_OTP_SECRET（Base32 或整段 otpauth:// 網址）
// 即時算出 6 位驗證碼。marker 與偵測規則同 src/js/auto_login.js（勿用 '2FA' 當 marker：
// 成功訊息與「找不到 2FA 設定檔」自癒訊息都含它）。
const OTP_PROMPT_MARKERS = ['請輸入兩階段', '位限時數字', '位救援碼'];
const otpPromptVisible = (screen) => OTP_PROMPT_MARKERS.some((m) => screen.includes(m));

// 核心登入流程。env PTT_USER/PTT_PASS 有值用真實帳號，否則 guest。
// 帳號有 2FA 時另需 PTT_OTP_SECRET。回傳登入結果摘要字串，供測試印出。
async function login(page) {
  const user = process.env.PTT_USER || 'guest';
  const pass = process.env.PTT_PASS || '';
  const otpSecret = process.env.PTT_OTP_SECRET || '';

  // 0. dev 模式會先跳「Developer Mode」警告 modal，需先關閉，app 才會 connect()。
  await dismissDeveloperModeAlert(page);

  // 0.5 先確認 WebSocket 連得上：PTT 掛掉時直接給明確結論，而不是讓下面的
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
  const MAIN_MENU = ['主功能表', '【主功能表】'];
  let throttleRetries = 0;
  let otpSent = 0;
  let deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const screen = await readScreen(page);

    // 已達主選單 → 成功
    if (MAIN_MENU.some((m) => screen.includes(m))) {
      return `登入成功（${user}）`;
    }

    // 兩階段驗證（2FA）→ 用 PTT_OTP_SECRET 算出當下驗證碼。PTT 給 5 次機會，
    // 這裡最多送 OTP_SKEW_STEPS.length 次，每次換一個時鐘偏差窗（見下方註解）。
    if (screen.includes('兩階段驗證失敗次數過多')) {
      throw new Error(
        `兩階段驗證失敗次數過多\n--- 當前畫面 ---\n${screen}\n----------------`
      );
    }
    if (otpPromptVisible(screen)) {
      if (!isValidOtpSecret(otpSecret)) {
        throw new Error(
          `帳號 ${user} 需要兩階段驗證，但沒有可用的 PTT_OTP_SECRET。\n` +
          '  $env:PTT_OTP_SECRET="你的 2FA 密鑰（Base32 或整段 otpauth:// 網址）"\n' +
          `--- 當前畫面 ---\n${screen}\n----------------`
        );
      }
      const rejected = screen.includes('驗證碼錯誤');
      if (rejected && otpSent >= OTP_SKEW_STEPS.length) {
        throw new Error(
          `兩階段驗證碼連續 ${otpSent} 次未通過（試過時鐘偏差 ` +
          `${OTP_SKEW_STEPS.join('/')} 窗都被拒 → 密鑰錯誤，或本機時鐘偏差超過 ±90 秒）\n` +
          `--- 當前畫面 ---\n${screen}\n----------------`
        );
      }
      if (otpSent === 0 || rejected) {
        // prompt 還在但沒有錯誤訊息＝server 還在驗，繼續等。
        // 被拒就換下一個時鐘偏差窗——**不可以只是等 30 秒再送**：那只是把同一個
        // 相位往後推一格，本機時鐘固定偏 N 秒時每一次都會落在同樣（錯的）窗，
        // 於是「重試」永遠是同一個結論（2026-08 實測：本機快 33 秒 → 連兩次被拒）。
        // 階梯與理由同 src/js/auto_login.js#OTP_SKEW_STEPS。
        const skew = OTP_SKEW_STEPS[otpSent] || 0;
        otpSent++;
        await typeLine(
          page,
          await totpCode(otpSecret, { atMs: Date.now() + skew * 30000 })
        );
      }
      await page.waitForTimeout(800);
      continue;
    }

    // PTT 登入節流（登入太頻繁, 請稍後再試）→ 退避後 reload 重連重送帳密，最多 2 次。
    // 實測節流後畫面卡在該訊息不動（連線疑似被掐），按鍵無效，必須重新連線。
    if (screen.includes('登入太頻繁') || screen.includes('登入次數太頻繁')) {
      if (throttleRetries >= 2) {
        throw new Error(
          `登入節流，退避重試 ${throttleRetries} 次仍失敗\n--- 當前畫面 ---\n${screen}\n----------------`
        );
      }
      throttleRetries++;
      console.log(`偵測到登入節流，等待 30s 後重新連線重試（第 ${throttleRetries} 次）`);
      await page.waitForTimeout(30000);
      await page.goto('/');
      await dismissDeveloperModeAlert(page);
      await waitBbsConnected(page);
      await sendCredentials();
      deadline = Date.now() + 40000;
      continue;
    }

    // 重複登入 → 不刪除其他連線
    if (screen.includes('您想刪除其他重複登入') || screen.includes('重複登入')) {
      await typeLine(page, 'n');
      await page.waitForTimeout(800);
      continue;
    }

    // 保留聊天/連線紀錄等 y/n 提示 → 預設 n
    if (screen.includes('您要刪除以上錯誤嘗試') || screen.includes('是否保留') ||
        screen.includes('保留上次') || screen.includes('清除錯誤嘗試')) {
      await typeLine(page, 'n');
      await page.waitForTimeout(800);
      continue;
    }

    // 「請按任意鍵繼續」類提示 → 送空白
    if (screen.includes('請按任意鍵') || screen.includes('按任意鍵') ||
        screen.includes('任意鍵繼續') || screen.includes('Press any key')) {
      await sendKey(page, 'Space');
      await page.waitForTimeout(800);
      continue;
    }

    // 帳號密碼錯誤 → 直接報錯，帶畫面
    if (screen.includes('密碼不對') || screen.includes('無法登入') ||
        screen.includes('密碼或代號錯誤')) {
      throw new Error(`登入失敗（帳密錯誤）\n--- 當前畫面 ---\n${screen}\n----------------`);
    }

    // guest 名額已滿（PTT 常見） → 立即報錯，提示改用真實帳號
    if (screen.includes('太多 guest') || screen.includes('guest 在站上')) {
      throw new Error(
        'guest 名額已滿（PTT 端限制）。請設定環境變數 PTT_USER / PTT_PASS 用真實帳號登入：\n' +
        '  $env:PTT_USER="你的帳號"; $env:PTT_PASS="你的密碼"; npm run test:e2e\n' +
        `--- 當前畫面 ---\n${screen}\n----------------`
      );
    }

    await page.waitForTimeout(700);
  }

  // 逾時：丟出最後畫面供除錯
  const screen = await readScreen(page);
  throw new Error(
    `login 逾時，未進入主選單（user=${user}）\n--- 當前畫面 ---\n${screen}\n----------------`
  );
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

module.exports = {
  readScreen,
  waitForScreen,
  typeLine,
  sendKey,
  login,
  waitBbsConnected,
  describeConnectFailure,
  attachConsole,
  dismissDeveloperModeAlert,
  applyPrefs,
  resetSession,
  gotoBoard,
  getPref,
};
