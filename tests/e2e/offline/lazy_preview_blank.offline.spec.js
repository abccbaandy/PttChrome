// 自動開圖佔位盒：非媒體連結不得留下高度（離線重放回歸）。
//
// 使用者實測（ptt-debug-20260812-010606）：每篇文章的推文區前面都多出一塊空白，
// 推文被往下推。成因不在累積/去重（pageLines 逐列正確），而在渲染層——
// 好讀對**每一個**連結都掛一個 <LazyInlinePreview> 佔位盒，而每篇 PTT 文章結尾
// 都有「※ 文章網址: https://www.ptt.cc/bbs/…html」。那個 URL 不是媒體：捲到附近
// 掛載後只會顯示「讀取中…」指示器，判定後內容消失；但卸載時舊碼無條件把「當下量到
// 的高度」釘進 min-height（本意是防真圖片卸載後內容塌陷、閱讀位置位移），於是把
// 指示器的 65px 永久釘住 ⇒ 每篇文章都有的假空白。
//
// 這裡鎖症狀：文章網址那列不得撐高。真媒體的塌陷補償另由 unit 守護
// （tests/unit/lazy_inline_preview.test.jsx）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

// 必須用**這一卷**：短文（test-xmen 之類）整篇都在視野內、從不觸發卸載，
// 佔位盒永遠不會被釘高度 ⇒ 測試恆綠、抓不到這個 bug。這卷是 bug 回報的原始現場
// （2 頁 + 兩張圖把文章網址那列推出卸載邊界）。
const article = loadCassette('ask-urlline-blank');

test('※ 文章網址（非媒體連結）的佔位盒不得留下 min-height', async ({ page }) => {
  test.setTimeout(90000);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    enablePicPreview: true,
  });
  await replayCassette(page, article, { easyReading: true });
  // 等 IntersectionObserver 的掛載/卸載跑完。**不能用固定 sleep**：圖回得慢時
  //（offline-slow project，圖 5.2 秒才回）1000ms 只量到中間態，「文章網址」那列
  // 甚至還沒被推出卸載邊界 ⇒ 測試恆綠、抓不到 bug。改等整頁終局。
  await waitPreviewsSettled(page);

  const slots = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('#mainContainer [data-type="bbsline"]')
    );
    return rows
      .map((el) => {
        const wrap = el.parentElement;
        if (!wrap) return null;
        const slot = wrap.querySelector('.inlinePreviewSlot');
        if (!slot) return null;
        return {
          text: el.textContent.replace(/\s+$/, ''),
          minHeight: slot.style.minHeight || '',
          height: Math.round(slot.getBoundingClientRect().height),
          hasMedia: !!slot.querySelector('img, video, iframe'),
        };
      })
      .filter(Boolean);
  });

  const urlRow = slots.find((s) => s.text.indexOf('※ 文章網址') === 0);
  expect(urlRow, '素材裡應有「※ 文章網址」列並掛上佔位盒').toBeTruthy();
  expect(urlRow.minHeight).toBe('');
  expect(urlRow.height).toBe(0);
});
