// 功能鍵可點（`[d]刪除` / `(y)回應` → 按鈕）的端到端守護 —— 離線重放，真瀏覽器、
// 真渲染、完整 boot 鏈。
//
// 為什麼一定要上 e2e：這個功能的接線橫跨**三條 render 分支**
//   1. 原生列表／選單 → term_view._renderScreenLines → computeAnnotations
//   2. 原生文章       → 同上（pageState 3，只有最後一列）
//   3. 文章好讀的 footer overlay → term_view._mirrorStatusRowToFooter，
//      **完全不經 computeAnnotations**（term_ui.renderOverlayRow 的第 4 參數）
// 三條各自算 functionKeyRows、各自把 onClick 接上去。unit 只驗得到單列的 DOM
// 與純函式，「哪一條分支忘了接」只有整條鏈跑起來才看得見。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  replayListCassette,
  loadCassette,
} = require('../helpers/replay');

const article = findCassette('article');

// 送出收集器（與 mouse.offline.spec.js 同一套 hook）。
async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}
async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

const fnKeyLabels = (page, scope = '#mainContainer') =>
  page.evaluate(
    (sel) =>
      Array.from(document.querySelectorAll(sel + ' a.fnKey')).map((a) =>
        a.getAttribute('data-fnkey'),
      ),
    scope,
  );

test.describe('功能鍵可點（離線重放）', () => {
  if (!article) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  test('原生文章：底部 footer 的單鍵變成按鈕，多鍵組維持純文字', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: false });

    const labels = await fnKeyLabels(page);
    expect(labels.length).toBeGreaterThan(0);
    // 每一個都必須是**單一按鍵**（單字元／caret／Ctrl-X／具名鍵）。
    labels.forEach((l) => {
      const inner = l.slice(1, -1);
      expect(
        inner.length === 1 ||
          /^\^.$/.test(inner) ||
          /^Ctrl-.$/i.test(inner) ||
          ['←', '→', '↑', '↓', 'PgUp', 'PgDn', 'Home', 'End', 'Enter', 'Esc', 'Tab', '空白鍵'].includes(
            inner,
          ),
        `「${l}」不是單一按鍵，不該可點`,
      ).toBe(true);
    });
    // pmore 的 footer 一定有這幾組多鍵組，它們必須留在畫面上但**不是**按鈕。
    const plain = await page.evaluate(
      () => document.getElementById('mainContainer').textContent,
    );
    ['(=[]<>)', '(/?a)'].forEach((group) => {
      if (plain.includes(group)) {
        expect(labels).not.toContain(group);
      }
    });
  });

  test('點按鈕 → 真的把那個按鍵送上線', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: false });

    const target = page.locator('#mainContainer a.fnKey').first();
    await expect(target).toBeVisible();
    const label = await target.getAttribute('data-fnkey');
    const key = label.slice(1, -1);

    // app 自己會把目前文章的 AID 寫進 hash（deep link），所以只能比「點擊前後
    // 有沒有變」，不能斷言它是空的。
    const hashBefore = await page.evaluate(() => window.location.hash);

    await startCapture(page);
    await target.click();
    await page.waitForTimeout(200);
    const sent = await takeCapture(page);

    expect(sent.length).toBeGreaterThan(0);
    if (key.length === 1) expect(sent).toContain(key);
    // href="#" 必須被 preventDefault：漏掉的話瀏覽器會把 hash 清成 '#'，
    // 而本 app 用 hash 做 deep link（docs/deep-link.md）⇒ 可能觸發跳文解析。
    expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore);
  });

  test('關掉 pref → 一個 a.fnKey 節點都不產生', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: false,
    });
    await replayCassette(page, article, { easyReading: false });
    expect(await fnKeyLabels(page)).toEqual([]);
  });

  test('滑鼠總開關關掉 → 子功能一併失效', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: false,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: false });
    expect(await fnKeyLabels(page)).toEqual([]);
  });

  test('切 pref 立即生效（不必等 PTT 重畫那幾列）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: false,
    });
    await replayCassette(page, article, { easyReading: false });
    expect(await fnKeyLabels(page)).toEqual([]);

    // dirty-row 逐列 patch 之下 server 一列都沒重畫 ⇒ 沒有 redraw(true) 就不會變。
    await page.evaluate(() => window.__app.onPrefChange('mouseFunctionKeys', true));
    await page.waitForTimeout(200);
    expect((await fnKeyLabels(page)).length).toBeGreaterThan(0);

    await page.evaluate(() => window.__app.onPrefChange('mouseFunctionKeys', false));
    await page.waitForTimeout(200);
    expect(await fnKeyLabels(page)).toEqual([]);
  });

  test('文章好讀：底部 footer overlay 也是按鈕（那條路不經 computeAnnotations）', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: true });

    const overlay = await fnKeyLabels(page, '#easyReadingLastRow');
    expect(overlay.length).toBeGreaterThan(0);
    // #easyReadingLastRow 沒有 pointer-events:none ⇒ 點得到。
    const target = page.locator('#easyReadingLastRow a.fnKey').first();
    await expect(target).toBeVisible();
  });

  test('文章好讀：點 footer 的功能鍵會先進 functionMode（不然使用者看不到 prompt）', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article, { easyReading: true });

    // 挑一個**不是 ←** 的鍵（← 走 stopEasyReading，語意不同）。
    const target = page
      .locator('#easyReadingLastRow a.fnKey')
      .filter({ hasNotText: '←' })
      .first();
    await expect(target).toBeVisible();

    await startCapture(page);
    await target.click();
    await page.waitForTimeout(250);

    expect(await takeCapture(page)).not.toBe('');
    expect(
      await page.evaluate(() => !!window.__app.buf.easyReadingFunctionMode),
    ).toBe(true);
  });
});

// 列表／選單（pageState 1/2）的提示列在 **row 1**（pttbbs bbs.c:663 / board.c:1330），
// 與文章的「只有最後一列」是不同的分支，故獨立驗一次。
test.describe('功能鍵可點：看板列表（離線重放）', () => {
  const listCassette = (() => {
    try {
      return loadCassette('cchat-list-nav');
    } catch (e) {
      return null;
    }
  })();

  if (!listCassette) {
    test.skip('尚無 list cassette', () => {});
  }

  test('原生列表：提示列（row 1）與底部狀態列都出現按鈕', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReadingList: false,
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayListCassette(page, listCassette);
    await page.waitForTimeout(400);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer a.fnKey')).map((a) =>
        Number(a.closest('[data-row]').getAttribute('data-row')),
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    // 只允許 row 1（提示列）與最後一列（vs_footer）。
    const allowed = new Set([1, 23]);
    rows.forEach((r) => expect(allowed.has(r), `row ${r} 不該有功能鍵`).toBe(true));
    expect(rows).toContain(1);
  });

  test('關掉 pref → 列表也一個節點都不產生', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReadingList: false,
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseFunctionKeys: false,
    });
    await replayListCassette(page, listCassette);
    await page.waitForTimeout(400);
    expect(await fnKeyLabels(page)).toEqual([]);
  });
});
