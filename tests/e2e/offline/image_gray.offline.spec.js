// 單張圖的暫時性灰階鈕 ＋ 圖片上放行瀏覽器原生選單（離線重放：真瀏覽器、真渲染、
// 零網路）。
//
// 使用者動線：把某張圖轉灰階 → 用 Chrome 內建的「以圖找圖／智慧鏡頭」查。兩端原本
// 都卡住：沒有任何轉灰階的入口，而 ContextMenu 的 onContextMenu 掛在 #BBSWindow 的
// capture 階段、**第一行就無條件 preventDefault()** ⇒ 圖片上的原生選單（另存圖片／
// 複製圖片／智慧鏡頭）整組叫不出來。智慧鏡頭沒有任何網頁可呼叫的 API，唯一入口就是
// 原生選單。
//
// 為什麼這幾條非 e2e 不可（純邏輯與 CSS 契約已分別由 tests/unit/image_gray_toggle、
// image_gray_css、context_menu_disposition、preview_targets 守）：
//   * 按鈕的位置是 `calc((100% - var(--img-w)) / 2)` 算出來的，jsdom 不解 calc()/var()
//     也沒有排版 —— 「右緣有沒有貼齊圖片右緣」只有真瀏覽器量得到；
//   * `filter: grayscale(1)` 的計算值同理；
//   * 「contextmenu 有沒有被 preventDefault」牽涉到 capture 階段的真實事件傳播，以及
//     React 選單是否真的開出來，那是三個檔案協作的結果。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const {
  scrollIntoViewStable,
  waitPreviewsSettled,
  waitRectStable,
} = require('../helpers/layout');

const article = findCassette('article');

const IMG_SEL = '#mainContainer img.hyperLinkPreview';
const GRAY_KEY = 'e2e-gray-slot';
const SLOT_SEL = `[data-e2e-gray="${GRAY_KEY}"]`;
const BTN_SEL = `${SLOT_SEL} > .previewGrayBtn`;
const TARGET_IMG_SEL = `${SLOT_SEL} img.hyperLinkPreview`;

const boot = async (page) => {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, enablePicPreview: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
};

// 由上往下掃整份累積頁，停在第一個真的把圖畫出來的位置，並替那個 slot 打上標記
// （測試自己的屬性，不動產品 DOM 契約 —— 同 helpers/layout.js#seekMountedPreview）。
// 自動開圖是延遲載入的：不捲進視野連 requestPreview() 都不會被呼叫。
async function seekGrayableImage(page) {
  const geom = await page.evaluate(() => {
    const s = document.querySelector('.main');
    return s ? { h: s.scrollHeight, ch: s.clientHeight } : null;
  });
  expect(geom, '找不到捲動容器 .main').not.toBeNull();
  const step = Math.max(200, geom.ch * 0.8);
  for (let y = 0; y <= geom.h; y += step) {
    await page.evaluate((top) => {
      document.querySelector('.main').scrollTop = top;
    }, y);
    await waitPreviewsSettled(page);
    const marked = await page.evaluate(
      ({ sel, key }) => {
        for (const im of document.querySelectorAll(sel)) {
          if (!(im.offsetWidth > 0 && im.offsetHeight > 0)) continue;
          const slot = im.closest('.inlinePreviewSlot');
          if (!slot) continue;
          slot.setAttribute('data-e2e-gray', key);
          return true;
        }
        return false;
      },
      { sel: IMG_SEL, key: GRAY_KEY }
    );
    if (marked) return true;
  }
  return false;
}

// 對某個元素派發 contextmenu 並回報「有沒有被 preventDefault」。
// 手法照抄 article_link_menu.offline.spec.js：真滑鼠右鍵在 headless 下座標對位太脆。
const dispatchContextMenu = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('未渲染到畫面，測試前提失效: ' + sel);
    const rect = el.getBoundingClientRect();
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, selector);

const styleOf = (page, selector, prop) =>
  page.evaluate(
    ({ sel, p }) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[p] : null;
    },
    { sel: selector, p: prop }
  );

