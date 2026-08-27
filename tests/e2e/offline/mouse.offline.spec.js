// 滑鼠功能重新設計（2026-08）的端到端守護 —— 離線重放，真瀏覽器、真渲染。
//
// 這裡鎖的東西 unit 抓不到：
//  * 提示帶的 CSS（pointer-events:none）與它跟可點區的像素對齊；
//  * 「連結／內嵌圖優先於左側退出」的實際 DOM 命中順序（含 a > span > span 的
//    雙色字 —— 舊的 isAnchorTarget 只往上找一層，那種字上會誤退出文章）；
//  * 總開關對中鍵與滾輪的 gate（改版前那兩個根本不看它）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  loadCassette,
  bootOffline,
  replayCassette,
  replayListCassette,
} = require('../helpers/replay');
// 量座標前一律先等版面停：好讀長頁的行內預覽會在 scrollIntoView 之後才撐高。
// 判準與 helper 的單一來源在 helpers/layout.js（靜態掃描守護
// tests/unit/e2e_layout_settle.test.js）。
const {
  assertElementUnder,
  assertPlainTextUnder,
  plainLeftEdge,
  stableCommentRow,
  waitPreviewsSettled,
} = require('../helpers/layout');

const article = findCassette('article');

const ARROW_LEFT = '\x1b[D';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';

// 終端機第 col 欄的畫面 x（取格子中心，避開邊界的 ±0.5 誤差）。
async function colX(page, col) {
  return page.evaluate((c) => {
    const left = window.__app.view.firstGridOffset.left;
    return parseFloat(left) + window.__app.view.chw * (c + 0.5);
  }, col);
}

// 滑鼠移到 (col, row) 並回傳當下的可觀察狀態。
async function hoverCell(page, col, row) {
  const x = await colX(page, col);
  const y = await page.evaluate(
    (r) => {
      const top = window.__app.view.firstGridOffset.top;
      return parseFloat(top) + window.__app.view.chh * (r + 0.5);
    },
    row
  );
  await page.mouse.move(x, y);
  await page.waitForTimeout(50);
  return page.evaluate(() => ({
    band: document.getElementById('exitHintBand').classList.contains('active'),
    cursor: window.__app.buf.BBSWin.style.cursor,
    action: window.__app.buf.mouseAction,
  }));
}

// plainLeftEdge / stableCommentRow / assertElementUnder 都搬到 helpers/layout.js —— 這裡
// 原本各有一份，pusher_highlight.offline 也有一份（且始終沒補上 settle，是 50fa35c
// 那個 bug 的活體）。合併之後只剩一處判準，補強會同時生效。

const highlightedPushers = (page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#mainContainer > span[type="bbsrow"].pusherHighlight')
    ).map((el) => el.getAttribute('data-pusher'))
  );

// 常駐的送出收集器：__stubWSSent 是 replay 的 hook（見 helpers/replay.js），
// 這裡接成一個可清空的陣列，好讓斷言橫跨「真實輸入」這種非同步操作。
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

