// 自動開圖佔位盒：放大態釘的高度不得留到縮小態（離線重放回歸）。
//
// 使用者實測（ptt-debug-20260815-112407，多長圖文章）：
//   1. 點一張圖放大 → 2. 往下滑到其他圖 → 3. 點縮小 → 4. 再往上滑
//   ⇒ 出現空白，目視約等於該圖**放大後**所佔用的空間。
//
// 成因：<LazyInlinePreview> 捲遠卸載時會把當下 offsetHeight 釘進佔位盒的 min-height
// （防內容塌陷讓閱讀位置位移）。放大態（#mainContainer.imagesEnlarged → width:100%、
// max-height:none）長圖的 layout 高度可達數千 px，釘住的就是那個值；而點縮小只是拿掉
// #mainContainer 的 class，CSS 立刻生效但佔位盒的 inline min-height 不受影響。
//
// 這裡鎖症狀：縮小後往上捲，視野內的佔位盒不得比它真正的內容高出一截。決策純函式
// （nextSlotHeight / slotMinHeight）另由 tests/unit/lazy_inline_preview.test.jsx 守護。
//
// ---- 為什麼捲動迴圈由 Node 驅動（2026-08-27 改）----
// 舊版整段跑在一個 page.evaluate 裡，靠 `sleep(180~300)` 推進，並以「scrollHeight
// 連續兩輪不變」當穩定判準。那在 fixture 圖秒回時剛好會過，但那是**運氣**：
//   * 圖回得慢時（offline-slow project）`seekImgs` 會一路捲到底都看不到任何 loaded
//     img → 以「no inline image rendered」假紅；
//   * 往下捲那段每步只等 180ms，圖根本來不及載入 ⇒ 卸載時 hasMedia=false ⇒ 一個都
//     沒被釘高度 ⇒ 以「素材太短」假紅。
// 現在每一步捲完都等 helpers/layout.js 的 waitPreviewsSettled（含 Node 端在途圖片
// 請求），與圖回得多快無關。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

// 需要「放大後夠長，捲下去足以把上方佔位盒推出 6000px 卸載邊界」的素材。
// 短文（test-xmen 之類）整篇都在視野內、從不卸載 ⇒ 佔位盒永不釘高度 ⇒ 測試恆綠、
// 抓不到這個 bug。stock-end 有 9 張圖，放大態的總高足夠；不夠時測試會在
// 「放大態沒有任何佔位盒被釘過高度」硬紅（見下方 pinnedWhileEnlarged 斷言），
// 不會靜默假綠。
const article = loadCassette('stock-end');

// 佔位盒可以比內容略高（img 的 margin: 0.5em auto 等）；症狀級的空白是「一張圖」的
// 量級（數百 px），不會落在這個容差裡。
const BLANK_TOLERANCE_PX = 80;

const LOADED_IMG_SEL = 'img.hyperLinkPreview';

// 視野內「已經佔到版面」的圖。FallbackImage 在 onLoad 前就把 <img> 放進 DOM（只是
// display:none），純 querySelectorAll 會數到還沒載好的。
const loadedImgCount = (page) =>
  page.evaluate(
    (sel) =>
      Array.from(document.querySelectorAll(sel)).filter(
        (im) => im.offsetWidth > 0 && im.offsetHeight > 0
      ).length,
    LOADED_IMG_SEL
  );

const scrollGeometry = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('.main');
    return {
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      scrollTop: s.scrollTop,
    };
  });

const scrollTo = (page, top) =>
  page.evaluate((y) => {
    document.querySelector('.main').scrollTop = y;
  }, top);

