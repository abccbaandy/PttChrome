// 觸控板水平手勢／瀏覽器「上一頁」→ PTT 左方向鍵（離線重放，真瀏覽器真事件）。
//
// unit 抓不到的部分才放這裡：
//  * 真的 wheel 事件走完 window capture listener 的整條路（辨識器吃的是真實
//    timeStamp，慣性鎖不是靠假時鐘）；
//  * history sentinel 在真 History API 上的行為（user activation → pushState →
//    goBack 被吃掉、頁面沒有離站）。
//
// 列表好讀（buffer）底下「必須走 ListSession 而不是裸送 byte」那條由 unit 守
// （tests/unit/term_view_send_key_as_user.test.js）：在這裡要製造 buffer 模式得
// 驅動整卷 list cassette，而該卷的門控只認錄製當時那串鍵，手勢送出的 ← 會落在
// 沒有對應 step 的位置 —— 測到的會是 cassette 的門控而不是本功能。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');

const article = findCassette('article');
const ARROW_LEFT = '\x1b[D';
const PAGE_DOWN = '\x1b[6~';

async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}
async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

// 一次「兩指左滑」：連續幾個小 delta（＝真實觸控板的樣子），中間不留空檔，
// 所以辨識器看到的是同一次手勢。
async function swipeLeft(page, steps = 6) {
  const box = await page.evaluate(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }));
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < steps; ++i) await page.mouse.wheel(-40, 0);
}

async function bootArticle(page, prefs = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    useMouseBrowsing: true,
    ...prefs,
  });
  await replayCassette(page, article, { easyReading: true });
}

test.describe('水平手勢／瀏覽器上一頁（離線重放）', () => {
  if (!article) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  test('文章裡左滑：送出一次左方向鍵，慣性不會連送', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page);
    await startCapture(page);
    await swipeLeft(page);
    await page.waitForTimeout(300);
    const sent = await takeCapture(page);
    expect(sent.split(ARROW_LEFT).length - 1).toBe(1);
    // 水平事件絕不可以順便翻頁（deltaY===0 被算成「往下」的舊 bug）
    expect(sent).not.toContain(PAGE_DOWN);
  });

  test('關掉手勢 pref：同一個動作什麼都不送', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page, { mouseSwipeHorizontal: 0 });
    await startCapture(page);
    await swipeLeft(page);
    await page.waitForTimeout(300);
    const sent = await takeCapture(page);
    expect(sent).not.toContain(ARROW_LEFT);
    expect(sent).not.toContain(PAGE_DOWN);
  });

  test('瀏覽器上一頁：被攔下來送左方向鍵，頁面沒有離站', async ({ page }) => {
    test.setTimeout(90000);
    // 左鍵關掉：取得 user activation 的那一下點擊落在文章左側退出帶上就會自己送
    // 一個 ←，把待測的東西混掉。
    await bootArticle(page, { mouseLeftClick: false });
    // sentinel 要等第一次 user activation 才疊（Chrome 的 History Manipulation
    // Intervention 會跳過沒有 activation 的 entry ⇒ 直接離站）。
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => window.history.state?.pttchromeBackGuard === 1);

    await startCapture(page);
    await page.goBack();
    await page.waitForTimeout(300);
    expect(await takeCapture(page)).toContain(ARROW_LEFT);
    // 還在同一個 document（沒有重載、沒有離站）
    expect(await page.evaluate(() => !!window.__app)).toBe(true);
  });

  test('關掉上一頁攔截：不疊 sentinel（瀏覽器行為原封不動）', async ({ page }) => {
    test.setTimeout(90000);
    await bootArticle(page, { mouseBackButton: 0, mouseLeftClick: false });
    await page.mouse.click(5, 5);
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() => !!(window.history.state && window.history.state.pttchromeBackGuard))
    ).toBe(false);
  });
});
