// P109 文章裡的 YouTube 先放縮圖，點了才載播放器（js/video_facade.js、ImagePreviewer.jsx#VideoFacade）。
// unit（video_facade.test.jsx）守元件；這裡守完整 boot 鏈＋好讀長頁下：
//   ①沒點之前頁面一個 youtube.com/embed 請求都沒有（這就是省下的 1.2 MB）
//   ②真滑鼠點縮圖 ⇒ 換成播放器、帶 autoplay，框大小不變
//   ③開關關掉 ⇒ 跟以前一樣直接嵌播放器
// 素材：test-xmen（文章開頭就是 YouTube 連結）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

function trackEmbeds(page) {
  const urls = [];
  page.on('request', (req) => {
    if (/youtube\.com\/embed\//.test(req.url())) urls.push(req.url());
  });
  return urls;
}

async function openArticle(page, prefs = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true, enableEasyReadingList: false, ...prefs });
  await replayCassette(page, loadCassette('test-xmen'), { easyReading: true });
}

test('YouTube 先放縮圖：沒點不載播放器，點了才換成播放器並自動播放', async ({ page }) => {
  const embeds = trackEmbeds(page);
  await openArticle(page);
  const facade = page.locator('#mainContainer [data-video-facade]').first();
  await expect(facade).toBeVisible({ timeout: 20000 });
  await facade.scrollIntoViewIfNeeded();
  const box = page.locator('#mainContainer [data-video-box]').first();
  const before = await waitRectStable(page, '#mainContainer [data-video-box]');
  await expect(page.locator('#mainContainer iframe')).toHaveCount(0);
  expect(embeds).toEqual([]);

  // 真滑鼠點（Playwright 先確認點的位置真的落在縮圖上：slot 是 pointer-events:none，
  // 縮圖沒取回 auto 的話點擊會穿到列上，這裡會等到逾時）。
  await facade.click();
  const iframe = box.locator('iframe');
  await expect(iframe).toHaveCount(1);
  const src = new URL(await iframe.getAttribute('src'));
  expect(src.pathname).toMatch(/^\/embed\/[\w-]+$/);
  expect(src.searchParams.get('autoplay')).toBe('1');
  await expect.poll(() => embeds.length).toBeGreaterThan(0);
  const after = await waitRectStable(page, '#mainContainer [data-video-box]');
  expect(Math.round(after.width)).toBe(Math.round(before.width));
  expect(Math.round(after.height)).toBe(Math.round(before.height));
});

test('開關關掉 ⇒ 直接嵌播放器（跟以前一樣）', async ({ page }) => {
  await openArticle(page, { videoThumbFirst: false });
  await expect(page.locator('#mainContainer iframe').first()).toBeAttached({ timeout: 20000 });
  await expect(page.locator('#mainContainer [data-video-facade]')).toHaveCount(0);
});
