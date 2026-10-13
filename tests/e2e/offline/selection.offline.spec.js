// 選取文字的兩條下游（issue #22，Firefox 上壞、Chrome 正常）：
//   1) copyOnSelect：放開滑鼠自動把選取寫進剪貼簿
//   2) 右鍵選單的快速搜尋：關鍵字要帶入選取內容
//
// **一定要用真滑鼠拖曳**選字（page.mouse.down/move/up）。程式化 addRange +
// dispatchEvent('contextmenu') 會繞過瀏覽器自己的選取機制與 app 的焦點竊取（#t），
// Firefox 下照樣會綠 —— 等於測不到這個 bug。2026-10 起所有 offline spec 都改走真輸入
// （helpers/real_input.js，守護 tests/unit/e2e_real_input.test.js）。
//
// 本檔同時跑 chromium（offline project）與 firefox（offline-firefox project）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw, waitScreenSettled } = require('../helpers/replay');
const { waitClickSettled, nextFrames } = require('../helpers/real_input');
const { openLongArticle } = require('../helpers/pmore_long_article');

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
  await waitScreenSettled(page);
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
  // 存活型：選取當下就成立，要證的是「之後沒被打斷」⇒ 等 app 對這個手勢的延遲反應
  // 全部跑完再讀（helpers/real_input.js#waitClickSettled），不是固定睡眠。
  await waitClickSettled(page);
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
    // 存活型：選取當下就成立，要證的是「之後沒被打斷」⇒ 等 app 對這個手勢的延遲反應
    // 全部跑完再讀（helpers/real_input.js#waitClickSettled），不是固定睡眠。
    await waitClickSettled(page);

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
    // 存活型：選取當下就成立，要證的是「之後沒被打斷」⇒ 等 app 對這個手勢的延遲反應
    // 全部跑完再讀（helpers/real_input.js#waitClickSettled），不是固定睡眠。
    await waitClickSettled(page);

    const info = await probe(page);
    expect(info, `三擊後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text).toContain('alpha');
    expect(info.text).toContain('omega');
  });

  // 2026-09 XTerm SGR 滑鼠回報：把滑鼠交給 PTT server 之後，原生選字**仍然要能用**
  // （CLAUDE.md 硬規則：系統／瀏覽器的原生行為不准模擬也不准擋掉）。
  //
  // 這條的設計刻意「不新增任何 mousedown/mouseup/auxclick listener、不新增
  // preventDefault」，回報只掛在既有的 click handler 上、且排在
  // `getSelection().isCollapsed` 那道守門之後 ⇒ 有選取時一個 byte 都不會送。
  // 放在本檔而不是 mouse_report.offline.spec.js：選字類斷言必須用這裡的
  // sentinel word + wordRect 技法才嚴謹（拖曳任意格子座標會因為那片剛好是空白、
  // 或列節點被重繪而靜默退化成空選取），而且本檔同時跑 chromium 與 firefox。
  test('滑鼠回報開啟時：選字仍然正常，且不送任何回報', async ({ page }) => {
    await boot(page, { useMouseBrowsing: true, mouseServerReport: true });
    // 主機宣告要滑鼠回報（mbbsd/term.c 的 MOUSE_MODE_CLICK 實際字串）。
    await feedRaw(page, '\x1b[?1003l\x1b[?1000h\x1b[?1006h');
    expect(
      await page.evaluate(() => window.__app.buf.mouseReport.isActive())
    ).toBe(true);

    await feedLine(page, WORD);
    await page.evaluate(() => {
      window.__sentLog = [];
      window.__stubWSSent = (s) => window.__sentLog.push(s);
    });

    await dragSelect(page, await wordRect(page, WORD));

    const info = await probe(page);
    expect(info, `拖曳後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text).toContain(WORD); // 選到的就是那個字，不是「非空就算過」
    // 有選取 ⇒ 優先權表第 6 條先擋下，回報一個 byte 都不送。
    expect(
      await page.evaluate(() => (window.__sentLog || []).join(''))
    ).not.toContain('\x1b[<');
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

  // 好讀長頁分塊（render/screen_chunk.js）：離視窗遠的塊是 content-visibility 跳過的
  // 「閉塊」，Firefox 對跨閉塊的 Selection.toString() 會漏字（實測 1.4 萬 vs 162 萬字）。
  // app 在 selectionchange 時把相交的塊展開（.screenChunkOpen），讀選取的地方再同步補一次
  // （screen_chunk.readSelectionText），複製仍是原生的。copyOnSelect 與 ^C 兩條路都驗。
  // 實測（Firefox，3000 行）：不展開的話選取後過一幀 toString 從 110085 掉回 90329 字。
  for (const via of ['copyOnSelect', 'Ctrl+C']) {
    test(`長文跨分塊選取：${via} 拿得到整段（含中段的閉塊）`, async ({ page, browserName }) => {
      // 漏字只發生在 Firefox（Chromium／WebKit 跨閉塊的 toString 本來就完整，handoff 四引擎
      // 實測）。Chromium 上 Shift+點擊延伸會被 app 把焦點搶回 #t 收合，是另一回事。
      test.skip(browserName !== 'firefox', '跨閉塊選取漏字是 Firefox 專屬');
      test.setTimeout(180000);
      const prefs = { copyOnSelect: via === 'copyOnSelect', useMouseBrowsing: false };
      await stubClipboardAndPrefs(page, prefs);
      // 同作者連三則會併成一個節點 ⇒ 1500 行約 600 個頂層節點、6 塊。
      await openLongArticle(page, ptt, { total: 1500, prefs });
      // openLongArticle 按了 End ⇒ 讀者黏在文末（bottom_stick.js），只有讀者自己的輸入會放手。
      // 不放手就程式設 scrollTop=0：頂端的閉塊解鎖長高 → stick 的 ResizeObserver 要把它拉回
      // 文末，Firefox 在同一輪 RO 派送裡重算 content-visibility ⇒ 偶發「本專案 RO 迴圈」
      // （nightly flaky hunt #77）。真讀者捲走一定帶輸入，所以先用真滾輪放手。
      // page.mouse.wheel 不等派發（tests/e2e/README.md「真輸入」）⇒ 等 stick 真的放手；
      // 滾輪的捲動若晚於下面的 scrollTop=0 才落地，往上捲在頂端被夾住，不影響位置。
      const vp = page.viewportSize();
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.wheel(0, -100);
      await expect
        .poll(
          () => page.evaluate(() => window.__app.easyReading._bottomStick.engaged),
          { message: '前提：讀者的滾輪已讓文末黏附放手' }
        )
        .toBe(false);
      await page.evaluate(() => {
        document.querySelector('.main').scrollTop = 0;
      });
      // 前提：真的分了好幾塊，而且中段的塊此刻是閉塊（否則這條測不到任何東西）
      await expect
        .poll(() =>
          page.evaluate(() => {
            const ks = document.querySelectorAll('#mainContainer > .screenChunk');
            const mid = ks[Math.floor(ks.length / 2)];
            const row = mid && mid.querySelector('[type="bbsrow"]');
            return {
              chunks: ks.length,
              midSkipped: !!row && !row.checkVisibility({ contentVisibilityAuto: true }),
            };
          })
        )
        .toEqual({ chunks: expect.any(Number), midSkipped: true });
      expect(
        await page.evaluate(() => document.querySelectorAll('#mainContainer > .screenChunk').length)
      ).toBeGreaterThanOrEqual(5);

      // 起點落在「line」上（第 0-6 欄是好讀的「點了就離開文章」帶，見 preview_targets.js）。
      // 原生的「點一下 → 捲走 → Shift+點」延伸選取（拖曳中途程式捲動，兩個引擎都會
      // 丟掉起點，不可靠）。
      const first = await wordRect(page, 'line 1');
      await page.mouse.click(first.x + 1, first.y + first.height / 2);
      await waitClickSettled(page);
      await page.evaluate(() => {
        const m = document.querySelector('.main');
        m.scrollTop = m.scrollHeight;
      });
      await nextFrames(page);
      const last = await wordRect(page, 'comment 1498');
      await page.keyboard.down('Shift');
      await page.mouse.click(last.x + last.width - 1, last.y + last.height / 2);
      await page.keyboard.up('Shift');
      await waitClickSettled(page);
      const info = await probe(page);
      expect(info.isCollapsed, `拖曳後的選取狀態: ${JSON.stringify({ ...info, text: info.text.length })}`).toBe(false);
      if (via === 'Ctrl+C') {
        // 捲回文首再複製：中段與尾段都成了視窗外的閉塊（實測 Firefox 漏字就在這種狀態）。
        await page.evaluate(() => {
          document.querySelector('.main').scrollTop = 0;
        });
        await nextFrames(page, 4);
        await page.keyboard.press('Control+c');
      }

      await expect
        .poll(() => page.evaluate(() => window.__copied[window.__copied.length - 1] || ''))
        .toContain('comment 1498');
      const text = await page.evaluate(() => window.__copied[window.__copied.length - 1]);
      // 逐行核對（漏字是整段整段掉，抽樣會剛好抽不到）：每一行的編號都要在。
      // 第 40 倍數的行是圖片連結（沒有 `comment n` 字樣）。
      const missing = [];
      for (let n = 2; n < 60; ++n) if (!new RegExp(`article line ${n}\\b`).test(text)) missing.push(n);
      for (let n = 60; n <= 1498; ++n)
        if (n % 40 && !new RegExp(`comment ${n}\\b`).test(text)) missing.push(n);
      expect(missing, `複製結果缺 ${missing.length} 行（長度 ${text.length}），前幾行：${missing.slice(0, 10)}`).toEqual([]);
    });
  }
});
