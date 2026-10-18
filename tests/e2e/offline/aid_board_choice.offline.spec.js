// 沒寫看板的 #AID → 先問看板（src/js/aid_board_choice.js）—— 離線重放守門。
//
// unit 守了判準與 ContextMenu 的接線；這裡守真渲染鏈上的接點：好讀畫出來的
// a.aidLink（data-board=""）→ term_view.onAidClick → App.onAidClick → React 彈窗，
// 以及「其他看板」走的是 `s` 看板搜尋彈窗的原生補全（真 BoardSearchBridge／CommandQueue），
// 在 prompt 上進板後才由 aidNavigation 接手 #AID。
//
// 素材：ask-aid-wrap（同 aid_wrap.offline.spec.js），卷裡唯一的 #1gU3wwNZ 的看板寫在
// 下一則推文開頭的 "(Browsers)"。在 server bytes 裡把那段換成等長空白 ⇒ 同一條
// 真實推文變成無看板的 #AID（只改後綴，版面欄位不動）；DOM 的 data-board 不能拿來
// 改，點擊端用的是渲染時綁進 handler 的 board。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');

const CASSETTE = 'ask-aid-wrap';
const SUFFIX = '(Browsers)';

function stripBoardSuffix(c) {
  let hits = 0;
  const steps = c.steps.map((s) => {
    if (!s.recv) return s;
    const bytes = Buffer.from(s.recv, 'base64').toString('latin1');
    if (bytes.indexOf(SUFFIX) < 0) return s;
    hits += 1;
    const recv = Buffer.from(bytes.split(SUFFIX).join(' '.repeat(SUFFIX.length)), 'latin1');
    return Object.assign({}, s, { recv: recv.toString('base64') });
  });
  if (!hits) throw new Error(`${CASSETTE} 裡找不到 ${SUFFIX}：素材換了，本 spec 要跟著改`);
  return Object.assign({}, c, { steps });
}

let raw = null;
try {
  raw = loadCassette(CASSETTE);
} catch (e) {
  raw = null;
}
// 不包進 try：找不到後綴要紅，不是靜默 skip。
const cassette = raw ? stripBoardSuffix(raw) : null;

async function boardlessLink(page) {
  const links = page.locator('a.aidLink[data-board=""]');
  await expect(links.first()).toBeVisible({ timeout: 15000 });
  return links.first();
}

test.describe('無看板 AID 的看板選擇（離線重放）', () => {
  test.skip(!cassette, `缺 cassette ${CASSETTE}.json`);

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: true });
  });

  test('點下去先開選擇彈窗、不送任何鍵；選本版 ⇒ s<目前看板>', async ({ page }) => {
    const link = await boardlessLink(page);
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    const dialog = page.locator('[data-aid-board-choice]');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.__replay.sent.length)).toBe(before);

    const current = await page.evaluate(() => window.__app.view._articleBoard);
    expect(current).toBeTruthy();
    await page.locator('[data-aid-choice="current"]').click();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.__replay.sent)).slice(before).join(''),
        { timeout: 15000 },
      )
      .toContain('s' + current);
  });

  // 使用者回報：「其他看板」要有 `s` 看板搜尋彈窗的 PTT 原生即時補全。這裡用照
  // mbbsd/name.c#generalnamecomplete 寫的迷你模擬（同 article_search.offline.spec.js）
  // 當 server：文章裡按 s ⇒ 補全 prompt；Enter ⇒ 目標板列表。
  test('其他看板 ⇒ 原生補全挑板 ⇒ 在 prompt 上進板 ⇒ 落地後 #AID', async ({ page }) => {
    const link = await boardlessLink(page);
    await installNameComplete(page);
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    await page.locator('[data-aid-choice="pick"]').click();
    const input = page.locator('input[name="searchKeyword"]');
    await expect(input).toBeVisible();
    // 背景 prompt 開出來了（補全可用），而且是從文章裡按的那一個 s。
    await expect(page.locator('[data-board-suggest="ready"]')).toHaveCount(1);
    await input.pressSequentially('bro');
    // 只認 PTT 回來的清單（查詢在飛時先顯示的是上一份篩過的過渡清單）。
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('[data-board-interim]')
            ? null
            : [...document.querySelectorAll('[data-board-candidate]')].map((e) => e.dataset.boardCandidate)
        )
      )
      .toEqual(['Browsers']);
    await input.press('Space');
    await expect(input).toHaveValue('Browsers');
    await input.press('Enter');
    await expect
      .poll(
        async () => (await page.evaluate(() => window.__replay.sent)).slice(before).join(''),
        { timeout: 15000 },
      )
      .toContain('#' + AID + '\r');
    const sent = (await page.evaluate(() => window.__replay.sent)).slice(before).join('');
    // 板跳就是 prompt 上的那個 Enter：不會再送一次 s<板>，也不會跑去目前看板。
    expect(sent).toContain('Browsers\r');
    expect(sent).not.toContain('sBrowsers');
    expect(sent).not.toContain('sask');
    expect(sent.indexOf('Browsers\r')).toBeLessThan(sent.indexOf('#' + AID));
  });

  // 原生 `s` 取消只會停在文章列表；app 要自己重開原文（閱讀紀錄再還原原列）。
  test('補全彈窗取消 ⇒ Ctrl-C ⇒ 落在列表後重開原文', async ({ page }) => {
    const link = await boardlessLink(page);
    await installNameComplete(page);
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    await page.locator('[data-aid-choice="pick"]').click();
    await expect(page.locator('[data-board-suggest="ready"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('input[name="searchKeyword"]')).toHaveCount(0);
    // 重開的是原文：畫面回到同一篇文章（好讀接回來）。
    await expect
      .poll(() => page.evaluate(() => window.__nc.mode), { timeout: 15000 })
      .toBe('article');
    await expect
      .poll(() => page.evaluate(() => window.__app.buf.pageState), { timeout: 15000 })
      .toBe(3);
    await expect.poll(() => page.evaluate(() => window.__app.aidNavigation.active)).toBe(false);
    const sent = (await page.evaluate(() => window.__replay.sent)).slice(before).join('');
    expect(sent).toContain('\x03');
    expect(sent.indexOf('\x03')).toBeLessThan(sent.lastIndexOf('\r'));
    expect(sent).not.toContain('sask');
  });
});

