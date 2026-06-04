// 可重用的 PTT E2E 工具：讀畫面、等畫面、打字、登入、擷取 console。
// 設計成「讀畫面 → 比對 → 回應」的容錯輪詢，PTT 中間提示頁不固定也能撐住。

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

// 核心登入流程。env PTT_USER/PTT_PASS 有值用真實帳號，否則 guest。
// 回傳登入結果摘要字串，供測試印出。
async function login(page) {
  const user = process.env.PTT_USER || 'guest';
  const pass = process.env.PTT_PASS || '';

  // 0. dev 模式會先跳「Developer Mode」警告 modal，需先關閉，app 才會 connect()。
  await dismissDeveloperModeAlert(page);

  // 1. 等首畫面（請輸入代號）
  await waitForScreen(page, ['請輸入代號', '請輸入帳號', 'guest'], { timeout: 40000 });

  // 2. 送帳號
  await typeLine(page, user);

  // 3. 真實帳號才需要密碼
  if (user !== 'guest' && pass) {
    await waitForScreen(page, ['請輸入您的密碼', '密碼', 'Password'], { timeout: 20000 });
    await typeLine(page, pass);
  }

  // 4. 容錯迴圈：處理登入後各種中間提示，直到出現主選單或可辨識的結束標記。
  const MAIN_MENU = ['主功能表', '【主功能表】'];
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const screen = await readScreen(page);

    // 已達主選單 → 成功
    if (MAIN_MENU.some((m) => screen.includes(m))) {
      return `登入成功（${user}）`;
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

// 收集 console 與 pageerror，測試失敗時可印出。回傳 logs 陣列。
function attachConsole(page) {
  const logs = [];
  page.on('console', (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
  return logs;
}

module.exports = { readScreen, waitForScreen, typeLine, sendKey, login, attachConsole };
