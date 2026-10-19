// Playwright 假時鐘的共用操作（offline spec 用）。
//
// `page.clock.pauseAt(t)` 只能往未來跳：t 在頁面時鐘的過去就丟
// "Cannot fast-forward to the past"。「讀頁面 Date.now() → pauseAt(now + 餘裕)」是兩次
// 往返，CI 滿載時（load 17、us+sy 100%）中間就超過固定餘裕 ⇒ 偶發紅。這裡在同一個迴圈
// 重讀 now、餘裕逐次放大，直到停得下來為止。spec 一律走這裡，不要直接呼叫 pauseAt
// （守護 tests/unit/e2e_clock_pause.test.js）。
async function pauseClockNow(page, { margin = 100, maxMargin = 60000 } = {}) {
  for (let m = margin; ; m *= 4) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + m);
      return;
    } catch (e) {
      if (!/fast-forward to the past/.test(String(e && e.message)) || m >= maxMargin) throw e;
    }
  }
}

module.exports = { pauseClockNow };