// 錄製檔 ptt-debug-20261018-173606：作者搜尋結果開的文章裡跳文 ⇒ PTT 回「此狀態下無法
// 使用搜尋文章代碼(AID)功能」。
test.describe('搜尋結果開的文章裡跳文（離線重放）', () => {
  test.skip(!cassette, `缺 cassette ${CASSETTE}.json`);

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, cassette, { easyReading: true });
  });

  const sentSince = async (page, before) =>
    (await page.evaluate(() => window.__replay.sent)).slice(before).join('');

  test('本版跳轉：落在系列列表 ⇒ 先 ← 離開搜尋再 #AID，# 不被拒', async ({ page }) => {
    const link = await boardlessLink(page);
    await installNameComplete(page, { sub: true });
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    await page.locator('[data-aid-choice="current"]').click();
    await expect.poll(() => sentSince(page, before), { timeout: 20000 }).toContain('#' + AID + '\r');
    const sent = await sentSince(page, before);
    expect(sent.indexOf('\x1b[D')).toBeGreaterThan(sent.indexOf('ask\r'));
    expect(sent.indexOf('\x1b[D')).toBeLessThan(sent.indexOf('#' + AID));
    expect(await page.evaluate(() => window.__nc.rejectedAid)).toBe(0);
  });

  test('其他看板：補全進板後仍是系列列表 ⇒ 先 ← 再 #AID', async ({ page }) => {
    const link = await boardlessLink(page);
    await installNameComplete(page, { sub: true });
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    await page.locator('[data-aid-choice="pick"]').click();
    const input = page.locator('input[name="searchKeyword"]');
    await expect(page.locator('[data-board-suggest="ready"]')).toHaveCount(1);
    await input.pressSequentially('Browsers');
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('[data-board-interim]')
            ? null
            : [...document.querySelectorAll('[data-board-candidate]')].map((e) => e.dataset.boardCandidate)
        )
      )
      .toEqual(['Browsers']);
    await input.press('Enter');
    await expect.poll(() => sentSince(page, before), { timeout: 20000 }).toContain('#' + AID + '\r');
    const sent = await sentSince(page, before);
    expect(sent.indexOf('\x1b[D')).toBeGreaterThan(sent.indexOf('Browsers\r'));
    expect(await page.evaluate(() => window.__nc.rejectedAid)).toBe(0);
  });

  test('取消挑板：Ctrl-C 落回系列列表 ⇒ 直接 ⏎ 開游標上的原文，不送 #', async ({ page }) => {
    const link = await boardlessLink(page);
    await installNameComplete(page, { sub: true });
    const before = await page.evaluate(() => window.__replay.sent.length);
    await link.click();
    await page.locator('[data-aid-choice="pick"]').click();
    await expect(page.locator('[data-board-suggest="ready"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect
      .poll(() => page.evaluate(() => window.__nc.mode), { timeout: 15000 })
      .toBe('article');
    await expect.poll(() => page.evaluate(() => window.__app.aidNavigation.active)).toBe(false);
    const sent = await sentSince(page, before);
    expect(sent).not.toContain('#');
    // 身後的搜尋結果原樣保留（沒有送 ← 離開搜尋）。
    expect(await page.evaluate(() => window.__nc.sub)).toBe(true);
  });
});

const AID = '1gU3wwNZ';
const BOARDS = ['ask', 'Baseball', 'Browsers', 'C_Chat', 'Gossiping'];

