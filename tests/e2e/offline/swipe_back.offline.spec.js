// 瀏覽器「返回」→ PTT 左方向鍵的 history sentinel（離線重放，真瀏覽器真 History API）。
//
// **觸控板手勢那條路測不到，這是刻意的**：手勢一律交給瀏覽器原生跑，而
// `page.mouse.wheel()` 送的是合成 wheel 事件，**不會觸發原生的 overscroll 導航**
// （真手勢下頁面只收得到 1–3 個 wheel 就被瀏覽器接管；被 CSS 擋掉時才會收到
// 40–200 個）。手勢的視覺／時序／取消是瀏覽器 chrome 的行為，只能人工驗收，
// 矩陣見 docs/mouse.md。這裡測的是它們**共用的那一層**：導航真的發生時
// sentinel 有沒有接住。
//
// unit 抓不到的部分才放這裡：真 History API 上的 pushState/forward 行為
// （guard 的純邏輯由 tests/unit/history_back_guard.test.js 守）。
//
// 列表好讀（buffer）底下「必須走 ListSession 而不是裸送 byte」那條由 unit 守
// （tests/unit/term_view_send_key_as_user.test.js）：在這裡要製造 buffer 模式得
// 驅動整卷 list cassette，而該卷的門控只認錄製當時那串鍵，返回送出的 ← 會落在
// 沒有對應 step 的位置 —— 測到的會是 cassette 的門控而不是本功能。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');

const article = findCassette('article');
const ARROW_LEFT = '\x1b[D';

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

async function bootArticle(page, prefs = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    useMouseBrowsing: true,
    ...prefs,
  });
  await replayCassette(page, article, { easyReading: true });
}

// sentinel 要等第一次 user activation 才疊（Chrome 的 History Manipulation
// Intervention 會跳過沒有 activation 的 entry ⇒ 直接離站）。點在畫面左上角，
// 左鍵功能已在 bootArticle 關掉（不然那一下會落在左側退出帶而自己送一個 ←）。
async function armSentinel(page) {
  await page.mouse.click(5, 5);
  await page.waitForFunction(
    () => !!(window.history.state && window.history.state.pttchromeBackGuard)
  );
}

test.describe('瀏覽器返回 → 左方向鍵（離線重放）', () => {
  if (!article) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  test('返回：被攔下來送左方向鍵，頁面沒有離站', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page, { mouseLeftClick: false });
    await armSentinel(page);

    await startCapture(page);
    await page.goBack();
    await page.waitForTimeout(300);
    expect(await takeCapture(page)).toContain(ARROW_LEFT);
    // 還在同一個 document（沒有重載、沒有離站）
    expect(await page.evaluate(() => !!window.__app)).toBe(true);
  });

  // 本次改版的核心回歸鎖（F11）：sentinel 補回來若用 pushState，那一層是「無
  // user activation 產生的 entry」⇒ 被 intervention 標成可跳過 ⇒ **第二次返回
  // 完全 no-op**。真觸控板上的症狀是「滑一次就失效，要點一下畫面才能再滑」。
  // 這裡用 goBack() 走同一條 popstate，且中間**刻意不製造任何 activation**。
  test('連續兩次返回都接得住（中間沒有任何點擊／按鍵）', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page, { mouseLeftClick: false });
    await armSentinel(page);

    await startCapture(page);
    await page.goBack();
    await page.waitForTimeout(300);
    await page.goBack();
    await page.waitForTimeout(300);

    const sent = await takeCapture(page);
    expect(sent.split(ARROW_LEFT).length - 1).toBe(2);
    // 送得出去的返回不算逃生門的一次 ⇒ 連退兩層不可以把使用者丟出站。
    expect(await page.evaluate(() => !!window.__app)).toBe(true);
  });

  test('關掉返回攔截：不疊 sentinel（瀏覽器行為原封不動）', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page, { mouseBackNav: 0, mouseLeftClick: false });
    await page.mouse.click(5, 5);
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() => !!(window.history.state && window.history.state.pttchromeBackGuard))
    ).toBe(false);
  });

  // 回歸鎖（2026-09-05 實機回報：按側鍵／Alt+← 都會被導回文章裡）。
  //
  // 兩個功能交會：「網址列跟著現在在讀哪一篇走」用 replaceState 把**當前 entry**
  // 改成 `#Board/AID`，而那一層正是 sentinel ⇒ guard 用 forward() 走回去時
  // fragment 變動 ⇒ hashchange ⇒ deep_link_entry 當成「使用者又貼了一條連結」
  // ⇒ aid-search + aid-open 把畫面拉回那篇文章。
  //
  // **順序是重點**：sentinel 必須在開文章「之前」疊起來，E0（站台根）與
  // S1（文章網址）才會分歧；反過來的話兩層網址相同，traversal 根本不發
  // hashchange，這個 bug 就重現不出來。純邏輯那半由
  // tests/unit/back_guard_deep_link.test.js 守。
  test('返回不可以被自己的 traversal 當成新 deep link 而跳回文章', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: false,
    });
    // 先疊 sentinel（此時網址還是站台根）。
    await armSentinel(page);
    // 再進文章 ⇒ 網址列鏡像把 sentinel 那一層改成文章的分享連結。
    await replayCassette(page, article, { easyReading: true });
    await page.waitForFunction(() => location.hash.length > 1);

    // 觀測點是 `deepLinkController.request`（＝「使用者給了一條連結」這個邊界）。
    // **不要改成斷言送出去的 bytes**：offline 重放停在文章畫面，AID 跳轉會先被
    // 排隊而不立刻送 `#<aid>` ⇒ 那種斷言在有 bug 的 code 上照樣綠（實測過）。
    await page.evaluate(() => {
      window.__deepLinkRequests = [];
      const c = window.__app.deepLinkController;
      const orig = c.request.bind(c);
      c.request = (t, o) => {
        window.__deepLinkRequests.push(t);
        return orig(t, o);
      };
    });
    await startCapture(page);
    await page.goBack();
    await page.waitForTimeout(500);

    expect(await takeCapture(page)).toContain(ARROW_LEFT);
    expect(await page.evaluate(() => window.__deepLinkRequests)).toEqual([]);
  });

  // 原生手勢的前提：CSS 不可以擋掉 overscroll 導航。靜態守護在
  // tests/unit/native_gesture_css.test.js，這裡驗真瀏覽器算出來的 computed style
  // （游標在文章好讀的捲動視口上時最容易被 `contain` 誤殺）。
  test('捲動視口沒有擋掉水平的 overscroll 導航', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page);
    const behaviors = await page.evaluate(() => {
      const pick = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { x: cs.overscrollBehaviorX, y: cs.overscrollBehaviorY };
      };
      return {
        body: pick(document.body),
        html: pick(document.documentElement),
        main: pick(document.querySelector('.main')),
      };
    });
    for (const el of ['body', 'html', 'main']) {
      if (!behaviors[el]) continue;
      expect(behaviors[el].x, `${el} 的 overscroll-behavior-x`).toBe('auto');
    }
    // .main 仍要收住垂直的 rubber-band／外傳（拆軸的另一半）。
    if (behaviors.main) expect(behaviors.main.y).toBe('contain');
  });
});
