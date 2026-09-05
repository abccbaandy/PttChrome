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

  test('原生文章：底部 footer 的每一顆按鈕都是**一個**按鍵', async ({ page }) => {
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
    // 2026-09 起複合組拆成逐個 atom ⇒ label 有兩種形狀：單鍵組仍是 `[d]`／`(y)`
    // （含括號），複合組的每顆按鈕就是 atom 本身（`=`、`↑`、`v`）。
    // 不管哪一種，**去掉括號之後一定是恰好一個按鍵**——這條就是「絕不可以取第一個
    // 鍵」的端到端鎖。
    const NAMED = ['←', '→', '↑', '↓', 'PgUp', 'PgDn', 'Home', 'End', 'Enter', 'Esc', 'Tab', 'Del', '空白鍵'];
    labels.forEach((l) => {
      const inner = /^[[(].*[\])]$/.test(l) ? l.slice(1, -1) : l;
      expect(
        inner.length === 1 ||
          /^\^.$/.test(inner) ||
          /^Ctrl-.$/i.test(inner) ||
          NAMED.some((n) => n.toLowerCase() === inner.toLowerCase()),
        `「${l}」不是單一按鍵，不該可點`,
      ).toBe(true);
    });
    // pmore 的 footer 一定有這幾組複合鍵，整組的字串本身**不可以**是一顆按鈕。
    // （`(=[]<>)` 的 `[` `]` 與 `(/?a)` 的 `/` 各自是**真的按鍵**，所以單獨出現在
    //  label 裡是對的；D3 的座標級鎖在下面看板列表那個 describe。）
    ['(=[]<>)', '(/?a)'].forEach((group) => {
      expect(labels).not.toContain(group);
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

  // 複合鍵逐鍵可點：文章列表的 vs_footer 有 `(=[]<>)相關主題(/?a)找標題/作者`
  // （read.c:1241）—— 兩組共八個 atom，是全站最密的一列。
  test('(=[]<>) 與 (/?a) 拆成八顆連續按鈕，整組字串本身不是按鈕', async ({
    page,
  }) => {
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

    const labels = await fnKeyLabels(page);
    ['=', '[', ']', '<', '>', '/', '?', 'a'].forEach((k) =>
      expect(labels, `缺少 atom「${k}」`).toContain(k),
    );
    expect(labels).not.toContain('(=[]<>)');
    expect(labels).not.toContain('(/?a)');
    // 八顆全在最後一列（vs_footer）。
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#mainContainer a.fnKey'))
        .filter((a) => ['=', '[', ']', '<', '>', '/', '?', 'a'].includes(a.getAttribute('data-fnkey')))
        .map((a) => Number(a.closest('[data-row]').getAttribute('data-row'))),
    );
    expect(new Set(rows)).toEqual(new Set([23]));
  });
});

// 「同一組括號、不同格、送不同的鍵」的端到端鎖。素材是 pmore 的 footer
// `(y)回應(X%)推文(h)說明(←)離開`（more.c:410 FOOTERMSG_*）—— `(X%)` 是**一組
// 括號、兩個不同的鍵**（X 推文／% 也是推文的同義鍵，read.c/more.c 各自獨立 case），
// 正是「絕不可以取第一個鍵」的現場。
test.describe('複合鍵逐鍵可點：文章 footer 的 (X%)（離線重放）', () => {
  const article2 = findCassette('article');
  if (!article2) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  async function openArticle(page) {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await replayCassette(page, article2, { easyReading: false });
  }

  // `(X%)` 這一組在**格子空間**的起點（`(` 的 col）。四個字元都是 ASCII 單格，
  // 所以直接逐格掃 buf.lines 就找得到，**不必量任何元素的 rect** ——
  // 格子數學（firstGridOffset + chw/chh）是常數，不會被延遲載入的預覽推走
  // （見 tests/unit/e2e_layout_settle.test.js 的規則說明）。
  async function groupStartCol(page) {
    return page.evaluate(() => {
      const line = window.__app.buf.lines[window.__app.buf.rows - 1];
      for (let i = 0; i + 3 < line.length; ++i) {
        if (
          line[i].ch === '(' &&
          line[i + 1].ch === 'X' &&
          line[i + 2].ch === '%' &&
          line[i + 3].ch === ')'
        )
          return i;
      }
      return -1;
    });
  }
  async function clickCell(page, col) {
    const { x, y } = await page.evaluate((c) => {
      const v = window.__app.view;
      return {
        x: parseFloat(v.firstGridOffset.left) + v.chw * (c + 0.5),
        y:
          parseFloat(v.firstGridOffset.top) +
          v.chh * (window.__app.buf.rows - 1 + 0.5),
      };
    }, col);
    await page.mouse.click(x, y);
  }

  test('點 X 送 X、點 % 送 %（同一組括號、相鄰兩格）', async ({ page }) => {
    test.setTimeout(90000);
    if (!article2) return;
    await openArticle(page);

    const x = page.locator('#mainContainer a.fnKey[data-fnkey="X"]');
    const pct = page.locator('#mainContainer a.fnKey[data-fnkey="%"]');
    await expect(x).toHaveCount(1);
    await expect(pct).toHaveCount(1);
    // 兩顆在同一列、且是相鄰的兩格（`(X%)` 是一組括號）。
    const at = await groupStartCol(page);
    expect(at).toBeGreaterThanOrEqual(0);

    await startCapture(page);
    await x.click();
    await page.waitForTimeout(200);
    expect(await takeCapture(page)).toBe('X');

    await startCapture(page);
    await pct.click();
    await page.waitForTimeout(200);
    expect(await takeCapture(page)).toBe('%');
  });

  test('REGRESSION（D3）：括號本身不可點 —— 點 ( 或 ) 一個 byte 都不送', async ({
    page,
  }) => {
    test.setTimeout(90000);
    if (!article2) return;
    await openArticle(page);

    const at = await groupStartCol(page);
    expect(at).toBeGreaterThanOrEqual(0);

    await startCapture(page);
    // `(X%)`：`(` 在 at、`)` 在 at+3。
    await clickCell(page, at);
    await clickCell(page, at + 3);
    await page.waitForTimeout(250);
    // 括號留在畫面上當視覺分隔，但**不屬於任何一顆按鈕**：「指哪就觸發該鍵」
    // 不容許把 `(` 或 `)` 算進某一顆的範圍。
    // （文章的 col >= 7 沒有滑鼠動作 ⇒ 也不會走到退出手勢。）
    expect(await takeCapture(page)).toBe('');
  });
});
