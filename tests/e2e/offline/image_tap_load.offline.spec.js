// 行動網路「點了才開圖」（離線重放：真瀏覽器、真渲染、零網路）。
//
// APK 的網路判定由原生回報（android_bridge.js 'networkState'／'pttandroid:network'）。這裡在
// 開機前注入一個假的 APK 殼（宣告 networkState、回覆 metered:true），其餘是完整產品：
// 好讀累積頁、佔位盒、#BBSWindow capture 的右鍵選單、終端機滑鼠路徑。
//
// 為什麼非 e2e 不可（閘門與按鈕分支已由 tests/unit/image_tap_load.test.js 守）：
//   * 長按＝瀏覽器發的 contextmenu，要穿過 ContextMenu 掛在 #BBSWindow capture 的 handler
//     （它先到）才輪到按鈕自己的 listener —— 只有完整頁面驗得到「我們的選單沒開、全篇開圖了」。
//     桌機 Chromium 的 CDP 觸控長按不發 contextmenu（docs/mobile.md「長按選單與選取模式」），
//     所以用真右鍵：同一個事件、同一條傳播路徑。
//   * 按鈕在 `.inlinePreviewSlot { pointer-events: none }` 底下，要靠 main.css 那條清單取回
//     auto 才點得到，unit 不載 main.css。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { recordContextMenu, lastContextMenu, rightClickElement } = require('../helpers/real_input');
const { scrollIntoViewStable, waitPreviewsSettled, waitRectStable } = require('../helpers/layout');

const article = findCassette('article');

const BTN_SEL = '#mainContainer .previewTapLoad';
const MEDIA_SEL = '#mainContainer img.hyperLinkPreview, #mainContainer video.easyReadingVideo, #mainContainer iframe';
const MARK = 'e2e-tap-slot';
const MARKED_SLOT = `[data-e2e-tap="${MARK}"]`;
const MARKED_BTN = `${MARKED_SLOT} > .previewTapLoad`;

// 假 APK 殼：只宣告 networkState，其餘能力一律沒有（site 空字串 ⇒ 連線走預設）。
async function installMeteredApk(page) {
  await page.addInitScript(() => {
    const listeners = [];
    window.__PTT_ANDROID__ = Object.freeze({ version: 'e2e', site: '', networkState: true });
    window.PttAndroid = {
      postMessage(str) {
        const msg = JSON.parse(str);
        if (msg.op !== 'networkState') return;
        const reply = JSON.stringify({ id: msg.id, ok: true, metered: true });
        setTimeout(() => listeners.forEach((fn) => fn({ data: reply })));
      },
      addEventListener(type, fn) {
        if (type === 'message') listeners.push(fn);
      },
    };
  });
}

const boot = async (page) => {
  await installMeteredApk(page);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, enablePicPreview: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
};

const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

// 第一顆按鈕所在的 slot 打上測試自己的標記（不動產品 DOM 契約），捲到視野中央。
async function markFirstButton(page) {
  const ok = await page.evaluate(
    ({ sel, key }) => {
      const btn = document.querySelector(sel);
      if (!btn) return false;
      btn.closest('.inlinePreviewSlot').setAttribute('data-e2e-tap', key);
      return true;
    },
    { sel: BTN_SEL, key: MARK }
  );
  expect(ok, '整份長頁沒有任何開圖按鈕').toBe(true);
  await scrollIntoViewStable(page, MARKED_SLOT);
  await waitRectStable(page, MARKED_BTN);
}

const ourMenuOpen = (page) =>
  page.evaluate(() => !!document.querySelector('.DropdownMenu, [data-sheet="context"]') && window.__app.contextMenuShown === true);

test.describe('行動網路點了才開圖（離線重放）', () => {
  test.skip(!article, '尚無 article cassette；先 yarn record:cassette');

  test('不自動開圖；點一下開那張，其餘仍是按鈕', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page);
    const before = await count(page, BTN_SEL);
    expect(before, '文章裡應該有圖片連結').toBeGreaterThan(1);
    expect(await count(page, MEDIA_SEL)).toBe(0);

    await markFirstButton(page);
    const sentBefore = await page.evaluate(() => window.__replay.sent.length);
    await page.locator(MARKED_BTN).click();
    await expect(page.locator(MARKED_BTN)).toHaveCount(0);
    await waitPreviewsSettled(page);
    // 這張開了（讀取中／圖／失敗任一終局都代表掛載了；離線圖片秒回）。
    await expect
      .poll(() => count(page, `${MARKED_SLOT} .inlinePreviewContent *`))
      .toBeGreaterThan(0);
    expect(await count(page, BTN_SEL)).toBe(before - 1);
    // 點按鈕不是點終端機：一個 byte 都不送 PTT（邊緣翻頁／退出手勢不得觸發）。
    expect(await page.evaluate(() => window.__replay.sent.length)).toBe(sentBefore);
  });

  test('長按（contextmenu）⇒ 全篇開圖、不開我們的選單也不出原生選單', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page);
    await markFirstButton(page);
    await recordContextMenu(page);
    await rightClickElement(page, MARKED_BTN);
    const ev = await lastContextMenu(page);
    expect(ev.isTrusted).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    await expect.poll(() => count(page, BTN_SEL)).toBe(0);
    expect(await ourMenuOpen(page)).toBe(false);
    await waitPreviewsSettled(page);
    await expect.poll(() => count(page, `${MARKED_SLOT} .inlinePreviewContent *`)).toBeGreaterThan(0);
  });

  test('換回 Wi-Fi（原生發 pttandroid:network）⇒ 按鈕全收、恢復自動開圖', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page);
    expect(await count(page, BTN_SEL)).toBeGreaterThan(0);
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('pttandroid:network', { detail: { metered: false } }))
    );
    await expect.poll(() => count(page, BTN_SEL)).toBe(0);
  });
});
