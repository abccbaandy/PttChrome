// 內文跨行連結：被切成兩列的網址要接成同一條可點連結（離線重放守門）。
//
// 回歸來源（使用者 2026-08-30 回報，素材 tests/e2e/cassettes/pttbug-body-urlwrap.json）：
// PTT 端把簽名檔寫壞了，`※ 文章網址:` 那行被切成兩列 ——
//   col 33..77  https://www.ptt.cc/bbs/PttBug/M.1788041180.A.
//   col  0..7   404.html
// 兩層逐列偵測都只看得到殘段 ⇒ articleTargetFromAnchor → parseArticleUrl 回 null
// ⇒ 右鍵的「複製文章代碼／複製文章 deep link」整組消失，「複製連結網址」也只複製
// 到壞網址。修法在 src/js/body_wrap.js：兩列各自包成同一個 href 的 <a class="y">。
//
// 為什麼要 e2e：接合本身由 tests/unit/body_wrap.test.js 守，但「右鍵選單裡有哪些
// 項目」是 React 依 urlEnabled / normalEnabled / contextArticle 三個旗標算出來的
// 組合（同 article_link_menu.offline.spec.js 的理由），純邏輯測不到。
//
// 注意：**這卷素材的版面是 PTT 的資料 bug，不是新 spec**——不可以據此對
// 「※ 文章網址」這行做任何特判。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

const article = loadCassette('pttbug-body-urlwrap');

const FRAG_L = 'https://www.ptt.cc/bbs/PttBug/M.1788041180.A.';
const FRAG_R = '404.html';
const FULL = FRAG_L + FRAG_R;
// 對照值守在 tests/unit/aid_codec.test.js（M.1788041180.A.404 ⇄ 1garVSG4）。
const AID = '1garVSG4';
const BOARD = 'PttBug';

const label = (page, key) => page.evaluate(k => window.__i18n(k), key);

async function stubClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: t => {
          window.__copied.push(String(t));
          return Promise.resolve();
        },
      },
    });
  });
}

// 對某個 <a> 派發 contextmenu（真滑鼠右鍵在 headless 下座標對位太脆，
// 同 article_link_menu.offline.spec.js 的手法）。
async function rightClickAnchor(page, selector) {
  await page.evaluate(sel => {
    const a = document.querySelector(sel);
    if (!a) throw new Error('未渲染到畫面，測試前提失效: ' + sel);
    a.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 })
    );
  }, selector);
  await expect(page.locator('.DropdownMenu').first()).toBeVisible();
}

const itemByText = (page, text) =>
  page.locator('.DropdownMenu').first().getByText(text, { exact: true });

async function boot(page, prefs) {
  await stubClipboard(page);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enableAutoFixUrl: true,
    ...prefs,
  });
  await replayCassette(page, article, { easyReading: true });
  // 版面等待一律綁條件，不用固定 timeout（tests/unit/e2e_layout_settle.test.js
  // 靜態守護）。
  await waitPreviewsSettled(page);
}

test.describe('內文跨行連結（離線重放）', () => {
  test('被切成兩列的網址 → 兩列都是指向完整網址的同一條連結', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);

    const anchors = page.locator(`#mainContainer a.y[href="${FULL}"]`);
    await expect(anchors).toHaveCount(2);
    expect(await anchors.nth(0).textContent()).toBe(FRAG_L);
    expect(await anchors.nth(1).textContent()).toBe(FRAG_R);

    // REGRESSION：殘段不可以再自己連到那個 404 網址。
    await expect(page.locator(`#mainContainer a[href="${FRAG_L}"]`)).toHaveCount(0);
    // 一條網址只開一張圖：前面幾段不掛佔位盒。
    const slots = await page.evaluate(
      () => document.querySelectorAll('#mainContainer .inlinePreviewSlot').length
    );
    expect(slots).toBe(1);
  });

  test('右鍵任一片段：兩個文章選項回來了（回報的症狀）', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    // 右鍵**後半段**那條（`404.html`）——修好之前它根本不是連結。
    await rightClickAnchor(page, `#mainContainer a.y[href="${FULL}"]:last-of-type`);

    await expect(
      itemByText(page, await label(page, 'cmenu_copyArticleAid'))
    ).toHaveCount(1);
    await expect(
      itemByText(page, await label(page, 'cmenu_copyArticleDeepLink'))
    ).toHaveCount(1);
  });

  test('複製文章代碼 → 帶看板的 PTT 慣用寫法', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await rightClickAnchor(page, `#mainContainer a.y[href="${FULL}"]`);
    await itemByText(page, await label(page, 'cmenu_copyArticleAid')).click();

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual([`#${AID} (${BOARD})`]);
  });

  test('關掉「自動修復斷掉的連結」→ 退回原狀', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page, { enableAutoFixUrl: false });

    await expect(page.locator(`#mainContainer a.y[href="${FULL}"]`)).toHaveCount(0);
    await expect(page.locator(`#mainContainer a.y[href="${FRAG_L}"]`)).toHaveCount(1);
  });
});
