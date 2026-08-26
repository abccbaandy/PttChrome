// 游標整列提亮（pref cursorRowBrighten，預設開）—— 離線重放，真瀏覽器、真 CSS。
//
// unit 量得到 class、量不到**顏色**：.cursorBrighten .qN 的提亮映射、以及它與
// .work-mode-active 的層疊順序（同 specificity，後定義者勝）只有真的跑過 CSSOM
// 才驗得出來。這一條就是為此存在。
//
// 還原的是 pttbbs e18a7182 的 cursor_show()：grayout(row,row+1,GRAYOUT_COLORBOLD)
// ＝整列 FTATTR_BOLD / ESC[1m（前景提亮一階、**背景不變**）。有底色的那個是
// GRAYOUT_STANDOUT，在本專案是另一個 pref cursorRowBackground。
// 考證見 docs/pttbbs-screen-protocol.md。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');

const list = findCassette('list');

// 游標所在列的**標示載體**。防誤觸模式（預設開）下標示只覆蓋可點區
// （clickableColStart：列表 col 30 起）⇒ class 掛在 LinkSegmentBuilder 包出來的
// .cursorHighlight wrapper 上，不是 bbsline 本身（bbsline 是 block 級，掛上去就滿版）。
// 防誤觸關掉時 col=0，才會回到 bbsline。兩種都要認得。
async function cursorLine(page) {
  return page.evaluate(() => {
    const row = window.__app.buf.cur_y;
    const line = document.querySelector(
      `#mainContainer [data-type="bbsline"][data-row="${row}"]`
    );
    if (!line) return null;
    const el = line.querySelector('.cursorHighlight') || line;
    const cs = getComputedStyle(el);
    return {
      row,
      partial: el !== line,
      classes: [...el.classList],
      // 上底色的話 background-color 會是不透明色；提亮不動背景 ⇒ 維持透明。
      background: cs.backgroundColor,
      textShadow: cs.textShadow,
    };
  });
}

// 標示範圍內第一個帶 .qN 前景 class 的字元 span 的實際顏色 + 它掛的 qN。
// **一定要從標示載體往下找**：防誤觸下 col 0-29 不在標示範圍內，從 bbsline 找到的
// 第一個字元根本沒被提亮，量出來會與基準色相同（假紅）。
async function firstColoredCell(page) {
  return page.evaluate(() => {
    const row = window.__app.buf.cur_y;
    const line = document.querySelector(
      `#mainContainer [data-type="bbsline"][data-row="${row}"]`
    );
    if (!line) return null;
    const scope = line.querySelector('.cursorHighlight') || line;
    for (const span of scope.querySelectorAll('span')) {
      const q = [...span.classList].find((c) => /^q\d+$/.test(c));
      if (q && span.textContent.trim())
        return { q, color: getComputedStyle(span).color };
    }
    return null;
  });
}

// 同一個 qN 在**沒有**提亮時的顏色（拿一個離線的探針元素量，不動畫面）。
async function baseColorOf(page, q) {
  return page.evaluate((cls) => {
    const probe = document.createElement('span');
    probe.className = cls;
    probe.textContent = 'x';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, q);
}

const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent'];

test.describe('游標整列提亮（離線重放）', () => {
  test.skip(!list, '尚無 list cassette；先 yarn record:cassette（RECORD_MODE=list）');

  test('預設：游標列提亮、背景不上色，且顏色真的變了', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    const line = await cursorLine(page);
    expect(line).not.toBeNull();
    expect(line.classes).toContain('cursorBrighten');
    // 預設不上底色 ⇒ 那一列不得有任何 bN 背景 class，背景維持透明。
    expect(line.classes.filter((c) => /^b\d+$/.test(c))).toEqual([]);
    expect(TRANSPARENT).toContain(line.background);
    // 已經是亮色的字沒有更亮的一階可去 ⇒ 靠整列 text-shadow 讓它也看得出變化。
    expect(line.textShadow).not.toBe('none');

    // CSS 真的生效：同一個 qN 在提亮列上的顏色與基準色不同（q8..q15 例外，
    // 它們本來就到頂，這時只看得到 text-shadow）。
    const cell = await firstColoredCell(page);
    expect(cell).not.toBeNull();
    const n = Number(cell.q.slice(1));
    if (n <= 7) {
      const base = await baseColorOf(page, cell.q);
      expect(cell.color).not.toBe(base);
      expect(cell.color).toBe(await baseColorOf(page, 'q' + (n + 8)));
    }
  });

  test('改成只上底色：提亮 class 消失、背景變成實色', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      window.__app.onPrefChange('cursorRowBrighten', false);
      window.__app.onPrefChange('cursorRowBackground', true);
    });
    await page.waitForTimeout(200);

    const line = await cursorLine(page);
    expect(line.classes).not.toContain('cursorBrighten');
    expect(line.classes.filter((c) => /^b\d+$/.test(c)).length).toBe(1);
    expect(TRANSPARENT).not.toContain(line.background);
  });

  test('兩種樣式都開 → 疊在同一列；都關 → 整列什麼都不畫', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    await page.evaluate(() =>
      window.__app.onPrefChange('cursorRowBackground', true)
    );
    await page.waitForTimeout(200);
    let line = await cursorLine(page);
    expect(line.classes).toContain('cursorBrighten');
    expect(line.classes.filter((c) => /^b\d+$/.test(c)).length).toBe(1);

    await page.evaluate(() => {
      window.__app.onPrefChange('cursorRowBrighten', false);
      window.__app.onPrefChange('cursorRowBackground', false);
    });
    await page.waitForTimeout(200);
    line = await cursorLine(page);
    expect(line.classes).not.toContain('cursorBrighten');
    expect(line.classes.filter((c) => /^b\d+$/.test(c))).toEqual([]);
    expect(TRANSPARENT).toContain(line.background);
  });
});