test.describe('滑鼠（離線重放）', () => {
  if (!article) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  test('文章左側：滑鼠靠近亮出提示帶，移開就熄；點下去送左方向鍵離開', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayCassette(page, article, { easyReading: true });

    // 左側 7 欄：帶子亮起 + 自訂指標（url(...)，括號要平衡才不會被 CSS 丟棄）
    const near = await hoverCell(page, 1, 10);
    expect(near.band).toBe(true);
    expect(near.action).toBe('exitArticle');
    expect(near.cursor).toMatch(/^url\(.+\)\s+\d+\s+\d+,\s*auto$/);

    // 第 7 欄起就沒有動作了
    const away = await hoverCell(page, 20, 10);
    expect(away.band).toBe(false);
    expect(away.action).toBe('none');
    expect(away.cursor).toBe('auto');

    // 點左側 → 真的送出左方向鍵
    const spot = await plainLeftEdge(page);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50); // hover → mouseAction 更新
    // 探測點的 y 來自格子數學所以自己不會飄，但**底下的內容會**（上方預覽長高會把
    // 連結／預覽推進這一列）—— 連結與內嵌圖在 App.mouse_click 的優先權高過退出帶。
    await assertPlainTextUnder(page, spot.x, spot.y);
    await startCapture(page);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await takeCapture(page)).toContain(ARROW_LEFT);
  });

  test('提示帶不吃滑鼠事件：底下的元素照樣是 elementFromPoint 的命中目標', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);

    await hoverCell(page, 1, 10);
    const hit = await page.evaluate(() => {
      const band = document.getElementById('exitHintBand');
      const r = band.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        isBand: el === band,
        pointerEvents: getComputedStyle(band).pointerEvents,
      };
    });
    // pointer-events:none 少了的話，左側 7 欄的連結與圖片全部點不到。
    expect(hit.pointerEvents).toBe('none');
    expect(hit.isBand).toBe(false);
  });

  test('提示帶右緣＝可點區右緣（幾何與 clientToPos 同源）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);

    const probe = await page.evaluate(() => {
      const r = document.getElementById('exitHintBand').getBoundingClientRect();
      const app = window.__app;
      return {
        inside: app.clientToPos(r.right - 1, 200).col,
        outside: app.clientToPos(r.right + 1, 200).col,
        left: app.clientToPos(r.left + 1, 200).col,
      };
    });
    expect(probe.left).toBe(0);
    expect(probe.inside).toBe(6);
    expect(probe.outside).toBe(7);
  });

  test('連結優先於左側退出：點在連結內層 span 上也不會退出文章', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayCassette(page, article, { easyReading: true });

    await waitPreviewsSettled(page);
    // 連結內部最深可到 a > span > span（TwoColorWord / ForceWidthWord）。
    // 舊的 isAnchorTarget 只往上找一層 ⇒ 點在那種字上會漏判成終端機動作。
    const deep = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('#mainContainer a')).find(
        (el) => el.querySelector('span span')
      );
      if (!a) return null;
      const inner = a.querySelector('span span');
      inner.setAttribute('data-e2e-deep-link', '1');
      return true;
    });
    test.skip(!deep, 'cassette 裡沒有含巢狀 span 的連結');

    // 關鍵：先把滑鼠停在退出帶上，讓 buf.mouseAction === 'exitArticle'。只有這個
    // 組合才驗得到「連結優先」——否則點擊落點本來就沒有動作，測了等於沒測。
    const spot = await plainLeftEdge(page);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50); // hover → mouseAction 更新
    await assertPlainTextUnder(page, spot.x, spot.y);
    expect(await page.evaluate(() => window.__app.buf.mouseAction)).toBe('exitArticle');

    await startCapture(page);
    await page.evaluate(() => {
      document
        .querySelector('[data-e2e-deep-link]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await page.waitForTimeout(150);
    expect(await takeCapture(page)).not.toContain(ARROW_LEFT);
  });

  test('內嵌預覽圖優先：點圖只切放大，不會退出文章', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      enablePicPreview: true,
    });
    await replayCassette(page, article, { easyReading: true });

    await waitPreviewsSettled(page);
    const slot = await page.evaluate(
      () => !!document.querySelector('.inlinePreviewSlot')
    );
    test.skip(!slot, 'cassette 裡沒有內嵌預覽插槽');

    // 同理：先讓 mouseAction 是 exitArticle，才驗得到「預覽優先於退出」。
    const spot = await plainLeftEdge(page);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50); // hover → mouseAction 更新
    await assertPlainTextUnder(page, spot.x, spot.y);
    expect(await page.evaluate(() => window.__app.buf.mouseAction)).toBe('exitArticle');

    await startCapture(page);
    await page.evaluate(() => {
      document
        .querySelector('.inlinePreviewSlot')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await page.waitForTimeout(150);
    expect(await takeCapture(page)).not.toContain(ARROW_LEFT);
  });

  test('左鍵功能關閉：沒有提示帶、沒有自訂指標、點了不送鍵', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: false,
    });
    await replayCassette(page, article, { easyReading: true });

    const near = await hoverCell(page, 1, 10);
    expect(near.band).toBe(false);
    expect(near.cursor).toBe('auto');

    const spot = await plainLeftEdge(page);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50); // hover → mouseAction 更新
    // 探測點的 y 來自格子數學所以自己不會飄，但**底下的內容會**（上方預覽長高會把
    // 連結／預覽推進這一列）—— 連結與內嵌圖在 App.mouse_click 的優先權高過退出帶。
    await assertPlainTextUnder(page, spot.x, spot.y);
    await startCapture(page);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await takeCapture(page)).not.toContain(ARROW_LEFT);
  });

  test('總開關關閉：中鍵與滾輪一併失效（改版前這兩個不受它管）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, article, { easyReading: false });
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      useMouseBrowsing: false,
      mouseMiddleClick: 2, // 左方向鍵
      mouseWheel: 1, // 上下頁
    });

    const exercise = async () => {
      await startCapture(page);
      await page.mouse.move(300, 300);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.up({ button: 'middle' });
      await page.mouse.wheel(0, -120);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(200);
      return takeCapture(page);
    };

    expect(await exercise()).toBe('');

    // 關閉時 mouse_scroll 是裸 return（不 preventDefault）＝把滾輪交還瀏覽器。
    // 前提是原生模式根本沒有可捲距離，否則畫面會被捲走。
    const scrollable = await page.evaluate(() => {
      const de = document.documentElement;
      const main = window.__app.view.mainDisplay;
      return {
        page: de.scrollHeight - de.clientHeight,
        main: main.scrollHeight - main.clientHeight,
      };
    });
    expect(scrollable.page).toBeLessThanOrEqual(0);
    expect(scrollable.main).toBeLessThanOrEqual(0);

    // 打開總開關後兩者都活過來
    await ptt.applyPrefs(page, { useMouseBrowsing: true });
    const on = await exercise();
    expect(on).toContain(ARROW_LEFT); // 中鍵
    expect(on).toContain(PAGE_UP);
    expect(on).toContain(PAGE_DOWN);
  });

  test('好讀長頁捲到中段後，左側帶仍覆蓋整個視窗高度且點擊仍退出', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: true,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayCassette(page, article, { easyReading: true });

    await waitPreviewsSettled(page);
    await page.evaluate(() => {
      window.__app.view.mainDisplay.scrollTop = 400;
    });
    // 捲動會把新的佔位盒帶進「接近視野」而觸發載入 ⇒ 量帶子幾何前要重新等穩。
    await waitPreviewsSettled(page);

    // clientToPos 會把 row clamp 進 0..rows-1，所以視窗內任何 y、只要 col<7 都是離開。
    for (const row of [0, 12, 22]) {
      const s = await hoverCell(page, 2, row);
      expect(s.action).toBe('exitArticle');
      expect(s.band).toBe(true);
    }

    const covers = await page.evaluate(() => {
      const r = document.getElementById('exitHintBand').getBoundingClientRect();
      const win = document.getElementById('BBSWindow').getBoundingClientRect();
      return Math.abs(r.height - win.height) < 2 && Math.abs(r.top - win.top) < 2;
    });
    expect(covers).toBe(true);
  });

  // 2026-08 回報：推文區的左側退出區點不到。data-pusher 掛在**整列**上，而
  // App.mouse_click 的 pusher 分支走在滑鼠瀏覽 gate 之前 ⇒ 推文列的 cols 0-6
  // 一律被 pusher 高亮吃掉，退出手勢在整個推文區失效。
  // 防誤觸模式（預設開）改成只有內容文字算數，左側因此還給退出帶。
  test.describe('推文列的可點區（防誤觸模式）', () => {
    const boot = async (page, prefs) => {
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        useMouseBrowsing: true,
        mouseLeftClick: true,
        // 合併會把整個 run 包成一個 div（懸掛縮排、多行），逐列的欄位幾何不成立。
        mergeSameAuthorComments: false,
        ...prefs,
      });
      await replayCassette(page, article, { easyReading: true });
    };

    test('防誤觸開啟：推文列左側＝離開文章，不會變成 pusher 高亮', async ({ page }) => {
      test.setTimeout(90000);
      await boot(page, { mouseMisclickGuard: true });

      const row = await stableCommentRow(page);
      await page.mouse.move(row.leftX, row.y);
      await page.waitForTimeout(50); // hover → mouseAction 更新
      await assertElementUnder(page, row.leftX, row.y, row.pusher, {
        closest: '[data-pusher]',
        attribute: 'data-pusher',
      });
      expect(await page.evaluate(() => window.__app.buf.mouseAction)).toBe(
        'exitArticle'
      );

      await startCapture(page);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(150);
      expect(await takeCapture(page)).toContain(ARROW_LEFT);
      expect(await highlightedPushers(page)).toEqual([]);
    });

    test('防誤觸開啟：點推文內容＝同作者高亮，且不會離開文章', async ({ page }) => {
      test.setTimeout(90000);
      await boot(page, { mouseMisclickGuard: true });

      const row = await stableCommentRow(page);
      await page.mouse.move(row.contentX, row.y);
      await page.waitForTimeout(50); // hover → mouseAction 更新
      // 點擊前再確認一次指標底下還是同一列：版面若在量測之後又位移，這裡會直接說出
      // 「預期 X、實際 Y」，而不是讓斷言退化成看不出原因的「高亮 0 列」。
      await assertElementUnder(page, row.contentX, row.y, row.pusher, {
        closest: '[data-pusher]',
        attribute: 'data-pusher',
      });
      await startCapture(page);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(150);

      expect(await takeCapture(page)).not.toContain(ARROW_LEFT);
      const on = await highlightedPushers(page);
      expect(on.length).toBeGreaterThan(0);
      on.forEach((p) => expect(p).toBe(row.pusher));
    });

    test('防誤觸關閉：整條推文列都能觸發同作者高亮（改版前的行為）', async ({ page }) => {
      test.setTimeout(90000);
      await boot(page, { mouseMisclickGuard: false });

      const row = await stableCommentRow(page);
      await page.mouse.move(row.leftX, row.y);
      await page.waitForTimeout(50); // hover → mouseAction 更新
      await assertElementUnder(page, row.leftX, row.y, row.pusher, {
        closest: '[data-pusher]',
        attribute: 'data-pusher',
      });
      await startCapture(page);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(150);

      expect(await takeCapture(page)).not.toContain(ARROW_LEFT);
      const on = await highlightedPushers(page);
      expect(on.length).toBeGreaterThan(0);
      on.forEach((p) => expect(p).toBe(row.pusher));
    });
  });

  // 「列表左緣離開」2026-08 重新加回（當初移除是因為舊版 15 種動作完全沒有提示；
  // 提示帶＋back 指標補上之後 affordance 問題已解決）。見 docs/mouse.md。
  test.describe('列表的左側退出帶', () => {
    // 用 list cassette 才畫得出真的看板列表（article cassette 送 ← 在離線重放
    // 下沒有回應，畫面會停在文章上）。
    const listCassette = loadCassette('cchat-list-nav');

    const bootList = async (page, prefs) => {
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: false,
        enableEasyReadingList: false,
        useMouseBrowsing: true,
        mouseLeftClick: true,
        ...prefs,
      });
      await replayListCassette(page, listCassette);
      await page.waitForTimeout(400);
      const ps = await page.evaluate(() => window.__app.buf.pageState);
      expect(ps, '重放後應停在看板列表').toBe(2);
    };

    test('原生列表：左緣亮提示帶 ＋ back 指標；點下去送左方向鍵', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await bootList(page);

      const near = await hoverCell(page, 1, 10);
      expect(near.band).toBe(true);
      expect(near.action).toBe('exit');
      expect(near.cursor).toMatch(/^url\(.+\)\s+\d+\s+\d+,\s*auto$/);

      // 第 7 欄起就不是退出帶了（那裡是一般的列表可點區）。
      const away = await hoverCell(page, 40, 10);
      expect(away.band).toBe(false);
      expect(away.action).not.toBe('exit');

      await hoverCell(page, 1, 10);
      await startCapture(page);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(150);
      expect(await takeCapture(page)).toContain(ARROW_LEFT);
    });

    test('防誤觸關閉也一樣成立（固定手勢，不是欄位判定）', async ({ page }) => {
      test.setTimeout(90000);
      await bootList(page, { mouseMisclickGuard: false });

      const near = await hoverCell(page, 1, 10);
      expect(near.action).toBe('exit');
      expect(near.band).toBe(true);
    });
  });
});
