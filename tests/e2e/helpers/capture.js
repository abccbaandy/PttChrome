// stub WebSocket 的送出記錄（offline spec 共用）。
//
// takeCapture 讀完就清空，**不能拿來 expect.poll**（第一次輪詢就把資料吃掉了）。
// 要等「某個 byte 送出了」用 peekCapture 輪詢，確定之後再 takeCapture 收尾：
//   await expect.poll(() => peekCapture(page)).toContain(ARROW_LEFT);
// 不要用「動作完固定 sleep 再 takeCapture」：renderer 一忙，sleep 就不夠。
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

module.exports = { startCapture, peekCapture, takeCapture };
