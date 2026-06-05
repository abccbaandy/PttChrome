const { test, expect } = require('@playwright/test');
const {
  readScreen,
  login,
  sendKey,
  typeLine,
  attachConsole,
  dismissDeveloperModeAlert
} = require('./helpers/ptt');

// Enhanced Add-on：樓層編號 + 黑名單。連真 PTT，需好讀模式。
// 對應 src/js/comment_parse.js / Screen.js / term_view.js(appendRows)。

const KEY = 'pttchrome.pref.v1';
const setPrefs = (page, extra) =>
  page.addInitScript((args) => {
    try {
      const cur = JSON.parse(window.localStorage.getItem(args.KEY) || '{}');
      const values = Object.assign({}, cur.values, args.extra);
      window.localStorage.setItem(args.KEY, JSON.stringify({ values }));
    } catch (e) {}
  }, { KEY, extra });

// 走 s 搜尋看板 → 進板 → 開最新文章，等好讀累積。
async function openLatestArticle(page, board) {
  await sendKey(page, 's');
  await page.waitForTimeout(500);
  await typeLine(page, board);
  await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    const s = await readScreen(page);
    if (s.includes('看板') && (s.includes('標題') || s.includes('人氣'))) break;
    if (s.includes('加入') || s.includes('訂閱') || s.includes('我的最愛')) await typeLine(page, 'y');
    else await sendKey(page, 'Space');
    await page.waitForTimeout(800);
  }
}

test('樓層編號：好讀模式推文出現遞增序號', async ({ page }) => {
  const logs = attachConsole(page);
  try {
    await setPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await page.goto('/');
    console.log(await login(page));

    await openLatestArticle(page, 'C_Chat');

    // 開最新一篇，等好讀自動翻頁累積整篇
    await sendKey(page, 'End');
    await page.waitForTimeout(800);
    await sendKey(page, 'Enter');
    await page.waitForTimeout(5000);

    // 多翻幾頁確保有推文
    for (let i = 0; i < 4; i++) {
      await sendKey(page, 'Space');
      await page.waitForTimeout(1200);
    }

    const floors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer [data-floor]'))
        .map((el) => parseInt(el.textContent, 10))
        .filter((n) => !Number.isNaN(n))
    );
    console.log('FLOOR BADGES:', JSON.stringify(floors.slice(0, 20)), 'total', floors.length);

    expect(floors.length).toBeGreaterThan(0);
    // 遞增且從 1 開始
    expect(floors[0]).toBe(1);
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBe(floors[i - 1] + 1);
    }
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-floor-error.png', fullPage: true });
    throw err;
  }
});

// 黑名單核心：好讀模式下被封鎖推文者的推文整列移除（不留空行）。
// 在同一篇文章上驗證：讀取 → 封鎖某推文者 → 離開再進入重新累積 → 該人推文消失且總列數下降。
test('黑名單：好讀模式移除推文且不留空行', async ({ page }) => {
  test.setTimeout(180000); // 找有推文的文章 + 兩階段累積，需較長時間
  const logs = attachConsole(page);
  // 注意：樓層徽章會插在 marker 與 userid 之間（"推9 userid"），故 \d* 略過徽章數字。
  const pushers = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
        .map((el) => {
          const m = el.textContent.match(/^(推|噓|→)\d*\s+([0-9A-Za-z]+)\s*:/);
          return m ? m[2] : null;
        })
        .filter(Boolean)
    );
  const childCount = () =>
    page.evaluate(() => document.querySelectorAll('#mainContainer [data-type="bbsline"]').length);

  try {
    await setPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await page.goto('/');
    console.log(await login(page));
    await openLatestArticle(page, 'C_Chat');

    // 用與樓層測試相同的成功導航（End→Enter）；若該篇無推文，回列表往上一篇再試。
    await sendKey(page, 'End');
    await page.waitForTimeout(800);
    let before = [];
    let c1 = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sendKey(page, 'Enter');
      await page.waitForTimeout(3800);
      for (let i = 0; i < 3; i++) {
        await sendKey(page, 'Space');
        await page.waitForTimeout(900);
      }
      before = await pushers();
      if (before.length > 0) {
        c1 = await childCount();
        break;
      }
      // 無推文 → 離開回列表、往上一篇（較舊）再試
      await sendKey(page, 'ArrowLeft');
      await page.waitForTimeout(1300);
      await sendKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
    }
    console.log('PUSHERS BEFORE:', before.length, 'childRows', c1);
    test.skip(before.length === 0, '找不到有推文的文章，跳過黑名單驗證');

    // 選出現次數最多的推文者
    const freq = {};
    before.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
    const target = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    const targetCount = freq[target];
    console.log('BLACKLIST TARGET:', target, 'x', targetCount);

    // 設黑名單到 view（appendRows 讀 this.blacklist）
    await page.evaluate((t) => {
      window.__app.view.blacklist = new Set([t.toLowerCase()]);
    }, target);

    // 離開回列表（游標仍停在本篇）→ 再進入，好讀重新累積套用黑名單
    await sendKey(page, 'ArrowLeft');
    await page.waitForTimeout(1500);
    await sendKey(page, 'Enter');
    await page.waitForTimeout(4000);
    for (let i = 0; i < 5; i++) {
      await sendKey(page, 'Space');
      await page.waitForTimeout(1000);
    }

    const after = await pushers();
    const c2 = await childCount();
    console.log('PUSHERS AFTER:', after.length, 'childRows', c2);

    // 被封鎖者的推文完全消失
    expect(after.includes(target)).toBe(false);
    // 列數真的變少（整列移除，非僅隱藏占行）
    expect(c2).toBeLessThan(c1);

    // 樓層仍連續遞增
    const floors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer [data-floor]'))
        .map((el) => parseInt(el.textContent, 10))
        .filter((n) => !Number.isNaN(n))
    );
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBe(floors[i - 1] + 1);
    }
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-blacklist-error.png', fullPage: true });
    throw err;
  }
});