// 視野內的佔位盒有多少「內容之外的空白」，同時記下哪幾個佔位盒經過了視野。
// 回傳 worst（最嚴重的空白）＋ seen（slot 索引）＋ 卸載期替身盒的高度。
const probeView = (page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.main');
    const view = scroller.getBoundingClientRect();
    const slots = document.querySelectorAll('.inlinePreviewSlot');
    let worst = null;
    const seen = [];
    for (let i = 0; i < slots.length; ++i) {
      const s = slots[i];
      const rect = s.getBoundingClientRect();
      if (rect.bottom <= view.top || rect.top >= view.bottom) continue;
      seen.push(Number(s.getAttribute('data-e2e-slot')));
      const media = s.querySelector('img.hyperLinkPreview, video.easyReadingVideo, iframe');
      // 佔位盒的高度扣掉真正的內容＝使用者看到的空白（媒體未掛載時整盒都是空白）。
      const blank = s.offsetHeight - (media ? media.offsetHeight : 0);
      if (!worst || blank > worst.blank) {
        worst = {
          blank,
          slotHeight: s.offsetHeight,
          mediaHeight: media ? media.offsetHeight : 0,
          minHeight: s.style.minHeight || '',
        };
      }
    }
    const ghosts = [];
    const gs = document.querySelectorAll('.inlinePreviewGhost');
    for (let i = 0; i < gs.length; ++i) {
      if (gs[i].offsetHeight > 0) ghosts.push(gs[i].offsetHeight);
    }
    return { worst, seen, ghosts };
  });

