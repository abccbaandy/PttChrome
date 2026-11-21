// P110 文章裡的一般網頁連結下面放預覽卡（js/link_card.js、ImagePreviewer.jsx#LinkCard）。
// unit（link_card.test.js、link_card_render.test.jsx）守純邏輯與元件；這裡守完整 boot 鏈＋好讀長頁：
//   ①Worker `/og` 回了分享資訊 ⇒ 連結下面出現卡片，標題、網站名、縮圖都在
//   ②真滑鼠點卡片 ⇒ 開新分頁到文章裡的原始連結（slot 是 pointer-events:none，卡片沒取回 auto 會點不到）
//   ③開關關掉 ⇒ 一個 `/og` 請求都沒有、沒有卡片（跟以前一樣）
// Worker 由 page.route 假裝（離線、零外流）；素材 stock-huang（內文有 reurl.cc 短網址）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled, waitRectStable } = require('../helpers/layout');

const THUMB = 'https://thumb.e2e.invalid/og.png';
// 1x1 透明 PNG。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function fakeWorker(page) {
  const asked = [];
  // 在 bootOffline 之後註冊：Playwright 後註冊的 route 優先，蓋過離線網路的 'blocked'。
  await page.route(
    (url) => url.pathname === '/og' && url.searchParams.has('url'),
    (route) => {
      const target = new URL(route.request().url()).searchParams.get('url');
      asked.push(target);
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ title: '預覽卡測試標題', site: '測試網站', image: THUMB, url: target }),
      });
    },
  );
  await page.route(THUMB, (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
  return asked;
}

async function openArticle(page, prefs = {}) {
  await bootOffline(page, ptt);
  const asked = await fakeWorker(page);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enableEasyReadingList: false,
    useImgurProxy: true,
    ...prefs,
  });
  await replayCassette(page, loadCassette('stock-huang'), { easyReading: true });
  return asked;
}

test('網頁連結下面出現預覽卡；真滑鼠點卡片開新分頁到原始連結', async ({ page, context }) => {
  const asked = await openArticle(page);
  const card = page.locator('#mainContainer a.linkCard').first();
  await card.scrollIntoViewIfNeeded({ timeout: 20000 });
  await expect(card).toBeVisible();
  await waitPreviewsSettled(page);
  await expect(card.locator('.linkCardTitle')).toHaveText('預覽卡測試標題');
  await expect(card.locator('.linkCardSite')).toHaveText('測試網站');
  await expect(card.locator('img.linkCardThumb')).toHaveAttribute('src', THUMB);
  const href = await card.getAttribute('href');
  expect(asked).toContain(href);
  // 卡片固定高度（佔位盒跨重建沿用量到的高度）：整數像素。
  const rect = await waitRectStable(page, '#mainContainer a.linkCard');
  expect(rect.height).toBe(Math.round(rect.height));

  // 新分頁的目標不能真的連出去。
  await context.route(href, (route) => route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }));
  const [popup] = await Promise.all([context.waitForEvent('page'), card.click()]);
  expect(popup.url()).toBe(href);
});

test('開關關掉 ⇒ 不問 Worker、沒有卡片（跟以前一樣）', async ({ page }) => {
  const asked = await openArticle(page, { linkPreviewCard: false });
  await waitPreviewsSettled(page);
  await expect(page.locator('#mainContainer .bbsrow, #mainContainer [data-type="bbsline"]').first()).toBeAttached({
    timeout: 20000,
  });
  await expect(page.locator('#mainContainer a.linkCard')).toHaveCount(0);
  expect(asked).toEqual([]);
});
