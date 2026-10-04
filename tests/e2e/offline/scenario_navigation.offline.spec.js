// 列表好讀 `]` 凍結交易、游標捲出視野後 ↓ 帶回、AID 跳文 → 返回 —— 重放真 PTT 錄的往返。
//
// 取代 2026-10 前的 live 測項（easy-reading-list.spec.js「A 類鍵 ]」「游標捲出視野後按 ↓」、
// aid-navigation.spec.js 三條）。live 版要現場挑文章、撈 AID、固定 sleep 等 PTT；這裡素材
// 固定（tests/e2e/cassettes/scn-*.json，yarn record:scenarios），等待一律綁重放進度。
// 純邏輯另有 unit：list_session / list_scroll / aid_navigation / nav_history。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  loadCassette,
  bootOffline,
  bootScenario,
  replayListCassette,
  waitFed,
} = require('../helpers/replay');

const bracket = loadCassette('scn-list-bracket');
const aidBack = loadCassette('scn-aid-back');
const aidBackSearch = loadCassette('scn-aid-back-search');
const nav = loadCassette('cchat-list-nav');

const listState = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    return {
      state: app.listSession.state,
      renderMode: app.buf.listRenderMode,
      queueIdle: app.commandQueue.idle,
      selectedNum: app.listSession._selectedNum,
      cursorHidden: document.getElementById('cursor').style.display === 'none',
    };
  });

async function engageListEasyReading(page) {
  await ptt.applyPrefs(page, { enableEasyReadingList: true });
  await page.waitForFunction(() => {
    const app = window.__app;
    return (
      app.listSession.state === 'active' &&
      app.buf.listRenderMode === 'buffer' &&
      app.commandQueue.idle
    );
  });
}

// 素材裡第 k 個 raw step 的 index（AID 導覽的 `s<board>` 開頭）。
const rawIndex = (cassette, k) =>
  cassette.steps.map((s, i) => (s.on === 'raw' ? i : -1)).filter((i) => i >= 0)[k];

// 好讀累積到文末、畫面 settle。
const waitArticleSettled = (page) =>
  page.waitForFunction(() => {
    const a = window.__app;
    return (
      a.buf.pageState === 3 &&
      a.view.useEasyReadingMode &&
      a.easyReading.easyReadingReachedPageEnd &&
      a.aidNavigation.active === false &&
      !a.buf.timerUpdate &&
      !a.buf._settleTimer
    );
  });

// 文章頭三列（好讀長頁的 pageLines；DOM 慢一幀，不讀它）。
const articleHead = (page) =>
  page.evaluate(() => {
    const b = window.__app.buf;
    return [0, 1, 2].map((r) => b.getRowText(r, 0, b.cols, b.pageLines)).join(' / ');
  });

// flashListHint 的紀錄：導覽失敗時產品只會在這裡說。
async function watchHints(page) {
  await page.evaluate(() => {
    window.__hints = [];
    const v = window.__app.view;
    const orig = v.flashListHint.bind(v);
    v.flashListHint = (msg, ms) => {
      window.__hints.push(msg);
      return orig(msg, ms);
    };
  });
}
const failedHints = (page) =>
  page.evaluate(() => window.__hints.filter((h) => h.includes('失敗')));

test.describe('列表好讀（scenario 重放）', () => {
  test('A 類鍵 `]` 走凍結交易：全程看不到原生 24 列', async ({ page }) => {
    test.skip(!bracket, '缺 scn-list-bracket（yarn record:scenarios）');
    await bootScenario(page, ptt, bracket);
    await engageListEasyReading(page);

    // 交易期間高頻取樣 listRenderMode：只要出現過一次 'native' 就是回歸。
    await page.evaluate(() => {
      window.__nativeSeen = false;
      window.__modeWatch = setInterval(() => {
        if (window.__app.buf.listRenderMode === 'native') window.__nativeSeen = true;
      }, 10);
    });
    await ptt.sendKey(page, ']');
    await waitFed(page, bracket.steps.length);
    await page.waitForFunction(() => {
      const app = window.__app;
      return app.listSession.state === 'active' && app.buf.listRenderMode === 'buffer' && app.commandQueue.idle;
    });
    const sawNative = await page.evaluate(() => {
      clearInterval(window.__modeWatch);
      return window.__nativeSeen;
    });
    expect(sawNative).toBe(false);
    expect((await listState(page)).cursorHidden).toBe(true);
    await expect(page.locator('.listBodyView')).toHaveCount(1);
  });

  test('捲動把游標捲出視野後，按 ↓ 會先把它帶回畫面上', async ({ page }) => {
    test.skip(!nav, '缺 cchat-list-nav');
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, { enableEasyReadingList: true, easyReadingListPrefetchCount: 200 });
    await page.waitForFunction(() => {
      const app = window.__app;
      return (
        app.listSession.state === 'active' &&
        app.commandQueue.idle &&
        (app.buf.listLines || []).length > 40
      );
    });
    // 游標剛 engage 時停在最新一篇，再往下就進置底區（selectedNum 變 null）⇒ 先往上
    // 移幾篇（本地導覽），↓ 才有「下一篇」可比。
    for (let i = 0; i < 3; i++) await ptt.sendKey(page, 'ArrowUp');
    await page.waitForFunction(() => window.__app.commandQueue.idle);
    const before = await listState(page);
    expect(typeof before.selectedNum).toBe('number');

    // 直接驅動視口（決定性；真滾輪另有 easy-reading-list.offline「滾輪 smoke」）。
    await page.evaluate(() => {
      const v = document.querySelector('#mainContainer .listBodyView');
      v.scrollTop = 0;
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('#mainContainer .listBodyView');
      return v.scrollTop === 0;
    });
    // 捲動不動游標（網頁式語意）。
    expect((await listState(page)).selectedNum).toBe(before.selectedNum);

    await ptt.sendKey(page, 'ArrowDown');
    // 游標往**舊端的下一篇**移一篇（升冪：下＝序號大），而且被帶回視野。
    const cursorInViewport = () =>
      page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        const vr = v.getBoundingClientRect();
        const row = Array.from(v.querySelectorAll('[data-type="bbsline"]')).find((el) =>
          el.textContent.startsWith('>')
        );
        if (!row) return false;
        const r = row.getBoundingClientRect();
        return r.top >= vr.top - 1 && r.bottom <= vr.bottom + 1;
      });
    await expect.poll(cursorInViewport).toBe(true);
    expect((await listState(page)).selectedNum).toBe(before.selectedNum + 1);
  });
});