// 自動登入：開頁後完全不按任何鍵，應自動送帳密、跳過提示，進到主選單。
test('自動登入：開頁自動到主選單（不需按鍵）', async ({ page }) => {
  const user = process.env.PTT_USER;
  const pass = process.env.PTT_PASS;
  test.skip(!user || !pass, '需 env PTT_USER/PTT_PASS 才能測自動登入');
  test.setTimeout(120000);
  const logs = attachConsole(page);
  try {
    await setPrefs(page, {
      autoLogin: true,
      autoLoginUser: user,
      autoLoginPassword: pass,
      autoLoginDupConn: 'N',
      autoLoginSkipWelcome: true
    });
    await page.goto('/');
    // dev build 仍需關掉 Developer Mode modal，app 才會 connect（autoLogin 在 connect 後啟動）。
    await dismissDeveloperModeAlert(page);

    // 關鍵：完全不呼叫 typeLine/sendKey，純等自動登入。
    const deadline = Date.now() + 90000;
    let screen = '';
    while (Date.now() < deadline) {
      screen = await readScreen(page);
      if (screen.includes('主功能表')) break;
      await page.waitForTimeout(1000);
    }
    console.log('AUTO LOGIN SCREEN HEAD:', screen.split('\n')[0]);
    expect(screen).toContain('主功能表');
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-autologin-error.png', fullPage: true });
    throw err;
  }
});

// 看板列表黑名單（好讀模式開啟時）：被封鎖作者的發文列應被隱藏。
// 此情境正是先前的 bug：好讀開啟時列表走 hideEasyReading→appendRows，需帶 enhance 才會過濾。
test('看板列表黑名單：好讀模式下隱藏被封鎖作者發文', async ({ page }) => {
  test.setTimeout(120000);
  const logs = attachConsole(page);
  try {
    await setPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await page.goto('/');
    console.log(await login(page));
    await openLatestArticle(page, 'C_Chat'); // 停在 C_Chat 列表
    await page.waitForTimeout(1000);

    const r = await page.evaluate(() => {
      const app = window.__app;
      const sel = '#mainContainer > span[type="bbsrow"]';
      // textContent（非 innerText）：visibility:hidden 的列 innerText 會是空字串。
      const authorCol = (el) => el.textContent.substring(17, 29).trim();
      const isIndexRow = (el) =>
        /^[ ●]?\d{5,6}\s/.test(el.textContent) && /^[0-9A-Za-z]+$/.test(authorCol(el));
      // 選列表中第一個合法作者
      let target = '';
      for (const el of document.querySelectorAll(sel)) {
        if (isIndexRow(el)) { target = authorCol(el); break; }
      }
      // 走真實 pref handler（會 parseBlacklist + redraw）
      app.onPrefChange('blacklist', target);
      const after = Array.from(document.querySelectorAll(sel)).map((el) => ({
        author: authorCol(el),
        vis: getComputedStyle(el).visibility,
      }));
      return {
        target,
        pageState: app.buf.pageState,
        hiddenCount: after.filter((x) => x.vis === 'hidden').length,
        targetHidden: after.some((x) => x.author === target && x.vis === 'hidden'),
      };
    });
    console.log('LIST BLACKLIST:', JSON.stringify(r));

    expect(r.target).not.toBe('');
    expect(r.pageState).toBe(2);
    expect(r.targetHidden).toBe(true);
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-list-bl-error.png', fullPage: true });
    throw err;
  }
});

// 守護 parseListAuthor 的欄位常數（17~28）：看板列表的索引列，作者欄應落在該區間。
// 若 PTT 改版位移，此測試會先紅，提醒重新校準 src/js/comment_parse.js。
test('看板列表作者欄位常數仍正確 (cols 17-28)', async ({ page }) => {
  const logs = attachConsole(page);
  try {
    await page.goto('/');
    console.log(await login(page));
    await openLatestArticle(page, 'C_Chat');
    await page.waitForTimeout(1000);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]')).map(
        (el) => el.innerText
      )
    );
    expect(rows.length).toBeGreaterThan(0);

    // 一般索引列：開頭為（空白/●）+ 5~6 位編號。對這些列取 cols 17~28 應為合法帳號。
    const indexRows = rows.filter((r) => /^[ ●]?\d{5,6}\s/.test(r));
    const valid = indexRows.filter((r) => /^[0-9A-Za-z]+$/.test(r.substring(17, 29).trim()));
    console.log(`INDEX ROWS: ${indexRows.length}, AUTHOR COL VALID: ${valid.length}`);

    expect(indexRows.length).toBeGreaterThan(0);
    // 容許少數編輯過(●)造成位移；多數應命中。
    expect(valid.length).toBeGreaterThanOrEqual(Math.ceil(indexRows.length * 0.7));
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    throw err;
  }
});