// 重放卷已餵完（人在好讀文章裡）之後接手 server 端。
// opts.sub：原文是從搜尋結果（MODE_SELECT）開的。照 read.c 新版：搜尋條件跟著列表走，
// 換板後仍是「系列」列表；# 在系列列表被拒（select_by_aid）；系列列表上的 ← 只離開搜尋。
async function installNameComplete(page, opts = {}) {
  // 列表上 ⏎ 重開原文時回卷裡原文第一頁的真 bytes。
  const articleFrame = Buffer.from(cassette.steps[0].recv, 'base64').toString('latin1');
  await page.evaluate(({ boards, articleFrame, sub }) => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out +=
          String.fromCharCode(window.lib.u2bArray[2 * c]) +
          String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    const app = window.__app;
    const match = (p) => boards.filter((b) => b.toLowerCase().indexOf(p.toLowerCase()) === 0);
    const st = { mode: 'article', board: '', field: '', listed: null, sub: !!sub, rejectedAid: 0 };
    window.__nc = st;
    const PROMPT = '請輸入看板名稱(按空白鍵自動搜尋): ';
    const listFrame = () => {
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[2J';
      const tail = (st.sub ? '系列《' : '看板《') + st.board + '》';
      d += '\x1b[1;1H' + REV + u2b(('【板主：test】' + tail).padEnd(80)) + OFF;
      d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
      d += '\x1b[4;1H' + u2b('   1233     9/01 testuser     □[閒聊] 測試文章');
      d += '\x1b[24;1H' + u2b((st.sub ? ' 系列文章 ' : ' 文章列表 ') + ' (y)回應(X)推文(^X)轉錄 ');
      return d + '\x1b[4;1H';
    };
    const aidRejectFrame = () =>
      listFrame() +
      '\x1b[23;1H' + u2b('此狀態下無法使用搜尋文章代碼(AID)功能') +
      '\x1b[24;1H\x1b[K' + u2b('                              請按任意鍵繼續');
    const promptFrame = () => {
      let d = '\x1b[2J\x1b[1;1H\x1b[7m' + u2b('【 選擇看板 】') + '\x1b[m';
      d += '\x1b[2;1H' + u2b(PROMPT) + '\x1b[30;47m' + st.field.padEnd(20) + '\x1b[m';
      if (st.listed) {
        d += '\x1b[3;1H' + u2b('-'.repeat(29) + ' 相關資訊一覽表 ' + '-'.repeat(29));
        st.listed.forEach((name, i) => {
          d += '\x1b[' + (4 + i) + ';1H' + name + ' ';
        });
      }
      return d + '\x1b[2;' + (35 + st.field.length) + 'H';
    };
    const handle = (data) => {
      let redraw = st.mode !== 'article';
      // 列表上：#AID⏎ 只是把游標停在那一列（重畫列表）；其餘的 ⏎ ＝開游標上的文章。
      if (st.mode === 'list') {
        if (data.indexOf('\x1b[D') === 0 && st.sub) {
          st.sub = false; // read_cmd_quit：只離開搜尋
        } else if (data[0] === '#') {
          if (st.sub) {
            st.rejectedAid += 1;
            setTimeout(() => app.onData(aidRejectFrame()), 5);
            return;
          }
        } else if (data.indexOf('\r') >= 0) {
          st.mode = 'article';
          setTimeout(() => app.onData(articleFrame), 5);
          return;
        }
        setTimeout(() => app.onData(listFrame()), 5);
        return;
      }
      for (const ch of data) {
        if (st.mode === 'article') {
          if (ch === 's') {
            Object.assign(st, { mode: 'prompt', field: '', listed: null });
            redraw = true;
          }
          continue;
        }
        if (ch === '\b') st.field = st.field.slice(0, -1);
        else if (ch === ' ') {
          const m = match(st.field);
          if (!m.length) continue;
          if (m.length === 1) st.field = m[0];
          st.listed = m;
        } else if (ch === '\r') {
          const m = match(st.field);
          const exact = m.find((b) => b.toLowerCase() === st.field.toLowerCase());
          const target = m.length === 1 ? m[0] : exact;
          st.mode = 'list';
          st.board = target || 'ask';
        } else if (ch === '\x03') {
          // do_select 取消 ⇒ 回原文所在板的文章列表（游標在原文上）。
          st.mode = 'list';
          st.board = 'ask';
        }
        else if (ch > ' ' && ch <= '~' && match(st.field + ch).length) st.field += ch;
      }
      if (redraw) setTimeout(() => app.onData(st.mode === 'list' ? listFrame() : promptFrame()), 5);
    };
    window.__stubWSSent = (s) => {
      window.__replay.sent.push(s);
      handle(s);
    };
  }, { boards: BOARDS, articleFrame, sub: !!opts.sub });
}
