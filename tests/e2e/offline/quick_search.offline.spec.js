// 快速搜尋（右鍵選單）的真瀏覽器守門。unit 抓不到的兩件事在這裡守：
//   1) **選單寬度是動態的**（jsdom 沒有 layout）：舊版 Menu width={220} 固定寬，
//      「Google 搜尋 '長關鍵字'」會被擠成第二行。現在改成 max-content + max-width，
//      長關鍵字必須「變寬但仍單行、超出用省略號」。
//   2) 真的 window.open 出去的網址（含 encodeURIComponent）。
//
// 不需 cassette：stub WebSocket 離線 boot 後直接餵畫面。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const label = (page, key) => page.evaluate(k => window.__i18n(k), key);

// window.open 攔下來（不要真的開分頁），並可預先塞偏好。
async function stubOpenAndPrefs(page, prefs) {
  await page.addInitScript(seed => {
    window.__opened = [];
    window.open = url => {
      window.__opened.push(url);
      return null;
    };
    if (seed) {
      window.localStorage.setItem(
        'pttchrome.pref.v1',
        JSON.stringify({ values: seed })
      );
    }
  }, prefs || null);
}

// 程式化選取畫面上的字串再派發 contextmenu：真滑鼠右鍵的 mousedown 若落在選取範圍
// 外會先收合選取，headless 下座標對位太脆（同 ui_behavior 的「複製」那條）。
async function selectAndRightClick(page, needle) {
  await page.evaluate(text => {
    const walker = document.createTreeWalker(
      document.getElementById('mainContainer'), NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      const idx = node.textContent.indexOf(text);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.getElementById('BBSWindow').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 }));
      return;
    }
    throw new Error('未渲染到畫面，測試前提失效: ' + text);
  }, needle);
}

async function boot(page, { prefs } = {}) {
  await stubOpenAndPrefs(page, prefs);
  await installReplay(page);
  await page.goto('/');
  await waitConnected(page);
}

async function feedLine(page, text) {
  await feedRaw(page, '\x1b[2J\x1b[H' + text);
  await page.waitForTimeout(200);
}

const quickItems = page => page.locator('.DropdownMenu__QuickSearch');

// 量選單幾何之前先等它真的可見且不再動。React 掛上選單、Mantine 套 transition、
// 文字量測撐開 max-content 都是分幀發生的 —— 右鍵之後**立刻** boundingBox() 量到的
// 可能是中途值（實際症狀是寬度比較忽大忽小）。
async function stableMenuBox(page) {
  await page.locator('.DropdownMenu').first().waitFor({ state: 'visible' });
  await waitRectStable(page, '.DropdownMenu');
  const box = await page.locator('.DropdownMenu').first().boundingBox();
  const item = await quickItems(page).first().boundingBox();
  return { box, item };
}

test.describe('快速搜尋（offline）', () => {
  test('選到純數字 → 三個內建項目全出現，點 pixiv 使用者開對的網址', async ({ page }) => {
    await boot(page);
    await feedLine(page, '126291399');
    await selectAndRightClick(page, '126291399');

    await expect(page.locator('.DropdownMenu').first()).toBeVisible();
    await expect(quickItems(page)).toHaveCount(3);

    const pixivUser = await label(page, 'quicksearch_builtin_pixivUser');
    await quickItems(page).filter({ hasText: pixivUser }).click();

    await expect
      .poll(() => page.evaluate(() => window.__opened))
      .toEqual(['https://www.pixiv.net/users/126291399']);
  });

  test('選到非數字 → 只剩 Google，且網址有 encode（回歸：舊版字串相接）', async ({ page }) => {
    await boot(page);
    await feedLine(page, 'hello&world');
    await selectAndRightClick(page, 'hello&world');

    await expect(quickItems(page)).toHaveCount(1);
    await quickItems(page).click();

    await expect
      .poll(() => page.evaluate(() => window.__opened))
      .toEqual(['https://www.google.com/search?q=hello%26world']);
  });

  test('設定停用的內建項目不出現在選單', async ({ page }) => {
    await boot(page, { prefs: { quickSearchDisabled: ['pixiv-artwork'] } });
    await feedLine(page, '126291399');
    await selectAndRightClick(page, '126291399');

    await expect(quickItems(page)).toHaveCount(2);
    const artwork = await label(page, 'quicksearch_builtin_pixivArtwork');
    await expect(quickItems(page).filter({ hasText: artwork })).toHaveCount(0);
  });

  test('長關鍵字：選單變寬但仍單行（有上限、不換行）', async ({ page }) => {
    const short = 'ab';
    const long = 'abcdefghij'.repeat(6); // 60 字，遠超舊的 220px 固定寬

    await boot(page);
    await feedLine(page, short);
    await selectAndRightClick(page, short);
    const { box: shortBox, item: shortItem } = await stableMenuBox(page);

    await page.keyboard.press('Escape');
    await feedLine(page, long);
    await selectAndRightClick(page, long);
    const { box: longBox, item: longItem } = await stableMenuBox(page);

    // 動態寬度：長關鍵字讓選單變寬……
    expect(longBox.width).toBeGreaterThan(shortBox.width);
    // ……但有上限（CSS max-width: min(560px, 100vw-24px)；上限在 2026-08 從 420
    // 放寬到 560，因為複製選項多了一行網址預覽，420 會把大半條網址省略掉）
    expect(longBox.width).toBeLessThanOrEqual(560);
    // 且項目維持單行（舊版固定 220px 時會擠成兩行 → 高度翻倍）
    expect(longItem.height).toBeLessThanOrEqual(shortItem.height + 1);
  });
});
