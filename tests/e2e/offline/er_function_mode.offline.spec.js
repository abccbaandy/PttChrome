// 文章好讀的 functionMode（鏡像原生）與 :N 往回跳 —— 重放 scenario 卷（真 PTT 錄的往返）。
//
// 取代 2026-10 前的 live 測項（easy-reading.spec.js「按 h 顯示說明」「:N 往回跳／`/` 提示」、
// enhance.spec.js「回文選單」）：那幾條在 live 要靠板況挑文章、固定 sleep 等 PTT，
// 現在素材固定，等待全部綁重放進度與狀態旗標。
// 素材：tests/e2e/cassettes/scn-er-{help,reply,seekback}.json（yarn record:scenarios）。
// 純邏輯另有 unit：easy_reading_function_mode_gate / easy_reading_seek_back /
// easy_reading_browser_find。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootScenario, waitFed } = require('../helpers/replay');

const help = loadCassette('scn-er-help');
const reply = loadCassette('scn-er-reply');
const seekback = loadCassette('scn-er-seekback');

const fnMode = (page) => page.evaluate(() => !!window.__app.easyReading._functionMode);
const lastRowDisplay = (page) =>
  page.evaluate(() => {
    const lr = document.getElementById('easyReadingLastRow');
    return lr ? getComputedStyle(lr).display : 'no-el';
  });
const bufText = (page) =>
  page.evaluate(() => {
    const b = window.__app.buf;
    const out = [];
    for (let r = 0; r < b.rows; r++) out.push(b.getRowText(r, 0, b.cols));
    return out.join('\n');
  });

// 已餵的 bytes 都畫進 buf 且 settle 完（pageState 已依本幀重算）。
const waitBufSettled = (page) =>
  page.waitForFunction(() => !window.__app.buf.timerUpdate && !window.__app.buf._settleTimer);

// 列表首幀 → Enter 開文 → 等自動翻頁把素材裡的頁數全吃完、好讀累積到文末。
async function openAndAccumulate(page, cassette) {
  // 第一個 open 之後連續的 pagedown 才是這篇的自動翻頁（之後的 open 屬於後面的動作）。
  const firstOpen = cassette.steps.findIndex((s) => s.on === 'open');
  expect(firstOpen).toBeGreaterThan(0);
  let n = firstOpen + 1;
  while (n < cassette.steps.length && cassette.steps[n].on === 'pagedown') n++;
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, n);
  await page.waitForFunction(
    () =>
      window.__app.view.useEasyReadingMode &&
      window.__app.easyReading.easyReadingReachedPageEnd &&
      !window.__app.buf.timerUpdate &&
      !window.__app.buf._settleTimer
  );
  expect(await fnMode(page)).toBe(false);
  return n; // 已餵的步數
}

