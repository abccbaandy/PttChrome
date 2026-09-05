// 文章好讀：讀圖時連按 PgUp，閱讀位置必須單調往前（離線重放回歸）。
//
// 使用者回報（2026-09-03）：「圖／圖／圖／文字」這種文章結構，畫面停在圖上時按
// PgUp 會卡住滾不上去，甚至來回跳。多圖且**正在讀圖**時特別容易觸發。
//
// 根因不是捲動計算，是我們自己把瀏覽器的捲動補償關掉了：舊碼把佔位高度寫在
// .inlinePreviewSlot 自己的 inline min-height 上，而讀者停在圖片中間時，CSS Scroll
// Anchoring 選的錨點就在那個 slot 裡 ⇒ 對「錨點的祖先」寫 min-height 命中 suppression
// trigger ⇒ 瀏覽器當幀放棄補償上方內容的高度變化。同一幀上方又正好有 slot 在
// mount（替身盒 494px → 讀取中指示器 56px，實測塌陷 438px ＝ 一次 PgUp 的 76.6%），
// 於是讀者被整整推走那麼多：兩張圖就吃掉一整次 PgUp。
// 修法見 src/render/inline_preview_slot.js 檔頭「疊層佔位」。
//
// 為什麼一定要 e2e：suppression 是真瀏覽器的排版行為，jsdom 沒有捲動也沒有
// anchoring，unit 只驗得到「高度寫在哪、掛載時塌不塌陷」
// （tests/unit/lazy_inline_preview.test.js），驗不到「讀者有沒有被推走」。
//
// 也跑 offline-slow（`yarn test:e2e:offline:adverse`，圖固定慢 5.2s）：那是「圖遲遲
// 載不完」的實體，也是使用者的實況（docs/imgur-latency-research.md 的 imgur stall，
// 且產品端沒有載入 timeout）。兩個情境的斷言語義相同。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

// 需要「圖夠多、總高夠長」的素材：短文整篇都在視野內，永遠不會有 slot 在 PgUp 的
// 同一幀掛載／卸載 ⇒ 測試恆綠。stock-end 有 9 張圖，總高足夠連按數次 PgUp。
const article = loadCassette('stock-end');

// 連按幾次 PgUp。太多次會撞到文章開頭（scrollTop 夾在 0，位移自然小於一頁），
// 所以取 4 次，並在起點就確認上方剩餘可捲距離夠。
const PRESSES = 4;
// 一次 PgUp 至少要拿到這個比例的位移。舊碼在讀圖時實測只拿到 23.4%
// （572 − 438 = 134px）；修好後應該是 100%，容差留給 chh 取整與圖片的次像素高度。
const MIN_RATIO = 0.9;

// 捲動容器內的絕對 y。**不用 getBoundingClientRect**：.main 與 img.hyperLinkPreview
// 各有自己的 transform，rect 與 scrollTop 不是同一把尺（src/js/scroll_anchor.js 鐵則）。
// 每個 page.evaluate 各自帶一份（evaluate 是獨立的函式，抓不到外層閉包）。
const TOP_OF = `(el) => {
  const scroller = document.querySelector('.main');
  let y = 0;
  let n = el;
  while (n && n !== scroller) { y += n.offsetTop; n = n.offsetParent; }
  return y;
}`;

const ROW_SEL = '#mainContainer [data-type="bbsline"]';
const MEDIA_IN_SLOT = 'img.easyReadingImg, video.easyReadingVideo, iframe';

// = LAZY_MOUNT_MARGIN_PX（src/js/lazy_media.js）。測試一端不能 import 那個 ESM
// 模組（spec 是 CJS），所以抄成常數，並由 tests/unit/e2e_lazy_margin_constant.test.js
// 靜態守護「兩邊一致」——產品端調大這個邊界時，本測試挑候選的死角也必須跟著變大。
const MOUNT_MARGIN_PX = 1500;
// 候選 slot 要離「掛載邊界」再遠一點，才不會踩在邊界上（次像素、捲動容器夾值）。
const OUT_OF_MOUNT_RANGE_SLACK_PX = 200;

