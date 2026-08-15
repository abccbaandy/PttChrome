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
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');

// 需要「放大後夠長，捲下去足以把上方佔位盒推出 6000px 卸載邊界」的素材。
// 短文（test-xmen 之類）整篇都在視野內、從不卸載 ⇒ 佔位盒永不釘高度 ⇒ 測試恆綠、
// 抓不到這個 bug。stock-end 有 9 張圖，放大態的總高足夠；不夠時測試會在
// 「放大態沒有任何佔位盒被釘過高度」硬紅（見下方 pinnedWhileEnlarged 斷言），
// 不會靜默假綠。
const article = loadCassette('stock-end');

// 佔位盒可以比內容略高（img 的 margin: 0.5em auto 等）；症狀級的空白是「一張圖」的
// 量級（數百 px），不會落在這個容差裡。
const BLANK_TOLERANCE_PX = 80;

test('放大→捲遠→縮小→捲回：佔位盒不得留下放大態的高度', async ({ page }) => {
  test.setTimeout(120000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });

  const r = await page.evaluate(
    async ({ tolerance }) => {
      const scroller = document.querySelector('.main');
      const mc = document.getElementById('mainContainer');
      if (!scroller || !mc) return { error: 'no scroller/container' };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 行內圖片非同步載入會撐高內容 → 量測前先等 scrollHeight 連續兩輪不變。
      const settle = async () => {
        let prev = -1;
        let stable = 0;
        for (let i = 0; i < 24 && stable < 2; i++) {
          await sleep(300);
          const h = scroller.scrollHeight;
          if (h === prev) stable++;
          else {
            stable = 0;
            prev = h;
          }
        }
      };
      const loadedImgs = () =>
        Array.from(document.querySelectorAll('img.hyperLinkPreview')).filter(
          (im) => im.offsetWidth > 0 && im.offsetHeight > 0
        );
      // 延遲載入：由上往下掃，停在第一個真的把圖掛出來的位置。
      const seekImgs = async () => {
        scroller.scrollTop = 0;
        await sleep(300);
        if (loadedImgs().length) return;
        const step = Math.max(200, scroller.clientHeight * 0.8);
        for (let y = 0; y <= scroller.scrollHeight; y += step) {
          scroller.scrollTop = y;
          await sleep(250);
          if (loadedImgs().length) return;
        }
      };
      // 視野內的佔位盒有多少「內容之外的空白」。
      const blankInView = () => {
        const view = scroller.getBoundingClientRect();
        let worst = null;
        const slots = document.querySelectorAll('.inlinePreviewSlot');
        for (let i = 0; i < slots.length; ++i) {
          const s = slots[i];
          const rect = s.getBoundingClientRect();
          if (rect.bottom <= view.top || rect.top >= view.bottom) continue;
          const media = s.querySelector(
            'img.hyperLinkPreview, video.easyReadingVideo, iframe'
          );
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
        return worst;
      };

      await seekImgs();
      await settle();
      let imgs = loadedImgs();
      if (!imgs.length) return { error: 'no inline image rendered' };

      // 1. 點一張圖 → 整頁放大
      imgs[0].click();
      await sleep(400);
      await settle();
      if (!mc.classList.contains('imagesEnlarged'))
        return { error: 'enlarge did not apply' };

      // 2. 往下滑（逐段捲，讓 IntersectionObserver 有機會回報）到底
      const step = Math.max(200, scroller.clientHeight * 0.8);
      for (let y = 0; y <= scroller.scrollHeight; y += step) {
        scroller.scrollTop = y;
        await sleep(180);
      }
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(600);

      // 放大態確實有佔位盒被釘過高度嗎？沒有的話這一卷抓不到 bug（素材太短），
      // 必須硬紅而不是靜默通過。
      const allSlots = Array.from(
        document.querySelectorAll('.inlinePreviewSlot')
      );
      // 被釘過高度的 slot 必定是「載到真媒體之後才卸載」的圖 —— 拿它們當「往上捲時
      // 應該一個都不會被跳過」的清單（捲回頂時它們多半已卸載，事後查 DOM 找不到圖）。
      const pinnedIdx = [];
      const pinnedWhileEnlarged = [];
      for (let i = 0; i < allSlots.length; ++i) {
        const h = parseFloat(allSlots[i].style.minHeight) || 0;
        if (h > 0) {
          pinnedIdx.push(i);
          pinnedWhileEnlarged.push(h);
        }
      }

      // 3. 點縮小（點當下看得到的任一張圖）
      const visible = loadedImgs();
      if (!visible.length) return { error: 'no image to click for shrink' };
      visible[0].click();
      await sleep(500);
      if (mc.classList.contains('imagesEnlarged'))
        return { error: 'shrink did not apply' };
      await settle();
      // 縮小態真圖的高度，等一下比對替身盒用（此刻視野內一定有圖；捲到頂之後那些圖
      // 可能又被卸掉，事後再量會量到 0）。
      const shrunkNow = loadedImgs();
      const realImg = shrunkNow.length ? shrunkNow[0].offsetHeight : 0;

      // 4. 再往上滑，一路量視野內最嚴重的空白，同時記下「看到過哪幾個佔位盒」
      //    —— 佔位盒塌陷時，往上捲的途中圖片一張張掛回來會把上方內容推走，
      //    使用者會整段跳過（回報：從圖3往上直接跳到圖1，中間的圖2沒看到）。
      const seen = new Set();
      const markSeen = () => {
        const view = scroller.getBoundingClientRect();
        for (let i = 0; i < allSlots.length; ++i) {
          const rect = allSlots[i].getBoundingClientRect();
          if (rect.bottom > view.top && rect.top < view.bottom) seen.add(i);
        }
      };
      let worst = null;
      // 替身盒（卸載期間佔位用）的實際高度：它必須跟真圖在同一模式下一樣高，
      // 否則掛回來的瞬間高度一變，上方內容就會被推走 ⇒ 跳頁。
      const ghostHeights = [];
      // 步長取半個視窗：小於視窗高度才能保證「沒被跳過的東西一定會被看到」。
      const upStep = Math.max(150, scroller.clientHeight * 0.5);
      for (let y = scroller.scrollTop; y >= 0; y -= upStep) {
        scroller.scrollTop = y;
        await sleep(260);
        markSeen();
        const ghosts = document.querySelectorAll('.inlinePreviewGhost');
        for (let i = 0; i < ghosts.length; ++i) {
          if (ghosts[i].offsetHeight > 0)
            ghostHeights.push(ghosts[i].offsetHeight);
        }
        const cur = blankInView();
        if (cur && (!worst || cur.blank > worst.blank)) worst = cur;
      }
      scroller.scrollTop = 0;
      await sleep(400);
      markSeen();
      const cur = blankInView();
      if (cur && (!worst || cur.blank > worst.blank)) worst = cur;

      const missed = pinnedIdx.filter((i) => !seen.has(i));

      return {
        pinnedWhileEnlarged: pinnedWhileEnlarged.length,
        maxPinned: Math.round(Math.max(0, ...pinnedWhileEnlarged)),
        worst,
        missed: missed.length,
        ghosts: ghostHeights.length,
        maxGhost: ghostHeights.length ? Math.max(...ghostHeights) : 0,
        realImg,
        tolerance,
      };
    },
    { tolerance: BLANK_TOLERANCE_PX }
  );

  console.log(`[enlarge-blank] ${JSON.stringify(r)}`);
  expect(r.error).toBeUndefined();
  // 素材有效性：放大態必須真的發生過卸載＋釘高度，否則這條測試恆綠。
  expect(
    r.pinnedWhileEnlarged,
    '素材太短：放大態沒有任何佔位盒被卸載釘高度 ⇒ 抓不到這個 bug，請換更長的 cassette'
  ).toBeGreaterThan(0);
  // 症狀 1：縮小後捲回，佔位盒不得比內容高出一整張圖的量級（假空白）。
  expect(r.worst.blank).toBeLessThan(BLANK_TOLERANCE_PX);
  // 症狀 2：往上捲的途中每個有圖的佔位盒都該經過視野一次。佔位盒塌陷時，圖片掛回來
  // 會把上方內容推走 ⇒ 整段被跳過（使用者回報「從圖3往上直接跳到圖1」）。
  expect(
    r.missed,
    `放大態被釘過高度的圖佔位盒共 ${r.pinnedWhileEnlarged} 個，往上捲時被跳過的數量`
  ).toBe(0);
  // 症狀 2 的機制：替身盒必須用**縮小態**的規則算高度（不是放大態的、也不是 0），
  // 掛回來時高度才不會變。這條直接量它，避免「剛好沒跳過」的假綠。
  expect(r.ghosts, '往上捲的途中應該看得到卸載期間的替身盒').toBeGreaterThan(0);
  expect(
    Math.abs(r.maxGhost - r.realImg),
    `替身盒 ${r.maxGhost}px vs 縮小態真圖 ${r.realImg}px`
  ).toBeLessThan(BLANK_TOLERANCE_PX);
});
