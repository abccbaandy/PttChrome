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

  test('s 也攔：開成看板搜尋；prompt 沒出現前送出，板名等 prompt 出現才送', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, 's');
    await expect(modalInput(page)).toBeVisible();
    // 看板種類一開就在背景開原生 prompt（比照 PTT 補全，見下一組）
    await expect.poll(() => sentText(page)).toBe('s\f');
    await modalInput(page).fill('C_Chat');
    await modalInput(page).press('Enter');
    await expect(modalInput(page)).toHaveCount(0);
    expect(await sentText(page)).toBe('s\f');
    // do_select：row0 反白標題、row1 是 prompt，游標停在 row1
    await page.evaluate((src) => {
      const u2b = new Function('return ' + src)();
      window.__app.onData(
        '\x1b[1;1H\x1b[K\x1b[7m' + u2b('【 選擇看板 】') + '\x1b[m' +
          '\x1b[2;1H\x1b[K' + u2b('請輸入看板名稱(按空白鍵自動搜尋): ')
      );
    }, U2B_SRC);
    await waitScreenSettled(page, { 1: '請輸入看板名稱' });
    // 輸入欄是空的 ⇒ 不必退格；查詢趟被送出取代（最新的勝出），直接送板名＋Enter
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

// ---- 看板：比照 PTT 原生補全（src/js/board_search_bridge.js）----
// 使用者回報：彈窗的看板搜尋只是普通輸入框；原生會提示後續關鍵字、沒有 bbb 這個看板就
// 打不進 bbb。server 端用一個照 mbbsd/name.c#generalnamecomplete 規則寫的迷你模擬
// （逐字判前綴、空白鍵延伸＋畫「相關資訊一覽表」、Enter 唯一／完全相符才進板、Ctrl-C
// 取消、\f 整幀重繪），驗彈窗 ↔ CommandQueue ↔ 線路整條鏈。
const BOARDS = ['Baseball', 'BabyMother', 'C_Chat', 'GO', 'Golf', 'Golfer', 'Gossiping'];

async function installNameComplete(page) {
  await page.evaluate(
    ({ src, boards }) => {
      const u2b = new Function('return ' + src)();
      const app = window.__app;
      const sorted = boards.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
      const match = (p) => sorted.filter((b) => b.toLowerCase().indexOf(p.toLowerCase()) === 0);
      const st = { mode: 'list', board: 'Test', field: '', listed: null, more: false };
      const PROMPT = '請輸入看板名稱(按空白鍵自動搜尋): ';
      const listFrame = () => {
        const REV = '\x1b[7m';
        const OFF = '\x1b[0m';
        let d = '\x1b[2J';
        d += '\x1b[1;1H' + REV + u2b(('【板主：test】看板《' + st.board + '》').padEnd(80)) + OFF;
        d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
        d += '\x1b[4;1H' + u2b('   1233     9/01 testuser     □[閒聊] 測試文章');
        d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
        return d + '\x1b[4;1H';
      };
      const promptFrame = () => {
        let d = '\x1b[2J\x1b[1;1H\x1b[7m' + u2b('【 選擇看板 】') + '\x1b[m';
        d += '\x1b[2;1H' + u2b(PROMPT) + '\x1b[30;47m' + st.field.padEnd(20) + '\x1b[m';
        if (st.listed) {
          d += '\x1b[3;1H' + u2b('-'.repeat(29) + ' 相關資訊一覽表 ' + '-'.repeat(29));
          st.listed.forEach((name, i) => {
            d += '\x1b[' + (4 + (i % 20)) + ';' + (1 + 22 * Math.floor(i / 20)) + 'H' + name + ' ';
          });
          if (st.more) d += '\x1b[24;1H' + u2b('按空白鍵可列出更多項目');
        }
        return d + '\x1b[2;' + (35 + st.field.length) + 'H';
      };
      const handle = (data) => {
        for (const ch of data) {
          if (st.mode === 'list') {
            if (ch === 's') Object.assign(st, { mode: 'prompt', field: '', listed: null, more: false });
            continue;
          }
          if (ch === '\b') st.field = st.field.slice(0, -1);
          else if (ch === ' ') {
            const m = match(st.field);
            if (!m.length) continue;
            let ext = m.length === 1 ? m[0] : st.field;
            while (
              m.length > 1 &&
              m.every((b) => b.length > ext.length && b[ext.length].toLowerCase() === m[0][ext.length].toLowerCase())
            )
              ext += m[0][ext.length];
            st.field = ext;
            st.listed = m.slice(0, 60);
            st.more = m.length > 60;
          } else if (ch === '\r') {
            const m = match(st.field);
            const exact = m.find((b) => b.toLowerCase() === st.field.toLowerCase());
            const target = m.length === 1 ? m[0] : exact;
            if (st.field && target) st.board = target;
            st.mode = 'list';
          } else if (ch === '\x03') st.mode = 'list';
          else if (ch > ' ' && ch <= '~' && match(st.field + ch).length) st.field += ch;
          // 其他（被拒的字＝bell、\f）：只重畫
        }
        setTimeout(() => app.onData(st.mode === 'list' ? listFrame() : promptFrame()), 5);
      };
      window.__sent = [];
      window.__stubWSSent = (s) => {
        window.__sent.push(s);
        handle(s);
      };
    },
    { src: U2B_SRC, boards: BOARDS }
  );
}

