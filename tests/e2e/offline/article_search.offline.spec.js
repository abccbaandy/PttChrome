// 搜尋彈窗（docs/article-search.md）的端到端行為：真瀏覽器、真 React 彈窗、真
// CommandQueue，只有 WebSocket 是 stub。「server 回什麼」由測試逐幀餵進
// App.onData，「client 送了什麼」從 stub WS 讀回來。
//
// unit（article_search.test.js／search_modal.test.jsx）已經釘死判準與鍵序，這裡守
// unit 碰不到的那半段：
//   - 文章列表按 / 真的開得了彈窗，而且一個 byte 都沒送出去
//   - 送出時「搜尋鍵 → 等 prompt 幀 → 關鍵字＋Enter」整條鏈接得起來（Big5）
//   - 關鍵字記在本機，下次 ↑ 叫得回來（取代被跳號污染的 PTT 輸入記憶）
//   - 設定關掉 ⇒ 回到 PTT 原生 prompt（逃生門）
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

// 頁面裡已經載好 Big5 轉碼表，用它把畫面文字／期望值轉成 server 會送的 bytes。
const U2B_SRC = `(str) => {
  let out = '';
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) { out += ch; continue; }
    out += String.fromCharCode(window.lib.u2bArray[2 * c]) +
      String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
  }
  return out;
}`;

const toBig5 = (page, s) =>
  page.evaluate(({ src, s }) => new Function('return ' + src)()(s), { src: U2B_SRC, s });

