// 整頁圖片倍率「－ 100% ＋」（離線重放：真瀏覽器、真渲染、零網路）。
//
// 純邏輯與 CSS 契約已由 tests/unit/image_zoom*、screen_image_zoom 守；這裡只驗
// jsdom 量不到的：`calc(min(--nat-w…, 39em, 19em×寬高比) × --img-zoom)` 真的算出
// 「小圖寬 × 倍率」、與一鍵放大互不干擾、被點的那張圖留在視野內。
//
// 寬度一律量 offsetWidth（layout 空間）：img 身上有反向 scale（term_view.js
// updateReverseScaleCss），getBoundingClientRect 的寬與 layout 寬差一個係數。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const {
  waitPreviewsSettled,
  waitRectStable,
} = require('../helpers/layout');

const article = findCassette('article');

const IMG_SEL = '#mainContainer img.hyperLinkPreview';
const KEY = 'e2e-zoom-slot';
const SLOT_SEL = `[data-e2e-zoom="${KEY}"]`;
const BAR_SEL = `${SLOT_SEL} > .previewZoomBar`;
const TARGET_IMG_SEL = `${SLOT_SEL} img.hyperLinkPreview`;

const boot = async (page) => {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, enablePicPreview: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
};

// 同 image_gray.offline.spec.js#seekGrayableImage：往下掃到第一張真的畫出來、而且
// 放大 1.25 倍還不會頂到容器寬的圖（頂到就量不出倍率）。
async function seekZoomableImage(page) {
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
          if (!slot || slot.querySelectorAll('img.easyReadingImg').length !== 1)
            continue;
          // 太窄的圖上緣中央會被倍率列／灰階鈕蓋住，沒有空位可 hover。
          if (im.offsetWidth < 300) continue;
          if (im.offsetWidth * 1.5 > slot.clientWidth) continue;
          slot.setAttribute('data-e2e-zoom', key);
          return true;
        }
        return false;
      },
      { sel: IMG_SEL, key: KEY }
    );
    if (marked) return true;
  }
  return false;
}

// 先捲穩再 hover（理由見 image_gray.offline.spec.js#clickGrayButton）。
// 放大後的圖可能比視窗高，scrollIntoViewStable 要求整個元素在視窗內會失敗；倍率列在
// 圖片上緣，所以改把**圖片上緣**捲到視窗上方，hover 圖片上緣附近（倍率列平時
// visibility:hidden，不吃 hit-test ⇒ 命中的是圖片本身）。
async function revealBar(page) {
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollIntoView({ block: 'start' });
  }, TARGET_IMG_SEL);
  await waitPreviewsSettled(page);
  await waitRectStable(page, TARGET_IMG_SEL);
  // hover 點選在圖片**上緣、左側四分之一**：上緣中央是倍率列、右上角是灰階鈕，hover
  // 一到它們就浮現、反過來攔下 Playwright 的命中檢查（「… intercepts pointer events」）。
  const box = await page.locator(TARGET_IMG_SEL).boundingBox();
  await page.locator(TARGET_IMG_SEL).hover({
    position: { x: Math.round(box.width / 4), y: 8 },
  });
}

async function clickBar(page, cls) {
  await revealBar(page);
  await page.locator(`${BAR_SEL} > .${cls}`).click();
  await waitRectStable(page, TARGET_IMG_SEL);
}

async function clickImage(page) {
  await revealBar(page);
  // 點圖片中央（避開上緣的倍率列與右上角的灰階鈕）。
  const box = await page.locator(TARGET_IMG_SEL).boundingBox();
  await page.locator(TARGET_IMG_SEL).click({
    position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) },
  });
  await waitRectStable(page, TARGET_IMG_SEL);
}

const measure = (page) =>
  page.evaluate((sel) => {
    const slot = document.querySelector(sel);
    const img = slot.querySelector('img.easyReadingImg');
    const s = document.querySelector('.main').getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return {
      w: img.offsetWidth,
      h: img.offsetHeight,
      slotW: slot.clientWidth,
      inView: r.bottom > s.top && r.top < s.bottom,
      container: document.getElementById('mainContainer').className,
    };
  }, SLOT_SEL);

const labelText = (page) =>
  page.locator(`${BAR_SEL} > .previewZoomLabel`).textContent();

