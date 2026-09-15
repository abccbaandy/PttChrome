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

// 終端機第 row 列的畫面 y（取格子中心）。
async function rowY(page, row) {
  return page.evaluate((r) => {
    const top = window.__app.view.firstGridOffset.top;
    return parseFloat(top) + window.__app.view.chh * (r + 0.5);
  }, row);
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

// 找一張「左側留白整段蓋過左側退出帶」的內嵌圖，回傳一個落在那片留白裡、且仍在
// 退出帶之內的座標（取圖片的垂直中心，確定跟圖片同高）。找不到回 null。
//
// 自動開圖是延遲載入的：不捲進視野連 requestPreview() 都不會被呼叫 ⇒ 得逐段捲著找
// （同 image_gray.offline.spec.js#seekGrayableImage）。本 cassette 實測 slot 1210px、
// 圖 760px ⇒ 單側留白 225px ＝ 15 欄，而退出帶是 7 欄。
async function seekWidePadding(page) {
  const geom = await page.evaluate(() => {
    const s = document.querySelector('.main');
    return s ? { h: s.scrollHeight, ch: s.clientHeight } : null;
  });
  if (!geom) return null;
  const bandRight = await page.evaluate(
    () => document.getElementById('exitHintBand').getBoundingClientRect().right
  );
  const step = Math.max(200, geom.ch * 0.8);
  for (let top = 0; top <= geom.h; top += step) {
    await page.evaluate((t) => {
      document.querySelector('.main').scrollTop = t;
    }, top);
    await waitPreviewsSettled(page);
    const hit = await page.evaluate((right) => {
      for (const slot of document.querySelectorAll('.inlinePreviewSlot')) {
        const img = slot.querySelector('img.easyReadingImg');
        if (!img || !(img.offsetWidth > 0 && img.offsetHeight > 0)) continue;
        const sr = slot.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        // 留白得整段蓋過退出帶，否則量到的是「圖片真的在那幾欄」＝既有的圖片優先。
        if (ir.left <= right) continue;
        const y = ir.top + ir.height / 2;
        if (y < 0 || y > window.innerHeight) continue;
        return { x: Math.round(sr.left + 2), y: Math.round(y) };
      }
      return null;
    }, bandRight);
    if (hit) return hit;
  }
  return null;
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
      // 這一條測的是左側退出帶本身 ⇒ 把 2026-09 找回來的邊緣翻頁區關掉，讓
      // 「第 7 欄起沒有動作」維持成立（那一區另有自己的 describe）。
      mouseEdgePaging: false,
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

  // 2026-09 回報：有圖時左側退出點擊區幾乎點不到。.inlinePreviewSlot 是**整列寬**的
  // 區塊（沒有 width 宣告，逐層繼承 .main 的 chw*80+10px），圖片卻是 max-width:39em
  // ＋ margin:auto 置中 ⇒ 直式圖／小圖左右各留下數十欄空白。那片空白以前也被
  // isPreviewTarget 當成「點在預覽上」⇒ App.mouse_click 第 5 條直接 return。
  // 而 hover 路徑**純看格子座標、完全不看 DOM** ⇒ 提示帶照亮、指標照樣是 back，
  // 點下去 0 byte —— affordance 在說謊。
  //
  // 修法是 CSS 的 pointer-events 收斂（宣告本身由 tests/unit/preview_pointer_events_css
  // 靜態守護，那是「改壞了也不會有其他測試紅」的那種）；真幾何只有這裡量得到。
  // 上面那條「內嵌預覽圖優先」守的是相反方向 —— 它用 dispatchEvent 直接打在 slot 上
  // （不經 hit-test），守的是「PREVIEW_CLICK_SELECTOR 這道安全網還在」。
  test('圖片左右留白不算預覽：那裡的左側退出照樣送左方向鍵', async ({ page }) => {
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

    const spot = await seekWidePadding(page);
    test.skip(!spot, 'cassette 裡沒有左右留白寬於退出帶的內嵌圖');

    // 座標在圖片之外、退出帶之內。改動前 elementFromPoint 會回 .inlinePreviewSlot
    // （它在 helpers/layout.js 的 OVERRIDING_SEL 裡）⇒ 這一行就先紅。
    await assertPlainTextUnder(page, spot.x, spot.y);

    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50); // hover → mouseAction 更新
    expect(await page.evaluate(() => window.__app.buf.mouseAction)).toBe('exitArticle');

    await startCapture(page);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(
      await takeCapture(page),
      '提示帶亮著、指標是 back，點下去卻 0 byte'
    ).toContain(ARROW_LEFT);
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
  // ── 邊緣點擊翻頁（2026-09 找回原版的四個區域）──────────────────────────────
  //
  // unit 抓不到的三件事：真的送出去的 byte（原生）／真的捲動（好讀）、提示帶與
  // 可點區的像素對齊、以及「功能鍵按鈕仍然贏過整列翻頁區」這條元素層優先權。
  test.describe('邊緣點擊翻頁', () => {
    const listCassette2 = loadCassette('cchat-list-nav');
    const HOME = '\x1b[1~';
    const END = '\x1b[4~';

    const bootNativeList = async (page, prefs) => {
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: false,
        enableEasyReadingList: false,
        useMouseBrowsing: true,
        mouseLeftClick: true,
        mouseEdgePaging: true,
        ...prefs,
      });
      await replayListCassette(page, listCassette2);
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(2);
    };

    const bootArticle = async (page, prefs) => {
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        useMouseBrowsing: true,
        mouseLeftClick: true,
        mouseEdgePaging: true,
        ...prefs,
      });
      await replayCassette(page, article, { easyReading: true });
    };

    const edgeBand = (page) =>
      page.evaluate(() => {
        const el = document.getElementById('edgeHintBand');
        const r = el.getBoundingClientRect();
        return {
          active: el.classList.contains('active'),
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });

    // 連續點擊之間**必須等超過 350ms**：mouse_down 在 dblclickTimer 還活著時會立
    // SkipMouseClick（雙擊選詞不可以順便翻兩頁，見 App.setDblclickTimer）。少等的話
    // 第二下之後全部被吞掉，看起來像功能壞了。
    const clickAt = async (page, x, y) => {
      await page.mouse.move(x, y);
      await page.waitForTimeout(60);
      await startCapture(page);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);
      return takeCapture(page);
    };

    // 好讀長頁上一個「不是連結、也不是內嵌預覽」的點：那兩種在點擊優先權表上排在
    // 滑鼠瀏覽之前（第 4、5 條），點到就只是開連結／切換放大。
    const plainPointInHalf = (page, half) =>
      page.evaluate((h) => {
        const view = window.__app.view;
        const top = parseFloat(view.firstGridOffset.top);
        const left = parseFloat(view.firstGridOffset.left);
        const rows = window.__app.buf.rows;
        const mid = Math.floor(rows / 2);
        const range = [];
        if (h === 'up') for (let r = 2; r <= mid; ++r) range.push(r);
        else for (let r = mid + 1; r <= rows - 2; ++r) range.push(r);
        for (const r of range) {
          const y = top + view.chh * (r + 0.5);
          for (const c of [40, 30, 50, 20, 60, 70]) {
            const x = left + view.chw * (c + 0.5);
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest) continue;
            if (el.closest('a') || el.closest('.inlinePreviewSlot')) continue;
            return { x, y };
          }
        }
        return null;
      }, half);

    test('原生列表：頂列 Home／底列 End／右緣上下半翻頁，送的是真的按鍵序列', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await bootNativeList(page);

      // 頂列（標題列）＝ Home。row 1 是功能鍵提示列，刻意避開。
      expect(await clickAt(page, await colX(page, 40), await rowY(page, 0))).toContain(
        HOME
      );
      // 底列＝ End。點在狀態列右側的空白處（功能鍵按鈕自己有元素層 listener）。
      expect(await clickAt(page, await colX(page, 76), await rowY(page, 23))).toContain(
        END
      );
      // 右緣：上半上一頁、下半下一頁。
      expect(await clickAt(page, await colX(page, 70), await rowY(page, 6))).toContain(
        PAGE_UP
      );
      expect(await clickAt(page, await colX(page, 70), await rowY(page, 20))).toContain(
        PAGE_DOWN
      );
    });

    test('提示帶與可點區逐格對齊（右緣帶左緣的前一格仍是開文區）', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await bootNativeList(page);

      await page.mouse.move(await colX(page, 70), await rowY(page, 6));
      await page.waitForTimeout(60);
      const band = await edgeBand(page);
      expect(band.active).toBe(true);

      // 帶子左緣往左 2px ⇒ 不再是翻頁區，帶子也要熄掉。
      await page.mouse.move(band.left - 2, await rowY(page, 6));
      await page.waitForTimeout(60);
      expect(await page.evaluate(() => window.__app.buf.mouseAction)).not.toMatch(
        /^page/
      );
      expect((await edgeBand(page)).active).toBe(false);

      // 帶子右緣就是行尾。
      await page.mouse.move(band.right - 2, await rowY(page, 6));
      await page.waitForTimeout(60);
      expect(await page.evaluate(() => window.__app.buf.mouseAction)).toBe('pageUp');
    });

    test('提示帶 pointer-events:none —— 不得擋掉底下的任何點擊', async ({ page }) => {
      test.setTimeout(90000);
      await bootNativeList(page);
      expect(
        await page.evaluate(
          () =>
            getComputedStyle(document.getElementById('edgeHintBand')).pointerEvents
        )
      ).toBe('none');
    });

    test('功能鍵按鈕仍然贏過翻頁區（元素層 listener 先跑）', async ({ page }) => {
      test.setTimeout(90000);
      await bootNativeList(page, { mouseFunctionKeys: true });

      const key = await page.evaluate(() => {
        const a = document.querySelector('#mainContainer a.fnKey');
        if (!a) return null;
        const r = a.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      test.skip(!key, '這一幀沒有功能鍵按鈕');

      const sent = await clickAt(page, key.x, key.y);
      // 送出去的是那顆按鍵本身，翻頁序列一個都不能混進去。
      expect(sent).not.toContain(PAGE_UP);
      expect(sent).not.toContain(HOME);
      expect(sent).not.toContain(END);
      expect(sent.length).toBeGreaterThan(0);
    });

    test('pref 關掉 ⇒ 一格都沒有邊緣區（退回找回之前的行為）', async ({ page }) => {
      test.setTimeout(90000);
      await bootNativeList(page, { mouseEdgePaging: false });

      await page.mouse.move(await colX(page, 70), await rowY(page, 6));
      await page.waitForTimeout(60);
      expect((await edgeBand(page)).active).toBe(false);
      expect(await page.evaluate(() => window.__app.buf.mouseAction)).not.toMatch(
        /^page/
      );
      expect(await clickAt(page, await colX(page, 40), await rowY(page, 0))).not.toContain(
        HOME
      );
    });

    test('文章好讀：上半／下半＝捲動一頁，底列＝捲到文末，0 byte 送給 PTT', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await bootArticle(page);
      await waitPreviewsSettled(page);

      const scrollTop = () =>
        page.evaluate(() => document.querySelector('.main').scrollTop);
      await page.evaluate(() => {
        document.querySelector('.main').scrollTop = 0;
      });

      // 下半 ⇒ 往下捲一頁，而且**不送 byte 給 PTT**（好讀的語意是捲動）。
      const down = await plainPointInHalf(page, 'down');
      expect(down, '找不到不是連結／預覽的可點處').not.toBeNull();
      expect(await clickAt(page, down.x, down.y)).toBe('');
      const afterDown = await scrollTop();
      expect(afterDown).toBeGreaterThan(0);

      // 上半 ⇒ 捲回去。
      const up = await plainPointInHalf(page, 'up');
      expect(up).not.toBeNull();
      await clickAt(page, up.x, up.y);
      expect(await scrollTop()).toBeLessThan(afterDown);

      // 底列 ⇒ 捲到文末（與鍵盤 End 同一條路：easy_reading._scrollBottom）。
      await clickAt(page, await colX(page, 40), await rowY(page, 23));
      const max = await page.evaluate(() => {
        const m = document.querySelector('.main');
        return m.scrollHeight - m.clientHeight;
      });
      expect(await scrollTop()).toBeGreaterThan(max - 5);
    });

    test('文章好讀：左側退出帶贏過底列 End（帶子亮著就得是離開）', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await bootArticle(page);

      const at = await hoverCell(page, 2, 23);
      expect(at.action).toBe('exitArticle');
      expect(at.band).toBe(true);
    });

    // 第三條 render 分支：列表好讀（buffer）。它的點擊**永遠不會**走到 action
    // switch —— App.mouse_click 提早分流給 ListSession，所以邊緣區在那裡另外接了
    // 一次，而且吃的是**螢幕列號**（body 的 row 是整段序列的 index）。
    test('列表好讀：右緣下半＝下一頁、頂列＝Home，交易照走不破封閉互動', async ({
      page,
    }) => {
      test.setTimeout(120000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        useMouseBrowsing: true,
        mouseLeftClick: true,
        mouseEdgePaging: true,
      });
      await replayListCassette(page, listCassette2);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 200,
      });
      await page.waitForFunction(
        () =>
          window.__app.listSession &&
          window.__app.listSession.state === 'active' &&
          window.__app.buf.listRenderMode === 'buffer',
        null,
        { timeout: 20000 }
      );

      // **位置一律用序列 index（getListView().cursorPos）**：_selectedNum 在置底文
      // 上是 null，拿它當位置會在「翻到列表尾端」時退化成 null vs null 的假斷言。
      const pos = () =>
        page.evaluate(() => {
          const ls = window.__app.listSession;
          const v = ls.getListView();
          return {
            cursor: v ? v.cursorPos : -1,
            len: v ? v.seq.length : 0,
            state: ls.state,
            mode: window.__app.buf.listRenderMode,
          };
        });
      // 交易在途時 ListSession 會吞掉按鍵並給提示（v5 封閉互動）⇒ 等它閒下來再動，
      // 不用固定 timeout（慢速桶下那是必紅的寫法）。
      const settle = () =>
        page.waitForFunction(
          () =>
            window.__app.commandQueue.idle &&
            window.__app.listSession.state === 'active',
          null,
          { timeout: 20000 }
        );

      await settle();
      const before = await pos();
      expect(before.len).toBeGreaterThan(5);

      // 右緣下半（螢幕列 20）＝下一頁：游標往序列後面走。
      await clickAt(page, await colX(page, 70), await rowY(page, 20));
      await expect
        .poll(async () => (await pos()).cursor, { timeout: 15000 })
        .toBeGreaterThan(before.cursor);
      const afterPgDn = await pos();
      // 封閉互動沒有被繞過：session 還活著、畫面還是它在畫。
      expect(afterPgDn.state).toBe('active');
      expect(afterPgDn.mode).toBe('buffer');

      // 頂列＝Home。**它不是本地瞬移**：ListSession 的 home/end 一律走 server 交易
      // （list_session._requestHome，2026-09-05 定案），所以離線重放下落點不會動 ——
      // 這裡鎖的是「那一下真的變成 session 的 jump-home 交易」，也就是走了
      // CommandQueue 而不是繞過它裸送 byte。
      await settle();
      await startCapture(page);
      await page.mouse.move(await colX(page, 40), await rowY(page, 0));
      await page.waitForTimeout(60);
      await page.mouse.down();
      await page.mouse.up();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const q = window.__app.commandQueue;
              return q.inFlightKind || (window.__sentLog || []).join('');
            }),
          { timeout: 15000 }
        )
        .toMatch(/jump-home|\x1b\[1~/);
      const afterHome = await pos();
      expect(afterHome.state).toBe('active');
      expect(afterHome.mode).toBe('buffer');
    });

    // 風險項：好讀長頁是捲動視口，右緣有瀏覽器捲軸 —— 拖它不可以被當成翻頁點擊。
    test('拖捲軸不會翻頁', async ({ page }) => {
      test.setTimeout(90000);
      await bootArticle(page);
      await waitPreviewsSettled(page);

      const bar = await page.evaluate(() => {
        const m = document.querySelector('.main');
        const r = m.getBoundingClientRect();
        const w = r.width - m.clientWidth; // 捲軸寬度（overlay 捲軸為 0）
        return w > 0 ? { x: r.right - w / 2, top: r.top + 20 } : null;
      });
      test.skip(!bar, '這個環境的捲軸是 overlay（不佔寬度）');

      await page.evaluate(() => {
        document.querySelector('.main').scrollTop = 0;
      });
      await startCapture(page);
      await page.mouse.move(bar.x, bar.top);
      await page.mouse.down();
      await page.mouse.move(bar.x, bar.top + 120, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      // 拖捲軸就只是捲動：不得送出任何 byte。
      expect(await takeCapture(page)).toBe('');
    });
  });
});

