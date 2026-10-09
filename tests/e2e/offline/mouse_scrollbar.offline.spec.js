// 好讀長頁右緣的**真捲軸**：拖它不可以被當成翻頁點擊（原本在 mouse.offline.spec.js）。
//
// 為什麼獨立成一支：Playwright 的 headless Chromium 預設帶 `--hide-scrollbars` ⇒ .main
// 的捲軸寬 0 ⇒ 原本那條 `test.skip(!bar, 'overlay 捲軸')` 在 CI 每一輪都 skip，從來
// 沒跑過（skip 在 CI 等於綠）。拿掉旗標要動 launchOptions，那是 worker 級設定，只能
// 寫在檔案頂層，不能放進 mouse.offline 的某個 describe。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');
const { startCapture, takeCapture } = require('../helpers/capture');
const { waitPreviewsSettled } = require('../helpers/layout');

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

// 同 mouse.offline 的 longArticle：可捲距離要夠長，拖曳才捲得動。
const longArticle = findCassettes('article').sort(
  (a, b) => (b.meta.pages || 0) - (a.meta.pages || 0)
)[0];

test('拖捲軸不會翻頁', async ({ page }) => {
  test.setTimeout(90000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    useMouseBrowsing: true,
    mouseLeftClick: true,
    mouseEdgePaging: true,
  });
  await replayCassette(page, longArticle, { easyReading: true });
  await waitPreviewsSettled(page);

  const bar = await page.evaluate(() => {
    const m = document.querySelector('.main');
    const r = m.getBoundingClientRect();
    const w = r.width - m.clientWidth; // 捲軸寬度（overlay／隱藏捲軸為 0）
    return w > 0 ? { x: r.right - w / 2, top: r.top + 20 } : null;
  });
  expect(bar, '捲軸沒有佔寬（--hide-scrollbars 沒拿掉？）').toBeTruthy();

  await page.evaluate(() => {
    document.querySelector('.main').scrollTop = 0;
  });
  // 歸零是一次捲動 ⇒ 行內預覽的版面還會再動一輪。
  await waitPreviewsSettled(page);
  await startCapture(page);
  await page.mouse.move(bar.x, bar.top);
  await page.mouse.down();
  await page.mouse.move(bar.x, bar.top + 120, { steps: 5 });
  await page.mouse.up();
  // 先等**拖曳真的把頁面捲起來**，再斷言沒送 byte：拖曳根本沒生效時「沒送 byte」也會綠。
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.main').scrollTop), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  // 拖捲軸就只是捲動：不得送出任何 byte。
  expect(await takeCapture(page)).toBe('');
});
