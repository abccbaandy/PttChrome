// 列表好讀模式的右鍵選單「前已讀後未讀」—— 離線重放版（stub WebSocket + cassette，
// 真瀏覽器／真渲染／真右鍵選單，零網路）。
//
// 守的是這功能唯一會靜默出錯的地方：**送出去的鍵序**。`v` 沒進 getdata prompt 時，
// 後面的 `w` 會落回列表按鍵 b_call_in（對該列作者送呼叫器）、`\r` 會開文，所以
//   1) 兩步之間一定要隔著「prompt 真的出現了」這個判定；
//   2) 第一步永遠是把 server 真游標搬到目標列的序號跳轉。
// cchat-list-mark cassette 剛好錄了 jump → 'v' → prompt 畫面，兩步都餵得動；
// `w\r` 沒有對應的門控（真 server 才會回應），所以只驗它**被送出**、不驗結果。
//
// live e2e 刻意不加：這個操作會真的改寫測試帳號的看板已讀記錄且不可逆
//（brc_trunc），而且有登入預算硬規範。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
// 量座標前一律先等版面停（tests/unit/e2e_layout_settle.test.js 靜態守護）。
const { waitRectStable, assertElementUnder } = require('../helpers/layout');

const mark = loadCassette('cchat-list-mark');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);
const menu = (page) => page.locator('.DropdownMenu').first();
const menuItem = (page, text) =>
  menu(page).getByRole('menuitem').filter({ hasText: text });

async function dumpListState(page) {
  return page.evaluate(() => {
    const app = window.__app;
    return {
      state: app.listSession.state,
      renderMode: app.buf.listRenderMode,
      queueIdle: app.commandQueue.idle,
      sent: (window.__replay && window.__replay.sent.slice()) || []
    };
  });
}

async function waitState(page, pred, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await dumpListState(page);
    if (pred(last)) return last;
    await page.waitForTimeout(200);
  }
  throw new Error('waitState 逾時：' + JSON.stringify(last));
}

// 進板 → 開列表好讀（不預讀，序列＝畫面那一頁 ⇒ 不必捲動就點得到）。
async function engage(page) {
  await bootOffline(page, ptt);
  await replayListCassette(page, mark);
  await page.waitForFunction(() => window.__app.buf.pageState === 2);
  await ptt.applyPrefs(page, {
    enableEasyReadingList: true,
    easyReadingListPrefetchCount: 0
  });
  await waitState(page, (s) => s.state === 'active' && s.renderMode === 'buffer' && s.queueIdle);
}

// 標記某一列（num = 該序號那一列；null = 第一列，也就是看板標題那條 header），
// 回傳它標題欄某一格的 client 座標。列表是純文字列（沒有延遲載入的預覽盒），
// 版面等待仍照契約走 waitRectStable。
async function targetRow(page, num) {
  const found = await page.evaluate((n) => {
    const rows = Array.from(
      document.querySelectorAll('#mainContainer span[type="bbsrow"]')
    );
    const el =
      n == null
        ? rows[0]
        : rows.find((r) => (r.textContent || '').replace(/^\s+/, '').indexOf(String(n)) === 0);
    if (!el) return false;
    el.setAttribute('data-e2e-target', '1');
    return true;
  }, num);
  if (!found) return null;
  await waitRectStable(page, '[data-e2e-target]');
  return page.evaluate((col) => {
    const el = document.querySelector('[data-e2e-target]');
    const rect = el.getBoundingClientRect();
    return {
      title: el.getAttribute('data-list-title'),
      text: el.textContent,
      x: rect.left + (col + 0.5) * window.__app.view.chw,
      y: rect.top + rect.height / 2
    };
  }, 45); // col 45 ∈ 標題區（≥29）
}

test.describe('列表好讀 · 右鍵「前已讀後未讀」（離線重放）', () => {
  test.skip(!mark, '缺 cchat-list-mark cassette（先 yarn record:cassette）');

  test('文章列右鍵有該項；點下去依序送出「序號跳轉 → v → w+Enter」', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await engage(page);

      // 目標＝cassette 錄過跳號的那一篇（門控只在序號一致時餵）。
      const num = (mark.steps.find((s) => s.on === 'jump') || {}).num;
      expect(num).toBeTruthy();
      const t = await targetRow(page, num);
      expect(t).not.toBeNull();
      expect(t.title).toBeTruthy();

      await assertElementUnder(page, t.x, t.y, t.title, {
        closest: '[data-list-title]',
        attribute: 'data-list-title'
      });
      await page.mouse.click(t.x, t.y, { button: 'right' });

      const itemLabel = await label(page, 'cmenu_markReadUnread');
      const item = menuItem(page, itemLabel);
      await expect(item).toBeVisible();

      const before = (await dumpListState(page)).sent.length;
      await item.click();

      // 第一步：把 server 真游標搬到目標列（絕不直接送 v）。
      await page.waitForFunction(
        ({ n, from }) => window.__replay.sent.slice(from).some((d) => d.indexOf(String(n) + '\r') === 0),
        { n: num, from: before },
        { timeout: 10000 }
      );
      // 第二步：跳號落地後才切原生鏡像並代送 'v'（cassette 餵回 prompt 畫面）。
      await page.waitForFunction(
        (from) => window.__replay.sent.slice(from).includes('v'),
        before,
        { timeout: 10000 }
      );
      await waitState(page, (s) => s.renderMode === 'native', 10000);
      // 原生鏡像的切換發生在「送出 v」的當下，PTT 畫的 prompt 要等回應才上畫面
      // ⇒ 等內容條件，不可在切到 native 的瞬間就量。
      await page.waitForFunction(
        () =>
          Array.from(
            document.querySelectorAll('#mainContainer [data-type="bbsline"]')
          ).some((el) => (el.textContent || '').includes('前已讀後未讀')),
        undefined,
        { timeout: 10000 }
      );

      // 第三步：prompt 出現之後才送 'w\r'（getdata 是整行輸入，少了 Enter 不會動）。
      await page.waitForFunction(
        (from) => window.__replay.sent.slice(from).includes('w\r'),
        before,
        { timeout: 10000 }
      );
      const sent = (await dumpListState(page)).sent.slice(before);
      expect(sent.indexOf('v')).toBeLessThan(sent.indexOf('w\r')); // 順序不可顛倒
      // 'w' 絕不可以在 prompt 之前就跟著跳號／'v' 一起出去（那會變成 b_call_in）。
      expect(sent.filter((d) => d === 'vw\r' || d === 'w').length).toBe(0);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('header 列右鍵 → 該項不出現（一般選單照常）', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page);

    const t = await targetRow(page, null); // 看板標題列（header）
    expect(t).not.toBeNull();
    await page.mouse.click(t.x, t.y, { button: 'right' });

    await expect(menu(page)).toBeVisible();
    const itemLabel = await label(page, 'cmenu_markReadUnread');
    await expect(menuItem(page, itemLabel)).toHaveCount(0);
    const settings = await label(page, 'cmenu_settings');
    await expect(menu(page).getByText(settings, { exact: true })).toBeVisible();
  });
});
