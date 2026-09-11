// 「BBS 終端機大小」兩種模式的幾何 —— 離線守門（真瀏覽器 / 真 layout）。
//
// 兩件事在 jsdom 量不到，只能在這裡鎖：
//   1. 「固定字體大小」模式的欄數恆 80（LOCKED，見 src/js/term_size.js）。改成依
//      視窗寬反推會讓終端機幾乎與視窗同寬，而 PTT 的內容只有 ~78 欄 ⇒ 右側整片
//      留白、畫面看起來靠左；本專案照 80 欄寫的欄位解析也全部要重驗。
//   2. 終端機**水平置中**，而且置中之後滑鼠座標（clientToPos）與退出提示帶仍與
//      格線對齊。置中是 pttchrome.jsx 的 `BBSWin.setAttribute("align","center")`
//      在做（Chrome 算成 text-align:-webkit-center，連 block 子元素一起置中）——
//      一個看起來很像遺跡、其實是硬需求的 deprecated 屬性，所以要有測試釘住它。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

// 隨便一個有內容的畫面，讓每一列都有可以量的節點。
const SCREEN = '\x1b[2J\x1b[1;1H  [test board]\x1b[5;1Habcdefg\x1b[5;1H';

// 設定頁的「終端機大小」走 onValuesPrefChange（整份值）而不是逐 key 的
// onPrefChange，所以不能用 ptt.applyPrefs。
async function applyTermSize(page, patch) {
  await page.evaluate((p) => {
    window.__app.onValuesPrefChange(Object.assign({}, window.__readPrefs(), p));
  }, patch);
  await page.waitForTimeout(300);
}

async function geom(page) {
  return page.evaluate(() => {
    const main = document.querySelector('.main');
    const band = document.getElementById('exitHintBand');
    const row = document.querySelector('#mainContainer [type="bbsrow"]');
    const v = window.__app.view;
    return {
      cols: window.__app.buf.cols,
      rows: window.__app.buf.rows,
      chw: v.chw,
      chh: v.chh,
      scaleX: v.scaleX,
      scaleY: v.scaleY,
      mainWidth: parseFloat(main.style.width),
      mainLeft: main.getBoundingClientRect().left,
      marginLeft: parseFloat(main.style.marginLeft) || 0,
      firstGridLeft: parseFloat(v.firstGridOffset.left),
      rowLeft: row ? row.getBoundingClientRect().left : null,
      bandLeft: parseFloat(band.style.left),
      bbsAlign: document.getElementById('BBSWindow').getAttribute('align'),
      innerWidth: v.innerBounds.width,
    };
  });
}

test.describe('BBS 終端機大小（離線）', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await feedRaw(page, SCREEN);
    await page.waitForTimeout(400); // term_buf 的 30ms notify debounce + render flush
  });

  test('固定終端機大小（預設 80×24）：畫面水平置中，座標消費端跟得上', async ({ page }) => {
    const g = await geom(page);
    expect(g.cols).toBe(80);
    expect(g.rows).toBe(24);
    expect(g.scaleX).toBe(1);
    // 置中的**唯一**來源。少了它，下面兩條斷言會退化成「都等於 0」而靜默通過，
    // 所以先鎖屬性本身。
    expect(g.bbsAlign).toBe('center');
    // 左右均分剩餘寬度。視窗（1280）比終端機寬 ⇒ 一定是正的，不是「剛好 0」。
    expect(g.mainLeft).toBeGreaterThan(0);
    expect(Math.abs(g.mainLeft - (g.innerWidth - g.mainWidth) / 2)).toBeLessThanOrEqual(1);
    // 置中不是靠 inline margin 疊出來的（疊了就會雙重置中，見 term_size.js）。
    expect(g.marginLeft).toBe(0);
    // 消費端跟得上：DOM 量到的第一格左緣、實際畫出來的列、提示帶三者同一個原點。
    expect(Math.abs(g.firstGridLeft - g.mainLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.rowLeft - g.mainLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.bandLeft - g.firstGridLeft)).toBeLessThanOrEqual(1);
  });

  test('置中之後 clientToPos 仍逐格對齊（滑鼠座標吃的是 .main 的 offsetLeft）', async ({
    page,
  }) => {
    const g = await geom(page);
    const at = (x) => page.evaluate((cx) => window.__app.clientToPos(cx, 10), x);
    expect((await at(g.firstGridLeft + g.chw * 3.5)).col).toBe(3);
    expect((await at(g.firstGridLeft + 1)).col).toBe(0);
    expect((await at(g.firstGridLeft + g.chw * 40.5)).col).toBe(40);
  });

  test('固定字體大小：欄數恆 80（LOCKED），列數隨視窗高度變多', async ({ page }) => {
    await applyTermSize(page, { termSizeMode: 'fixed-font-size', fontSize: 20 });
    const g = await geom(page);
    expect(g.cols).toBe(80); // ← 改成依視窗寬反推就會紅
    expect(g.rows).toBeGreaterThan(24); // 一頁真的看得到更多列
    expect(g.chh).toBe(20); // 字級固定，不隨視窗縮放
    expect(g.scaleX).toBe(1); // 這個模式永遠不縮放
    // 欄數鎖住之後，終端機比視窗窄 ⇒ 置中才看得出來（這就是使用者要的版面）。
    expect(g.mainWidth).toBeLessThan(g.innerWidth - 100);
    expect(Math.abs(g.mainLeft - (g.innerWidth - g.mainWidth) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.firstGridLeft - g.mainLeft)).toBeLessThanOrEqual(1);
  });

  test('縮放模式（把字體拉大來補滿畫面）：提示帶與 clientToPos 的公式原點仍成立', async ({
    page,
  }) => {
    // 不是整數格的視窗尺寸，scale 才會 ≠ 1（比例無條件捨去到小數兩位）。
    await page.setViewportSize({ width: 1013, height: 717 });
    await applyTermSize(page, {
      termSizeMode: 'fixed-term-size',
      fontFitWindowWidth: true,
      termSize: { cols: 80, rows: 24 },
    });
    const g = await geom(page);
    expect(g.scaleX).not.toBe(1); // 前提成立：真的在縮放
    // 縮放分支的原點是公式推的（mouse_geometry.gridOriginX），前提是 layout box
    // 置中 ＋ transform-origin: center。改成貼左，這條就會整條跑掉。
    const expectedBand = (g.innerWidth - g.chw * g.cols * g.scaleX) / 2;
    expect(Math.abs(g.bandLeft - expectedBand)).toBeLessThanOrEqual(1);
    expect(g.marginLeft).toBe(0);
  });
});