test.describe('整頁圖片倍率（離線重放）', () => {
  test.skip(!article, '尚無 article cassette；先 yarn record:cassette');

  test('＋ 放大一格 ＝ 小圖寬 × 1.25；一鍵放大照舊滿版，縮回回到原倍率', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekZoomableImage(page), '整份長頁都沒有可量倍率的圖').toBe(true);
    await expect(page.locator(BAR_SEL)).toHaveCount(1);

    const base = await measure(page);
    expect(await labelText(page)).toBe('100%');

    await clickBar(page, 'previewZoomIn');
    const z = await measure(page);
    expect(z.container).toContain('imagesZoomed');
    expect(await labelText(page)).toBe('125%');
    expect(Math.abs(z.w - base.w * 1.25), `寬 ${base.w} → ${z.w}`).toBeLessThanOrEqual(2);
    // 等比：高度同倍率。
    expect(Math.abs(z.h - base.h * 1.25)).toBeLessThanOrEqual(3);
    expect(z.inView, '被點的那張圖應留在視野內').toBe(true);

    // 一鍵放大不動：滿版（＝slot 寬），倍率列藏起來。
    await clickImage(page);
    const big = await measure(page);
    expect(big.container).toContain('imagesEnlarged');
    expect(big.container).not.toContain('imagesZoomed');
    expect(Math.abs(big.w - big.slotW)).toBeLessThanOrEqual(2);
    await expect(page.locator(BAR_SEL)).toBeHidden();

    // 再點一下縮回來：回到 125%，不是 100%。
    await clickImage(page);
    const back = await measure(page);
    expect(back.container).toContain('imagesZoomed');
    expect(Math.abs(back.w - z.w)).toBeLessThanOrEqual(2);

    // 標籤＝回 100%。
    await clickBar(page, 'previewZoomLabel');
    const reset = await measure(page);
    expect(reset.container).not.toContain('imagesZoomed');
    expect(Math.abs(reset.w - base.w)).toBeLessThanOrEqual(2);
  });

  // 使用者回報：倍率列原本貼圖片左上角，圖一變寬按鈕就跟著左緣跑 ⇒ 無法原地連點。
  // 置中之後：圖片水平置中（中線不動）、上緣由錨定補償釘在原視窗位置 ⇒ 按鈕不動。
  test('連點 ＋：按鈕留在原位，游標不動就能再點一次', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekZoomableImage(page)).toBe(true);
    await revealBar(page);
    const inSel = `${BAR_SEL} > .previewZoomIn`;
    const before = await page.locator(inSel).boundingBox();
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    await page.mouse.click(x, y);
    await waitRectStable(page, TARGET_IMG_SEL);
    const after = await page.locator(inSel).boundingBox();
    expect(Math.abs(after.x - before.x), `＋ 鈕水平位移：${before.x} → ${after.x}`).toBeLessThanOrEqual(2);
    expect(Math.abs(after.y - before.y), `＋ 鈕垂直位移：${before.y} → ${after.y}`).toBeLessThanOrEqual(2);
    // 游標完全不動再點一次。
    await page.mouse.click(x, y);
    await waitRectStable(page, TARGET_IMG_SEL);
    expect(await labelText(page)).toBe('150%');
  });

  // 2026-09 回報「比例放大到 150% 後滾輪往上捲不動、畫面上下一直抖」
  // （ptt-debug-20260928-181323）。根因：倍率態的寬度上限只剩 `max-width:100%`，而
  // slot 是單欄 grid（implicit auto 軌道）。<img> 是替換元素，百分比上限讓它的內容
  // 貢獻被當成 0；**替身盒是 <div>**，它的絕對寬（小圖寬×倍率，例如 1621px）會被
  // 算進 auto 軌道 ⇒ 軌道被撐到比 slot 寬 ⇒ 100% 跟著變大 ⇒ 替身盒高 912、真圖 726。
  // 捲動時每張圖一掛上／卸下，slot 高度就在兩者之間跳，跟瀏覽器的 scroll anchoring
  // 互相拉扯。fixture 圖在 1.5 倍時還沒頂到容器寬，所以拉到頂格讓兩者分岔。
  //
  // 替身盒由 slot 在「卸載期／掛載後還在下載」才建立，這裡直接在同一個 spacer 裡放一個
  // 屬性相同的盒子量（與 inline_preview_slot.js#syncGhost 同一組 class 與變數）——
  // 卸載要捲到 6000px 外，素材長度不保證夠。
  test('替身盒與真圖同尺寸（倍率撐到超過容器寬時）', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekZoomableImage(page)).toBe(true);
    const inBtn = page.locator(`${BAR_SEL} > .previewZoomIn`);
    for (let i = 0; i < 8; ++i) {
      if (await inBtn.isDisabled()) break;
      await clickBar(page, 'previewZoomIn');
    }
    const m = await page.evaluate((sel) => {
      const slot = document.querySelector(sel);
      const img = slot.querySelector('img.easyReadingImg');
      const spacer = slot.querySelector('.inlinePreviewSpacer');
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const ghost = document.createElement('div');
      ghost.className = 'easyReadingImg inlinePreviewGhost';
      ghost.style.setProperty('--ghost-w', `${w}px`);
      ghost.style.setProperty('--nat-w', String(w));
      ghost.style.setProperty('--nat-h', String(h));
      ghost.style.aspectRatio = `${w} / ${h}`;
      spacer.appendChild(ghost);
      const out = {
        slotW: slot.clientWidth,
        img: [img.offsetWidth, img.offsetHeight],
        ghost: [ghost.offsetWidth, ghost.offsetHeight],
      };
      ghost.remove();
      return out;
    }, SLOT_SEL);
    expect(m.img[0], JSON.stringify(m)).toBeLessThanOrEqual(m.slotW);
    expect(m.ghost[0], `替身盒撐破容器寬：${JSON.stringify(m)}`).toBeLessThanOrEqual(m.slotW);
    expect(Math.abs(m.ghost[0] - m.img[0]), JSON.stringify(m)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.ghost[1] - m.img[1]), JSON.stringify(m)).toBeLessThanOrEqual(1);
  });

  test('倍率上限＝容器寬，不會把圖撐出版面', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page);
    expect(await seekZoomableImage(page)).toBe(true);
    const inBtn = page.locator(`${BAR_SEL} > .previewZoomIn`);
    for (let i = 0; i < 8; ++i) {
      if (await inBtn.isDisabled()) break;
      await clickBar(page, 'previewZoomIn');
    }
    expect(await labelText(page)).toBe('400%');
    const m = await measure(page);
    expect(m.w).toBeLessThanOrEqual(m.slotW + 1);
  });
});
