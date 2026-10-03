// 延遲載入佔位盒的「預載」與「遲滯」邊界必須真的生效（離線重放回歸）。
//
// 設計（src/js/lazy_media.js）：與「視野 ± LAZY_MOUNT_MARGIN_PX」相交就掛載（預載，捲到之前
// 圖就開始抓）；與「視野 ± LAZY_UNMOUNT_MARGIN_PX」不相交才卸載（遲滯，來回捲不重載）。
// bug：兩個 IntersectionObserver 沒給 root（隱式 root＝viewport），而佔位盒在捲動容器
// `.main` 裡 —— 規格上 rootMargin 只擴 root，祖先捲動容器的裁切照算 ⇒ 兩個 margin 實際≈0：
// 捲到才開始載、捲出一點點就卸（往回捲重新下載／解碼）。整頁同時只掛得上視野內那幾張。
//
// 這條 bug 讓「點圖縮小後仍在視野內（捲動錨定）」量到的位移恆 0（鄰居從來沒被掛上，
// 縮放時上方內容高度不變），錨定邏輯形同沒測。
//
// 距離一律用 getBoundingClientRect（client px）：rootMargin 也是 client px，與 .main 的
// transform scale 無關。取的距離都遠在邊界內（掛載 900 < 1500、保留 2500 < 6000），
// 不是貼邊量。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

// 這卷圖多（十來個佔位盒）、文章長，捲得出「視野外但在邊界內」的距離。
const article = loadCassette('stock-end');

const PRELOAD_GAP = 900; // 佔位盒頂端在視窗底下方多少 px（< LAZY_MOUNT_MARGIN_PX）
const KEEP_GAP = 2500; // 佔位盒底端在視窗頂上方多少 px（< LAZY_UNMOUNT_MARGIN_PX）

// 把第 idx 個佔位盒捲到「頂端＝視窗底 + gap」（edge='below'）或「底端＝視窗頂 − gap」
// （edge='above'）。.main 有 transform scale 時一次捲不準，逐幀收斂。回傳實際誤差。
function placeSlot(page, idx, edge, gap) {
  return page.evaluate(
    async ({ idx, edge, gap }) => {
      const scroller = document.querySelector('.main');
      const slot = () => document.querySelectorAll('#mainContainer .inlinePreviewSlot')[idx];
      const delta = () => {
        const mr = scroller.getBoundingClientRect();
        const sr = slot().getBoundingClientRect();
        return edge === 'below' ? sr.top - (mr.bottom + gap) : sr.bottom - (mr.top - gap);
      };
      for (let i = 0; i < 30; i++) {
        const d = delta();
        if (Math.abs(d) < 3) break;
        const before = scroller.scrollTop;
        scroller.scrollTop += d;
        await new Promise((r) => requestAnimationFrame(r));
        if (scroller.scrollTop === before) break; // 捲到頭了
      }
      return delta();
    },
    { idx, edge, gap }
  );
}

const slotState = (page, idx) =>
  page.evaluate((idx) => {
    const scroller = document.querySelector('.main');
    const s = document.querySelectorAll('#mainContainer .inlinePreviewSlot')[idx];
    const mr = scroller.getBoundingClientRect();
    const sr = s.getBoundingClientRect();
    return {
      mounted: s.querySelector('.inlinePreviewContent').childNodes.length > 0,
      outOfView: sr.top >= mr.bottom || sr.bottom <= mr.top,
      top: Math.round(sr.top - mr.bottom),
      bottom: Math.round(sr.bottom - mr.top),
    };
  }, idx);

test('視野外、預載邊界內的佔位盒要先掛上；捲出但仍在保留邊界內的不得卸載', async ({ page }) => {
  test.setTimeout(120000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, enablePicPreview: true });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  const n = await page.evaluate(
    () => document.querySelectorAll('#mainContainer .inlinePreviewSlot').length
  );
  expect(n, '素材應有多個佔位盒').toBeGreaterThan(3);
  // 預載量最後一個（上方內容最多，捲得出「它在視窗底下方」）；遲滯量第一個（下方內容
  // 最多，捲得出「它在視窗頂上方」）。

  // 1. 預載：頂端在視窗底下方 PRELOAD_GAP（看不到）⇒ 必須已掛載。
  const last = n - 1;
  expect(Math.abs(await placeSlot(page, last, 'below', PRELOAD_GAP)), '捲不到預載距離').toBeLessThan(
    50
  );
  await waitPreviewsSettled(page);
  await expect
    .poll(() => slotState(page, last), {
      message: `視窗下方 ${PRELOAD_GAP}px 的佔位盒沒有被預載`,
    })
    .toMatchObject({ mounted: true, outOfView: true });

  // 2. 遲滯：第一個盒子先捲進視野掛上，再捲到視窗頂上方 KEEP_GAP ⇒ 仍須掛著。
  await page.evaluate(() =>
    document.querySelector('#mainContainer .inlinePreviewSlot').scrollIntoView({ block: 'center' })
  );
  await waitPreviewsSettled(page);
  await expect.poll(() => slotState(page, 0)).toMatchObject({ mounted: true });
  expect(Math.abs(await placeSlot(page, 0, 'above', KEEP_GAP)), '捲不到保留距離').toBeLessThan(50);
  // 柵欄：waitPreviewsSettled 要求版面指紋連續數次不變（數百 ms），observer 回呼在捲動後
  // 下一幀就送達，卸載會讓佔位盒內容消失、指紋改變 ⇒ 等得到終局就代表該跑的都跑完了。
  await waitPreviewsSettled(page);
  const s = await slotState(page, 0);
  expect(s.outOfView, '前提：佔位盒已捲出視野').toBe(true);
  expect(s.mounted, `視窗上方 ${KEEP_GAP}px 的佔位盒被提早卸載：${JSON.stringify(s)}`).toBe(true);
});
