// 行內開圖在三種圖片載入情境下的產品行為（離線重放，真瀏覽器、真渲染）。
//
// 為什麼要有這一支：`installOfflineNetwork` 原本只有一種情境 —— fixture PNG 秒回，
// 等同於「本地快取永遠命中」。真實世界至少還有兩種，而且都零覆蓋：
//   * 圖床壞掉（404，或 301 轉址到已刪除的位置）
//   * 讀圖超久（>5 秒）—— 產品端**沒有任何載入 timeout**（ImagePreviewer 只有 onError
//     驅動的 backoff 重試），所以永遠 hang 的請求會永久停在 `.previewLoading`。
//
// 情境由 `bootOffline(page, ptt, { imageProfile })` 指定，決定性（固定延遲、URL 雜湊
// 分桶），純函式守護在 tests/unit/offline_image_profile.test.js。
//
// 注意分工：這一支驗的是**產品行為**。「既有測試在逆境下是否仍成立」是另一件事，
// 由 offline-slow / offline-broken / offline-mixed 三個 project 重跑既有 spec 來守。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  offlineServedUrls,
  offlineExternalUrls,
} = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');
const { GONE_PREFIX, GONE_ORIGIN, DEFAULT_SLOW_IMAGE_MS } = require('../helpers/offline_images');

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|apng|avif)(?:$|[?#:])/i;

const article = findCassette('article');

const IMG_SEL = '#mainContainer img.hyperLinkPreview';

// 由上往下掃到第一個真的掛出媒體（或錯誤提示）的捲動位置。
// 自動開圖是延遲載入的：不捲進視野連 requestPreview() 都不會被呼叫。
async function seekPreviewOutcome(page, { settle = true } = {}) {
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
    if (settle) await waitPreviewsSettled(page);
    const r = await outcome(page);
    if (r.loadedImgs > 0 || r.errors > 0) return r;
  }
  return outcome(page);
}

const outcome = (page) =>
  page.evaluate((sel) => ({
    slots: document.querySelectorAll('.inlinePreviewSlot').length,
    loading: document.querySelectorAll('.previewLoading').length,
    errors: document.querySelectorAll('.previewError').length,
    errorText: Array.from(document.querySelectorAll('.previewError'))
      .map((n) => n.textContent)
      .join('|'),
    loadedImgs: Array.from(document.querySelectorAll(sel)).filter(
      (im) => im.offsetWidth > 0 && im.offsetHeight > 0
    ).length,
    // 佔位盒被釘住的 inline min-height。載入失敗時**不得**有值：釘住的會是錯誤提示
    // 的高度 ⇒ 永久假空白（同 lazy_preview_blank 那條 bug 的根因，
    // src/js/lazy_media.js#recordSlotHeight 的 hasMedia 分支）。
    pinned: Array.from(document.querySelectorAll('.inlinePreviewSlot'))
      .map((n) => parseFloat(n.style.minHeight) || 0)
      .filter((h) => h > 0),
  }), IMG_SEL);

const boot = async (page, imageProfile) => {
  await bootOffline(page, ptt, { imageProfile });
  await ptt.applyPrefs(page, { enableEasyReading: true, enablePicPreview: true });
  await replayCassette(page, article, { easyReading: true });
};

test.describe('行內開圖：圖片載入情境（離線重放）', () => {
  test.skip(!article, '尚無 article cassette；先 yarn record:cassette');

  test('本地快取命中：圖秒開，沒有錯誤提示也沒有殘留的讀取動畫', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page, 'cache');
    await waitPreviewsSettled(page);

    const r = await seekPreviewOutcome(page);
    expect(r.slots, '素材裡應有行內預覽佔位盒').toBeGreaterThan(0);
    expect(r.loadedImgs, '快取命中時圖必定載得出來').toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.loading).toBe(0);
  });

  test('圖床 404：重試耗盡後顯示可點重試的失敗提示，且佔位盒不得留下假高度', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await boot(page, 'broken');
    await waitPreviewsSettled(page);

    const r = await seekPreviewOutcome(page);
    expect(r.slots).toBeGreaterThan(0);
    // FallbackImage：每個候選 1+2 次嘗試（backoff 300/600ms），候選全耗盡才顯示提示。
    expect(r.errors, '圖全 404 時應出現「載入失敗」提示，而不是靜默無圖').toBeGreaterThan(0);
    expect(r.errorText).toContain('點擊重試');
    expect(r.loadedImgs, '404 的 body 不得是可解碼的圖（<img> 不看 HTTP status）').toBe(0);
    // 這一條是 lazy_preview_blank 那條 bug 的同一個根因：載入失敗時量到的是錯誤提示
    // 的高度，釘進 min-height 就變成永久假空白。
    expect(
      r.pinned,
      '載入失敗的佔位盒不得被釘住高度（會變成永久假空白）'
    ).toEqual([]);
  });

  test('圖床 404：點失敗提示會重試（改回可用之後就載得出來）', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page, 'broken');
    await waitPreviewsSettled(page);
    const before = await seekPreviewOutcome(page);
    expect(before.errors).toBeGreaterThan(0);

    // 圖床「修好了」：之後的請求改回 fixture PNG。route 是後註冊優先，所以這條會蓋掉
    // installOfflineNetwork 的規則。
    const { previewPng } = require('../helpers/offline_images');
    await page.route(
      (url) => /\.(?:jpe?g|png|gif|webp|bmp|apng|avif)(?:$|[?#:])/i.test(url.pathname + url.search),
      (route) => route.fulfill({ contentType: 'image/png', body: previewPng() })
    );

    await page.evaluate(() => document.querySelector('.previewError').click());
    await waitPreviewsSettled(page);
    const after = await outcome(page);
    expect(after.loadedImgs, '點重試之後圖應該載得出來').toBeGreaterThan(0);
  });

  test('301 轉址到已刪除位置：圖拿不到時走失敗路徑，不靜默無圖', async ({ page }) => {
    test.setTimeout(120000);
    // 用整輪 redirect profile 而不是 mixed：轉址桶在 mixed 底下會不會落到這一卷素材
    // 取決於它有哪些網址 —— 那是素材的性質，不能拿來當斷言前提（實測第一卷 article
    // 一個都沒落進去 ⇒ 測試以「應有圖落在 redirect 桶」假紅）。
    //
    // **Chromium 會跟隨 route.fulfill 吐出的 301，但那一跳不再經過 page.route**
    //（見 helpers/offline_images.js 的 GONE_ORIGIN 註解；2026-08-28 由 Cloudflare
    // access log 推翻了 08-27「不會跟隨」的誤判）。所以這裡驗得到的是「圖床回 3xx ⇒
    // 圖拿不到」這一段，而不是「跟隨轉址後再 404」——但那一跳是真的送上網路，
    // 因此下面必須另外釘住「它只能落在保留域」。
    await boot(page, 'redirect');
    await waitPreviewsSettled(page);

    const r = await seekPreviewOutcome(page);
    expect(r.slots).toBeGreaterThan(0);
    expect(r.errors, '圖床回 301 到死路時應顯示失敗提示，而不是靜默無圖').toBeGreaterThan(0);
    expect(r.errorText).toContain('點擊重試');
    expect(r.loadedImgs).toBe(0);
    expect(r.pinned, '轉址失敗的佔位盒同樣不得被釘住高度').toEqual([]);

    // 這一輪確實有圖片請求走過離線層（否則整條在空轉）。
    const served = offlineServedUrls(page);
    expect(served.some((u) => IMAGE_EXT_RE.test(new URL(u).pathname))).toBe(true);
    // 終點必須是死路（不得再吐 301 造成無窮迴圈）。
    const chained = served.filter((u) => u.split(GONE_PREFIX).length > 2);
    expect(chained).toEqual([]);

    // REGRESSION（2026-08-28）：轉址終點的 origin 原本沿用原址，而產品預設會把 imgur
    // 網址改寫成自架 Worker 位址 ⇒ 那一跳每輪都真的打到 ptt-imgur-cache.…workers.dev
    //（access log 實錄 GET /__offline-gone__/783.png）。它逃出 page.route，所以只能從
    // 頁面實際發出的請求清單抓。凡是 __offline-gone__ 的請求，host 一律得是保留域。
    const gone = offlineExternalUrls(page).filter((u) => u.includes(GONE_PREFIX));
    const onRealHost = gone.filter((u) => new URL(u).origin !== GONE_ORIGIN);
    expect(onRealHost, '轉址終點不得落在任何真實 host').toEqual([]);
  });

  test('讀圖超久（>5 秒）：等待期間維持讀取動畫、不誤判成失敗，之後仍正常載出', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await boot(page, 'slow');

    // 捲到有圖的位置**但不等 settle** —— 這一測要看的正是「還在等」的那段。
    const geom = await page.evaluate(() => {
      const s = document.querySelector('.main');
      return { h: s.scrollHeight, ch: s.clientHeight };
    });
    const step = Math.max(200, geom.ch * 0.8);
    let sawLoading = false;
    for (let y = 0; y <= geom.h && !sawLoading; y += step) {
      await page.evaluate((top) => {
        document.querySelector('.main').scrollTop = top;
      }, y);
      // 佔位盒掛上到 <img> 發出請求只要幾幀；圖本身要 5.2 秒。
      await page.waitForTimeout(500);
      const mid = await outcome(page);
      if (mid.loading > 0) {
        sawLoading = true;
        // (a) 產品不得把「慢」誤判成「失敗」。
        expect(mid.errors, '圖還在載的時候不得出現失敗提示').toBe(0);
        // (b) 還沒載到的佔位盒不得被釘住高度（釘的會是讀取動畫的高度）。
        expect(mid.pinned).toEqual([]);
      }
    }
    expect(
      sawLoading,
      `慢圖情境（${DEFAULT_SLOW_IMAGE_MS}ms）下應該看得到讀取動畫；看不到代表這個 profile 沒生效`
    ).toBe(true);

    // (c) 等到終局之後，最終畫面與快取命中時一致 —— 慢只是慢，不改變結果。
    await waitPreviewsSettled(page);
    const r = await seekPreviewOutcome(page);
    expect(r.loadedImgs, '等夠久之後圖必須載得出來').toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.loading).toBe(0);
  });

  test('讀圖超久：圖還在載的時候終端機照常收送鍵盤', async ({ page }) => {
    test.setTimeout(180000);
    await boot(page, 'slow');

    // 捲到會觸發載入的位置，趁圖還在途中打字。
    await page.evaluate(() => {
      const s = document.querySelector('.main');
      s.scrollTop = Math.min(s.scrollHeight, s.clientHeight * 2);
    });
    await page.waitForTimeout(500);
    expect(
      (await outcome(page)).loading,
      '這一測的前提是此刻真的有圖在載'
    ).toBeGreaterThan(0);

    const sent = await page.evaluate(async () => {
      const out = [];
      window.__stubWSSent = (s) => out.push(s);
      const input = document.getElementById('t');
      input.focus();
      window.__app.view.onKeyDown(
        Object.assign(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), {})
      );
      await new Promise((r) => setTimeout(r, 200));
      return out.join('');
    });
    expect(sent, '圖片載入不得卡住終端機的送鍵路徑').toContain('\x1b[D');
  });
});