// 一路往下走完整篇（每步等整頁終局），讓每張圖都真的載入過一次。
async function walkDown(page) {
  const geom = await page.evaluate(() => {
    const s = document.querySelector('.main');
    return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
  });
  const step = Math.max(200, geom.clientHeight * 0.8);
  for (let y = 0; y <= geom.scrollHeight; y += step) {
    await page.evaluate((top) => {
      document.querySelector('.main').scrollTop = top;
    }, y);
    await waitPreviewsSettled(page);
  }
  await page.evaluate(() => {
    const s = document.querySelector('.main');
    s.scrollTop = s.scrollHeight;
  });
  await waitPreviewsSettled(page);
}

// 點視野內任一張已載入的圖 ⇒ 切換放大／縮小。回傳有沒有點到。
const clickAnyLoadedImg = (page) =>
  page.evaluate(() => {
    const img = Array.from(
      document.querySelectorAll('img.hyperLinkPreview')
    ).find((im) => im.offsetWidth > 0 && im.offsetHeight > 0);
    if (!img) return false;
    img.click();
    return true;
  });

// 固定的「起讀位置」：第一個佔位盒往上留一點空間。
//
// **刻意不用「由上往下逐格掃到有圖為止」**（2026-09-05 CI 紅的根因）：掃到第幾格才停
// 取決於當下的載入節奏，而停在哪裡就決定了「哪幾張圖在 normal 模式下被量過高度」
// （pinned[normal]）—— 那正是本測試挑候選佔位盒時的**排除**條件。掃描式起點 ⇒ 候選
// 集合隨機器快慢而變，慢的機器上會歸零，測試就紅在「素材太短」（實錄：
// actions/runs/33955762422，同一份素材本機與其他四輪 CI 全綠）。
// 改成由**素材本身**（第一個 slot 的位置）決定起點，與時序無關。
async function gotoFirstSlot(page) {
  const ok = await page.evaluate((topOfSrc) => {
    const topOf = eval(topOfSrc);
    const slot = document.querySelector('.inlinePreviewSlot');
    if (!slot) return false;
    document.querySelector('.main').scrollTop = Math.max(0, topOf(slot) - 200);
    return true;
  }, TOP_OF);
  if (ok) await waitPreviewsSettled(page);
  return ok;
}

// 捲到底。整趟放大態走完之後**明確**回到一個決定性的位置：點縮小那一下會讓整頁高度
// 塌掉好幾倍，最終的 scrollTop 是瀏覽器的 scroll anchoring 決定的，測試不該拿它當前提
// （同一份素材本機恆為 6824，CI 上顯然落在別處 ⇒ 上方一個候選都不剩）。
async function gotoBottom(page) {
  await page.evaluate(() => {
    const s = document.querySelector('.main');
    s.scrollTop = s.scrollHeight;
  });
  await waitPreviewsSettled(page);
}

// 「已卸載＋只剩替身盒頂著」而且**保證不會自己掛回來**的佔位盒。
// 三個條件缺一不可（缺了就抓不到 bug，只是靜默變成恆綠）：
//   a. slot 裡沒有媒體 ⇒ 真的卸載了；
//   b. spacer 沒有 inline min-height ⇒ normal 這格從沒量過，高度純靠替身盒；
//   c. 整個 slot 落在「視野 + LAZY_MOUNT_MARGIN_PX」之外 ⇒ 它在原地不會被 near
//      observer 掛回來。少了 c 就會挑到邊界上的 slot：在慢一點的機器上它早就掛回來、
//      圖也載好了（本地 fixture 秒回）⇒ 條件 a 反過來把它刷掉。
// 一律回傳整張表，失敗時直接印出來（不必再猜「素材太短」是哪一種太短）。
const pickGhostOnlySlot = (page) =>
  page.evaluate(
    ({ topOfSrc, mediaSel, margin }) => {
      const topOf = eval(topOfSrc);
      const scroller = document.querySelector('.main');
      const limit = scroller.scrollTop - margin;
      const table = [];
      let chosen = null;
      const slots = Array.from(document.querySelectorAll('.inlinePreviewSlot'));
      for (let i = slots.length - 1; i >= 0; --i) {
        const s = slots[i];
        const spacer = s.querySelector('.inlinePreviewSpacer');
        const ghost = s.querySelector('.inlinePreviewGhost');
        const y = topOf(s);
        const row = {
          i: i,
          y: Math.round(y),
          h: s.offsetHeight,
          media: !!s.querySelector(mediaSel),
          minHeight: spacer ? spacer.style.minHeight : null,
          ghostHeight: ghost ? ghost.offsetHeight : null,
        };
        table.push(row);
        if (chosen) continue;
        if (row.media) continue;
        if (row.minHeight) continue;
        if (!(row.ghostHeight >= 200)) continue;
        if (y + row.h > limit) continue;
        chosen = row;
        window.__slotSamples = [s.offsetHeight];
        window.__slotRO = new ResizeObserver(() => {
          window.__slotSamples.push(s.offsetHeight);
        });
        window.__slotRO.observe(s);
      }
      table.reverse();
      return {
        ok: !!chosen,
        chosen: chosen,
        scrollTop: Math.round(scroller.scrollTop),
        limit: Math.round(limit),
        slots: table,
      };
    },
    { topOfSrc: TOP_OF, mediaSel: MEDIA_IN_SLOT, margin: MOUNT_MARGIN_PX + OUT_OF_MOUNT_RANGE_SLACK_PX }
  );