const lastSent = (page) => page.evaluate(() => window.__sent[window.__sent.length - 1]);
const candidates = (page) =>
  page.locator('[data-board-candidate]').evaluateAll((els) => els.map((e) => e.dataset.boardCandidate));

async function openBoardSearch(page) {
  await boot(page);
  await installNameComplete(page);
  await ptt.sendKey(page, 's');
  await expect(modalInput(page)).toBeVisible();
  await expect(page.locator('[data-board-suggest="ready"]')).toHaveCount(1);
  await waitScreenSettled(page, { 1: '請輸入看板名稱' });
}

test.describe('搜尋彈窗：看板比照 PTT 原生補全（離線）', () => {
  test('沒有這個開頭的看板就打不進去（字被退回＋提示），並列出符合的看板', async ({ page }) => {
    await openBoardSearch(page);
    await modalInput(page).pressSequentially('bbb');
    await expect(modalInput(page)).toHaveValue('b');
    await expect(page.locator('[data-board-status]')).toContainText('bb');
    await expect.poll(() => candidates(page)).toEqual(['BabyMother', 'Baseball']);
    // 繼續打合法的字照常收下
    await modalInput(page).pressSequentially('as');
    await expect(modalInput(page)).toHaveValue('bas');
    await expect.poll(() => candidates(page)).toEqual(['Baseball']);
  });

  test('空白鍵自動完成，Enter 在同一個 prompt 上送出板名並進板', async ({ page }) => {
    await openBoardSearch(page);
    await modalInput(page).pressSequentially('goss');
    await expect.poll(() => candidates(page)).toEqual(['Gossiping']);
    await modalInput(page).press('Space');
    await expect(modalInput(page)).toHaveValue('Gossiping');
    await modalInput(page).press('Enter');
    await expect(modalInput(page)).toHaveCount(0);
    await waitScreenSettled(page, { 0: '看板《Gossiping》' });
    expect(await lastSent(page)).toBe('\b'.repeat(9) + 'Gossiping\r');
    // 整段只按過一次 s（送出不會再開一次 prompt）
    const all = await page.evaluate(() => window.__sent.join(''));
    expect(all.split('s\f').length).toBe(2);
    await expect.poll(() => page.evaluate(() => window.__app.searchInFlight)).toBe(false);
  });

  test('多個符合時 Enter 不送；點清單裡的看板直接進板', async ({ page }) => {
    await openBoardSearch(page);
    await modalInput(page).pressSequentially('gol');
    await expect.poll(() => candidates(page)).toEqual(['Golf', 'Golfer']);
    await modalInput(page).press('Enter');
    await expect(modalInput(page)).toBeVisible();
    await page.locator('[data-board-candidate="Golfer"]').click();
    await waitScreenSettled(page, { 0: '看板《Golfer》' });
  });

  test('Esc 關彈窗 ⇒ 送 Ctrl-C 收掉背景的 prompt，回到列表', async ({ page }) => {
    await openBoardSearch(page);
    await modalInput(page).pressSequentially('go');
    await expect.poll(() => candidates(page)).toEqual(['GO', 'Golf', 'Golfer', 'Gossiping']);
    await page.keyboard.press('Escape');
    await expect(modalInput(page)).toHaveCount(0);
    await expect.poll(() => lastSent(page)).toBe('\x03\f');
    await waitScreenSettled(page, { 0: '看板《Test》', 23: '文章選讀' });
    await expect.poll(() => page.evaluate(() => window.__app.searchInFlight)).toBe(false);
  });
});
