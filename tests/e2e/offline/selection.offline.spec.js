// 選取文字的兩條下游（issue #22，Firefox 上壞、Chrome 正常）：
//   1) copyOnSelect：放開滑鼠自動把選取寫進剪貼簿
//   2) 右鍵選單的快速搜尋：關鍵字要帶入選取內容
//
// **一定要用真滑鼠拖曳**選字（page.mouse.down/move/up）。其他 offline spec 為了穩定
// 是用程式化 addRange + dispatchEvent('contextmenu')，那條路徑繞過瀏覽器自己的選取
// 機制與 app 的焦點竊取（#t），Firefox 下照樣會綠 —— 等於測不到這個 bug。
//
// 本檔同時跑 chromium（offline project）與 firefox（offline-firefox project）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');

const WORD = 'SELECTSMOKE';

// 剪貼簿不能靠 context.grantPermissions(['clipboard-read'])：那是 Chromium-only。
// 改在頁面內把 navigator.clipboard 換成記錄用的 stub（同時也驗到 app 真的呼叫了它）。
async function stubClipboardAndPrefs(page, prefs) {
  await page.addInitScript((seed) => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied.push(String(t));
          return Promise.resolve();
        },
        readText: () =>
          Promise.resolve(window.__copied[window.__copied.length - 1] || ''),
      },
    });
    if (seed) {
      window.localStorage.setItem(
        'pttchrome.pref.v1',
        JSON.stringify({ values: seed })
      );
    }
  }, prefs || null);
}

async function boot(page, prefs) {
  await stubClipboardAndPrefs(page, prefs);
  await installReplay(page);
  await page.goto('/');
  await waitConnected(page);
}

async function feedLine(page, text) {
  await feedRaw(page, '\x1b[2J\x1b[H' + text);
  await page.waitForTimeout(200);
}

// 畫面上那串字的可視矩形（含 .main 的 transform 縮放）。
async function wordRect(page, text) {
  const rect = await page.evaluate((needle) => {
    const walker = document.createTreeWalker(
      document.getElementById('mainContainer'),
      NodeFilter.SHOW_TEXT
    );
    for (let node; (node = walker.nextNode()); ) {
      const idx = node.textContent.indexOf(needle);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
  }, text);
  if (!rect || rect.width < 4) {
    throw new Error(`${text} 未渲染到畫面（或量不到寬度），測試前提失效`);
  }
  return rect;
}

// 真滑鼠：從字串左緣拖到右緣。
async function dragSelect(page, rect) {
  const y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 1, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

// 失敗時要能一眼看出是「選取本身沒了」還是「讀取端讀錯」。
const probe = (page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    return {
      activeElement: document.activeElement && document.activeElement.id,
      rangeCount: sel.rangeCount,
      isCollapsed: sel.isCollapsed,
      text: sel.toString(),
      userSelect: (() => {
        const row = document.querySelector('#mainContainer > span');
        return row ? getComputedStyle(row).userSelect : '(no row)';
      })(),
    };
  });

test.describe('選取文字（offline）', () => {
  test('拖曳選取後：選取仍在、且讀得到文字', async ({ page }) => {
    await boot(page, { copyOnSelect: true });
    await feedLine(page, WORD);
    await dragSelect(page, await wordRect(page, WORD));

    // 診斷用：Firefox 壞掉時這裡先炸，直接指出是哪個機制。
    const info = await probe(page);
    expect(info.userSelect, `畫面列的 user-select 計算值=${info.userSelect}`).not.toBe(
      'none'
    );
    expect(info, `拖曳後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text).toContain(WORD);
  });

  test('copyOnSelect：放開滑鼠即把選取寫進剪貼簿', async ({ page }) => {
    await boot(page, { copyOnSelect: true });
    await feedLine(page, WORD);
    await dragSelect(page, await wordRect(page, WORD));

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual(expect.arrayContaining([expect.stringContaining(WORD)]));
  });

  // 鍵盤路徑：term_view 的 keyup 會無條件把焦點搶回隱藏 input #t，而 Firefox 的
  // Element.focus() 會收合 document selection（Chrome 不會）。copyOnSelect 關著，
  // 所以剪貼簿裡若有東西，必定是 ^C 這條路徑寫的。
  test('^C 複製：選取後按 Ctrl+C 拿得到選取文字', async ({ page }) => {
    await boot(page);
    await feedLine(page, WORD);
    await dragSelect(page, await wordRect(page, WORD));
    await page.keyboard.press('Control+c');

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual(expect.arrayContaining([expect.stringContaining(WORD)]));
  });

  // 雙擊／三擊選字：mousedown 的預設行為就是瀏覽器的選取機制，App.mouse_down 曾在
  // 「350ms 內的第二下」呼叫 preventDefault()（滑鼠瀏覽開啟時），把整組原生雙擊
  // 選詞／三擊選行掐死。useMouseBrowsing 預設 true ⇒ 預設就是壞的。
  // 純邏輯守護在 tests/unit/mouse_dblclick_skip.test.js，這裡鎖真瀏覽器的症狀。
  test('雙擊選字：滑鼠瀏覽開啟時仍選得到整個詞', async ({ page }) => {
    await boot(page, { useMouseBrowsing: true });
    await feedLine(page, 'alpha ' + WORD + ' omega');

    const rect = await wordRect(page, WORD);
    await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(150);

    const info = await probe(page);
    expect(info, `雙擊後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text).toContain(WORD);
  });

  test('三擊選行：滑鼠瀏覽開啟時選得到整列', async ({ page }) => {
    await boot(page, { useMouseBrowsing: true });
    await feedLine(page, 'alpha ' + WORD + ' omega');

    const rect = await wordRect(page, WORD);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await page.mouse.click(x, y, { clickCount: 3 });
    await page.waitForTimeout(150);

    const info = await probe(page);
    expect(info, `三擊後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text).toContain('alpha');
    expect(info.text).toContain('omega');
  });

  test('拖曳選取後右鍵：快速搜尋帶入選取內容', async ({ page }) => {
    await boot(page);
    await feedLine(page, WORD);
    const rect = await wordRect(page, WORD);
    await dragSelect(page, rect);

    // 右鍵落在選取範圍內（落在範圍外瀏覽器會先收合選取）。
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, {
      button: 'right',
    });

    const items = page.locator('.DropdownMenu__QuickSearch');
    await expect(items.first()).toBeVisible();
    await expect(items.filter({ hasText: WORD })).not.toHaveCount(0);
  });
});