// ---------------------------------------------------------------------------
// 測試 1：掛載那一幀不得塌陷（**這條就是 bug 的機制，舊碼必紅**）。
//
// 動線就是 §3 case 1：整篇只在**放大態**看過 ⇒ 那些圖的 normal 高度從沒被量到
// （pinned[normal] 為空），卸載後只剩替身盒頂著。點縮小、往回捲，舊碼在 mount()
// 當下先把替身盒拿掉、再放進「讀取中…」指示器 ⇒ slot 從 ~570px 掉到 ~56px。
// 那一次塌陷（實測 438px ＝ 一次 PgUp 的 76.6%）就是使用者「PgUp 捲不上去」的量。
//
// 用 ResizeObserver 逐幀採樣而不是事後量一次：事後量到的是已經撐回來的值 ⇒ 恆綠。
//
// **每一個捲動位置都由素材決定、不由載入節奏決定**（見 gotoFirstSlot／gotoBottom）：
// 這條測試的前提（找得到「只剩替身盒」的佔位盒）本身就是被那些位置決定的，起點一飄
// 前提就會落空，紅的還是一句看不出原因的「素材太短」。
//
// **這條自己把圖片情境釘成 'slow'**（見下方 bootOffline）：預設的 'cache' 下它結構性
// 地測不到東西。整支 spec 仍留在 playwright.config.js 的 ADVERSE_IMAGE_SPECS 裡 ——
// 那是為了測試 2（它在 slow 下才有牙齒，但沿用 project 的情境）。
test('往回捲時佔位盒掛載：高度不得塌陷（替身盒讓位給讀取中指示器）', async ({ page }) => {
  test.setTimeout(300000);
  // **這條自己指定 'slow' 情境**（明確傳入的優先序高於 project 名，同
  // image_load_conditions.offline.spec.js）：預設的 'cache' 下圖片秒回，mount 到真圖
  // 佔到版面之間跨不過一次排版 ⇒ 中間態根本不存在，斷言恆綠。實測（2026-09-05，把
  // syncGhost 的判準改回舊碼的「有沒有掛載」當突變）：cache 下 3/3 綠、samples 全程
  // [600,600]；slow 下 3/3 紅、samples 是 600,65,600,65… —— 65px 就是「讀取中…」
  // 指示器，那串來回正是使用者說的「來回跳」。
  // 換句話說，在 cache 下跑這條**只可能假紅、不可能真紅**，所以不讓它靠 project 決定。
  await bootOffline(page, ptt, { imageProfile: 'slow' });
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  // 1. 停在第一個佔位盒上點放大（此時只有最前面那幾張圖在 normal 模式下量過高度），
  //    之後整趟往下都在放大態 ⇒ 中後段的圖**只**在放大態載入過，normal 那格永遠是空的。
  expect(await gotoFirstSlot(page), '素材裡沒有任何行內預覽佔位盒').toBe(true);
  expect(await clickAnyLoadedImg(page), '起讀位置應有可點的圖來切換放大').toBe(true);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(true);

  await walkDown(page);

  // 2. 回到同一個起讀位置點縮小（回到 normal）。回到原位再點，是為了讓「哪幾張圖被
  //    量過 normal 高度」這件事一路都由位置決定 —— 在文末隨便點一張，被量到的就是
  //    文末那幾張，候選集合又變成看運氣。
  expect(await gotoFirstSlot(page), '縮小前回不到起讀位置').toBe(true);
  expect(await clickAnyLoadedImg(page), '縮小前視野內應有可點的圖').toBe(true);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(false);

  // 3. 捲到底（決定性的觀察位置），再找一個「已卸載、只剩替身盒頂著、而且遠在掛載
  //    邊界之外」的佔位盒，在它身上裝 ResizeObserver 逐幀記高度。
  await gotoBottom(page);
  const target = await pickGhostOnlySlot(page);
  expect(
    target.ok,
    '找不到「已卸載＋只剩替身盒」的佔位盒 ⇒ 抓不到這個 bug。' +
      `scrollTop=${target.scrollTop}、候選須整個落在 y+h ≤ ${target.limit}，` +
      `佔位盒現況：${JSON.stringify(target.slots)}`
  ).toBe(true);

  // 4. 捲回去讓它進入掛載範圍。
  await page.evaluate((y) => {
    document.querySelector('.main').scrollTop = Math.max(0, y - 200);
  }, target.chosen.y);
  await waitPreviewsSettled(page);

  const samples = await page.evaluate(() => {
    window.__slotRO.disconnect();
    return window.__slotSamples;
  });
  const min = Math.min(...samples);
  console.log(
    `[mount-collapse] ${JSON.stringify({
      ghostHeight: target.chosen.ghostHeight,
      before: target.chosen.h,
      min,
      samples: samples.slice(0, 12),
    })}`
  );
  // 舊碼：mount() 先 removeGhost() ⇒ 掉到「讀取中…」指示器的高度（~56px）。
  // 新碼：替身盒住在 spacer 裡，疊層取 max ⇒ 全程維持替身盒的高度。
  expect(
    min,
    `掛載過程中佔位盒一度塌到 ${min}px（替身盒 ${target.chosen.ghostHeight}px）` +
      '⇒ 讀者會被整整推走那一截'
  ).toBeGreaterThanOrEqual(Math.round(target.chosen.ghostHeight * 0.9));
});