test.describe('AID 跳文 → 返回（scenario 重放）', () => {
  test('從列表好讀開的文章：跳文後可返回原文（序號錨點＋捲動位置）', async ({ page }) => {
    test.skip(!aidBack, '缺 scn-aid-back（yarn record:scenarios）');
    await bootScenario(page, ptt, aidBack);
    await engageListEasyReading(page);
    await watchHints(page);

    await ptt.sendKey(page, 'Enter');
    await waitFed(page, rawIndex(aidBack, 0));
    await waitArticleSettled(page);
    const originHead = await articleHead(page);
    const scrolled = await page.evaluate(() => {
      const d = window.__app.view.mainDisplay;
      d.scrollTop = Math.min(400, Math.max(0, d.scrollHeight - d.clientHeight));
      return d.scrollTop;
    });

    // 跳文（等同點擊文章裡的 AID 連結）。
    await page.evaluate(([a, b]) => window.__app.aidNavigation.start(a, b), [aidBack.meta.aid, aidBack.meta.board]);
    await waitFed(page, rawIndex(aidBack, 2));
    await waitArticleSettled(page);
    expect(await failedHints(page)).toEqual([]);
    expect(await articleHead(page)).not.toBe(originHead);
    expect(await page.evaluate(() => window.__app.aidNavigation.canGoBack())).toBe(true);
    expect(
      await page.evaluate(() => {
        const el = window.__app.view._aidBackEl;
        return !!el && el.style.display !== 'none';
      })
    ).toBe(true);

    // 返回。
    await page.evaluate(() => window.__app.aidNavigation.back());
    await waitFed(page, aidBack.steps.length);
    await waitArticleSettled(page);
    expect(await failedHints(page)).toEqual([]);
    expect(await articleHead(page)).toBe(originHead);
    if (scrolled > 0)
      await expect
        .poll(() => page.evaluate(() => window.__app.view.mainDisplay.scrollTop))
        .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__app.aidNavigation.canGoBack())).toBe(false);
  });

  // REGRESSION（使用者回報）：`/` 搜尋 → 進文章 → 點 AID → 返回 → 回不到原文。序號在
  // 搜尋清單裡會位移，修法是離開前問出本篇自己的 AID 當錨點（素材裡的返回目標就是它）。
  test('從 `/` 搜尋結果開的文章：返回走 aid 錨點，回得到原文', async ({ page }) => {
    test.skip(!aidBackSearch, '缺 scn-aid-back-search（yarn record:scenarios）');
    await bootScenario(page, ptt, aidBackSearch);
    await watchHints(page);

    await ptt.sendKey(page, 'Slash');
    await waitFed(page, 2);
    await ptt.typeLine(page, aidBackSearch.meta.keyword);
    await waitFed(page, 3);
    await ptt.sendKey(page, 'Enter');
    await waitFed(page, rawIndex(aidBackSearch, 0));
    await waitArticleSettled(page);
    const originHead = await articleHead(page);

    await page.evaluate(
      ([a, b]) => window.__app.aidNavigation.start(a, b),
      [aidBackSearch.meta.aid, aidBackSearch.meta.board]
    );
    await waitFed(page, rawIndex(aidBackSearch, 2));
    await waitArticleSettled(page);
    expect(await articleHead(page)).not.toBe(originHead);
    const anchor = await page.evaluate(() => {
      const n = window.__app.aidNavigation;
      return { canBack: n.canGoBack(), label: n._history.peek() };
    });
    expect(anchor.canBack).toBe(true);
    expect(anchor.label && anchor.label.kind).toBe('aid');

    await page.evaluate(() => window.__app.aidNavigation.back());
    await waitFed(page, aidBackSearch.steps.length);
    await waitArticleSettled(page);
    expect(await failedHints(page)).toEqual([]);
    expect(await articleHead(page)).toBe(originHead);
  });
});
