// stub WebSocket 的送出記錄（offline spec 共用）。
//
// takeCapture 讀完就清空，**不能拿來 expect.poll**（第一次輪詢就把資料吃掉了）。
// 要等「某個 byte 送出了」用 peekCapture 輪詢，確定之後再 takeCapture 收尾：
//   await expect.poll(() => peekCapture(page)).toContain(ARROW_LEFT);
// 不要用「動作完固定 sleep 再 takeCapture」：renderer 一忙，sleep 就不夠。
const { expect } = require('@playwright/test');

async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}

async function peekCapture(page) {
  return page.evaluate(() => (window.__sentLog || []).join(''));
}

async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

// 否定斷言的柵欄：證明「前面那個動作一個 byte 都沒送」。
//
// 「動作 → sleep → takeCapture === ''」在慢機器上會假綠（還沒送也算沒送），而且
// capture 根本沒接上時也一樣綠。改成：動作之後再做一個**走同一條輸入管道、必定會送**
// 的對照動作 `fence`，等它的 byte 到了，斷言整份記錄**恰好**等於它。
//   * 對照動作送得出去 ⇒ capture 有接上、管道沒被前一個動作卡死；
//   * 輸入事件依序派發 ⇒ 前一個動作若同步送了東西，必然排在對照 byte 前面而被抓到。
// 由 timer 延後送出的路徑不在此保證範圍內：那種要另外等該 timer 本身清空
// （例：`__app.dblclickTimer`）。
async function expectOnlyFence(page, fence, fenceBytes, label) {
  await fence();
  await expect
    .poll(() => peekCapture(page), `${label || ''} 對照動作沒送出（capture 沒接上？）`)
    .toContain(fenceBytes);
  expect(await takeCapture(page), label).toBe(fenceBytes);
}

module.exports = { startCapture, peekCapture, takeCapture, expectOnlyFence };
