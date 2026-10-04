// deep link 的**完整跳轉**（主功能表 → s<board> → 進板畫面 → #<aid> → ⏎ → 好讀落地）
// ＋ 落地後 F2 複製本篇連結 —— 重放真 PTT 錄的往返（scn-deep-link，需帳號錄製）。
//
// deep_link.offline.spec.js 只驗「URL 進得來、待跳目標被收下」；真正會壞的是與 PTT 的
// 往返（主功能表起手式不能送 escape preamble、進板畫面的 pressanykey 要先收掉），
// 2026-10 前只有 live 驗得到，現在由素材固定下來。跳轉序列的純邏輯在
// tests/unit/aid_navigation.test.js、deep_link_controller.test.js。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootScenario, waitFed } = require('../helpers/replay');

const cassette = loadCassette('scn-deep-link');

test('deep link（hashchange）：自動落在該篇文章、好讀接手；F2 複製到本篇連結', async ({ page }) => {
  test.skip(!cassette, '缺 scn-deep-link（需帳號：yarn record:scenarios）');
  const { board, aid } = cassette.meta;
  await bootScenario(page, ptt, cassette);
  await page.evaluate(() => {
    window.__hints = [];
    const v = window.__app.view;
    const orig = v.flashListHint.bind(v);
    v.flashListHint = (msg, ms) => {
      window.__hints.push(msg);
      return orig(msg, ms);
    };
    window.__copied = [];
    navigator.clipboard.writeText = (t) => {
      window.__copied.push(t);
      return Promise.resolve();
    };
  });
  // 前提：停在主功能表、好讀尚未啟動 ⇒ 走 startExternal（與冷啟動同一支）。
  expect(await page.evaluate(() => window.__app.buf.startedEasyReading)).toBeFalsy();

  await page.evaluate((h) => {
    window.location.hash = h;
  }, '#' + board + '/' + aid);

  // F2 之前的所有往返 ＝ 素材裡最後一個 raw 之前（F2 不經 PTT 時素材沒有對應 step）。
  await page.waitForFunction(() => {
    const a = window.__app;
    return (
      a.buf.pageState === 3 &&
      a.aidNavigation.active === false &&
      a.view.useEasyReadingMode &&
      a.easyReading.easyReadingReachedPageEnd
    );
  });
  const hints = () => page.evaluate(() => window.__hints);
  expect((await hints()).filter((h) => h.includes('失敗'))).toEqual([]);
  expect(await page.evaluate(() => window.__app.easyReading._functionMode)).toBe(false);
  // 網址列同步成落地那篇（若有寫回）。
  const hashTarget = await page.evaluate(() =>
    location.hash ? window.__parseDeepLink(location.href) : null
  );
  if (hashTarget) expect(hashTarget).toEqual({ board, aid });

  await ptt.sendKey(page, 'F2');
  await waitFed(page, cassette.steps.length);
  await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1);
  const copied = await page.evaluate(() => window.__copied[0]);
  expect(copied).toContain('#' + board + '/M.');
  expect(await page.evaluate((l) => window.__parseDeepLink(l), copied)).toEqual({ board, aid });
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(3);
  expect(await page.evaluate(() => window.__app.buf.startedEasyReading)).toBe(true);
  expect((await hints()).filter((h) => h.includes('複製連結失敗'))).toEqual([]);
});
