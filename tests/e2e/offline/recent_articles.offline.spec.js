// 最近讀過＋稍後再讀（P34，src/js/recent_articles.js、docs/recent-articles.md）：
//   1. 好讀讀一篇（stock-huang，文末有網址列）⇒ 記進「最近讀過」；真右鍵 →「稍後再讀」⇒ 收進清單，
//      一個 byte 都不送。
//   2. 文章列表按 F4 ⇒ 指令面板列出那一篇；點下去 ⇒ 走 deep link 的 AID 跳文（送鍵切到那個板）。
//   3. 開回讀到一半的那篇（scn-deep-link 真往返）⇒ 好讀載到上次那一列後捲過去，頂端「回到開頭」
//      捲回頂端；之後滾輪捲動停下來 ⇒ 位置記回清單。
// 選單、面板的點擊與焦點只有真瀏覽器驗得出來。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette, waitScreenSettled, bootScenario } = require('../helpers/replay');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled } = require('../helpers/layout');
const { rightClickElement } = require('../helpers/real_input');
const { drawMainMenu } = require('../helpers/main_menu');

const article = loadCassette('stock-huang');
const scenario = loadCassette('scn-deep-link');
const KEY = 'pttchrome.recentArticles.v1';
const readStore = (page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"recent":[],"later":[]}'), KEY);
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function drawList(page) {
  await page.evaluate(() => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    const REV = '\x1b[7m';
    const OFF = '\x1b[0m';
    let d = '\x1b[2J';
    d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
    d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
    d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
    d += '\x1b[4;1H' + u2b('>  1233 + 5 9/01 testuser     □[閒聊] 測試');
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  });
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

test.describe('最近讀過／稍後再讀', () => {
  test('讀一篇 ⇒ 記進最近讀過；右鍵「稍後再讀」⇒ 收進清單、零送鍵', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);

    await expect.poll(async () => (await readStore(page)).recent.map((e) => e.board + '/' + e.aid)).toEqual([
      'Stock/1g8znzQ3',
    ]);
    expect((await readStore(page)).recent[0].title).toBeTruthy();

    await page.evaluate(() => {
      const el = document.querySelector('#mainContainer [type="bbsrow"]:not([data-pusher])');
      el.setAttribute('data-e2e-body', '1');
    });
    await startCapture(page);
    await rightClickElement(page, '[data-e2e-body]');
    const menu = page.locator('.DropdownMenu').first();
    await menu.getByRole('menuitem').filter({ hasText: await label(page, 'cmenu_readLater') }).click();
    await expect.poll(async () => (await readStore(page)).later.map((e) => e.aid)).toEqual(['1g8znzQ3']);

    // 再開一次選單 ⇒ 改給「從稍後再讀移除」
    await rightClickElement(page, '[data-e2e-body]');
    await expect(
      page.locator('.DropdownMenu').first().getByRole('menuitem').filter({ hasText: await label(page, 'cmenu_removeReadLater') })
    ).toBeVisible();
    expect(await takeCapture(page)).toBe('');
  });

  test('文章列表 F4 ⇒ 面板列出稍後再讀的那篇；點下去走 AID 跳文', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReadingList: false });
    await page.evaluate((k) => {
      localStorage.setItem(
        k,
        JSON.stringify({ recent: [], later: [{ board: 'Stock', aid: '1g8znzQ3', title: '[新聞] 測試標題', at: 1 }] })
      );
    }, KEY);
    // deep link 要看過主功能表（＝登入完成）才會開跳，否則只是收著等登入。
    await drawMainMenu(page);
    await drawList(page);
    await page.evaluate(() => window.__app.setInputAreaFocus());
    await startCapture(page);
    await page.keyboard.press('F4');
    const item = page.locator('[data-palette-item="recent:stock/1g8znzQ3"]');
    await expect(item).toBeVisible();
    await expect(item).toContainText('[新聞] 測試標題');
    expect(await takeCapture(page)).toBe('');
    await item.click();
    // AID 跳文從別的板出發：先切到 Stock 板（送鍵裡有板名）。
    await expect.poll(() => peekCapture(page), { timeout: 10000 }).toContain('Stock');
  });

  test('開回讀到一半的文章 ⇒ 捲到上次那一列；「回到開頭」捲回頂端；捲動停下來記回位置', async ({ page }) => {
    test.skip(!scenario, '缺 scn-deep-link（需帳號：yarn record:scenarios）');
    test.setTimeout(90000);
    const { board, aid } = scenario.meta;
    const LINE = 60;
    await bootScenario(page, ptt, scenario);
    await page.evaluate(
      ({ k, board, aid, line }) =>
        localStorage.setItem(k, JSON.stringify({ recent: [{ board, aid, title: '測試', at: 1, line }], later: [] })),
      { k: KEY, board, aid, line: LINE }
    );
    // 每次狀態提示亮起時記下文字（P51：開回去落地不閃「已跳至 #AID」）。
    await page.evaluate(() => {
      window.__shownHints = [];
      new MutationObserver(() => {
        const el = document.querySelector('.ListHint');
        const t = el && el.style.opacity === '1' ? el.textContent : null;
        if (t && window.__shownHints[window.__shownHints.length - 1] !== t) window.__shownHints.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.evaluate(({ board, aid }) => window.__app.recentArticles.open({ board, aid }), { board, aid });

    await page.waitForFunction(() => {
      const a = window.__app;
      return a.buf.pageState === 3 && !a.aidNavigation.active && a.easyReading.easyReadingReachedPageEnd;
    });
    const toast = page.locator('#recentResume');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(await label(page, 'recent_resumeHint'));
    // 進度提示有亮過（跳文真的跑了），落地後收掉，沒有另一張「已跳至」疊在內文上。
    const shown = await page.evaluate(() => window.__shownHints);
    expect(shown).toContain('跳至 #' + aid + ' (' + board + ')…');
    expect(shown.filter((t) => t.startsWith('已跳至'))).toEqual([]);
    await expect(page.locator('.ListHint')).toHaveCSS('opacity', '0');
    // 好讀的一次性還原：累積到位才捲（量節點，頂端那一列就是上次的那一列）。
    await expect
      .poll(() => page.evaluate(() => Math.floor(window.__app.view.currentLineIndex())), { timeout: 10000 })
      .toBe(LINE);

    await toast.getByRole('button', { name: await label(page, 'recent_resumeTop') }).click();
    await expect(toast).toBeHidden();
    expect(await page.evaluate(() => window.__app.view.mainDisplay.scrollTop)).toBe(0);
    // 捲回頂端也會記：第一列＝沒有讀到一半，那一筆不帶 line（下次從頭）
    await expect.poll(async () => (await readStore(page)).recent[0].line).toBeUndefined();

    // 真滾輪往下捲、停下來 ⇒ 記回現在頂端那一列
    const box = await page.locator('#mainContainer').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.wheel(0, 900);
    await expect.poll(async () => (await readStore(page)).recent[0].line || 0).toBeGreaterThan(5);
    const top = await page.evaluate(() => Math.floor(window.__app.view.currentLineIndex()));
    expect(Math.floor((await readStore(page)).recent[0].line)).toBe(top);
  });
});
