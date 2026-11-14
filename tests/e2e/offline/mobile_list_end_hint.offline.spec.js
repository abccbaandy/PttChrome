// P85：手機列表這頁不滿時（看板搜尋結果只有幾筆），空白列不畫成一張張空卡片：
// 空卡片沒有分隔線，第一張空卡片寫「沒有更多了」（pref mobileListEndHint，預設開）。
// 只在 offline-mobile project 跑。unit 守 CSS 與節點（tests/unit/list_end_hint.test.js），
// 這支守真 boot 鏈：term_view 把 pref 帶進 enhance、真的素材畫出來確實有空白卡片。
// 素材：tests/e2e/cassettes/scn-board-search-prompt.json（看板搜尋結果一筆）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');

const cassette = loadCassette('scn-board-search-prompt');

const cardState = (page) =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('.main.mobileListCards .listBodyView > span.listCard')];
    const empty = cards.filter((c) => !c.textContent.trim());
    return {
      cards: cards.length,
      filled: cards.length - empty.length,
      empty: empty.length,
      hints: cards
        .map((c) => getComputedStyle(c, '::after').content)
        .filter((s) => s && s !== 'none' && s !== 'normal'),
      emptyShadows: empty.map((c) => getComputedStyle(c).boxShadow),
      filledShadow: cards.length > empty.length
        ? getComputedStyle(cards.find((c) => c.textContent.trim())).boxShadow
        : null,
    };
  });

async function engage(page, prefs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, ...prefs });
  await replayCassette(page, cassette, { easyReading: false });
  await expect
    .poll(async () => {
      const s = await cardState(page);
      return s.filled > 0 && s.empty > 0;
    }, { timeout: 20000 })
    .toBe(true);
}

test.describe('P85 手機列表到底寫「沒有更多了」（離線重放）', () => {
  test.skip(!cassette, '缺 scn-board-search-prompt（yarn record:scenarios）');

  test('預設開：空卡片沒有分隔線，提示只出現一次', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page, {});
    const s = await cardState(page);
    expect(s.filledShadow).not.toBe('none');
    expect(s.emptyShadows.every((x) => x === 'none')).toBe(true);
    expect(s.hints).toEqual(['"— 沒有更多了 —"']);
  });

  test('開關關掉：空卡片照舊畫分隔線、沒有提示', async ({ page }) => {
    test.setTimeout(90000);
    await engage(page, { mobileListEndHint: false });
    const s = await cardState(page);
    expect(s.emptyShadows.every((x) => x !== 'none')).toBe(true);
    expect(s.hints).toEqual([]);
  });
});