test.describe('好讀 functionMode（scenario 重放）', () => {
  test('h → pmore 說明（functionMode 鏡像原生）→ 空白鍵離開回長頁', async ({ page }) => {
    test.skip(!help, '缺 scn-er-help（yarn record:scenarios）');
    await bootScenario(page, ptt, help);
    const fed = await openAndAccumulate(page, help);

    // 舊 bug：h 在好讀的吞鍵清單裡，完全沒反應。
    await ptt.sendKey(page, 'h');
    await waitFed(page, fed + 1);
    await expect.poll(() => fnMode(page)).toBe(true);
    // fnMode 在 keydown 當下就設（_enterFunctionMode），waitFed 只代表 bytes 進了 parser；
    // pageState 要等 queueUpdate 的 30ms timer → notify → setPageState 才更新。先等 buf
    // settle 再判，否則負載高時會讀到上一幀（文章）的 3。
    await waitBufSettled(page);
    expect(await page.evaluate(() => window.__app.buf.pageState)).not.toBe(3); // 說明頁不是文章畫面

    await ptt.sendKey(page, 'Space');
    await waitFed(page, fed + 2);
    await expect.poll(() => fnMode(page)).toBe(false);
    // 'resume'：回好讀長頁，footer overlay 復現。
    expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
    await expect.poll(() => lastRowDisplay(page)).toBe('block');
  });

  test('r → 「回應至」（functionMode）→ q 取消，乾淨退出不卡死', async ({ page }) => {
    test.skip(!reply, '缺 scn-er-reply（需帳號錄製）');
    await bootScenario(page, ptt, reply);
    const fed = await openAndAccumulate(page, reply);

    // 舊 bug：選單被好讀 footer 蓋住、看不到 prompt。
    await ptt.sendKey(page, 'r');
    await waitFed(page, fed + 1);
    await expect.poll(() => fnMode(page)).toBe(true);
    // 選單列真的畫在畫面上（不是被長頁蓋住）：DOM 是原生 24 列的鏡像。
    await expect.poll(() => bufText(page)).toContain('回應至');
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelectorAll('#mainContainer [data-type="bbsline"]').length)
      )
      .toBeLessThanOrEqual(24);

    await ptt.typeLine(page, 'q');
    await waitFed(page, fed + 2);
    await expect.poll(() => fnMode(page)).toBe(false);
    const ps = await page.evaluate(() => window.__app.buf.pageState);
    // 取消後 PTT 回文章（resume 回長頁）或帶回列表（leave）：兩者都是合法的乾淨退出。
    if (ps === 3) await expect.poll(() => lastRowDisplay(page)).toBe('block');
    else expect(await lastRowDisplay(page)).toBe('none');
  });

  test(':5 往回跳不重複累積、捲到落點；`/` 只提示瀏覽器搜尋、Ctrl+F 不送 ^F', async ({ page }) => {
    test.skip(!seekback, '缺 scn-er-seekback（yarn record:scenarios）');
    await bootScenario(page, ptt, seekback, { prefs: { easyReadingBrowserFind: true } });
    const fed = await openAndAccumulate(page, seekback);
    const rowTexts = () =>
      page.evaluate(() =>
        window.__app.buf.pageLines.map((r) => r.map((c) => c.ch).join('').replace(/\s+$/, ''))
      );
    const before = await rowTexts();
    const accEnd = await page.evaluate(() => window.__app.view._accEndRow);
    expect(before.length).toBeGreaterThan(40);

    // ---- `/`：本地提示，不送 PTT、不進 functionMode ----
    const sentBefore = await page.evaluate(() => window.__replay.sent.length);
    await ptt.sendKey(page, 'Slash');
    await expect(page.locator('.ListHint')).toContainText(/Ctrl\+F|⌘F/);
    expect(await fnMode(page)).toBe(false);

    // ---- Ctrl+F：不送 ^F（pmore 的 ^F 會移頁指標） ----
    const sigBefore = await page.evaluate(() => window.__app.easyReading._currentPageSignature());
    await ptt.sendKey(page, 'Control+f');
    // 柵欄：下一個 `:` 必定會送出；等它出現在送出紀錄，再斷言它前面什麼都沒有。
    await ptt.sendKey(page, ':');
    await waitFed(page, fed + 1);
    const sent = await page.evaluate((k) => window.__replay.sent.slice(k), sentBefore);
    expect(sent.join('')).not.toContain('/');
    expect(sent.join('')).not.toContain('\x06');
    expect(sent[0]).toBe(':');
    expect(await page.evaluate(() => window.__app.easyReading._currentPageSignature())).toBe(sigBefore);

    // ---- :5 往回跳 ----
    await expect.poll(() => fnMode(page)).toBe(true);
    await ptt.typeLine(page, '5');
    // 落點那一幀＋realign（:<文末>\r）都餵完、functionMode 退出、_accEndRow 回到文末。
    await waitFed(page, seekback.steps.length);
    await page.waitForFunction(
      (end) => {
        const a = window.__app;
        return (
          a.easyReading._functionMode === false &&
          !a.buf.easyReadingHealInFlight &&
          a.view._accEndRow === end &&
          !a.buf.timerUpdate &&
          !a.buf._settleTimer
        );
      },
      accEnd
    );
    // 修前症狀：_accEndRow 倒退 ⇒ 自動翻頁把已累積的內容重複接到尾巴。素材已全部餵完，
    // 若有人再送 PageDown 只會落空——直接檢查它沒送。
    const after = await rowTexts();
    expect(after).toEqual(before);
    const extra = await page.evaluate(() => window.__replay.sent.join(''));
    expect(extra.split('\x1b[6~').length - 1).toBe(
      seekback.steps.filter((s) => s.on === 'pagedown').length
    );
    const top = await page.evaluate(() => window.__app.view.mainDisplay.scrollTop);
    const chh = await page.evaluate(() => window.__app.view.chh);
    expect(top).toBeLessThan(chh * 12);
  });
});
