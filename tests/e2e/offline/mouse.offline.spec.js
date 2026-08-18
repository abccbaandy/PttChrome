// 滑鼠功能重新設計（2026-08）的端到端守護 —— 離線重放，真瀏覽器、真渲染。
//
// 這裡鎖的東西 unit 抓不到：
//  * 提示帶的 CSS（pointer-events:none）與它跟可點區的像素對齊；
//  * 「連結／內嵌圖優先於左側退出」的實際 DOM 命中順序（含 a > span > span 的
//    雙色字 —— 舊的 isAnchorTarget 只往上找一層，那種字上會誤退出文章）；
//  * 總開關對中鍵與滾輪的 gate（改版前那兩個根本不看它）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');

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
});