// 一整幀文章列表（指紋同 long_push.offline.spec.js 的 drawBoardList：row0／row2 反白、
// 底列「文章選讀」、游標停在條目區第 0 欄）。
async function drawArticleList(page) {
  await page.evaluate((src) => {
    const u2b = new Function('return ' + src)();
    const REV = '\x1b[7m';
    const OFF = '\x1b[0m';
    let d = '\x1b[2J';
    d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
    d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
    d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
    const rows = [
      [1233, 'testuser', '[閒聊] 測試文章'],
      [1234, 'someoneElse', '[公告] 別篇'],
      [1235, 'thirdGuy', '[問卦] 又一篇'],
    ];
    rows.forEach(([n, a, t], i) => {
      d += '\x1b[' + (4 + i) + ';1H' +
        u2b(String(n).padStart(7) + '    ' + ' 9/01 ' + a.padEnd(13).slice(0, 13) + '□' + t);
    });
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  }, U2B_SRC);
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

// PTT 的搜尋 prompt：getdata(b_lines, 0, "搜尋標題: ", …)，游標停在輸入列。
async function drawPrompt(page, text) {
  await page.evaluate(
    ({ src, s }) => {
      const u2b = new Function('return ' + src)();
      window.__app.onData('\x1b[24;1H\x1b[K' + u2b(s));
    },
    { src: U2B_SRC, s: text }
  );
  await waitScreenSettled(page, { 23: text });
}

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

const modalInput = (page) => page.locator('input[name="searchKeyword"]');

async function boot(page) {
  await bootOffline(page, ptt);
  // 自己畫的列表驗的是**原生**路徑；列表好讀一 engage 就會自己往線路送機器鍵。
  await ptt.applyPrefs(page, { enableEasyReadingList: false });
  await drawArticleList(page);
}

test.describe('搜尋彈窗（離線）', () => {
  test('文章列表按 / → 開彈窗、不送 byte；送出走「/ → 等 prompt → 關鍵字」', async ({ page }) => {
    await boot(page);
    await collectSent(page);

    await ptt.sendKey(page, '/');
    await expect(modalInput(page)).toBeVisible();
    expect(await sentText(page)).toBe('');

    await modalInput(page).fill('問卦');
    await modalInput(page).press('Enter');
    await expect(modalInput(page)).toHaveCount(0);
    // 第一步：只有搜尋鍵（＋保證整幀重繪的 \f），關鍵字還沒出去
    await expect.poll(() => sentText(page)).toBe('/\f');

    await drawPrompt(page, '搜尋標題: ');
    const kw = await toBig5(page, '問卦');
    await expect.poll(() => sentText(page)).toBe('/\f' + kw + '\r');
  });

  // REGRESSION（live 錄製檔 live-2026-10-07T12-51-14：`/\f` → End → `\r` 先上線，關鍵字
  // 沒送）：搜尋兩步在途時使用者的鍵不可插隊——插進去的 Enter 會把空 prompt 送出（取消），
  // 之後的關鍵字就落到列表上變成指令。
  test('送出後、prompt 出現前按的鍵不插隊（序列化操作閘門）', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, '/');
    await modalInput(page).fill('問卦');
    await modalInput(page).press('Enter');
    await expect.poll(() => sentText(page)).toBe('/\f');

    await ptt.sendKey(page, 'End');
    await ptt.sendKey(page, 'Enter');
    expect(await sentText(page)).toBe('/\f');

    await drawPrompt(page, '搜尋標題: ');
    const kw = await toBig5(page, '問卦');
    await expect.poll(() => sentText(page)).toBe('/\f' + kw + '\r');
    // server 回搜尋結果（列表全幅重繪）⇒ 第二步收尾、閘門解除，鍵照常送出
    await drawArticleList(page);
    await expect.poll(() => page.evaluate(() => window.__app.searchInFlight)).toBe(false);
    await ptt.sendKey(page, 'End');
    await expect.poll(() => sentText(page)).toBe('/\f' + kw + '\r\x1b[4~');
  });

  test('作者搜尋（a）同樣攔；關鍵字記在本機，下次 ↑ 叫得回來', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, 'a');
    await expect(modalInput(page)).toBeVisible();
    await modalInput(page).fill('someoneElse');
    await modalInput(page).press('Enter');
    await drawPrompt(page, '搜尋作者: ');
    await expect.poll(() => sentText(page)).toBe('a\fsomeoneElse\r');

    // 回到列表再按一次 a：輸入框空的，↑ 叫回上一次的作者
    await drawArticleList(page);
    await ptt.sendKey(page, 'a');
    await expect(modalInput(page)).toBeVisible();
    await expect(modalInput(page)).toHaveValue('');
    await modalInput(page).press('ArrowUp');
    await expect(modalInput(page)).toHaveValue('someoneElse');
    // 存在專用 key，不在 prefs（不會被雲端同步帶走）
    const stored = await page.evaluate(() => ({
      own: localStorage.getItem('pttchrome.searchHistory.v1') || '',
      pref: localStorage.getItem('pttchrome.pref.v1') || '',
    }));
    expect(stored.own).toContain('someoneElse');
    expect(stored.pref).not.toContain('someoneElse');
  });

  test('s 也攔：開成看板搜尋，送出走「s → 等第 1 列 prompt → 板名」', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, 's');
    await expect(modalInput(page)).toBeVisible();
    expect(await sentText(page)).toBe('');
    await modalInput(page).fill('C_Chat');
    await modalInput(page).press('Enter');
    await expect.poll(() => sentText(page)).toBe('s\f');
    // do_select：row0 反白標題、row1 是 prompt，游標停在 row1
    await page.evaluate((src) => {
      const u2b = new Function('return ' + src)();
      window.__app.onData(
        '\x1b[1;1H\x1b[K\x1b[7m' + u2b('【 選擇看板 】') + '\x1b[m' +
          '\x1b[2;1H\x1b[K' + u2b('請輸入看板名稱(按空白鍵自動搜尋): ')
      );
    }, U2B_SRC);
    await waitScreenSettled(page, { 1: '請輸入看板名稱' });
    await expect.poll(() => sentText(page)).toBe('s\fC_Chat\r');
  });

  test('紀錄可以逐筆刪除與全部清除', async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      localStorage.setItem(
        'pttchrome.searchHistory.v1',
        JSON.stringify({ title: ['新的', '舊的'], author: ['someone'], push: [], board: [] })
      )
    );
    await ptt.sendKey(page, '/');
    await expect(modalInput(page)).toBeVisible();
    await page.locator('[data-search-forget="新的"]').click();
    await expect(page.locator('[data-search-recent-item="新的"]')).toHaveCount(0);
    await modalInput(page).press('ArrowUp');
    await expect(modalInput(page)).toHaveValue('舊的');
    await page.locator('[data-search-forget-all]').click();
    await expect(page.locator('[data-search-recent]')).toHaveCount(0);
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('pttchrome.searchHistory.v1')));
    expect(h.title).toEqual([]);
    expect(h.author).toEqual(['someone']);
  });

  test('Esc 關彈窗：什麼都不送，那一下也不落到終端機', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, 'Z');
    await expect(modalInput(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modalInput(page)).toHaveCount(0);
    expect(await sentText(page)).toBe('');
  });

  test('設定關掉 → / 回到 PTT 原生 prompt（逃生門）', async ({ page }) => {
    await boot(page);
    await ptt.applyPrefs(page, { searchKeyOpensModal: false });
    await collectSent(page);
    await ptt.sendKey(page, '/');
    await expect.poll(() => sentText(page)).toBe('/');
    await expect(modalInput(page)).toHaveCount(0);
  });

  test('列表上已經開著 PTT 的 prompt 時，打的 a 是內容不是搜尋', async ({ page }) => {
    await boot(page);
    // 反白輸入欄（vgetstring 的 fg=0/bg=7）＋游標停在欄內 ＝ 有 prompt 開著
    await page.evaluate(() => {
      window.__app.onData('\x1b[24;1H\x1b[K' + 'abc: ' + '\x1b[30;47m' + ' '.repeat(20) + '\x1b[m\x1b[24;6H');
    });
    await waitScreenSettled(page, { 23: 'abc:' });
    await collectSent(page);
    await ptt.sendKey(page, 'a');
    await expect.poll(() => sentText(page)).toBe('a');
    await expect(modalInput(page)).toHaveCount(0);
  });
});
