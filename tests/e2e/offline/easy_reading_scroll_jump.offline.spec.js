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

// 由上往下走，停在第一個真的把圖載出來的位置。延遲載入 ⇒ 文章開頭不一定有圖。
async function seekLoadedImg(page) {
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
    const found = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('img.hyperLinkPreview')).filter(
          (im) => im.offsetWidth > 0 && im.offsetHeight > 0
        ).length
    );
    if (found > 0) return true;
  }
  return false;
}

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
// **這條的必現環境是 offline-slow**（`yarn test:e2e:offline:adverse`，圖固定慢 5.2s）。
// 一般 offline 用瀏覽器快取，圖的 load 事件在 mount 的下一個 task 就回來、來不及跨
// 過一次排版 ⇒ 量不到中間態（實測 rafMin 全程 570）。舊碼在 slow 下的實錄是
// `570,65,570,65,570,65…` —— 65px 就是「讀取中…」指示器，那串來回正是使用者說的
// 「來回跳」。所以它掛在 playwright.config.js 的 ADVERSE_IMAGE_SPECS 裡。
test('往回捲時佔位盒掛載：高度不得塌陷（替身盒讓位給讀取中指示器）', async ({ page }) => {
  test.setTimeout(300000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);

  // 1. 先點放大（此時只有前面那幾張圖載過），之後整趟往下都在放大態 ⇒ 中後段的圖
  //    **只**在放大態載入過，normal 那格永遠是空的。
  expect(await seekLoadedImg(page), '整篇掃過一遍都沒有圖載得出來').toBe(true);
  expect(await clickAnyLoadedImg(page), '應有可點的圖來切換放大').toBe(true);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(true);

  await walkDown(page);

  // 2. 點縮小（回到 normal）。
  expect(await clickAnyLoadedImg(page), '縮小前視野內應有可點的圖').toBe(true);
  await waitPreviewsSettled(page);
  expect(
    await page.evaluate(() =>
      document.getElementById('mainContainer').classList.contains('imagesEnlarged')
    )
  ).toBe(false);

  // 3. 找一個「已卸載、只剩替身盒頂著、而且在目前位置上方」的佔位盒，
  //    在它身上裝 ResizeObserver 逐幀記高度。
  const target = await page.evaluate(
    ({ topOfSrc, mediaSel }) => {
      const topOf = eval(topOfSrc);
      const scroller = document.querySelector('.main');
      const slots = Array.from(document.querySelectorAll('.inlinePreviewSlot'));
      for (let i = slots.length - 1; i >= 0; --i) {
        const s = slots[i];
        if (s.querySelector(mediaSel)) continue; // 還掛著真圖 ⇒ 沒卸載
        // 佔位高度必須是空的（＝normal 這格從沒量過），高度純粹由替身盒頂著。
        // 有釘住的高度時舊碼在 mount 也不會塌陷 ⇒ 選到那種就抓不到 bug。
        const spacer = s.querySelector('.inlinePreviewSpacer');
        if (spacer && spacer.style.minHeight) continue;
        const ghost = s.querySelector('.inlinePreviewGhost');
        if (!ghost || ghost.offsetHeight < 200) continue;
        const y = topOf(s);
        if (y > scroller.scrollTop - 500) continue; // 必須在上方，等下捲回去才會 mount
        window.__slotSamples = [s.offsetHeight];
        window.__slotRO = new ResizeObserver(() => {
          window.__slotSamples.push(s.offsetHeight);
        });
        window.__slotRO.observe(s);
        return { ok: true, y: y, ghostHeight: ghost.offsetHeight, height: s.offsetHeight };
      }
      return { ok: false, slots: slots.length };
    },
    { topOfSrc: TOP_OF, mediaSel: MEDIA_IN_SLOT }
  );
  expect(
    target.ok,
    '素材太短：整趟放大態走完之後，上方應該留下「已卸載＋只剩替身盒」的佔位盒 ⇒ ' +
      '抓不到這個 bug，請換更長的 cassette'
  ).toBe(true);

  // 4. 捲回去讓它進入掛載範圍。
  await page.evaluate((y) => {
    document.querySelector('.main').scrollTop = Math.max(0, y - 200);
  }, target.y);
  await waitPreviewsSettled(page);

  const samples = await page.evaluate(() => {
    window.__slotRO.disconnect();
    return window.__slotSamples;
  });
  const min = Math.min(...samples);
  console.log(
    `[mount-collapse] ${JSON.stringify({
      ghostHeight: target.ghostHeight,
      before: target.height,
      min,
      samples: samples.slice(0, 12),
    })}`
  );
  // 舊碼：mount() 先 removeGhost() ⇒ 掉到「讀取中…」指示器的高度（~56px）。
  // 新碼：替身盒住在 spacer 裡，疊層取 max ⇒ 全程維持替身盒的高度。
  expect(
    min,
    `掛載過程中佔位盒一度塌到 ${min}px（替身盒 ${target.ghostHeight}px）` +
      '⇒ 讀者會被整整推走那一截'
  ).toBeGreaterThanOrEqual(Math.round(target.ghostHeight * 0.9));
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