test('放大→捲遠→縮小→捲回：佔位盒不得留下放大態的高度', async ({ page }) => {
  test.setTimeout(300000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  // 每個佔位盒配一個穩定索引：之後跨多次 evaluate 才指得回同一個盒子。
  const slotCount = await page.evaluate(() => {
    const slots = document.querySelectorAll('.inlinePreviewSlot');
    for (let i = 0; i < slots.length; ++i) slots[i].setAttribute('data-e2e-slot', String(i));
    return slots.length;
  });
  expect(slotCount, '素材裡應有行內預覽佔位盒').toBeGreaterThan(0);

  const geom0 = await scrollGeometry(page);
  const step = Math.max(200, geom0.clientHeight * 0.8);

  // 延遲載入：由上往下掃，停在第一個真的把圖掛出來的位置。
  let found = 0;
  for (let y = 0; y <= geom0.scrollHeight; y += step) {
    await scrollTo(page, y);
    await waitPreviewsSettled(page);
    found = await loadedImgCount(page);
    if (found > 0) break;
  }
  expect(found, '整份長頁掃過一遍都沒有任何行內圖被載出來').toBeGreaterThan(0);

  // 1. 點一張圖 → 整頁放大
  await page.evaluate((sel) => {
    const img = Array.from(document.querySelectorAll(sel)).find(
      (im) => im.offsetWidth > 0 && im.offsetHeight > 0
    );
    img.click();
  }, LOADED_IMG_SEL);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(true);

  // 2. 往下滑（逐段捲，讓 IntersectionObserver 有機會回報）到底
  let geom = await scrollGeometry(page);
  for (let y = 0; y <= geom.scrollHeight; y += step) {
    await scrollTo(page, y);
    await waitPreviewsSettled(page);
    geom = await scrollGeometry(page); // 放大態的圖會一路把總高撐大
  }
  await scrollTo(page, geom.scrollHeight);
  await waitPreviewsSettled(page);

  // 放大態確實有佔位盒被釘過高度嗎？沒有的話這一卷抓不到 bug（素材太短），
  // 必須硬紅而不是靜默通過。
  // 被釘過高度的 slot 必定是「載到真媒體之後才卸載」的圖 —— 拿它們當「往上捲時
  // 應該一個都不會被跳過」的清單（捲回頂時它們多半已卸載，事後查 DOM 找不到圖）。
  const pinned = await page.evaluate(() => {
    const out = [];
    const slots = document.querySelectorAll('.inlinePreviewSlot');
    for (let i = 0; i < slots.length; ++i) {
      const h = parseFloat(slots[i].style.minHeight) || 0;
      if (h > 0) out.push({ idx: Number(slots[i].getAttribute('data-e2e-slot')), h });
    }
    return out;
  });

  // 3. 點縮小（點當下看得到的任一張圖）
  const shrank = await page.evaluate((sel) => {
    const img = Array.from(document.querySelectorAll(sel)).find(
      (im) => im.offsetWidth > 0 && im.offsetHeight > 0
    );
    if (!img) return false;
    img.click();
    return true;
  }, LOADED_IMG_SEL);
  expect(shrank, '縮小前視野內應有可點的圖').toBe(true);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(false);

  // 縮小態真圖的高度，等一下比對替身盒用（此刻視野內一定有圖；捲到頂之後那些圖
  // 可能又被卸掉，事後再量會量到 0）。
  const realImg = await page.evaluate((sel) => {
    const img = Array.from(document.querySelectorAll(sel)).find(
      (im) => im.offsetWidth > 0 && im.offsetHeight > 0
    );
    return img ? img.offsetHeight : 0;
  }, LOADED_IMG_SEL);
  expect(realImg, '縮小後視野內應有已載入的圖可量高度').toBeGreaterThan(0);

  // 4. 再往上滑，一路量視野內最嚴重的空白，同時記下「看到過哪幾個佔位盒」
  //    —— 佔位盒塌陷時，往上捲的途中圖片一張張掛回來會把上方內容推走，
  //    使用者會整段跳過（回報：從圖3往上直接跳到圖1，中間的圖2沒看到）。
  const seen = new Set();
  const ghostHeights = [];
  let worst = null;
  const absorb = (r) => {
    r.seen.forEach((i) => seen.add(i));
    r.ghosts.forEach((h) => ghostHeights.push(h));
    if (r.worst && (!worst || r.worst.blank > worst.blank)) worst = r.worst;
  };
  // 步長取半個視窗：小於視窗高度才能保證「沒被跳過的東西一定會被看到」。
  const upStep = Math.max(150, geom0.clientHeight * 0.5);
  const from = (await scrollGeometry(page)).scrollTop;
  for (let y = from; y >= 0; y -= upStep) {
    await scrollTo(page, y);
    await waitPreviewsSettled(page);
    absorb(await probeView(page));
  }
  await scrollTo(page, 0);
  await waitPreviewsSettled(page);
  absorb(await probeView(page));

  const missed = pinned.filter((p) => !seen.has(p.idx));
  const maxGhost = ghostHeights.length ? Math.max(...ghostHeights) : 0;

  console.log(
    `[enlarge-blank] ${JSON.stringify({
      slots: slotCount,
      pinnedWhileEnlarged: pinned.length,
      maxPinned: Math.round(Math.max(0, ...pinned.map((p) => p.h))),
      worst,
      missed: missed.length,
      ghosts: ghostHeights.length,
      maxGhost,
      realImg,
    })}`
  );

  // 素材有效性：放大態必須真的發生過卸載＋釘高度，否則這條測試恆綠。
  expect(
    pinned.length,
    '素材太短：放大態沒有任何佔位盒被卸載釘高度 ⇒ 抓不到這個 bug，請換更長的 cassette'
  ).toBeGreaterThan(0);
  expect(worst, '往上捲的途中應該量得到視野內的佔位盒').not.toBeNull();
  // 症狀 1：縮小後捲回，佔位盒不得比內容高出一整張圖的量級（假空白）。
  expect(worst.blank).toBeLessThan(BLANK_TOLERANCE_PX);
  // 症狀 2：往上捲的途中每個有圖的佔位盒都該經過視野一次。佔位盒塌陷時，圖片掛回來
  // 會把上方內容推走 ⇒ 整段被跳過（使用者回報「從圖3往上直接跳到圖1」）。
  expect(
    missed.length,
    `放大態被釘過高度的圖佔位盒共 ${pinned.length} 個，往上捲時被跳過的數量`
  ).toBe(0);
  // 症狀 2 的機制：替身盒必須用**縮小態**的規則算高度（不是放大態的、也不是 0），
  // 掛回來時高度才不會變。這條直接量它，避免「剛好沒跳過」的假綠。
  expect(ghostHeights.length, '往上捲的途中應該看得到卸載期間的替身盒').toBeGreaterThan(0);
  expect(
    Math.abs(maxGhost - realImg),
    `替身盒 ${maxGhost}px vs 縮小態真圖 ${realImg}px`
  ).toBeLessThan(BLANK_TOLERANCE_PX);
});
