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

// 找一列「左緣是純文字」的位置。好讀長頁裡有些列的左緣落在內嵌預覽插槽上
// （整寬區塊、起點就在第 0 欄），那裡本來就該由預覽優先接手，不是退出手勢的現場。
async function plainLeftEdge(page) {
  const pos = await page.evaluate(() => {
    const v = window.__app.view;
    const x = parseFloat(v.firstGridOffset.left) + v.chw * 1.5;
    const top = parseFloat(v.firstGridOffset.top);
    for (let row = 0; row < window.__app.buf.rows; ++row) {
      const y = top + v.chh * (row + 0.5);
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      if (el.closest('a, img, video, iframe, .inlinePreviewSlot, .previewLoading, .previewError'))
        continue;
      return { x, y, row };
    }
    return null;
  });
  if (!pos) throw new Error('找不到左緣是純文字的列');
  return pos;
}

// 找一列「可以被真的點到」的推文列，回傳它的座標與內容起始欄。
// 排除黑名單列（visibility:hidden ⇒ 根本不是 hit-test 目標）與左緣被連結／內嵌
// 預覽蓋住的列（那些位置本來就該由它們優先接手，見 plainLeftEdge 的同一理由）。
//
// **量座標前一定要等版面停下來**（2026-08-27 修，CI 偶發紅的來源）：好讀長頁裡有
// 行內預覽佔位盒（這卷 cassette 有 3 個），scrollIntoView 把它們捲進視窗正好觸發
// IntersectionObserver → mount → onLoad → ResizeObserver 撐高這串非同步流程 ⇒ 捲完
// 當下量到的 rect 之後還會再位移。位移之後 (contentX, y) 就落在別的元素上，點下去
// 既不會高亮（不是推文列）也不會送左方向鍵（在退出帶右邊）—— 症狀正是
// 「防誤觸開啟：點推文內容＝同作者高亮」拿到 0 個高亮列。本機 fixture 圖秒回，
// 幾乎都在量測前就穩定了，所以只在 CI 上偶發。
async function commentRow(page) {
  const pos = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 連續兩次量到同一個 top（±0.5px）才算穩定；撐不穩就放棄這一列。
    const settle = async (el) => {
      let last = null;
      for (let i = 0; i < 40; i++) {
        const top = el.getBoundingClientRect().top;
        if (last !== null && Math.abs(top - last) < 0.5) return true;
        last = top;
        await sleep(50);
      }
      return false;
    };
    const v = window.__app.view;
    const left = parseFloat(v.firstGridOffset.left);
    const xOf = (col) => left + v.chw * (col + 0.5);
    const rows = document.querySelectorAll(
      '#mainContainer span[type="bbsrow"][data-pusher]'
    );
    for (const el of rows) {
      if (el.style.visibility === 'hidden') continue;
      const col = Number(el.getAttribute('data-pusher-col'));
      if (!(col > 7)) continue; // 內容區要真的在退出帶右邊才有得比
      // 好讀是累積長頁，推文在文章尾端 ⇒ 預設一定捲在視窗外，elementFromPoint
      // 用的是**視窗座標**，不先捲進來一律落空。
      el.scrollIntoView({ block: 'center' });
      if (!(await settle(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const y = r.top + r.height / 2;
      // 連結／內嵌預覽在 App.mouse_click 裡優先於一切（含 pusher 高亮與退出帶），
      // 落在那上面的座標不是這一測的現場。
      const hit = (x) => {
        const at = document.elementFromPoint(x, y);
        if (!at || at.closest('[data-pusher]') !== el) return false;
        return !at.closest(
          'a, img, video, iframe, .inlinePreviewSlot, .previewLoading, .previewError'
        );
      };
      const leftX = xOf(1);
      const contentX = xOf(col + 1);
      if (!hit(leftX) || !hit(contentX)) continue;
      return { y, col, leftX, contentX, pusher: el.getAttribute('data-pusher') };
    }
    return null;
  });
  if (!pos) throw new Error('找不到可點的推文列');
  return pos;
}

// 點下去之前再確認一次「指標底下真的還是那一列推文」。版面若在量測之後又位移，
// 這裡會直接指出來，而不是讓斷言退化成看不出原因的「高亮 0 列」。
const pusherUnder = (page, x, y) =>
  page.evaluate(({ x, y }) => {
    const at = document.elementFromPoint(x, y);
    const el = at && at.closest && at.closest('[data-pusher]');
    return el ? el.getAttribute('data-pusher') : null;
  }, { x, y });

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
    await page.waitForTimeout(50);
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
    await page.waitForTimeout(50);
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

    const slot = await page.evaluate(
      () => !!document.querySelector('.inlinePreviewSlot')
    );
    test.skip(!slot, 'cassette 裡沒有內嵌預覽插槽');

    // 同理：先讓 mouseAction 是 exitArticle，才驗得到「預覽優先於退出」。
    const spot = await plainLeftEdge(page);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(50);
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
    await page.waitForTimeout(50);
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

    await page.evaluate(() => {
      window.__app.view.mainDisplay.scrollTop = 400;
    });
    await page.waitForTimeout(100);

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

      const row = await commentRow(page);
      await page.mouse.move(row.leftX, row.y);
      await page.waitForTimeout(50);
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

      const row = await commentRow(page);
      await page.mouse.move(row.contentX, row.y);
      await page.waitForTimeout(50);
      expect(
        await pusherUnder(page, row.contentX, row.y),
        '點擊前指標底下應仍是同一列推文（版面位移的話這裡先炸）'
      ).toBe(row.pusher);
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

      const row = await commentRow(page);
      await page.mouse.move(row.leftX, row.y);
      await page.waitForTimeout(50);
      expect(
        await pusherUnder(page, row.leftX, row.y),
        '點擊前指標底下應仍是同一列推文（版面位移的話這裡先炸）'
      ).toBe(row.pusher);
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
