// 搜尋狀態列（src/js/search_status.js、docs/article-search.md「搜尋狀態列」）的端到端行為：
// 真瀏覽器、真搜尋彈窗、真 CommandQueue，「server 回什麼」逐幀餵進 App.onData。
// unit（search_status.test.js）釘死畫面認法與條件記憶；這裡守 unit 碰不到的那半段：
//   - 彈窗送出 → PTT 收下 → 搜尋結果畫出來，狀態列真的出現、寫的是剛剛的條件
//   - ✕ 送出去的真的是 ←（PTT 在列表上只離開子模式），回到完整列表就收起
//   - 不是彈窗進去的搜尋結果只說「搜尋結果」；點狀態列不會被當成點終端機
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

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

// 一整幀文章列表（新版 caption）。sub：搜尋結果（read.c MODE_SELECT：標題列右段「系列《板》」、
// 底列 caption「系列文章」，編號從 1 起算）。
async function drawList(page, { sub = false } = {}) {
  await page.evaluate(
    ({ src, sub }) => {
      const u2b = new Function('return ' + src)();
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[2J';
      d += '\x1b[1;1H' + REV + u2b(('【板主:test】' + (sub ? '系列' : '看板') + '《Test》').padEnd(80)) + OFF;
      d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
      d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
      const rows = sub
        ? [[1, 'someone', 'Re: [閒聊] 測試文章'], [2, 'other', 'Re: [問卦] 又一篇']]
        : [[1233, 'testuser', '[閒聊] 測試文章'], [1234, 'someone', 'Re: [閒聊] 測試文章'], [1235, 'other', 'Re: [問卦] 又一篇']];
      rows.forEach(([n, a, t], i) => {
        d += '\x1b[' + (4 + i) + ';1H' + u2b(String(n).padStart(7) + '    ' + ' 9/01 ' + a.padEnd(13) + '□' + t);
      });
      d += '\x1b[24;1H' + u2b(' ' + (sub ? '系列文章' : '文章列表') + '  (y)回應(X)推文(^X)轉錄 ');
      d += '\x1b[4;1H';
      window.__app.onData(d);
    },
    { src: U2B_SRC, sub }
  );
  await waitScreenSettled(page, { 2: '編號', 23: sub ? '系列文章' : '文章列表' });
}

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
const i18n = (page, key) => page.evaluate((k) => window.__i18n(k), key);
const bar = (page) => page.locator('#searchStatus');

async function boot(page, prefs) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootOffline(page, ptt, { searchStatus: true });
  // 自己畫的列表驗的是原生路徑；列表好讀一 engage 就會自己往線路送機器鍵。
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs || {}));
  await drawList(page);
}

test.describe('搜尋狀態列', () => {
  test('彈窗搜尋 → 搜尋結果出現狀態列、寫著條件；✕ 送 ←、回完整列表就收起', async ({ page }) => {
    await boot(page);
    await expect(bar(page)).toHaveCount(0);
    await collectSent(page);
    await ptt.sendKey(page, '/');
    const input = page.locator('input[name="searchKeyword"]');
    await input.fill('Re');
    await input.press('Enter');
    await expect.poll(() => sentText(page)).toBe('/\f');
    await drawPrompt(page, '搜尋標題: ');
    await expect.poll(() => sentText(page)).toBe('/\fRe\r');
    await drawList(page, { sub: true });

    await expect(bar(page)).toBeVisible();
    const expected = (await i18n(page, 'searchStatus_searching')) + (await i18n(page, 'searchStatus_title')) + '「Re」';
    await expect(bar(page).locator('.searchStatusLabel')).toHaveText(expected);
    // 在終端機右上角、整條在視窗裡。
    const term = await page.locator('#BBSWindow > .main').boundingBox();
    const box = await bar(page).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(term.x + term.width + 1);
    expect(box.y).toBeLessThan(term.y + 40);

    await collectSent(page);
    await bar(page).locator('[data-search-status="leave"]').click();
    await expect.poll(() => sentText(page)).toBe('\x1b[D');
    await drawList(page);
    await expect(bar(page)).toHaveCount(0);
  });

  test('原生搜尋進去的搜尋結果 ⇒ 只顯示「搜尋結果」；＋條件 開搜尋彈窗、不送鍵', async ({ page }) => {
    await boot(page);
    await drawList(page, { sub: true });
    await expect(bar(page).locator('.searchStatusLabel')).toHaveText(await i18n(page, 'searchStatus_unknown'));
    await collectSent(page);
    await bar(page).locator('[data-search-status="add"]').click();
    await expect(page.locator('input[name="searchKeyword"]')).toBeVisible();
    expect(await sentText(page)).toBe('');
  });

  test('pref 關 ⇒ 搜尋結果也不出現', async ({ page }) => {
    await boot(page, { enableSearchStatus: false });
    await drawList(page, { sub: true });
    await expect(page.locator('#mainContainer')).toContainText('系列');
    await expect(bar(page)).toHaveCount(0);
  });
});