// ---------------------------------------------------------------------------
// 測試 2：使用者看得到的症狀本身 —— 讀圖時連按 PgUp，位置必須一次往前一整頁。
// 也順帶守住「文章不得被重讀」（_healFromTop 送 Home 重來 ⇒ 累積頁列數會變）。
test('讀圖時連按 PgUp：閱讀位置單調往前，不會被塌陷的佔位盒抵銷', async ({ page }) => {
  test.setTimeout(300000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  // 一次 PgUp 捲多少：_turnPageLines × chh，直接問產品自己（dev build 的 e2e 探針）。
  const pageStep = await page.evaluate(() => {
    const app = window.__app;
    return app.easyReading._turnPageLines * app.view.chh;
  });
  expect(pageStep, '一次 PgUp 的位移量應由產品算得出來').toBeGreaterThan(0);

  // 1. 由上往下走完整篇，讓每張圖都真的載入過一次（量到原尺寸）。這是使用者的實況
  //    ——「一路往下讀到文末，再往回翻」；跳著捲到底的話中段的圖從沒載過，往回翻時
  //    才第一次載入，內容本來就會長高，量到的位移會混進那一份，測不出本 bug。
  await walkDown(page);

  // 2. 把視窗頂端停在**某張圖的中間** —— 這是踩中 suppression 的必要條件（捲動錨點
  //    必須落在 .inlinePreviewSlot 內部）。停在文字列上抓不到這個 bug。
  const start = await page.evaluate(
    ({ topOfSrc, need }) => {
      const topOf = eval(topOfSrc);
      const scroller = document.querySelector('.main');
      const slots = Array.from(document.querySelectorAll('.inlinePreviewSlot'));
      // 由下往上找一個「夠高、而且上方還有 need px 可以往回捲」的佔位盒。
      for (let i = slots.length - 1; i >= 0; --i) {
        const s = slots[i];
        const h = s.offsetHeight;
        if (h < 200) continue;
        const mid = topOf(s) + Math.round(h / 2);
        if (mid < need) continue;
        scroller.scrollTop = mid;
        return { ok: true, slotHeight: h, scrollTop: scroller.scrollTop };
      }
      return { ok: false, slots: slots.length };
    },
    { topOfSrc: TOP_OF, need: pageStep * (PRESSES + 1) }
  );
  expect(
    start.ok,
    `素材太短：找不到「上方還有 ${pageStep * (PRESSES + 1)}px 可捲」的圖片佔位盒 ⇒ ` +
      '抓不到這個 bug，請換更長的 cassette'
  ).toBe(true);
  await waitPreviewsSettled(page);

  // 3. 選一個**剛好在視窗頂端下方**的列當量尺。它上方的內容高度變化才會影響
  //    topOf(anchor) − scrollTop，所以這個差值就是「讀者相對文章的位置」：每按一次
  //    PgUp 它應該增加整整一頁。上方塌陷又沒被補償時就會少掉那一截（＝本 bug）。
  //    刻意取「頂端下方第一列」而不是更遠的列：頂端與量尺之間的東西不受 scroll
  //    anchoring 保護，距離愈短，量到的就愈純粹是捲動本身。
  const anchor = await page.evaluate(
    ({ topOfSrc, rowSel }) => {
      const topOf = eval(topOfSrc);
      const scroller = document.querySelector('.main');
      const rows = document.querySelectorAll(rowSel);
      for (let i = 0; i < rows.length; ++i) {
        if (topOf(rows[i]) >= scroller.scrollTop)
          return { idx: i, rows: rows.length };
      }
      return { idx: -1, rows: rows.length };
    },
    { topOfSrc: TOP_OF, rowSel: ROW_SEL }
  );
  expect(anchor.idx, '視窗頂端下方應該找得到一列當量尺').toBeGreaterThanOrEqual(0);

  // 節點可能因為 annotationsKey 變動被整列重建 ⇒ 每次都用**索引**重新查，不留參考。
  const readOffset = () =>
    page.evaluate(
      ({ topOfSrc, rowSel, idx }) => {
        const topOf = eval(topOfSrc);
        const scroller = document.querySelector('.main');
        const rows = document.querySelectorAll(rowSel);
        const row = rows[idx];
        if (!row) return null;
        return {
          offset: topOf(row) - scroller.scrollTop,
          scrollTop: scroller.scrollTop,
          rows: rows.length,
        };
      },
      { topOfSrc: TOP_OF, rowSel: ROW_SEL, idx: anchor.idx }
    );

  const before = await readOffset();
  expect(before, '量尺列消失了').not.toBeNull();

  // 4. 連按 PgUp。每次之間等整頁終局（**禁止 waitForTimeout 當版面等待**：行內預覽
  //    是延遲載入的佔位盒，捲動本身就會觸發載入，捲完立刻量到的位置之後還會動）。
  await page.evaluate(() => document.getElementById('t').focus());
  const steps = [];
  let prev = before;
  for (let i = 0; i < PRESSES; ++i) {
    await page.keyboard.press('PageUp');
    await waitPreviewsSettled(page);
    const cur = await readOffset();
    expect(cur, `第 ${i + 1} 次 PgUp 之後量尺列不見了`).not.toBeNull();
    steps.push({
      press: i + 1,
      gained: Math.round(cur.offset - prev.offset),
      offset: Math.round(cur.offset),
      scrollTop: Math.round(cur.scrollTop),
      rows: cur.rows,
    });
    prev = cur;
  }

  console.log(
    `[scroll-jump] ${JSON.stringify({
      pageStep,
      startSlotHeight: start.slotHeight,
      anchorIdx: anchor.idx,
      steps,
    })}`
  );

  for (const s of steps) {
    // 整份被重讀（_healFromTop 送 Home 重來）⇒ 列數會變，量尺也就不是同一列了。
    expect(
      s.rows,
      `第 ${s.press} 次 PgUp 之後累積頁的列數變了（${anchor.rows} → ${s.rows}）` +
        '＝文章被重讀，畫面跳回開頭'
    ).toBe(anchor.rows);
    // 症狀「來回跳」：位移為負＝讀者被往後推。
    // 症狀「捲不上去」：位移遠小於一頁＝PgUp 被上方的塌陷抵銷掉。
    expect(
      s.gained,
      `第 ${s.press} 次 PgUp 只往前 ${s.gained}px（應為 ${pageStep}px 的 ` +
        `${MIN_RATIO * 100}% 以上）—— 讀圖時的捲動補償被抑制了`
    ).toBeGreaterThanOrEqual(Math.round(pageStep * MIN_RATIO));
    // 也不得暴衝（補償被重複套用／內容憑空長高）。
    expect(s.gained).toBeLessThanOrEqual(Math.round(pageStep * 1.2));
  }

  // 累積起來也必須是完整的 N 頁：逐次都剛好卡在門檻上、整體卻短了一頁的情況要擋。
  const total = steps.reduce((a, s) => a + s.gained, 0);
  expect(total).toBeGreaterThanOrEqual(Math.round(pageStep * PRESSES * MIN_RATIO));
});
