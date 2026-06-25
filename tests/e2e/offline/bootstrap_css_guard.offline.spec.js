// Bootstrap CSS 相容守門 —— 功能型(非版本號比對)。
//
// 本專案用 react-bootstrap@0.31 吐出 Bootstrap 3 的 class 名(modal-dialog、
// btn-default、col-xs-*…),由 webpack-cdn-plugin 依「實際安裝版本」載入的
// bootstrap CSS 去 style。升 BS4/5 時 class 被改名/移除 → 畫面套不上樣式,
// 但 DOM 沒變、JS 沒拋錯,所有「行為型」斷言照樣綠(這就是 grouped dependabot
// 把 bootstrap 3→5 時三個 test job 全過、卻會弄壞 UI 的原因)。
//
// 這裡不比對版本號,而是讀「真實載入的 bootstrap CSS 對 BS3 class 算出的樣式」:
// 注入帶 BS3 class 的探針,讀 getComputedStyle。BS3 的規則還在 → 綠;
// 換成 BS4/5(規則被刪) → 算出的樣式變了 → 紅。版本無關、行為導向。
// 必須在真瀏覽器跑(unit 的 node/jsdom 不套用外部 CSS,getComputedStyle 量不到)。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay } = require('../helpers/replay');

test.describe('Bootstrap CSS 相容(BS3 class 仍被正確 style)', () => {
  test('btn-default 背景白 + col-xs-6 半寬(BS4/5 會 fail)', async ({ page }) => {
    // stub WebSocket → 不連真實 PTT;只需頁面載入(含 bootstrap CDN <link>)。
    await installReplay(page);
    await page.goto('/');
    await ptt.dismissDeveloperModeAlert(page);

    // 等 bootstrap 的 CDN <link> 真的載入並套上(非同步);載入後量一次即可,
    // pass/fail 都快(不靠輪詢某個預期值,否則 fail 路徑會空轉到 timeout)。
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const link = document.querySelector(
              'link[rel="stylesheet"][href*="bootstrap"]'
            );
            // link.sheet 非 null 代表樣式表已載入並套用(不讀 cssRules,避開跨域限制)。
            return !!(link && link.sheet);
          }),
        { timeout: 15000 }
      )
      .toBe(true);

    // BS3：.btn-default{background-color:#fff} → rgb(255, 255, 255)
    // BS4/5：無 .btn-default 規則 → 維持 UA 預設按鈕底色(非白)
    const btnBg = await page.evaluate(() => {
      const probe = document.createElement('button');
      probe.className = 'btn btn-default';
      document.body.appendChild(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return bg;
    });
    expect(
      btnBg,
      'react-bootstrap 吐 BS3 的 .btn-default 應被 Bootstrap 3 CSS 染成白底;' +
        '若非白底,代表載入的 bootstrap 非 BS3(major 被誤升),UI 會壞。'
    ).toBe('rgb(255, 255, 255)');

    // BS3：.col-xs-6{width:50%}(box-sizing:border-box 全域) → 父寬 240 → 120px
    // BS4/5：無 .col-xs-* → 區塊預設撐滿父寬 → 240px
    const colWidth = await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.style.width = '240px';
      const col = document.createElement('div');
      col.className = 'col-xs-6';
      wrap.appendChild(col);
      document.body.appendChild(wrap);
      const w = getComputedStyle(col).width;
      wrap.remove();
      return w;
    });
    expect(
      colWidth,
      'BS3 的 .col-xs-6 應為父寬一半(120px);非半寬代表載入的 bootstrap 非 BS3。'
    ).toBe('120px');
  });
});