// 平時 visibility:hidden ⇒ 先 hover 圖片讓它浮現（滑鼠從圖片移到按鈕時仍在同一個
// slot 內，:hover 不會斷）。
//
// **先把 slot 捲到視野中央**不是保險而是必要：click() 自己會 scrollIntoViewIfNeeded，
// 而那一捲會把 slot 從游標底下抽走 ⇒ :hover 斷掉 ⇒ 按鈕變回 visibility:hidden ⇒
// 命中測試落到圖片上，Playwright 一路重試到 timeout（錯誤訊息是「img … intercepts
// pointer events」，看起來像 z-index 問題，其實不是）。
async function clickGrayButton(page) {
  await scrollIntoViewStable(page, SLOT_SEL);
  await page.locator(TARGET_IMG_SEL).hover();
  await page.locator(BTN_SEL).click();
}

const enlarged = (page) =>
  page.evaluate(() =>
    document.getElementById('mainContainer').classList.contains('imagesEnlarged')
  );

test.describe('圖片灰階鈕與原生右鍵選單（離線重放）', () => {
  test.skip(!article, '尚無 article cassette；先 yarn record:cassette');

  test('hover 才浮現的灰階鈕，貼齊圖片右上角', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekGrayableImage(page), '整份長頁都沒有圖被載出來').toBe(true);

    // 按鈕是在 ResizeObserver 量到圖寬時才建立的。
    await expect(page.locator(BTN_SEL)).toHaveCount(1);

    // 平時隱藏 —— 不干擾閱讀。
    expect(await styleOf(page, BTN_SEL, 'visibility')).toBe('hidden');

    await page.locator(TARGET_IMG_SEL).hover();
    expect(await styleOf(page, BTN_SEL, 'visibility')).toBe('visible');

    // 右緣貼齊**圖片**的右緣，不是 slot（整寬區塊）的右緣。這正是那條
    // `margin-right: calc((100% - var(--img-w)) / 2)` 在做的事：抵掉圖片
    // `margin: 0.5em auto` 置中留下的單側留白。
    const btn = await waitRectStable(page, BTN_SEL);
    const img = await waitRectStable(page, TARGET_IMG_SEL);
    expect(
      Math.abs(btn.left + btn.width - (img.left + img.width)),
      '按鈕右緣應貼齊圖片右緣（差太多＝--img-w 沒被寫進去或百分比 margin 被改掉）'
    ).toBeLessThanOrEqual(2);
    // 也真的在圖片的**上緣**附近，不是飄到下面去。
    expect(btn.top).toBeGreaterThanOrEqual(img.top - 2);
    expect(btn.top).toBeLessThan(img.top + img.height / 2);
  });

  test('點灰階鈕：只有那張圖變灰階，且不得誤觸點圖放大', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekGrayableImage(page)).toBe(true);
    await expect(page.locator(BTN_SEL)).toHaveCount(1);

    expect(await styleOf(page, TARGET_IMG_SEL, 'filter')).toBe('none');
    const before = await enlarged(page);

    // 按鈕平時 visibility:hidden，得先 hover 圖片才點得到 —— 這正是使用者的動線，
    // 也順帶確認 Playwright 的可操作性檢查（visible/enabled/stable）真的過得了。
    await clickGrayButton(page);
    expect(await styleOf(page, TARGET_IMG_SEL, 'filter')).toContain('grayscale(1)');
    // 按鈕住在 #mainContainer 裡，而 ScreenController 在容器上掛了「點圖放大／縮小」
    // 的委派 listener —— 不 stopPropagation 就會順手把整頁圖片放大。
    expect(await enlarged(page), '點灰階鈕不得改變 imagesEnlarged').toBe(before);

    await clickGrayButton(page);
    expect(await styleOf(page, TARGET_IMG_SEL, 'filter')).toBe('none');
    expect(await enlarged(page)).toBe(before);
  });

  test('右鍵壓在圖片上 ⇒ 放行原生選單（我們的選單不開）', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekGrayableImage(page)).toBe(true);

    const prevented = await dispatchContextMenu(page, TARGET_IMG_SEL);
    expect(
      prevented,
      'preventDefault 過 ⇒ 另存圖片／複製圖片／智慧鏡頭整組叫不出來'
    ).toBe(false);
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
  });

  test('右鍵壓在文字上 ⇒ 照舊開我們的選單', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);

    const prevented = await dispatchContextMenu(
      page,
      '#mainContainer [data-type="bbsline"]'
    );
    expect(prevented).toBe(true);
    await expect(page.locator('.DropdownMenu').first()).toBeVisible();
  });
});
