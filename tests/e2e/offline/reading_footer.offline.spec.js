// P65 好讀文章底列顯示「你讀到哪」（pref easyReadingFooterProgress，預設開）。
//
// 好讀自動把整篇翻完接起來 ⇒ PTT 停在最後一頁，原生狀態列的鏡像寫「第 N/N 頁 (100%)」、
// 捲動也不變。底列左半改成讀者自己的位置、跟著捲動；右半功能鍵照舊。關掉就照 PTT 原樣。
// 捲動走真滾輪（helpers/real_input.mouseWheel），不手捏 scroll 事件。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');
const { mouseWheel } = require('../helpers/real_input');

const article = findCassette('article');

const footerText = (page) =>
  page.evaluate(() => (document.getElementById('easyReadingLastRow') || {}).textContent || '');

const open = async (page, prefs) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true }, prefs));
  await replayCassette(page, article, { easyReading: true });
  await waitPreviewsSettled(page);
};

test.describe('好讀底列顯示讀到哪', () => {
  test.skip(!article, '尚無 article cassette');

  test('開頭顯示讀者位置、捲到文末變 100%；功能鍵照舊', async ({ page }) => {
    test.setTimeout(90000);
    await open(page, {});
    await expect.poll(() => footerText(page)).toMatch(/讀到 \d+%\s+第 1~\d+ 列／共 \d+ 列/);
    const first = await footerText(page);
    expect(first).not.toMatch(/瀏覽|目前顯示/);
    expect(await page.locator('#easyReadingLastRow a.fnKey').count()).toBeGreaterThan(0);

    const total = Number(/共 (\d+) 列/.exec(first)[1]);
    const box = await page.locator('.main').boundingBox();
    for (let i = 0; i < 40; ++i) {
      await mouseWheel(page, box.x + box.width / 2, box.y + box.height / 2, { deltaY: 600 });
      if (/讀到 100%/.test(await footerText(page))) break;
    }
    await expect.poll(() => footerText(page)).toMatch(/讀到 100%/);
    expect(await footerText(page)).toMatch(new RegExp(`~${total} 列／共 ${total} 列`));
  });

  test('關掉 ⇒ 照 PTT 原樣鏡像', async ({ page }) => {
    test.setTimeout(90000);
    await open(page, { easyReadingFooterProgress: false });
    await expect.poll(() => footerText(page)).toMatch(/瀏覽 第 \d+\/\d+ 頁/);
    expect(await footerText(page)).not.toMatch(/讀到/);
  });
});
