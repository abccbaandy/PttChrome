// 手機上的原生文章列表（列表好讀關掉、安全模式、原生鏡像時的 80 欄格線）：tap 一列＝開那一篇。
// 只在 offline-mobile project 跑（真觸控 tap）。
//
// 回歸：畫面上留著選取（選取模式長按選了字、複製完沒收）時 tap 一列，mousedown 看到選取就把
// 這一下當成「點一下清掉選取」（桌機滑鼠的語意）⇒ 底色移到那一列、文章沒開，再點一次才開。
// 觸控的 tap 不是「點掉選取」的手勢（瀏覽器自己會在 mousedown 收掉選取），所以第一下就要開。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const nav = loadCassette('cchat-list-nav');

async function engageNative(page) {
  await bootOffline(page, ptt);
  await replayListCassette(page, nav);
  await page.waitForFunction(() => window.__app.buf.pageState === 2);
  await ptt.applyPrefs(page, { enableEasyReadingList: false, useMouseBrowsing: true, mouseLeftClick: true });
  await expect
    .poll(() => page.evaluate(() => window.__app.buf.listRenderMode === 'native' && !window.__app.view.listCards))
    .toBe(true);
  // 游標以外的一列文章列（標題列、欄名列之後）。
  const row = await page.evaluate(() => (window.__app.buf.cur_y === 6 ? 7 : 6));
  const sel = '#mainContainer [data-row="' + row + '"]';
  await waitRectStable(page, sel);
  const pt = await page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { x: b.left + b.width * 0.45, y: b.top + b.height / 2 };
  }, sel);
  return { row, pt };
}

async function tapOpens(page, pt) {
  const sentBefore = await page.evaluate(() => window.__replay.sent.length);
  await page.touchscreen.tap(pt.x, pt.y);
  await expect
    .poll(() => page.evaluate((n) => window.__replay.sent.slice(n).join(''), sentBefore))
    .toContain('\r');
}

test.describe('手機原生文章列表：tap 一列（離線重放）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette');

  test('tap 一列 ⇒ 第一下就開那一篇', async ({ page }) => {
    test.setTimeout(60000);
    const { pt } = await engageNative(page);
    await tapOpens(page, pt);
  });

  test('畫面上留著選取時 tap 一列 ⇒ 第一下就開那一篇，選取收掉', async ({ page }) => {
    test.setTimeout(60000);
    const { row, pt } = await engageNative(page);
    await page.evaluate((r) => {
      getSelection().selectAllChildren(document.querySelector('#mainContainer [data-row="' + (r + 2) + '"]'));
    }, row);
    expect(await page.evaluate(() => getSelection().isCollapsed)).toBe(false);
    await tapOpens(page, pt);
    expect(await page.evaluate(() => getSelection().isCollapsed)).toBe(true);
  });
});
